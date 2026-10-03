import { describe, it, expect, vi } from "vitest";
import {
  runAccountFailover, paneCaptureCmd, dismissModalCmd, DISMISS_VERDICT, exhaustedMessage,
  PANE_CAPTURE_MARKER, AUTO_CONTINUE_PROMPT, PARKED_AUTO_STOP_HOURS, type FailoverDeps,
} from "../src/studio/failover";
import { PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd } from "../src/studio/wake";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import {
  BRINGUP_TOKEN_WRITE_SECTION, SESSION_FOUND_SECTION, SESSION_CONTINUE_SECTION, SESSION_CWD_SECTION,
} from "../src/studio/observed";
import type { StudioStatus } from "../src/studio/types";
import type { ClaudeAccount } from "../src/studio/accounts";
import type { DestroyOutcome } from "../src/studio/destroy";
import { RULE_PROMPT } from "./fixtures/rate-limit-panes";

// ---------------------------------------------------------------------------
// Issue #210 — a parked studio never auto-resumes when an account frees, and
// never auto-stops after idle-billing a container for hours with nothing
// free at all. This is a NEW, THIRD recovery mechanism, additional to (never
// a replacement for):
//   1. evaluateDegradedRecovery/healDegradedRowAndWake (failover.ts) — pane-
//      visual only, fires an inline heal wake only once the pane ITSELF
//      already looks clear.
//   2. autoContinueAttempt/autoContinueDue (failover.ts) — a blind hourly
//      retry for select-modal rows, never checking account freedom.
//
// Same storage-level harness shape test/studio.account-failover.test.ts and
// test/studio.auto-continue.test.ts already use — a live StudioDO cannot be
// constructed under vitest-pool-workers (see src/studio/do.ts's header).
// ---------------------------------------------------------------------------

const STUDIO_ID = "fleetflare--release-studio";
const NOW = new Date("2026-10-03T12:00:00.000Z");
const TOKEN_1 = "sk-ant-oat01-" + "a".repeat(40);
const TOKEN_2 = "sk-ant-oat01-" + "b".repeat(40);
const TOKEN_3 = "sk-ant-oat01-" + "c".repeat(40);
const ONE_ACCOUNT: ClaudeAccount[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 }];
const TWO_ACCOUNTS: ClaudeAccount[] = [...ONE_ACCOUNT, { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 }];

/** A select-style modal ("You've hit your org's monthly spend limit") — never
 *  inline. Same frame every other runAccountFailover fixture in this repo
 *  already uses. */
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
 * An inline block with NO parseable reset at all ("out of usage credits",
 * INLINE_LIMIT_HEADLINES's own hint-less entry) — deliberately NOT the
 * "resets 1:30pm" shape every #109/#158 fixture already uses: a block WITH a
 * printed reset goes stale (detectRateLimitModal's own `inlineLimitBlock`
 * reclassifies it as `kind: "working"` the instant the clock passes it,
 * which is exactly mechanism 1's own job, not this feature's). A block with
 * no reset at all never does — it only ever clears via THIS feature's own
 * fleet-wide `accountIsFree` check (the null-until staleness ceiling) or an
 * actual pane change, which is the realistic #210 repro shape: the pane sits
 * frozen on an unreadable-reset block for hours, nothing retypes it.
 */
const NO_RESET_INLINE_PANE = [
  "⏺ Opening the PR for the pilot fix.",
  "",
  "  ⎿  You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
  "     /usage-credits to finish what you're working on.",
  "",
  ...RULE_PROMPT,
].join("\n");

/** claude back at its input box: no modal, no limit block anywhere. */
const RECOVERED_IDLE = ["⏺ Resumed.", "", ...RULE_PROMPT].join("\n");

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
    put: (async (key: string, value: unknown) => { map.set(key, value); }) as StudioStorage["put"],
  };
}

const captured = (first: string, second = first) => `${first}\n${PANE_CAPTURE_MARKER}\n${second}\n`;

interface Harness {
  deps: FailoverDeps;
  storage: StudioStorage;
  recorded: StudioStatus[];
  execs: string[];
  accountLimits: Map<string, { until: string | null; seenAt: string; dead?: true }>;
  run(): ReturnType<typeof runAccountFailover>;
  setPane(pane: string): void;
  setNow(now: Date): void;
  /** Spy proof of whether the ask-3 auto-stop capability fired this call. */
  stopParkedStudio: ReturnType<typeof vi.fn>;
}

/** Review round 1, finding 1: the real `destroyStudio` return shape, never a
 *  bare void — a refusal (or a throw) must be distinguishable from an actual
 *  stop. Default stand-in for every test that does not care about the
 *  distinction: a plain completed stop. */
const STOP_SUCCEEDED: DestroyOutcome = { ok: true, status: status({ state: "stopped" }) };

function harness(opts: {
  accounts: ClaudeAccount[];
  pane: string;
  initial?: StudioStatus;
  now?: Date;
  autoFailover?: boolean;
  accountLimits?: Record<string, string | null>;
  /** Default true: a test that covers #210's own "absent, no-op" contract
   *  (test 10) passes false to leave it unwired entirely. */
  wireStopParkedStudio?: boolean;
  /** Review round 1, finding 1: override the canned success result above —
   *  a refusal or a throw, to prove the outcome reports the real result. */
  stopParkedStudioImpl?: () => Promise<DestroyOutcome>;
  /** Review round 1, finding 2: a mapped primary + reserved set, the same
   *  shape test/studio.account-failover.test.ts's own borrow fixtures use —
   *  needed to build an active-borrow, current-before-anchor scenario. */
  primary?: string;
  primaryIsMapped?: boolean;
  reservedAccounts?: Set<string>;
}): Harness {
  const execs: string[] = [];
  const recorded: StudioStatus[] = [];
  const storage = fakeStorage(opts.initial ?? status());
  let pane = opts.pane;
  let now = opts.now ?? NOW;
  const accountLimits = new Map<string, { until: string | null; seenAt: string; dead?: true }>(
    Object.entries(opts.accountLimits ?? {}).map(([name, until]) => [name, { until, seenAt: NOW.toISOString() }]),
  );
  const stopParkedStudio = vi.fn(opts.stopParkedStudioImpl ?? (async () => STOP_SUCCEEDED));
  const deps: FailoverDeps = {
    accounts: opts.accounts,
    autoFailover: opts.autoFailover ?? true,
    ...(opts.primary !== undefined ? { primary: opts.primary } : {}),
    primaryIsMapped: opts.primaryIsMapped ?? false,
    ...(opts.reservedAccounts ? { reservedAccounts: opts.reservedAccounts } : {}),
    now: () => now,
    accountLimits: {
      read: async () => Object.fromEntries(accountLimits),
      write: async (name: string, until: string | null, seenAt: string, dead?: true) => {
        accountLimits.set(name, { until, seenAt, ...(dead ? { dead: true as const } : {}) });
      },
    },
    exec: vi.fn(async (cmd: string) => {
      execs.push(cmd);
      if (cmd === paneCaptureCmd()) return { code: 0, stdout: captured(pane), stderr: "" };
      if (cmd === dismissModalCmd()) return { code: 0, stdout: `${DISMISS_VERDICT} escaped\n`, stderr: "" };
      // runGatedWake's own gate 2 (pane_current_command) and gate 3 (screen):
      // answered so a wake attempt reaches a definite ok/skipped verdict
      // rather than the generic "no window" refusal.
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      if (cmd === PANE_SCREEN_CMD) return { code: 0, stdout: `${RECOVERED_IDLE}\n`, stderr: "" };
      // The post-switch combined token-write + pane-probe exec (issue #85).
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
    relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    notify: vi.fn(async () => {}),
    ...(opts.wireStopParkedStudio === false ? {} : { stopParkedStudio }),
  };
  return {
    deps, storage, recorded, execs, accountLimits, stopParkedStudio,
    run: () => runAccountFailover(deps, storage, STUDIO_ID, async (s) => { recorded.push(s); }),
    setPane: (p: string) => { pane = p; },
    setNow: (n: Date) => { now = n; },
  };
}

const HOUR_MS = 60 * 60_000;

describe("issue #210, ask 1 — parkedAt stamped only for a genuine, no-free-account park", () => {
  it("every account fleet-wide limited (parkedOn === null): parkedAt stamped at the clock this tick observed, exhaustionKind recorded", async () => {
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: MODAL_PANE,
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
      accountLimits: { CLAUDE_CODE_OAUTH_TOKEN: new Date(NOW.getTime() + HOUR_MS).toISOString() },
    });
    const out = await h.run();

    expect(out.kind).toBe("exhausted");
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.parkedAt).toBe(NOW.toISOString());
    expect(stored?.exhaustionKind).toBe("select");
  });

  it("'parked' (auto-failover off, a candidate exists) never gets a parkedAt stamp at all — the separate #271 operator-choice case", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: MODAL_PANE, autoFailover: false });
    const out = await h.run();

    expect(out).toEqual({ kind: "parked", account: "CLAUDE_CODE_OAUTH_TOKEN" });
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.parkedAt ?? null).toBeNull();
  });

  it("a repeat already-degraded tick never resets parkedAt to a later time", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: MODAL_PANE });
    await h.run();
    const firstStored = await h.storage.get(STATUS_KEY);
    expect(firstStored?.parkedAt).toBe(NOW.toISOString());

    h.setNow(new Date(NOW.getTime() + 30 * 60_000));
    await h.run();

    const secondStored = await h.storage.get(STATUS_KEY);
    expect(secondStored?.parkedAt).toBe(NOW.toISOString());
  });
});

describe("issue #210, ask 1 — parkedAt clears on a heal", () => {
  it("a pane-visual heal (verdict goes 'working', claude back at an idle prompt) clears parkedAt to null", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE });
    await h.run();
    expect((await h.storage.get(STATUS_KEY))?.parkedAt).toBe(NOW.toISOString());

    h.setPane(RECOVERED_IDLE);
    h.setNow(new Date(NOW.getTime() + HOUR_MS));
    const out = await h.run();

    expect(out.kind).toBe("recovered");
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.state).toBe("running");
    expect(stored?.parkedAt ?? null).toBeNull();
  });

  it("an ordinary account switch landing (e.g. a third account secret added) clears parkedAt to null", async () => {
    const allLimited = { CLAUDE_CODE_OAUTH_TOKEN: new Date(NOW.getTime() + HOUR_MS).toISOString() };
    const h = harness({
      accounts: TWO_ACCOUNTS, pane: MODAL_PANE,
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
      accountLimits: allLimited,
    });
    await h.run();
    expect((await h.storage.get(STATUS_KEY))?.parkedAt).toBe(NOW.toISOString());

    h.deps.accounts = [...TWO_ACCOUNTS, { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 }];
    const out = await h.run();

    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN_2", to: "CLAUDE_CODE_OAUTH_TOKEN_3" });
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.state).toBe("running");
    expect(stored?.parkedAt ?? null).toBeNull();
  });
});

describe("issue #210, ask 2 — a periodic tick wakes the row the moment ANY account reads free, with no blind timer of its own", () => {
  // Review round 2 (#210), finding 3 — the original form of this test (and
  // its select-modal sibling just below) jumped the clock 25h to cross the
  // 24h null-until grace, which (after finding 3's own fix) ALSO crosses
  // PARKED_AUTO_STOP_HOURS (6h) — and the auto-stop now fires FIRST,
  // unconditionally of what the free-account check reads, so the row would
  // be stopped before this wake is ever reached. Backdating the account's
  // own fleet-wide sighting (rather than the clock) keeps `parkedAt`'s own
  // elapsed time safely under 6h while still genuinely crossing the
  // null-until grace — the same real-world shape as "some OTHER studio
  // already recorded this account limited hours before THIS studio parked".
  it("an inline-exhausted row with an unreadable reset: once its OWN account's null-until grace passes, fires a gated wake with AUTO_CONTINUE_PROMPT, with no dismiss-modal attempt (nothing to Esc)", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE });
    const first = await h.run();
    expect(first.kind).toBe("exhausted");

    // Backdate the account's own null-until sighting by 23h — its grace
    // (24h) is now already almost spent, well ahead of `parkedAt`'s own
    // clock (which stays at NOW).
    h.accountLimits.set(ONE_ACCOUNT[0].name, { until: null, seenAt: new Date(NOW.getTime() - 23 * HOUR_MS).toISOString() });
    // 2h later: the SAME pane, never retyped (the realistic #210 shape) —
    // the backdated sighting has now crossed NULL_UNTIL_CEILING_MS (24h),
    // so accountIsFree reads it free again, while `parkedAt` itself is
    // only 2h old — well under PARKED_AUTO_STOP_HOURS.
    h.setNow(new Date(NOW.getTime() + 2 * HOUR_MS));
    const second = await h.run();

    expect(second).toEqual({ kind: "free-account-wake", wake: "ok" });
    expect(h.execs.filter((c) => c === dismissModalCmd())).toEqual([]);
    expect(h.execs.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toHaveLength(1);
    // The wake never itself heals the row — that stays mechanism 1's own
    // job, once the pane visually confirms it.
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.state).toBe("degraded");
    expect(stored?.parkedAt).toBe(NOW.toISOString());
  });

  it("a select-exhausted row: once its own account reads free, fires exactly ONE wake — never a second, double-firing #109's own independent hourly retry on the SAME tick", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: MODAL_PANE });
    const first = await h.run();
    // #109's own immediate first attempt already fires as a side effect of
    // THIS tick's fresh-degrade write (unrelated to this feature) — the
    // outcome itself stays "exhausted" either way (runAccountFailover's own
    // fresh-degrade branch reports the degrade, never the attempt).
    expect(first.kind).toBe("exhausted");
    expect(h.execs.filter((c) => c === dismissModalCmd())).toHaveLength(1);

    // Backdate the account's own null-until sighting (see the inline test
    // just above for why the CLOCK, not the sighting, must stay under 6h).
    h.accountLimits.set(ONE_ACCOUNT[0].name, { until: null, seenAt: new Date(NOW.getTime() - 23 * HOUR_MS).toISOString() });
    const beforeTick2 = h.execs.length;
    // 2h later: #109's own hourly retry (AUTO_CONTINUE_RETRY_MS) is ALSO
    // independently due by now — proving this is a genuine composition
    // guard, not just "the other mechanism never got a chance".
    h.setNow(new Date(NOW.getTime() + 2 * HOUR_MS));
    const second = await h.run();

    expect(second).toEqual({ kind: "free-account-wake", wake: "ok" });
    const execsThisTick = h.execs.slice(beforeTick2);
    expect(execsThisTick.filter((c) => c === dismissModalCmd())).toHaveLength(1);
    expect(execsThisTick.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toHaveLength(1);
  });

  it("nothing free at all (own account, spare, borrow all miss): neither ask-2 check fires, the row stays exactly as today", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE });
    await h.run();
    const beforeTick2 = h.execs.length;

    // Only 1h later — well under the 24h null-until grace, so the account
    // genuinely still reads limited.
    h.setNow(new Date(NOW.getTime() + HOUR_MS));
    const second = await h.run();

    expect(second.kind).toBe("already-degraded");
    const execsThisTick = h.execs.slice(beforeTick2);
    expect(execsThisTick.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toEqual([]);
    expect(h.stopParkedStudio).not.toHaveBeenCalled();
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.parkedAt).toBe(NOW.toISOString());
  });

  it("deps.accountLimits not wired at all (a caller/test that predates #102): the whole check no-ops, never reading accountIsFree's bare 'not tracked' default as 'free'", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE });
    await h.run();
    // Simulate a caller that never wires fleet-wide limit tracking at all —
    // `accountIsFree`'s own "account absent from the map" default reads as
    // free UNCONDITIONALLY, which is correct for a plain wrap scanning
    // OTHER accounts nobody has ever recorded anything about, but would be
    // nonsense read as "this row's own account is free" with zero real
    // evidence behind it.
    h.deps.accountLimits = undefined;

    h.setNow(new Date(NOW.getTime() + 25 * HOUR_MS));
    const second = await h.run();

    expect(second.kind).toBe("already-degraded");
    expect(h.execs.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toEqual([]);
    expect(h.stopParkedStudio).not.toHaveBeenCalled();
  });

  it("exhaustionKind 'dead' never gets the free-account wake, even once well past any staleness grace", async () => {
    const ORG_DISABLED_PANE = [
      "● Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask",
      "  your admin to enable access",
      "", ...RULE_PROMPT,
    ].join("\n");
    const h = harness({ accounts: ONE_ACCOUNT, pane: ORG_DISABLED_PANE });
    const first = await h.run();
    expect(first.kind).toBe("exhausted");
    expect((await h.storage.get(STATUS_KEY))?.exhaustionKind).toBe("dead");

    const beforeTick2 = h.execs.length;
    h.setNow(new Date(NOW.getTime() + 25 * HOUR_MS));
    const second = await h.run();

    expect(second.kind).toBe("already-degraded");
    const execsThisTick = h.execs.slice(beforeTick2);
    expect(execsThisTick.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toEqual([]);
  });
});

describe("issue #210, ask 3 — a studio parked past PARKED_AUTO_STOP_HOURS with nothing free at all gets rescued-then-stopped", () => {
  it(`confirms PARKED_AUTO_STOP_HOURS is 6 (the repro idled ~7h; this bounds the worst case well below that)`, () => {
    expect(PARKED_AUTO_STOP_HOURS).toBe(6);
  });

  it("parked > 6h ago, still nothing free: deps.stopParkedStudio is called, outcome names the park", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE });
    await h.run();
    const parkedAt = (await h.storage.get(STATUS_KEY))?.parkedAt as string;

    h.setNow(new Date(NOW.getTime() + (PARKED_AUTO_STOP_HOURS * HOUR_MS) + 60_000));
    const out = await h.run();

    expect(out).toEqual({ kind: "auto-stopped", parkedAt });
    expect(h.stopParkedStudio).toHaveBeenCalledTimes(1);
  });

  it("parked < 6h ago, still nothing free: deps.stopParkedStudio is NOT called", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE });
    await h.run();

    h.setNow(new Date(NOW.getTime() + 5 * HOUR_MS));
    const out = await h.run();

    expect(out.kind).toBe("already-degraded");
    expect(h.stopParkedStudio).not.toHaveBeenCalled();
  });

  it("exhaustionKind 'dead', parked well past 6h: never auto-stopped — stays permanently manual, same #141 convention autoContinueEligible already excludes it from", async () => {
    const ORG_DISABLED_PANE = [
      "● Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask",
      "  your admin to enable access",
      "", ...RULE_PROMPT,
    ].join("\n");
    const h = harness({ accounts: ONE_ACCOUNT, pane: ORG_DISABLED_PANE });
    await h.run();

    h.setNow(new Date(NOW.getTime() + (PARKED_AUTO_STOP_HOURS * HOUR_MS) + 60_000));
    const out = await h.run();

    expect(out.kind).toBe("already-degraded");
    expect(h.stopParkedStudio).not.toHaveBeenCalled();
  });

  it("deps.stopParkedStudio absent (an older caller/test that never wired it): the whole ask-3 check no-ops cleanly, no throw", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE, wireStopParkedStudio: false });
    await h.run();
    expect(h.deps.stopParkedStudio).toBeUndefined();

    h.setNow(new Date(NOW.getTime() + (PARKED_AUTO_STOP_HOURS * HOUR_MS) + 60_000));
    await expect(h.run()).resolves.toMatchObject({ kind: "auto-stopped" });
  });
});

// ---------------------------------------------------------------------------
// Review round 2 (#210), finding 2 (BLOCKER) — a stale `parkedAt` surviving
// a stop -> resume cycle caused an immediate re-stop (~5 min later). This
// pins the LOAD-BEARING half of the fix, at failover.ts's own degrade-write:
// `existing.parkedAt ?? now` used to carry the stale value forward
// regardless of what `existing.state` was, so a row that genuinely passed
// through "running" since the old `parkedAt` was stamped (a resume) still
// re-read as "parked since <hours-old time>" the instant the SAME
// exhaustion re-appeared. The fix only ever preserves the old value for a
// GENUINE same-episode repeat (`existing.state === "degraded"`); any other
// previous state (a resume landed) restarts the clock from `now`.
// test/studio.provision.test.ts and test/studio.destroy.test.ts pin the
// complementary "defense in depth" half — provision/restart/destroy must
// never carry a stale `parkedAt` onto a fresh row in the first place.
// ---------------------------------------------------------------------------
describe("review round 2 (#210), finding 2 — a stale parkedAt must not survive a stop/resume cycle", () => {
  it("resumed (state running again), parkedAt left stale by an earlier park: the next exhaustion stamps a FRESH parkedAt, and the auto-stop does not immediately refire", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: MODAL_PANE });
    const first = await h.run();
    expect(first.kind).toBe("exhausted");
    const firstParkedAt = (await h.storage.get(STATUS_KEY))?.parkedAt as string;
    expect(firstParkedAt).toBe(NOW.toISOString());

    // Simulate a stop -> resume cycle that (the bug) left the stale
    // parkedAt on the row: state flips back to "running" (what a genuine
    // resume always does), but parkedAt is untouched — exactly the shape
    // destroy.ts's/provision.ts's own pre-fix carry-forward produced.
    const resumedAt = new Date(NOW.getTime() + 7 * HOUR_MS);
    const beforeResume = (await h.storage.get(STATUS_KEY))!;
    await h.storage.put(STATUS_KEY, {
      ...beforeResume, state: "running", error: null, parkedAt: firstParkedAt,
    });
    h.setNow(resumedAt);

    // The SAME exhaustion verdict re-appears immediately after the resume
    // (the realistic #210 shape: still nothing free) — a fresh degrade,
    // since `existing.state` was just "running", not "degraded".
    const second = await h.run();
    expect(second.kind).toBe("exhausted");
    const stored = await h.storage.get(STATUS_KEY);
    // The NEW episode's own clock, never the 7h-stale one.
    expect(stored?.parkedAt).toBe(resumedAt.toISOString());

    // And critically: the auto-stop must not fire on the very next tick —
    // the (now-correct) clock reads "only just started", not "6h+ old".
    // (#109's own immediate auto-continue attempt already fired as a side
    // effect of tick 2's own fresh-degrade write, so this tick's own outcome
    // is its hourly-cap "not yet due" — the load-bearing assertion here is
    // that `stopParkedStudio` was never even invoked.)
    h.setNow(new Date(resumedAt.getTime() + 60_000));
    const third = await h.run();
    expect(third.kind).not.toBe("auto-stopped");
    expect(third.kind).not.toBe("park-refused");
    expect(h.stopParkedStudio).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fresh-context review round 1, finding 1 — `deps.stopParkedStudio` used to
// be typed `Promise<void>`, so a REFUSAL (the realistic case: a studio sat
// parked mid-task almost always has an open assigned board task, and
// destroy.ts's own `runDestroy` fails CLOSED on that — see its own doc
// comment) was indistinguishable from an actual stop. `runAccountFailover`
// reported `"auto-stopped"` unconditionally regardless of what actually
// happened, so an operator reading the outcome could never tell the
// container was still up and still billing. `stopParkedStudio` now returns
// the real `DestroyOutcome`, and this file's own call site reports a
// DIFFERENT kind — `"park-refused"` — whenever it was not a genuine stop.
// ---------------------------------------------------------------------------
describe("review round 1, finding 1 — stopParkedStudio's real outcome, never a silent \"auto-stopped\" lie", () => {
  it("a refusal (e.g. an open assigned board task) reports park-refused, never auto-stopped", async () => {
    const REFUSAL: DestroyOutcome = {
      ok: false, refused: true,
      reason: "studio fleetflare--release-studio has an open assigned board task; pass --force to destroy anyway",
    };
    const h = harness({
      accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE, stopParkedStudioImpl: async () => REFUSAL,
    });
    await h.run();
    const parkedAt = (await h.storage.get(STATUS_KEY))?.parkedAt as string;

    h.setNow(new Date(NOW.getTime() + (PARKED_AUTO_STOP_HOURS * HOUR_MS) + 60_000));
    const out = await h.run();

    expect(h.stopParkedStudio).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ kind: "park-refused", parkedAt, reason: REFUSAL.reason });
  });

  it("stopParkedStudio throwing (an unexpected RPC/destroy failure, not a tagged refusal) ALSO reports park-refused, never auto-stopped — fail safe, not fail open", async () => {
    const h = harness({
      accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE,
      stopParkedStudioImpl: async () => { throw new Error("destroy failed: container kill failed: no such container"); },
    });
    await h.run();
    const parkedAt = (await h.storage.get(STATUS_KEY))?.parkedAt as string;

    h.setNow(new Date(NOW.getTime() + (PARKED_AUTO_STOP_HOURS * HOUR_MS) + 60_000));
    const out = await h.run();

    expect(out).toEqual({
      kind: "park-refused", parkedAt,
      reason: "destroy failed: container kill failed: no such container",
    });
  });

  it("a genuine stop (ok: true) reports auto-stopped exactly as before", async () => {
    const h = harness({
      accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE,
      stopParkedStudioImpl: async () => ({ ok: true, status: status({ state: "stopped" }) }),
    });
    await h.run();
    const parkedAt = (await h.storage.get(STATUS_KEY))?.parkedAt as string;

    h.setNow(new Date(NOW.getTime() + (PARKED_AUTO_STOP_HOURS * HOUR_MS) + 60_000));
    const out = await h.run();

    expect(out).toEqual({ kind: "auto-stopped", parkedAt });
  });
});

// ---------------------------------------------------------------------------
// Review round 2 (#210), finding 3 SUPERSEDES this test's own original
// expectation. Round 1, finding 2 fixed `anyAccountFreeToResume`'s tier-1
// check to branch on `currentOutOfScope` like the real `candidate`
// selection, and asserted that fix by having a DIFFERENT, non-current tier
// (OTHER, a plain scoped-chain account) free up while the studio's own
// CURRENT account (CUR, actively borrowed) stayed limited — and treated the
// resulting wake as correct.
//
// It was not: round 2's finding 3 is the literal #210 bug shape,
// reintroduced by this feature's own first draft. A blind wake is just
// "dismiss + continue on the account the pane is CURRENTLY sitting on" — it
// can only ever help if the CURRENT account itself is the one that freed. A
// free OTHER tier, with auto-failover OFF (this fixture's own setup), moves
// nothing by design (#271) — firing a wake at a pane still sitting on a
// limited CUR account accomplishes nothing, Esc+prompt-spam forever. The fix
// (below, and in failover.ts) narrows the wake trigger to ONLY
// `accountIsFree(currentAccount, ...)` — this fixture's own CUR never frees,
// so this tick must NOT wake at all.
// ---------------------------------------------------------------------------
describe("review round 2 (#210), finding 3 — the free-account wake must fire ONLY when the studio's own CURRENT account frees, never a different tier", () => {
  it("auto-failover off, active borrow, current account (CUR) stays limited for hours while a DIFFERENT scoped account (OTHER) frees up: no wake fires", async () => {
    const CUR: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 };
    const PRIMARY: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 };
    const OTHER: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 };
    const FAR_UNTIL = new Date(NOW.getTime() + 5 * HOUR_MS).toISOString();
    const SOON_UNTIL = new Date(NOW.getTime() + HOUR_MS).toISOString();
    const h = harness({
      accounts: [CUR, PRIMARY, OTHER], pane: MODAL_PANE, autoFailover: false,
      primary: PRIMARY.name, primaryIsMapped: true,
      initial: status({
        claudeAccount: CUR.name, launchedAccount: CUR.name, borrowedAccount: CUR.name, borrowedFromRepo: null,
      }),
      // PRIMARY stays limited for hours; OTHER (inside scopedAccounts, i.e.
      // accounts.slice(anchor) = [PRIMARY, OTHER]) is limited only an hour
      // out. CUR — the studio's own current account — is left UNSET here on
      // purpose: tick 1's own observation stamps it (a null-until "unknown
      // reset" sighting, MODAL_PANE prints none), and that sighting is what
      // actually keeps CUR limited for the rest of this test (its 24h
      // null-until grace, accounts.ts's NULL_UNTIL_CEILING_MS) — never a
      // `--discard-unsynced`-shaped literal date this test would have to
      // keep in sync with the observation logic by hand.
      accountLimits: { [PRIMARY.name]: FAR_UNTIL, [OTHER.name]: SOON_UNTIL },
    });
    // Tick 1: nothing free anywhere -> genuine exhaustion, parkedAt stamped.
    const first = await h.run();
    expect(first.kind).toBe("exhausted");

    // Tick 2, just past SOON_UNTIL: OTHER is now free, so the REAL `candidate`
    // (correctly currentOutOfScope-aware) finds it -> parkedOn flips non-null
    // -> this tick's own message is the DIFFERENT "#271 parked" shape, so the
    // anti-loop guard does not match yet and this is a one-time re-card, not
    // the branch under test.
    h.setNow(new Date(NOW.getTime() + HOUR_MS + 60_000));
    const second = await h.run();
    expect(second.kind).toBe("parked");

    // Tick 3, same conditions held: the SAME "#271 parked" message now
    // matches tick 2's own stored error, so the anti-loop guard DOES match
    // and this tick reaches the free-account-wake check under test — but
    // CUR (the studio's own current account) is STILL limited (its own
    // null-until sighting is well under the 24h grace), so the wake must
    // not fire: OTHER freeing is irrelevant to this row's own wake decision.
    h.setNow(new Date(NOW.getTime() + HOUR_MS + 2 * 60_000));
    const beforeTick3 = h.execs.length;
    const third = await h.run();

    expect(third.kind).toBe("already-degraded");
    const execsThisTick = h.execs.slice(beforeTick3);
    expect(execsThisTick.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toEqual([]);
    expect(h.stopParkedStudio).not.toHaveBeenCalled();
  });

  // Review round 2 (#210), finding 3 — backdates the account's own
  // null-until sighting (never the clock) so the grace crosses WELL under
  // PARKED_AUTO_STOP_HOURS (6h) — see the inline test above's own doc
  // comment for why a 25h clock jump is no longer usable here.
  it("the studio's own CURRENT account is the one that frees: the wake fires, even while the OTHER account stays limited for a very long time", async () => {
    const CUR: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 };
    const SECOND: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 };
    // Far enough out that it stays limited throughout this test.
    const VERY_FAR_UNTIL = new Date(NOW.getTime() + 100 * HOUR_MS).toISOString();
    const h = harness({
      accounts: [CUR, SECOND], pane: MODAL_PANE, autoFailover: false,
      initial: status({ claudeAccount: CUR.name, launchedAccount: CUR.name }),
      accountLimits: { [SECOND.name]: VERY_FAR_UNTIL },
    });
    const first = await h.run();
    expect(first.kind).toBe("exhausted");

    // Backdate CUR's own null-until sighting by 23h, so its 24h grace is
    // already almost spent while `parkedAt` itself stays at NOW.
    h.accountLimits.set(CUR.name, { until: null, seenAt: new Date(NOW.getTime() - 23 * HOUR_MS).toISOString() });
    // 2h later: CUR's own backdated sighting has crossed the 24h grace and
    // reads free again; SECOND stays limited throughout, so `candidate`
    // still finds nowhere to go and `parkedOn` stays null — the SAME
    // exhausted message, landing in the anti-loop guard, the
    // free-account-wake branch under test. `parkedAt` itself is only 2h
    // old — well under PARKED_AUTO_STOP_HOURS.
    h.setNow(new Date(NOW.getTime() + 2 * HOUR_MS));
    const second = await h.run();

    expect(second).toEqual({ kind: "free-account-wake", wake: "ok" });
  });

  // Finding 3, part 2 — the anti-hammer bound: a wake that fires but does
  // not actually resolve anything (the row is still degraded next tick,
  // same reason as any transient pane-probe hiccup) must not refire on
  // every single 300s tick forever just because the current account still
  // reads free. Mirrors #109's own `autoContinueAt`/`autoContinueLastTriedAt`
  // hourly cadence (`AUTO_CONTINUE_RETRY_MS`), rather than a blind timer.
  it("a wake that fired but did not resolve anything does not refire on the very next tick, even though the current account still reads free", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE });
    const first = await h.run();
    expect(first.kind).toBe("exhausted");

    h.accountLimits.set(ONE_ACCOUNT[0].name, { until: null, seenAt: new Date(NOW.getTime() - 23 * HOUR_MS).toISOString() });
    h.setNow(new Date(NOW.getTime() + 2 * HOUR_MS));
    const second = await h.run();
    expect(second).toEqual({ kind: "free-account-wake", wake: "ok" });

    // The wake did not heal the row (the pane is byte-identical, never
    // retyped — the realistic #210 shape); 1 minute later, the account
    // STILL reads free (its own null-until grace has long since passed),
    // yet the wake must not fire again — the retry window has not elapsed.
    const beforeTick3 = h.execs.length;
    h.setNow(new Date(NOW.getTime() + 2 * HOUR_MS + 60_000));
    const third = await h.run();

    expect(third.kind).not.toBe("free-account-wake");
    const execsThisTick = h.execs.slice(beforeTick3);
    expect(execsThisTick.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toEqual([]);
  });

  // Finding 3, part 3 — the auto-stop's own triggering condition no longer
  // depends on correctly re-deriving "is anything free" at all: elapsed
  // time past PARKED_AUTO_STOP_HOURS, still degraded, not dead, is on its
  // own sufficient. Proven here by the EXACT scenario the old "nothing free
  // anywhere" condition would have refused to stop: the current account
  // itself reads free (its own 24h null-until grace has passed) on the
  // very same tick that crosses the 6h parked threshold — yet the stop
  // still fires, because elapsed time alone decides it now.
  it("the auto-stop fires purely on elapsed time past 6h, even on a tick where the free-account check would itself read the current account as free", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE });
    await h.run();

    // 25h later: past PARKED_AUTO_STOP_HOURS (6h) AND past the 24h
    // null-until grace (so accountIsFree(currentAccount, ...) would itself
    // read true this same tick) — the auto-stop must fire anyway.
    h.setNow(new Date(NOW.getTime() + 25 * HOUR_MS));
    const out = await h.run();

    expect(out.kind).toBe("auto-stopped");
    expect(h.stopParkedStudio).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Review round 2 (#210), finding 5 Part A (Major) — a refused auto-stop
// needs its own backoff + a single notify: the row must carry the refusal
// reason BEFORE this function returns it, the operator must be told exactly
// ONCE for an ongoing, unchanged refusal (never every single 300s tick), and
// a bounded retry cadence (mirrors AUTO_CONTINUE_RETRY_MS) must stop this
// from hammering `deps.stopParkedStudio` itself every tick forever.
// ---------------------------------------------------------------------------
describe("review round 2 (#210), finding 5 Part A — a refused auto-stop backs off and notifies exactly once", () => {
  const REFUSAL_REASON = "studio fleetflare--release-studio has an open assigned board task; pass --force to destroy anyway";
  // `deps.notify` already fires once on tick 1's own fresh-degrade write
  // (unrelated to this feature) — every assertion below counts calls made
  // AFTER that point, never the running total.
  const notifyCalls = (h: Harness) => (h.deps.notify as ReturnType<typeof vi.fn>).mock.calls.length;

  it("writes the refusal reason onto the row before returning, and notifies the operator exactly once for an unchanged, ongoing refusal", async () => {
    const h = harness({
      accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE,
      stopParkedStudioImpl: async () => ({ ok: false, refused: true, reason: REFUSAL_REASON }),
    });
    await h.run();
    const beforeFirstRefusal = notifyCalls(h);

    h.setNow(new Date(NOW.getTime() + PARKED_AUTO_STOP_HOURS * HOUR_MS + 60_000));
    const first = await h.run();

    expect(first).toEqual({ kind: "park-refused", parkedAt: NOW.toISOString(), reason: REFUSAL_REASON });
    expect(h.stopParkedStudio).toHaveBeenCalledTimes(1);
    expect(notifyCalls(h)).toBe(beforeFirstRefusal + 1);
    const lastNotifyArg = (h.deps.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(lastNotifyArg).toContain(REFUSAL_REASON);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.parkRefusalReason).toBe(REFUSAL_REASON);
    expect(stored?.parkRefusedAt).toBe(new Date(NOW.getTime() + PARKED_AUTO_STOP_HOURS * HOUR_MS + 60_000).toISOString());

    // A minute later, same ongoing refusal: neither the destroy attempt nor
    // the notify repeats — bounded backoff, not a blind every-tick retry.
    const beforeSecondTick = notifyCalls(h);
    h.setNow(new Date(NOW.getTime() + PARKED_AUTO_STOP_HOURS * HOUR_MS + 2 * 60_000));
    const second = await h.run();

    expect(second).toEqual({ kind: "park-refused", parkedAt: NOW.toISOString(), reason: REFUSAL_REASON });
    expect(h.stopParkedStudio).toHaveBeenCalledTimes(1);
    expect(notifyCalls(h)).toBe(beforeSecondTick);
  });

  it("retries the stop attempt once the backoff cadence has elapsed", async () => {
    const h = harness({
      accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE,
      stopParkedStudioImpl: async () => ({ ok: false, refused: true, reason: REFUSAL_REASON }),
    });
    await h.run();

    h.setNow(new Date(NOW.getTime() + PARKED_AUTO_STOP_HOURS * HOUR_MS + 60_000));
    await h.run();
    expect(h.stopParkedStudio).toHaveBeenCalledTimes(1);
    const beforeRetryTick = notifyCalls(h);

    // Past the retry cadence (AUTO_CONTINUE_RETRY_MS, 1h) since the first
    // refusal attempt: the stop is retried.
    h.setNow(new Date(NOW.getTime() + PARKED_AUTO_STOP_HOURS * HOUR_MS + HOUR_MS + 2 * 60_000));
    const third = await h.run();

    expect(third).toEqual({
      kind: "park-refused", parkedAt: NOW.toISOString(), reason: REFUSAL_REASON,
    });
    expect(h.stopParkedStudio).toHaveBeenCalledTimes(2);
    // Same, unchanged reason: no additional notify this tick.
    expect(notifyCalls(h)).toBe(beforeRetryTick);
  });

  it("a CHANGED refusal reason (the board task situation shifted) notifies again", async () => {
    let call = 0;
    const SECOND_REASON = "studio fleetflare--release-studio: could not confirm no open assigned board task (board API error: 503); pass --force to destroy anyway";
    const h = harness({
      accounts: ONE_ACCOUNT, pane: NO_RESET_INLINE_PANE,
      stopParkedStudioImpl: async () => {
        call += 1;
        return { ok: false, refused: true, reason: call === 1 ? REFUSAL_REASON : SECOND_REASON };
      },
    });
    await h.run();

    h.setNow(new Date(NOW.getTime() + PARKED_AUTO_STOP_HOURS * HOUR_MS + 60_000));
    await h.run();
    const beforeSecondRefusal = notifyCalls(h);

    h.setNow(new Date(NOW.getTime() + PARKED_AUTO_STOP_HOURS * HOUR_MS + HOUR_MS + 2 * 60_000));
    const second = await h.run();

    expect(second).toEqual({ kind: "park-refused", parkedAt: NOW.toISOString(), reason: SECOND_REASON });
    expect(notifyCalls(h)).toBe(beforeSecondRefusal + 1);
  });
});

describe("exhaustedMessage sanity (shared fixture reuse, no behavior change)", () => {
  it("names the one account tried", () => {
    expect(exhaustedMessage(STUDIO_ID, ["CLAUDE_CODE_OAUTH_TOKEN"])).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
