import { describe, it, expect, vi } from "vitest";
import {
  resolveClaudeAccounts, nextClaudeAccount, claudeAccountToken, accountsTried, earliestAccountReset,
  MAX_CLAUDE_ACCOUNTS, claudeAccountVarName, type ClaudeAccount,
} from "../src/studio/accounts";
import {
  detectRateLimitModal, paneCaptureCmd, accountSwitchCmd, runAccountFailover, FLEET_TOKEN_ENV,
  exhaustedMessage, RATE_LIMIT_HEADLINES, RATE_LIMIT_MODAL_MARKERS, FLAP_GUARD_MINUTES,
  PANE_CAPTURE_MARKER, MODAL_TAIL_LINES, type FailoverDeps,
} from "../src/studio/failover";
import { STATUS_KEY, OPERATION_KEY, OPERATION_STALE_MS, type StudioStorage } from "../src/studio/provision";
import { syncSessionCycle, launchFields, recordLaunchedAccount, StudioDO } from "../src/studio/do";
import type { SessionSyncDeps } from "../src/studio/session-sync";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import {
  getObserved, mergeObserved, type ObservedStorage, INCARNATION_PATH,
  BRINGUP_TOKEN_WRITE_SECTION, SESSION_FOUND_SECTION, SESSION_CONTINUE_SECTION, SESSION_CWD_SECTION,
} from "../src/studio/observed";
import { STUDIO_TMUX } from "../src/studio/tmux";
// Issue #102's no-flapping tests need a genuine INLINE limit block (as
// opposed to this file's own MODAL_PANE, a select-style modal) — reused from
// the shared fixture set rather than a second, drifting copy of the same
// pane shape.
import { SESSION_LIMIT_LOGIN_HINT_PANE as INLINE_LIMIT_PANE, WEEKLY_LIMIT_PANE } from "./fixtures/rate-limit-panes";

// ---------------------------------------------------------------------------
// Issue #53 — fail over to a second account when one is exhausted.
//
// Measured 2026-09-23: both `fleetflare` studios and both `demosite-life`
// studios parked on claude's `/rate-limit-options` modal ("You've hit your
// org's monthly spend limit"). Containers `running`, READY `provisioned`,
// `pane_current_command` still `claude`, BURN still ticking up as the failure
// messages printed — every cheap signal said healthy while nothing worked.
// Recovery was a human running `/login` inside each container, which dies at
// the next recycle because the container's env comes from the Worker secret.
//
// A live StudioDO cannot be constructed under vitest-pool-workers (see
// src/studio/do.ts's header), so this file targets the exported pure
// functions and the storage-level orchestrator the DO's syncSession tick is a
// thin wrapper around — the same shape test/studio.refresh.test.ts already
// uses for studioEnvVars/refreshWithStorage.
// ---------------------------------------------------------------------------

const STUDIO_ID = "fleetflare--release-studio";
const NOW = new Date("2026-09-23T14:00:00.000Z");

// Realistic Anthropic OAuth token shape (redact.ts's `sk-ant-` pattern covers
// the whole family). Never a real value — the repo rule is that no token ever
// lands in a fixture, a log or a PR body.
const TOKEN_1 = "sk-ant-oat01-" + "a".repeat(40);
const TOKEN_2 = "sk-ant-oat01-" + "b".repeat(40);
const TOKEN_3 = "sk-ant-oat01-" + "c".repeat(40);

function envWith(vars: Record<string, string>): Env {
  return vars as unknown as Env;
}

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

function fakeStorage(initial?: StudioStatus): StudioStorage {
  const map = new Map<string, unknown>();
  if (initial) map.set(STATUS_KEY, initial);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => {
      map.set(key, value);
    }) as StudioStorage["put"],
  };
}

// --- pane fixtures ---------------------------------------------------------
//
// `tmux capture-pane -p -t studio:claude` prints the VISIBLE pane, which is
// where a blocking modal lives. Every fixture below is written as the pane
// really renders, modal frame included.

/** A lead parked on the `/rate-limit-options` modal — the measured state. */
const MODAL_PANE = [
  "⏺ Reading the release notes for the batch.",
  "",
  "⏺ Read(docs/release.md)",
  "  ⎿  Read 42 lines",
  "",
  "╭────────────────────────────────────────────────────────────────╮",
  "│ You've hit your org's monthly spend limit                      │",
  "│                                                                │",
  "│ Run /rate-limit-options to see what you can do.                │",
  "│                                                                │",
  "│ ❯ 1. Upgrade your plan                                         │",
  "│   2. Not now                                                   │",
  "╰────────────────────────────────────────────────────────────────╯",
].join("\n");

/**
 * A lead MID-TURN that is literally working on this very issue: its pane
 * carries both the headline and a modal marker, quoted out of a grep. It must
 * never be switched. What separates it from the fixture above is not the text
 * — the text is identical — it is that the pane REPAINTS: claude renders a
 * live status line that ticks every second for as long as a turn is running.
 */
const MID_TURN_PANE_A = [
  "⏺ Checking how the fleet detects an exhausted account.",
  "",
  "⏺ Bash(rg -n \"spend limit\" src/studio/)",
  "  ⎿  src/studio/failover.ts:41:  \"You've hit your org's monthly spend limit\",",
  "     src/studio/failover.ts:52:  \"Upgrade your plan\",",
  "     src/studio/failover.ts:53:  \"/rate-limit-options\",",
  "",
  "✻ Thinking… (12s · ↑ 1.4k tokens · esc to interrupt)",
].join("\n");
const MID_TURN_PANE_B = MID_TURN_PANE_A.replace(
  "(12s · ↑ 1.4k tokens", "(15s · ↑ 1.6k tokens",
);

/** An idle lead waiting on background subagents: static pane, no modal. */
const IDLE_PANE = [
  "⏺ Dispatched 3 subagents. Waiting.",
  "",
  "╭────────────────────────────────────────────────────────────────╮",
  "│ >                                                              │",
  "╰────────────────────────────────────────────────────────────────╯",
].join("\n");

/** Two observations of the pane, as `paneCaptureCmd()`'s stdout carries them. */
function captured(first: string, second = first): string {
  return `${first}\n${PANE_CAPTURE_MARKER}\n${second}\n`;
}

// ---------------------------------------------------------------------------
// Part 1 — a SECOND credential. Adding an account must be a secret write, not
// a code change.
// ---------------------------------------------------------------------------
describe("resolveClaudeAccounts", () => {
  it("reads an ordered list off the Worker secrets, numbered from the second", () => {
    const accounts = resolveClaudeAccounts(envWith({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1,
      CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2,
      CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3,
    }));
    expect(accounts).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 },
    ]);
  });

  it("the first account keeps the unsuffixed name every existing deploy already has", () => {
    expect(claudeAccountVarName(1)).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(claudeAccountVarName(2)).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("skips a gap rather than stopping at it — deleting _2 must not hide _3", () => {
    const accounts = resolveClaudeAccounts(envWith({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3,
    }));
    expect(accounts.map((a) => a.name)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_3"]);
  });

  it("an empty-string secret is not an account", () => {
    const accounts = resolveClaudeAccounts(envWith({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: "",
    }));
    expect(accounts.map((a) => a.name)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("no secrets at all is an empty list, never a throw", () => {
    expect(resolveClaudeAccounts(envWith({}))).toEqual([]);
  });

  it("scans a fixed window, so an operator adds an account with one secret write", () => {
    const vars: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1 };
    for (let i = 2; i <= MAX_CLAUDE_ACCOUNTS; i++) vars[`CLAUDE_CODE_OAUTH_TOKEN_${i}`] = `${TOKEN_2}${i}`;
    expect(resolveClaudeAccounts(envWith(vars))).toHaveLength(MAX_CLAUDE_ACCOUNTS);
  });
});

describe("nextClaudeAccount", () => {
  const accounts: ClaudeAccount[] = [
    { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 },
    { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 },
  ];

  it("a studio on no recorded account is on the first one, so its next is the second", () => {
    expect(nextClaudeAccount(accounts, null)).toEqual(accounts[1]);
  });

  // Issue #102 (CTO decision 2026-09-30) supersedes #53's forward-only rule:
  // the fleet now WRAPS around to the account with free room, immediately.
  it("issue #102: WRAPS to the first account when the last one has nowhere forward to go", () => {
    expect(nextClaudeAccount(accounts, "CLAUDE_CODE_OAUTH_TOKEN_2")).toEqual(accounts[0]);
  });

  it("issue #102: skips an account with a live fleet-wide limit and wraps past it", () => {
    const three: ClaudeAccount[] = [...accounts, { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 }];
    const now = new Date("2026-09-23T14:00:00.000Z");
    const limits = { CLAUDE_CODE_OAUTH_TOKEN: { until: new Date(now.getTime() + 60_000).toISOString(), seenAt: now.toISOString() } };
    // On CLAUDE_CODE_OAUTH_TOKEN_3 (the last slot): forward wrap would land on
    // account 1 first, but it is still live-limited, so account 2 is next.
    expect(nextClaudeAccount(three, "CLAUDE_CODE_OAUTH_TOKEN_3", limits, now)).toEqual(accounts[1]);
  });

  it("issue #102: an account whose recorded reset has already passed counts as free again", () => {
    const now = new Date("2026-09-23T14:00:00.000Z");
    const limits = { CLAUDE_CODE_OAUTH_TOKEN: { until: new Date(now.getTime() - 1000).toISOString(), seenAt: now.toISOString() } };
    expect(nextClaudeAccount(accounts, "CLAUDE_CODE_OAUTH_TOKEN_2", limits, now)).toEqual(accounts[0]);
  });

  it("issue #102: every OTHER account still live-limited (or an unreadable reset) — nowhere to go, null", () => {
    const now = new Date("2026-09-23T14:00:00.000Z");
    const limits = { CLAUDE_CODE_OAUTH_TOKEN: { until: null, seenAt: now.toISOString() } };
    expect(nextClaudeAccount(accounts, "CLAUDE_CODE_OAUTH_TOKEN_2", limits, now)).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Review round 1 (#102 review, 2026-09-30), finding 1 — a `null`-until
  // entry (a select-style modal sighting) must not blacklist an account
  // FOREVER: nothing ever re-probes it, since `nextClaudeAccount` skips it on
  // every future wrap. A bounded staleness ceiling (NULL_UNTIL_CEILING_MS,
  // 24h) gives the fleet a chance to re-probe instead.
  // ---------------------------------------------------------------------
  it("issue #102 review round 1: a null-until entry seen long ago (30 days) is free again, not a permanent deadlock", () => {
    const now = new Date("2026-09-23T14:00:00.000Z");
    const seenAt = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
    const limits = { CLAUDE_CODE_OAUTH_TOKEN: { until: null, seenAt } };
    expect(nextClaudeAccount(accounts, "CLAUDE_CODE_OAUTH_TOKEN_2", limits, now)).toEqual(accounts[0]);
  });

  it("issue #102 review round 1: a FRESH null-until entry (seen 1 minute ago) still correctly excludes the account", () => {
    const now = new Date("2026-09-23T14:00:00.000Z");
    const seenAt = new Date(now.getTime() - 60_000).toISOString();
    const limits = { CLAUDE_CODE_OAUTH_TOKEN: { until: null, seenAt } };
    expect(nextClaudeAccount(accounts, "CLAUDE_CODE_OAUTH_TOKEN_2", limits, now)).toBeNull();
  });

  it("an account name no longer in the secrets has no next — degrade, never wrap to the start", () => {
    expect(nextClaudeAccount(accounts, "CLAUDE_CODE_OAUTH_TOKEN_7")).toBeNull();
  });

  it("names every account up to and including the current one as tried", () => {
    expect(accountsTried(accounts, "CLAUDE_CODE_OAUTH_TOKEN_2"))
      .toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"]);
    expect(accountsTried(accounts, null)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("resolves the token for the account a studio is recorded on, falling back to the first", () => {
    expect(claudeAccountToken(accounts, "CLAUDE_CODE_OAUTH_TOKEN_2")).toBe(TOKEN_2);
    expect(claudeAccountToken(accounts, null)).toBe(TOKEN_1);
    expect(claudeAccountToken(accounts, "CLAUDE_CODE_OAUTH_TOKEN_9")).toBe(TOKEN_1);
    expect(claudeAccountToken([], null)).toBe("");
  });
});

describe("earliestAccountReset (issue #102 requirement 3)", () => {
  const accounts: ClaudeAccount[] = [
    { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 },
    { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 },
  ];
  const now = new Date("2026-09-23T14:00:00.000Z");

  it("the earliest still-live reset among the limited accounts", () => {
    const later = new Date(now.getTime() + 2 * 60_000).toISOString();
    const earlier = new Date(now.getTime() + 60_000).toISOString();
    expect(earliestAccountReset(accounts, {
      CLAUDE_CODE_OAUTH_TOKEN: { until: later, seenAt: now.toISOString() },
      CLAUDE_CODE_OAUTH_TOKEN_2: { until: earlier, seenAt: now.toISOString() },
    }, now)).toBe(earlier);
  });

  it("null when no account has a readable, still-live reset", () => {
    expect(earliestAccountReset(accounts, {}, now)).toBeNull();
    expect(earliestAccountReset(accounts, { CLAUDE_CODE_OAUTH_TOKEN: { until: null, seenAt: now.toISOString() } }, now)).toBeNull();
    const past = new Date(now.getTime() - 1000).toISOString();
    expect(earliestAccountReset(accounts, { CLAUDE_CODE_OAUTH_TOKEN: { until: past, seenAt: now.toISOString() } }, now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — detection that cannot false-positive.
// ---------------------------------------------------------------------------
describe("detectRateLimitModal", () => {
  it("a pane parked on the rate-limit modal is a modal, named by the string it matched", () => {
    const v = detectRateLimitModal(captured(MODAL_PANE));
    expect(v.kind).toBe("modal");
    if (v.kind !== "modal") throw new Error("unreachable");
    expect(v.headline).toBe("You've hit your org's monthly spend limit");
    expect(RATE_LIMIT_MODAL_MARKERS).toContain(v.marker);
  });

  it("a lead MID-TURN that greps the modal's own strings is never a modal", () => {
    const v = detectRateLimitModal(captured(MID_TURN_PANE_A, MID_TURN_PANE_B));
    expect(v.kind).toBe("working");
    if (v.kind !== "working") throw new Error("unreachable");
    expect(v.reason).toContain("repainted");
  });

  it("an idle lead with no modal text is not a modal, however still the pane is", () => {
    expect(detectRateLimitModal(captured(IDLE_PANE)).kind).toBe("working");
  });

  it("the headline alone is not enough — the modal's own option text must be there too", () => {
    const headlineOnly = ["⏺ Wrote the note.", "", RATE_LIMIT_HEADLINES[0]].join("\n");
    const v = detectRateLimitModal(captured(headlineOnly));
    expect(v.kind).toBe("working");
  });

  it("a headline scrolled far above the bottom of the pane is scrollback, not a modal", () => {
    const buried = [
      RATE_LIMIT_HEADLINES[0], RATE_LIMIT_MODAL_MARKERS[0],
      ...Array.from({ length: MODAL_TAIL_LINES + 5 }, (_, i) => `⏺ line ${i}`),
    ].join("\n");
    expect(detectRateLimitModal(captured(buried)).kind).toBe("working");
  });

  it("a capture with no second observation is inconclusive, never a modal", () => {
    expect(detectRateLimitModal(MODAL_PANE).kind).toBe("inconclusive");
  });

  it("an empty capture is inconclusive, never a modal", () => {
    expect(detectRateLimitModal("").kind).toBe("inconclusive");
  });
});

describe("paneCaptureCmd", () => {
  it("addresses the pane BY NAME and never switches, selects or attaches a window", () => {
    const cmd = paneCaptureCmd();
    expect(cmd).toContain("capture-pane -p -t studio:claude");
    for (const forbidden of ["select-window", "select-pane", "switch-client", "attach-session", "kill-"]) {
      expect(cmd).not.toContain(forbidden);
    }
  });

  it("takes TWO observations in ONE exec, separated by the marker the parser splits on", () => {
    expect(cmd_occurrences(paneCaptureCmd(), "capture-pane")).toBe(2);
    expect(paneCaptureCmd()).toContain(PANE_CAPTURE_MARKER);
  });
});

function cmd_occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Part 3 — switch WITHOUT interacting with the modal.
// ---------------------------------------------------------------------------
describe("accountSwitchCmd", () => {
  const account: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 };

  it("never answers the modal: no Enter, no arrow key, no option number sent to the claude pane", () => {
    const cmd = accountSwitchCmd();
    // Two send-keys, both into a pane that is a plain bash by then — the
    // modal is already gone: C-c to clear readline (#90), then the shell
    // line that adopts the new token.
    const sendKeys = cmd.split("\n").filter((l) => l.includes("send-keys"));
    expect(sendKeys).toHaveLength(2);
    expect(sendKeys[1]).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    for (const line of sendKeys) {
      for (const forbidden of ["Up", "Down", "C-m", "\"1\"", "'1'"]) {
        expect(line).not.toContain(` ${forbidden}`);
      }
    }
  });

  it("clears the pane's readline with C-c before typing (#90), and only into a pane that reads bash", () => {
    // An attach client's terminal replies can sit in the fresh pane's
    // readline; the adopt line typed over them is eaten, and the leftover
    // corrupts the relaunch bring-up types next.
    const lines = accountSwitchCmd().split("\n");
    const cc = lines.findIndex((l) => /send-keys -t studio:claude C-c\b/.test(l));
    const adopt = lines.findIndex((l) => l.includes("send-keys") && l.includes("CLAUDE_CODE_OAUTH_TOKEN"));
    expect(cc).toBeGreaterThan(lines.findIndex((l) => l.includes("respawn-pane")));
    expect(cc).toBeLessThan(adopt);
    expect(lines[cc]).toMatch(/\[ "\$\(__ff_tmux display-message -p -t studio:claude '#\{pane_current_command\}'\)" = bash \] && __ff_tmux send-keys -t studio:claude C-c/);
  });

  it("carries no token anywhere in the command text — it arrives in the exec's env (#110 review)", () => {
    expect(accountSwitchCmd()).not.toContain(TOKEN_2);
    expect(accountSwitchCmd()).toContain(`"$${FLEET_TOKEN_ENV}"`);
    // Handed to tmux on stdin by a shell builtin, never as a tmux argv —
    // through the dual-socket builder's function (issue #117).
    expect(accountSwitchCmd()).toContain(`| ${STUDIO_TMUX} source-file -`);
  });

  it("kills the claude process in studio:claude with tmux itself, addressing the pane by name", () => {
    expect(accountSwitchCmd()).toContain("respawn-pane -k -t studio:claude");
  });

  it("puts the next token into the tmux SESSION environment", () => {
    expect(accountSwitchCmd()).toContain("set-environment -t studio CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("never types the token into the pane — the pane reads it back out of tmux instead", () => {
    const cmd = accountSwitchCmd();
    const sendKeys = cmd.split("\n").filter((l) => l.includes("send-keys")).join("\n");
    expect(sendKeys).not.toContain(TOKEN_2);
    expect(sendKeys).toContain("show-environment");
  });

  it("switches no window and attaches no client", () => {
    for (const forbidden of ["select-window", "select-pane", "switch-client", "attach-session"]) {
      expect(accountSwitchCmd()).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// The orchestrator: one switch, never a loop, always auditable.
// ---------------------------------------------------------------------------
interface Harness {
  deps: FailoverDeps;
  storage: StudioStorage & ObservedStorage;
  recorded: StudioStatus[];
  execs: string[];
  relaunches: number;
  notices: string[];
  setPane(stdout: string): void;
  /** Issue #102: the fleet-wide fake `accountLimits` store, exposed so a test
   *  can seed another account as ALREADY limited (fleet-wide, from some other
   *  studio's own sighting) before running this one. */
  accountLimits: Map<string, { until: string | null; seenAt: string }>;
}

function harness(opts: {
  accounts: ClaudeAccount[];
  pane: string;
  initial?: StudioStatus;
  /** Issue #271: default ON here, so every #53 test below keeps switching. */
  autoFailover?: boolean;
  primary?: string | null;
  display?: (name: string) => string;
  now?: Date;
  /** Issue #102: seed a fleet-wide limit fixture, `{ name: until }`. */
  accountLimits?: Record<string, string | null>;
}): Harness {
  const execs: string[] = [];
  const recorded: StudioStatus[] = [];
  const notices: string[] = [];
  let pane = opts.pane;
  let relaunches = 0;
  const storage = fakeStorage(opts.initial ?? status()) as StudioStorage & ObservedStorage;
  const accountLimits = new Map<string, { until: string | null; seenAt: string }>(
    Object.entries(opts.accountLimits ?? {}).map(([name, until]) => [name, { until, seenAt: NOW.toISOString() }]),
  );
  const h: Harness = {
    execs, recorded, notices, storage, accountLimits,
    get relaunches() { return relaunches; },
    setPane: (stdout: string) => { pane = stdout; },
    deps: {
      accounts: opts.accounts,
      autoFailover: opts.autoFailover ?? true,
      ...(opts.primary !== undefined ? { primary: opts.primary } : {}),
      ...(opts.display ? { display: opts.display } : {}),
      now: () => opts.now ?? NOW,
      accountLimits: {
        read: async () => Object.fromEntries(accountLimits),
        write: async (name: string, until: string | null, seenAt: string) => {
          accountLimits.set(name, { until, seenAt });
        },
      },
      exec: vi.fn(async (cmd: string) => {
        execs.push(cmd);
        if (cmd === paneCaptureCmd()) return { code: 0, stdout: pane, stderr: "" };
        // Issue #85, maestro correction #6: the post-switch combined
        // token-write + pane-probe exec. Default simulates a successful
        // token write with no lead pane found (this fake has no real tmux)
        // — same "own default, own reason" shape studio.replacement.test.ts's
        // own restartDeps helper uses for the identical exec.
        if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
          return {
            code: 0,
            stdout: [
              BRINGUP_TOKEN_WRITE_SECTION, "yes",
              SESSION_FOUND_SECTION, "no", SESSION_CONTINUE_SECTION, "no", SESSION_CWD_SECTION, "",
            ].join("\n"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
      relaunch: vi.fn(async () => {
        relaunches++;
        return { code: 0, stdout: "", stderr: "" };
      }),
      notify: vi.fn(async (m: string) => { notices.push(m); }),
    },
  };
  return h;
}

const TWO_ACCOUNTS: ClaudeAccount[] = [
  { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 },
  { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 },
];

async function run(h: Harness) {
  return runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => { h.recorded.push(s); });
}

describe("runAccountFailover — (a) a pane showing the rate-limit modal triggers exactly ONE switch", () => {
  it("switches to the second account, once", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    const out = await run(h);

    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(h.execs.filter((c) => c.includes("respawn-pane"))).toHaveLength(1);
    expect(h.relaunches).toBe(1);
  });

  it("hands the next token to the switch in the exec's env, never in its command (#110 review)", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    await run(h);
    expect(h.deps.exec).toHaveBeenCalledWith(accountSwitchCmd(), { [FLEET_TOKEN_ENV]: TOKEN_2 });
    for (const c of h.execs) expect(c).not.toContain(TOKEN_2);
  });

  it("records which account the studio is now on, so an operator can SEE it", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    await run(h);

    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(h.recorded.at(-1)?.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("tells the operator a switch happened, naming both accounts and never the token", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    await run(h);

    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain(STUDIO_ID);
    expect(h.notices[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(h.notices[0]).not.toContain(TOKEN_1);
    expect(h.notices[0]).not.toContain(TOKEN_2);
  });

  it("the studio it switched stays running — a switch is a recovery, not a degradation", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    await run(h);
    expect((await h.storage.get(STATUS_KEY))?.state).toBe("running");
  });

  it("the NEXT tick, with the modal gone, does nothing at all", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    await run(h);
    h.setPane(captured(IDLE_PANE));
    const out = await run(h);

    expect(out.kind).toBe("no-modal");
    expect(h.execs.filter((c) => c.includes("respawn-pane"))).toHaveLength(1);
    expect(h.relaunches).toBe(1);
  });
});

describe("runAccountFailover — (b) a pane mid-turn triggers NO switch", () => {
  it("a lead mid-turn is never switched, even when its own output quotes the modal strings", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MID_TURN_PANE_A, MID_TURN_PANE_B) });
    const out = await run(h);

    expect(out.kind).toBe("no-modal");
    expect(h.execs).toEqual([paneCaptureCmd()]);
    expect(h.relaunches).toBe(0);
    expect(h.recorded).toEqual([]);
    expect((await h.storage.get(STATUS_KEY))?.claudeAccount).toBeUndefined();
  });

  it("an idle lead waiting on subagents is never switched", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(IDLE_PANE) });
    expect((await run(h)).kind).toBe("no-modal");
    expect(h.relaunches).toBe(0);
  });

  it("a capture that could not be taken is inconclusive and changes nothing", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: "" });
    expect((await run(h)).kind).toBe("inconclusive");
    expect(h.relaunches).toBe(0);
    expect(h.recorded).toEqual([]);
  });

  it("a stopped studio is not probed at all", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE), initial: status({ state: "stopped" }),
    });
    expect((await run(h)).kind).toBe("skipped");
    expect(h.execs).toEqual([]);
  });
});

describe("runAccountFailover — (c) with every account exhausted the studio ends degraded and does NOT loop", () => {
  // Issue #102: with wrap-around, "every account exhausted" now means every
  // OTHER account is ALSO fleet-wide limited — seeded here via accountLimits,
  // exactly as another studio's own sighting would fleet-wide-mark it.
  const ALL_LIMITED = { CLAUDE_CODE_OAUTH_TOKEN: new Date(NOW.getTime() + 60 * 60_000).toISOString() };

  it("degrades, naming every account tried, and relaunches nothing", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(MODAL_PANE),
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
      accountLimits: ALL_LIMITED,
    });
    const out = await run(h);

    expect(out).toEqual({
      kind: "exhausted", tried: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"],
    });
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.state).toBe("degraded");
    expect(stored?.error).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(stored?.error).toContain("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(h.relaunches).toBe(0);
    expect(h.execs.filter((c) => c.includes("respawn-pane"))).toHaveLength(0);
  });

  // Issue #102 requirement 1: with NO fleet-wide limit recorded against the
  // account wrap would land on, the studio moves there immediately — the
  // whole point of "the fleet moves the studio to the next account WITH FREE
  // ROOM, immediately" rather than staying stuck on the last slot.
  it("issue #102: wraps to the first account instead of degrading, when it is free", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(MODAL_PANE),
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
    });
    const out = await run(h);
    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN_2", to: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect((await h.storage.get(STATUS_KEY))?.state).toBe("running");
  });

  // Issue #102 requirement 1: an account fleet-wide marked limited becomes a
  // candidate again once its OWN recorded reset has passed — "an account
  // whose reset has passed counts as free again", even with no code change
  // and no operator action, just the clock.
  it("issue #102: wraps to an account once its fleet-wide reset has passed", async () => {
    const justPassed = { CLAUDE_CODE_OAUTH_TOKEN: new Date(NOW.getTime() - 1000).toISOString() };
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(MODAL_PANE),
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
      accountLimits: justPassed,
    });
    const out = await run(h);
    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN_2", to: "CLAUDE_CODE_OAUTH_TOKEN" });
  });

  // Issue #102 requirement 2: fleet-wide, not per-studio. THIS studio's own
  // sighting of its current account's limit must be visible to a SECOND,
  // otherwise-unrelated studio's own next failover decision.
  it("issue #102: one studio's own sighting marks the account fleet-wide for a DIFFERENT studio", async () => {
    const first = harness({
      accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE),
      initial: status({ id: "fleetflare--studio-a", claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN" }),
    });
    await run(first);
    // The second studio shares the SAME fleet-wide accountLimits store, and
    // starts on the account the first studio just marked limited.
    const second = harness({
      accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE),
      initial: status({ id: "fleetflare--studio-b", claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
    });
    second.deps.accountLimits!.read = () => first.deps.accountLimits!.read();
    const out = await runAccountFailover(second.deps, second.storage, "fleetflare--studio-b", async (s) => { second.recorded.push(s); });
    // Both accounts now read limited fleet-wide (first marked TOKEN, second's
    // own tick marks TOKEN_2) — nowhere for the second studio to go either.
    expect(out.kind).toBe("exhausted");
  });

  it("one account configured and exhausted degrades immediately rather than restarting it", async () => {
    const h = harness({ accounts: [TWO_ACCOUNTS[0]], pane: captured(MODAL_PANE) });
    const out = await run(h);
    expect(out).toEqual({ kind: "exhausted", tried: ["CLAUDE_CODE_OAUTH_TOKEN"] });
    expect(h.relaunches).toBe(0);
  });

  it("no accounts configured at all degrades rather than switching to nothing", async () => {
    const h = harness({ accounts: [], pane: captured(MODAL_PANE) });
    expect((await run(h)).kind).toBe("exhausted");
    expect(h.relaunches).toBe(0);
  });

  it("the tick AFTER the degradation does not re-degrade, re-notify, or retry — no loop", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(MODAL_PANE),
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
      accountLimits: ALL_LIMITED,
    });
    await run(h);
    const writesAfterFirst = h.recorded.length;
    const noticesAfterFirst = h.notices.length;

    const second = await run(h);
    const third = await run(h);

    expect(second.kind).toBe("already-degraded");
    expect(third.kind).toBe("already-degraded");
    expect(h.recorded).toHaveLength(writesAfterFirst);
    expect(h.notices).toHaveLength(noticesAfterFirst);
    expect(h.relaunches).toBe(0);
  });

  it("adding a THIRD account secret is what un-sticks an exhausted studio — no code change", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(MODAL_PANE),
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
      accountLimits: ALL_LIMITED,
    });
    await run(h);
    h.deps.accounts = [...TWO_ACCOUNTS, { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 }];

    const out = await run(h);
    expect(out).toEqual({
      kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN_2", to: "CLAUDE_CODE_OAUTH_TOKEN_3",
    });
    expect((await h.storage.get(STATUS_KEY))?.state).toBe("running");
  });

  it("the degraded message names the accounts and never a token", () => {
    const msg = exhaustedMessage(STUDIO_ID, ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"]);
    expect(msg).toContain("CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(msg).not.toContain("sk-ant-");
  });

  // Issue #102 requirement 3: "show earliest reset in fleet ls" — fleet ls
  // renders StudioStatus.error verbatim (ff.ts's oneLine(row.error)), so the
  // earliest reset reaching THIS message is what reaches the operator.
  it("issue #102: a genuinely exhausted studio's degraded message names the earliest fleet-wide reset", async () => {
    const earlier = new Date(NOW.getTime() + 60_000).toISOString();
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(MODAL_PANE),
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
      accountLimits: { CLAUDE_CODE_OAUTH_TOKEN: earlier },
    });
    await run(h);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.error).toContain(`Earliest reset: ${earlier}`);
  });

  it("exhaustedMessage appends the earliest reset only when given one", () => {
    const reset = "2026-09-23T19:00:00.000Z";
    expect(exhaustedMessage(STUDIO_ID, ["CLAUDE_CODE_OAUTH_TOKEN"], reset)).toContain(`Earliest reset: ${reset}.`);
    expect(exhaustedMessage(STUDIO_ID, ["CLAUDE_CODE_OAUTH_TOKEN"])).not.toContain("Earliest reset");
    expect(exhaustedMessage(STUDIO_ID, ["CLAUDE_CODE_OAUTH_TOKEN"], null)).not.toContain("Earliest reset");
  });
});

// ---------------------------------------------------------------------------
// Issue #102 — no flapping. A studio moved onto a new account is trusted
// there for FLAP_GUARD_MINUTES: an inline-only limit block (the shape
// `--continue` can redraw un-guarded after a select-modal switch, per
// runAccountFailover's own residual notes) within that window does not move
// it again; a genuine select-style modal always does, since claude can never
// redraw one of those from a resumed transcript.
// ---------------------------------------------------------------------------
describe("runAccountFailover — no flapping (issue #102)", () => {
  // INLINE_LIMIT_PANE's own printed reset is "1:30pm (UTC)" — a session-limit
  // time-only reset is live only within its 5h window (rate-limit.ts's
  // isResetStale), so `now` here is fixed well inside that window rather than
  // reusing the file's outer NOW (14:00Z, at which this exact fixture reads
  // as stale — see studio.failover-106.test.ts's own `at(...)` calls against
  // this same fixture for the identical reason).
  const FLAP_NOW = new Date("2026-09-23T10:00:00.000Z");
  const MOVED_AT = new Date(FLAP_NOW.getTime() - 2 * 60_000).toISOString(); // 2 minutes ago
  // INLINE_LIMIT_PANE's own block-key (failover.ts's limitBlockKey): what a
  // select-modal switch would have recorded as `claudeAccountMovedBlock` had
  // it already known about this exact block (a prior sighting) at the moment
  // it fired.
  const INLINE_LIMIT_KEY = "You've hit your session limit · 1:30pm (UTC)";

  // Review round 1 (#102 review, 2026-09-30), finding 2 — the escape hatch
  // must distinguish a genuine STALE REDRAW (same block-key as whatever this
  // studio already knew about when the select-modal switch fired) from a
  // GENUINELY NEW/different inline limit on the account it is now on. Only
  // the former is suppressed.
  it("a stale redraw matching the block already known at the switch IS suppressed", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(INLINE_LIMIT_PANE),
      now: FLAP_NOW,
      initial: status({
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2", claudeAccountMovedAt: MOVED_AT, claudeAccountMovedVia: "modal",
        claudeAccountMovedBlock: INLINE_LIMIT_KEY,
      }),
    });
    const out = await run(h);
    expect(out.kind).toBe("flap-guarded");
    expect(h.relaunches).toBe(0);
    expect((await h.storage.get(STATUS_KEY))?.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  // The bug: the OLD guard suppressed ANY inline verdict within the cooldown
  // window after a "modal"-via switch, with no regard for whether it matched
  // anything the switch actually knew about. A genuinely new limit — here, a
  // DIFFERENT block (weekly, not session) on an account the select-modal
  // switch never saw any inline content on at all (claudeAccountMovedBlock
  // absent, i.e. "the switch itself was NOT justified by an inline block at
  // all") — must not be suppressed.
  it("issue #102 review round 1: a genuinely new, differently-keyed inline limit is NOT suppressed", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(WEEKLY_LIMIT_PANE),
      now: FLAP_NOW,
      initial: status({
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2", claudeAccountMovedAt: MOVED_AT, claudeAccountMovedVia: "modal",
      }),
    });
    const out = await run(h);
    expect(out.kind).toBe("switched");
  });

  it("a genuinely new limit is not suppressed even when a DIFFERENT block was known at the switch", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(WEEKLY_LIMIT_PANE),
      now: FLAP_NOW,
      initial: status({
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2", claudeAccountMovedAt: MOVED_AT, claudeAccountMovedVia: "modal",
        claudeAccountMovedBlock: INLINE_LIMIT_KEY,
      }),
    });
    const out = await run(h);
    expect(out.kind).toBe("switched");
  });

  it("a genuine select-style modal overrides the guard and moves the studio immediately", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(MODAL_PANE),
      now: FLAP_NOW,
      initial: status({
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2", claudeAccountMovedAt: MOVED_AT, claudeAccountMovedVia: "modal",
        claudeAccountMovedBlock: INLINE_LIMIT_KEY,
      }),
    });
    const out = await run(h);
    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN_2", to: "CLAUDE_CODE_OAUTH_TOKEN" });
  });

  it("outside the cooldown window, a matching inline block still moves the studio normally", async () => {
    const longAgo = new Date(FLAP_NOW.getTime() - (FLAP_GUARD_MINUTES + 1) * 60_000).toISOString();
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(INLINE_LIMIT_PANE),
      now: FLAP_NOW,
      initial: status({
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2", claudeAccountMovedAt: longAgo, claudeAccountMovedVia: "modal",
        claudeAccountMovedBlock: INLINE_LIMIT_KEY,
      }),
    });
    const out = await run(h);
    expect(out.kind).toBe("switched");
  });

  it("a completed switch stamps claudeAccountMovedAt and claudeAccountMovedVia", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    await run(h);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.claudeAccountMovedAt).toBe(NOW.toISOString());
    expect(stored?.claudeAccountMovedVia).toBe("modal");
  });

  it("an inline-block-triggered switch stamps claudeAccountMovedVia as inline", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(INLINE_LIMIT_PANE), now: FLAP_NOW });
    await run(h);
    expect((await h.storage.get(STATUS_KEY))?.claudeAccountMovedVia).toBe("inline");
  });
});

// ---------------------------------------------------------------------------
// Wiring: the failover step is a step of the syncSession cycle, isolated from
// the other three exactly the way board issue #24 made them isolated from
// each other.
// ---------------------------------------------------------------------------
describe("syncSessionCycle — the account failover step", () => {
  function cycleSyncDeps(): SessionSyncDeps {
    return {
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      r2Put: vi.fn(async () => {}),
      r2List: vi.fn(async () => []),
      r2Delete: vi.fn(async () => {}),
      now: () => NOW,
      notify: vi.fn(async () => {}),
      burnAlertThresholdTokens: 0,
    };
  }

  it("switches the account when the tick finds the modal", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    await syncSessionCycle(cycleSyncDeps(), h.storage as never, STUDIO_ID, async () => {}, h.deps);

    expect((await h.storage.get(STATUS_KEY))?.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("a failover step that throws never blocks the readiness check that follows it", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    h.deps.exec = vi.fn(async () => { throw new Error("container unreachable"); });
    const recorded: StudioStatus[] = [];

    await syncSessionCycle(cycleSyncDeps(), h.storage as never, STUDIO_ID, async (s) => { recorded.push(s); }, h.deps);

    expect(recorded.some((s) => s.readiness != null)).toBe(true);
  });

  it("no failover deps at all leaves the cycle exactly as it was", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    await syncSessionCycle(cycleSyncDeps(), h.storage as never, STUDIO_ID, async () => {});

    expect((await h.storage.get(STATUS_KEY))?.claudeAccount).toBeUndefined();
  });
});

describe("runAccountFailover — a relaunch that fails is reported, never silently swallowed", () => {
  it("records the bring-up failure on the status it just switched", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    h.deps.relaunch = vi.fn(async () => ({ code: 1, stdout: "", stderr: "studio-bringup: claude exited" }));

    const out = await run(h);
    expect(out.kind).toBe("switched");
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(stored?.error).toContain("studio-bringup");
  });
});

describe("runAccountFailover — incarnation token write (issue #85)", () => {
  it("a completed switch writes a fresh incarnation token", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });

    const out = await runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => { h.recorded.push(s); }, h.storage);

    expect(out.kind).toBe("switched");
    expect(h.execs.some((c) => c.includes(INCARNATION_PATH) && c.includes("printf"))).toBe(true);
    const observed = await getObserved(h.storage);
    expect(observed.incarnation).not.toBeNull();
    expect(typeof observed.incarnation).toBe("string");
  });

  it("a failed relaunch does NOT write an incarnation token — the switch itself did not land", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    h.deps.relaunch = vi.fn(async () => ({ code: 1, stdout: "", stderr: "studio-bringup: claude exited" }));

    const out = await runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => { h.recorded.push(s); }, h.storage);

    expect(out.kind).toBe("switched");
    expect(h.execs.some((c) => c.includes(INCARNATION_PATH))).toBe(false);
    const observed = await getObserved(h.storage);
    expect(observed.incarnation).toBeNull();
  });

  it("with no observedStorage passed, behaves exactly as before — no incarnation exec at all", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });

    await runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => { h.recorded.push(s); });

    expect(h.execs.some((c) => c.includes(INCARNATION_PATH))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #85, maestro correction #14 — one verdict test per bring-up path:
// this is failover's own. `restore` is always "not-attempted" here (a
// failover never restages a session — see runAccountFailover's own doc
// comment above computeSessionVerdict's call site) and `via` must read
// "failover", never the default "restart" some other path uses.
// ---------------------------------------------------------------------------
describe("runAccountFailover — a session verdict is recorded on the failover bring-up path too (issue #85)", () => {
  it("via is \"failover\", restore is always not-attempted", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });

    const out = await runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => { h.recorded.push(s); }, h.storage);

    expect(out.kind).toBe("switched");
    const observed = await getObserved(h.storage);
    expect(observed.session?.via).toBe("failover");
    expect(observed.session?.restore).toBe("not-attempted");
  });

  // Board issue #183 — a successful failover's observation exec is proof the
  // exec plane answered, exactly like a successful ship tick, so it must
  // ALSO re-anchor `lastShipOkAt` to the current tick's own `nowIso` —
  // leaving it stale (an older timestamp) makes the time-based `unreachable`
  // rule measure elapsed time from the wrong instant and fire too early.
  it("board #183: a successful failover re-anchors a stale lastShipOkAt to NOW", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    await mergeObserved(h.storage, { lastShipOkAt: "2026-09-20T00:00:00.000Z" });

    const out = await runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => { h.recorded.push(s); }, h.storage);

    expect(out.kind).toBe("switched");
    const observed = await getObserved(h.storage);
    expect(observed.lastShipOkAt).toBe(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// Issue #85 review round 5, Finding 3 — the token-write + mergeObserved
// two-step right above (the SAME "container-exec-then-DO-patch" shape
// provisionWithStorage/restartWithStorage/recycleWithSync all wrap in
// OPERATION_KEY) held no lock at all. A concurrent ship tick reading the
// fresh incarnation token this exec just wrote, before mergeObserved's own
// write had landed, could read a live container as falsely "replaced" — the
// exact race class OPERATION_KEY exists to close on every other bring-up
// path.
// ---------------------------------------------------------------------------
describe("runAccountFailover — op-lock coverage (issue #85 review round 5, Finding 3)", () => {
  it("holds OPERATION_KEY {op: 'failover'} during the token-write + mergeObserved two-step, cleared once failover finishes", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    let opDuringObservationExec: unknown;
    const baseExec = h.deps.exec;
    h.deps.exec = vi.fn(async (cmd: string, env?: Record<string, string>) => {
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        opDuringObservationExec = await h.storage.get(OPERATION_KEY);
      }
      return baseExec(cmd, env);
    });

    const out = await runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => { h.recorded.push(s); }, h.storage);

    expect(out.kind).toBe("switched");
    expect(opDuringObservationExec).toEqual({ op: "failover", since: expect.any(String) });
    expect(await h.storage.get(OPERATION_KEY)).toBeNull();
  });

  it("clears OPERATION_KEY in a finally even when mergeObserved throws", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    const throwingObserved: ObservedStorage = {
      get: h.storage.get,
      put: async () => { throw new Error("DO storage unavailable"); },
    };

    await expect(
      runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => { h.recorded.push(s); }, throwingObserved),
    ).rejects.toThrow("DO storage unavailable");
    expect(await h.storage.get(OPERATION_KEY)).toBeNull();
  });

  // Review round 6, Blocker 2: this fixture's own `since` used to be dated
  // AFTER `NOW` ("2026-09-24T12:00:00.000Z" against a fixed `deps.now()` of
  // "2026-09-23T14:00:00.000Z") — a value that happened to read as "locked"
  // under the OLD (any-non-null) check but says nothing about freshness.
  // Pinned to a genuinely FRESH `since` (5 minutes before NOW, well inside
  // OPERATION_STALE_MS) so this test actually proves what its name claims: a
  // fresh outer lock is respected, not just "some non-null value" was.
  const FRESH_OUTER_SINCE = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();

  it("does not clobber an ALREADY-held FRESH lock (e.g. a genuine provision/recycle racing this same tick) — only the outermost setter clears it", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    await h.storage.put(OPERATION_KEY, { op: "provision", since: FRESH_OUTER_SINCE });
    let opDuringObservationExec: unknown;
    const baseExec = h.deps.exec;
    h.deps.exec = vi.fn(async (cmd: string, env?: Record<string, string>) => {
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        opDuringObservationExec = await h.storage.get(OPERATION_KEY);
      }
      return baseExec(cmd, env);
    });

    const out = await runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => { h.recorded.push(s); }, h.storage);

    expect(out.kind).toBe("switched");
    // Still the OUTER provision's lock throughout — failover never overwrote it.
    expect(opDuringObservationExec).toEqual({ op: "provision", since: FRESH_OUTER_SINCE });
    // And failover, which never set it, must never be the one to clear it.
    expect(await h.storage.get(OPERATION_KEY)).toEqual({ op: "provision", since: FRESH_OUTER_SINCE });
  });

  // Review round 6, Blocker 2 — the fix this round adds: a lock that is
  // present but STALE (older than OPERATION_STALE_MS, e.g. an isolate that
  // died mid-provision and never reached its own `finally`) must be treated
  // as no lock at all, not as "already held forever". Before this fix,
  // `alreadyLocked` read true for ANY non-null lock regardless of age, so a
  // stale lock permanently blocked this function from ever taking (or
  // clearing) its OWN lock again.
  it("a STALE outer lock is ignored — takes its OWN fresh lock during the observation exec, clears it after", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    const staleSince = new Date(NOW.getTime() - OPERATION_STALE_MS - 1000).toISOString();
    await h.storage.put(OPERATION_KEY, { op: "provision", since: staleSince });
    let opDuringObservationExec: unknown;
    const baseExec = h.deps.exec;
    h.deps.exec = vi.fn(async (cmd: string, env?: Record<string, string>) => {
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        opDuringObservationExec = await h.storage.get(OPERATION_KEY);
      }
      return baseExec(cmd, env);
    });

    const out = await runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => { h.recorded.push(s); }, h.storage);

    expect(out.kind).toBe("switched");
    // This function's OWN fresh lock, not the stale one it found.
    expect(opDuringObservationExec).toEqual({ op: "failover", since: NOW.toISOString() });
    // Cleared exactly as if there had been no pre-existing lock at all.
    expect(await h.storage.get(OPERATION_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #271: auto-failover is OFF unless FLEET_AUTO_FAILOVER=on. The detector
// is not yet safe to act on (#239 review), so with it off a limit detection
// marks the row and sends the card, and never switches accounts.
// ---------------------------------------------------------------------------
describe("runAccountFailover — auto-failover OFF (#271)", () => {
  it("a limit with another account available is marked and carded, never switched", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE), autoFailover: false });
    const out = await run(h);

    expect(out).toEqual({ kind: "parked", account: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(h.execs.filter((c) => c === accountSwitchCmd())).toHaveLength(0);
    expect(h.relaunches).toBe(0);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.state).toBe("degraded");
    expect(stored?.claudeAccount ?? null).toBeNull();
    expect(stored?.rateLimited).not.toBeNull();
    expect(h.notices).toEqual([stored?.error]);
    expect(stored?.error).toBe(
      `claude account exhausted: ${STUDIO_ID} is parked on the rate-limit modal in tmux studio:claude ` +
      "on CLAUDE_CODE_OAUTH_TOKEN. Auto-failover is off (set FLEET_AUTO_FAILOVER=on to enable it); no switch attempted.",
    );
  });

  it("the next tick does not re-card or switch — no loop", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE), autoFailover: false });
    await run(h);
    const out = await run(h);
    expect(out.kind).toBe("already-degraded");
    expect(h.notices).toHaveLength(1);
    expect(h.relaunches).toBe(0);
  });

  it("a mapped studio is parked on its mapped primary, named with its label", async () => {
    const three: ClaudeAccount[] = [...TWO_ACCOUNTS, { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 }];
    const h = harness({
      accounts: three, pane: captured(MODAL_PANE), autoFailover: false,
      primary: "CLAUDE_CODE_OAUTH_TOKEN_2", display: (n) => (n === "CLAUDE_CODE_OAUTH_TOKEN_2" ? `second@example.com (${n})` : n),
    });
    expect(await run(h)).toEqual({ kind: "parked", account: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(h.notices[0]).toContain("on second@example.com (CLAUDE_CODE_OAUTH_TOKEN_2).");
  });

  it("a studio mapped to the last account names only the accounts it was on, not account 1", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE), autoFailover: false,
      primary: "CLAUDE_CODE_OAUTH_TOKEN_2", display: (n) => (n === "CLAUDE_CODE_OAUTH_TOKEN_2" ? `second@example.com (${n})` : n),
    });
    expect(await run(h)).toEqual({ kind: "exhausted", tried: ["CLAUDE_CODE_OAUTH_TOKEN_2"] });
    expect(h.notices[0]).toContain("(second@example.com (CLAUDE_CODE_OAUTH_TOKEN_2))");
  });

  it("a single account behaves exactly as today (exhausted, same message)", async () => {
    const h = harness({ accounts: [TWO_ACCOUNTS[0]], pane: captured(MODAL_PANE), autoFailover: false });
    expect(await run(h)).toEqual({ kind: "exhausted", tried: ["CLAUDE_CODE_OAUTH_TOKEN"] });
    expect(h.notices[0]).toBe(exhaustedMessage(STUDIO_ID, ["CLAUDE_CODE_OAUTH_TOKEN"]));
  });
});

describe("runAccountFailover — the launched account (#289)", () => {
  it("a completed switch records the account the lead now runs on as launchedAccount", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    await run(h);
    expect((await h.storage.get(STATUS_KEY))?.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("flag off, launched on account 1 before a map to 2: the parked card names account 1", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE), autoFailover: false,
      primary: "CLAUDE_CODE_OAUTH_TOKEN_2", initial: status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }),
    });
    expect(await run(h)).toEqual({ kind: "parked", account: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(h.notices[0]).toContain("on CLAUDE_CODE_OAUTH_TOKEN.");
  });
});

describe("runAccountFailover — stale recorded account, flag off (#273 r2)", () => {
  it("the parked card names the mapped primary the studio runs on, not an old failover's account", async () => {
    const three: ClaudeAccount[] = [...TWO_ACCOUNTS, { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 }];
    const h = harness({
      accounts: three, pane: captured(MODAL_PANE), autoFailover: false, primary: "CLAUDE_CODE_OAUTH_TOKEN",
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
    });
    expect(await run(h)).toEqual({ kind: "parked", account: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(h.notices[0]).toContain("on CLAUDE_CODE_OAUTH_TOKEN.");
  });
});

describe("runAccountFailover — auto-failover ON with a mapped primary (#271)", () => {
  it("a studio on its mapped primary moves FORWARD from it, and the card names labels", async () => {
    const three: ClaudeAccount[] = [...TWO_ACCOUNTS, { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 }];
    const h = harness({
      accounts: three, pane: captured(MODAL_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2",
      display: (n) => `${n.toLowerCase()}@example.com (${n})`,
    });
    expect(await run(h)).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN_2", to: "CLAUDE_CODE_OAUTH_TOKEN_3" });
    expect(h.notices[0]).toContain("claude_code_oauth_token_3@example.com (CLAUDE_CODE_OAUTH_TOKEN_3)");
  });
});

// ---------------------------------------------------------------------------
// Issue #354: a completed failover wrote launchedAccount/claudeAccount to the
// ROW only. The DO's in-memory start config (envVars + envAccount) kept the
// OLD account, so the next container start (alarm/exec wake) booted the old
// token and onStart recorded the old account over the failover's. The switch
// now hands the new account to deps.onSwitched, and the DO derives BOTH
// fields from that one name (launchFields) in one assignment.
// ---------------------------------------------------------------------------
describe("runAccountFailover — the in-memory start config follows a completed switch (#354)", () => {
  // A switch only happens with auto-failover on (#271), so the start config it
  // hands over is derived under that same setting.
  const ENV = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, FLEET_AUTO_FAILOVER: "on" });
  const SPAWN = "spawn-token";

  it("a completed switch calls onSwitched once, with the new account", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    const onSwitched = vi.fn(async (_n: string) => {});
    h.deps.onSwitched = onSwitched;
    await run(h);
    expect(onSwitched.mock.calls).toEqual([["CLAUDE_CODE_OAUTH_TOKEN_2"]]);
  });

  // #357 review item 2: recordStudioFn awaits a D1 write; the DO can run a
  // container start in that window. The in-memory start config must already
  // be the new account by then — onSwitched runs BEFORE recordStudioFn.
  it("onSwitched has already run when the switched row is recorded", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    let switchedInMemory = false;
    h.deps.onSwitched = async () => { switchedInMemory = true; };
    const seenAtRecord: boolean[] = [];
    await runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => {
      if (s.launchedAccount === "CLAUDE_CODE_OAUTH_TOKEN_2") seenAtRecord.push(switchedInMemory);
    });
    expect(seenAtRecord).toEqual([true]);
  });

  it("a switch that did not complete never calls it", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE) });
    h.deps.relaunch = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const onSwitched = vi.fn(async (_n: string) => {});
    h.deps.onSwitched = onSwitched;
    await run(h);
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it("failover, then a container restart: the token it boots and the account onStart records are both the new one", async () => {
    // The DO's in-memory start config, as the DO would hold it: launched on account 1.
    const live = launchFields(ENV, STUDIO_ID, SPAWN, "CLAUDE_CODE_OAUTH_TOKEN");
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE), initial: status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }) });
    h.deps.onSwitched = async (name: string) => { Object.assign(live, launchFields(ENV, STUDIO_ID, SPAWN, name)); };
    await run(h);
    // Restart: the container starts from `live.envVars`; onStart records `live.envAccount`.
    await recordLaunchedAccount(h.storage, STUDIO_ID, live.envAccount, async () => {});
    expect(live.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_2);
    expect(live.envAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect((await h.storage.get(STATUS_KEY))?.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("with auto-failover OFF the token and the recorded account still agree (the mapped primary serves both)", () => {
    const off = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2 });
    const f = launchFields(off, STUDIO_ID, SPAWN, "CLAUDE_CODE_OAUTH_TOKEN_2");
    const tokenOf = { [TOKEN_1]: "CLAUDE_CODE_OAUTH_TOKEN", [TOKEN_2]: "CLAUDE_CODE_OAUTH_TOKEN_2" };
    expect(tokenOf[f.envVars.CLAUDE_CODE_OAUTH_TOKEN]).toBe(f.envAccount);
  });

  it("launchFields derives the token and the account from the SAME name", () => {
    const f = launchFields(ENV, STUDIO_ID, SPAWN, "CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(f.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_2);
    expect(f.envAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  // #357 review item 1: the REAL StudioDO.failoverDeps closure, not a
  // test-built stand-in — called on a fake `this` holding only what the
  // closure reads (env, ctx.storage, selfId, primaryAccount) and the two
  // fields it must set.
  it("StudioDO's own onSwitched sets BOTH the token it boots and the account it records to the new account", async () => {
    const mem = new Map<string, unknown>();
    const fakeThis = {
      env: ENV,
      ctx: { storage: { get: async (k: string) => mem.get(k), put: async (k: string, v: unknown) => { mem.set(k, v); } } },
      selfId: () => STUDIO_ID,
      primaryAccount: () => "CLAUDE_CODE_OAUTH_TOKEN",
      envVars: launchFields(ENV, STUDIO_ID, SPAWN, "CLAUDE_CODE_OAUTH_TOKEN").envVars,
      envAccount: "CLAUDE_CODE_OAUTH_TOKEN" as string | undefined,
    };
    const deps = (StudioDO.prototype as unknown as { failoverDeps(this: unknown): FailoverDeps }).failoverDeps.call(fakeThis);
    await deps.onSwitched!("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(fakeThis.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_2);
    expect(fakeThis.envAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });
});
