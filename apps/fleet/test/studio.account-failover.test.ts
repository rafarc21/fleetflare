import { describe, it, expect, vi } from "vitest";
import {
  resolveClaudeAccounts, nextClaudeAccount, claudeAccountToken, accountsTried, earliestAccountReset,
  MAX_CLAUDE_ACCOUNTS, claudeAccountVarName, otherRepoPrimaries, nextBorrowedAccount, repoForAccount,
  accountIsFree, firstFreeAccount, selectFreeAccount, selectByHeadroom, USAGE_ORDERING_FRESHNESS_MS,
  type ClaudeAccount, type AccountUsageMap,
} from "../src/studio/accounts";
import {
  detectRateLimitModal, paneCaptureCmd, accountSwitchCmd, runAccountFailover, FLEET_TOKEN_ENV,
  exhaustedMessage, RATE_LIMIT_HEADLINES, RATE_LIMIT_MODAL_MARKERS, FLAP_GUARD_MINUTES,
  PANE_CAPTURE_MARKER, MODAL_TAIL_LINES, deadAccountScrollbackCmd, type FailoverDeps,
} from "../src/studio/failover";
import { STATUS_KEY, OPERATION_KEY, OPERATION_STALE_MS, type StudioStorage } from "../src/studio/provision";
import { syncSessionCycle, launchFields, recordLaunchedAccount, StudioDO } from "../src/studio/do";
import type { SessionSyncDeps } from "../src/studio/session-sync";
import type { StudioStatus } from "../src/studio/types";
import type { DestroyOutcome } from "../src/studio/destroy";
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
import {
  SESSION_LIMIT_LOGIN_HINT_PANE as INLINE_LIMIT_PANE, WEEKLY_LIMIT_PANE, ORG_DISABLED_PANE, ORG_SPEND_CAP_TAIL_PANE,
} from "./fixtures/rate-limit-panes";

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

  // -------------------------------------------------------------------
  // Issue #141 — a `dead` account (org disabled subscription access) must
  // NEVER become eligible again, unlike a plain null-until entry, which the
  // review-round-1 fix just above deliberately DOES let clear after 24h. This
  // is the core regression this feature must never allow.
  // -------------------------------------------------------------------
  it("issue #141: a dead account stays excluded PAST the 24h null-until ceiling — no auto-expiry", () => {
    const now = new Date("2026-09-23T14:00:00.000Z");
    const seenAt = new Date(now.getTime() - 25 * 60 * 60_000).toISOString(); // 25h ago
    const limits = { CLAUDE_CODE_OAUTH_TOKEN: { until: null, seenAt, dead: true as const } };
    expect(accountIsFree(accounts[0], limits, now)).toBe(false);
  });

  it("issue #141: nextClaudeAccount finds nowhere to go when the only other account is dead", () => {
    const now = new Date("2026-09-23T14:00:00.000Z");
    const limits = {
      CLAUDE_CODE_OAUTH_TOKEN_2: { until: null, seenAt: now.toISOString(), dead: true as const },
    };
    expect(nextClaudeAccount(accounts, "CLAUDE_CODE_OAUTH_TOKEN", limits, now)).toBeNull();
  });

  // -------------------------------------------------------------------
  // Issue #103 — `reserved` unconditionally excludes a candidate, the same
  // way a live fleet-wide limit does, regardless of `isFree`. This is what
  // lets failover.ts keep a studio off an account that is ANOTHER repo's own
  // mapped primary (see otherRepoPrimaries below), even when that account has
  // never been seen limited at all.
  // -------------------------------------------------------------------
  it("issue #103: `reserved` skips a candidate even though it carries no fleet-wide limit at all", () => {
    const four: ClaudeAccount[] = [
      { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_4", token: "sk-ant-oat01-" + "d".repeat(40) },
    ];
    const now = new Date("2026-09-23T14:00:00.000Z");
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_3"]);
    // On CLAUDE_CODE_OAUTH_TOKEN_2 (free, no limits at all): forward wrap
    // would land on account 3 first — but it is RESERVED for another repo's
    // own mapped primary, so it must be skipped in favour of account 4.
    expect(nextClaudeAccount(four, "CLAUDE_CODE_OAUTH_TOKEN_2", {}, now, reserved)).toEqual(four[3]);
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

// ---------------------------------------------------------------------------
// Issue #238 (step 3) — wiring the now-persisted fleet-wide `account-usage:
// <slot>` rows into the live tier-1/tier-2 failover cascade: a free candidate
// with a FRESH usage row (<10 min) wins over plain list/wrap order when it
// has the most headroom (lowest usageMaxPct); stale/missing data falls back
// to today's unchanged order.
// ---------------------------------------------------------------------------
describe("selectByHeadroom (issue #238 step 3)", () => {
  const A: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 };
  const B: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 };
  const NOW_H = new Date("2026-10-05T12:00:00.000Z");

  function snapshot(fiveHourPct: number, sevenDayPct: number, scopedMaxPct: number | null, ageMs: number): AccountUsageMap[string] {
    return { fiveHourPct, sevenDayPct, scopedMaxPct, seenAt: new Date(NOW_H.getTime() - ageMs).toISOString() };
  }

  it("fresh usage wins: the candidate with the lower maxPct is picked over list order", () => {
    const usage: AccountUsageMap = {
      [A.name]: snapshot(80, 10, null, 60_000),
      [B.name]: snapshot(20, 10, null, 60_000),
    };
    // Plain list order would pick A first; headroom ordering must prefer B
    // (maxPct 20 < A's 80).
    expect(selectByHeadroom([A, B], usage, NOW_H)?.name).toBe(B.name);
  });

  it("a row pushed just past the 10-minute freshness ceiling loses, falling back to null (today's order)", () => {
    const usage: AccountUsageMap = {
      [A.name]: snapshot(80, 10, null, 60_000),
      [B.name]: snapshot(20, 10, null, USAGE_ORDERING_FRESHNESS_MS), // exactly at the ceiling: >= is stale
    };
    // B's own low-pct row is now stale and must never be trusted — A's own
    // fresh (if worse) row is the only one left, so A wins.
    expect(selectByHeadroom([A, B], usage, NOW_H)?.name).toBe(A.name);
  });

  it("a scoped window with a HIGHER pct than fiveHour/sevenDay makes that candidate lose, proving usageMaxPct's scoped-fold is wired end to end", () => {
    const usage: AccountUsageMap = {
      // A's plain fiveHour/sevenDay numbers are both LOWER than B's, but A
      // carries a scoped-model window at 99% — its real usageMaxPct (99) is
      // worse than B's (40), so B must win.
      [A.name]: snapshot(10, 10, 99, 60_000),
      [B.name]: snapshot(40, 40, null, 60_000),
    };
    expect(selectByHeadroom([A, B], usage, NOW_H)?.name).toBe(B.name);
  });

  it("a tie in maxPct resolves to the candidates' own (current/list) order, never a coin-flip", () => {
    const usage: AccountUsageMap = {
      [A.name]: snapshot(50, 50, null, 60_000),
      [B.name]: snapshot(50, 50, null, 60_000),
    };
    expect(selectByHeadroom([A, B], usage, NOW_H)?.name).toBe(A.name);
    // Order reversed in the candidates array: the FIRST element still wins —
    // "current order" means candidates' own order, not a fixed name.
    expect(selectByHeadroom([B, A], usage, NOW_H)?.name).toBe(B.name);
  });

  it("missing usage for every candidate returns null — the caller's own cue to fall back unchanged", () => {
    expect(selectByHeadroom([A, B], {}, NOW_H)).toBeNull();
  });

  // Maestro review round 2, MINOR 5: `Date.parse` on a malformed `seenAt`
  // returns NaN, and `NaN >= freshnessMs` is `false` in JS — so a row with a
  // genuinely unparseable `seenAt` must never survive the staleness filter as
  // if it were fresh. A's own pct (10) is the lowest in this fixture, so if
  // the bug were present A would wrongly win; the fix must exclude it
  // entirely, leaving B (the only genuinely fresh candidate) as the pick.
  it("a malformed (unparseable) seenAt is treated as stale, never as the freshest reading", () => {
    const usage: AccountUsageMap = {
      [A.name]: { fiveHourPct: 10, sevenDayPct: 10, scopedMaxPct: null, seenAt: "not-a-real-date" },
      [B.name]: snapshot(50, 10, null, 60_000),
    };
    expect(selectByHeadroom([A, B], usage, NOW_H)?.name).toBe(B.name);
  });

  // Maestro review round 2, MINOR 3: a fresh-but-nearly-spent reading must
  // never jump ahead of an unknown (no-data) candidate. A has no usage data
  // at all; B's own fresh reading is 94% used (over the 80 threshold) —
  // promoting B over the genuinely unknown A is backwards, so the whole
  // comparator must defer to the caller's own plain-order fallback (null).
  it("a candidate with no usage data at all is never passed over for a fresh-but-nearly-spent (94%) candidate — defers to null", () => {
    const usage: AccountUsageMap = { [B.name]: snapshot(94, 10, null, 60_000) };
    expect(selectByHeadroom([A, B], usage, NOW_H)).toBeNull();
  });

  // Same shape, but B's fresh reading is a comfortable 30% — promoting a
  // known-good candidate over an unknown one is correct, so B must win.
  it("a candidate with no usage data at all loses to a fresh, comfortable (30%) candidate", () => {
    const usage: AccountUsageMap = { [B.name]: snapshot(30, 10, null, 60_000) };
    expect(selectByHeadroom([A, B], usage, NOW_H)?.name).toBe(B.name);
  });

  // Sanity check for the "fresh vs no-data" rule: the 80% threshold only ever
  // gates a fresh candidate against an UNKNOWN one, never fresh against
  // fresh. Both A and B have fresh data here (85% and 92%) — the lower one
  // (85%) must still win even though 85 is itself over 80.
  it("the 80% promotion threshold never applies between two candidates that both have fresh data", () => {
    const usage: AccountUsageMap = {
      [A.name]: snapshot(85, 10, null, 60_000),
      [B.name]: snapshot(92, 10, null, 60_000),
    };
    expect(selectByHeadroom([A, B], usage, NOW_H)?.name).toBe(A.name);
  });
});

describe("nextClaudeAccount / firstFreeAccount — headroom ordering (issue #238 step 3)", () => {
  const A: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 };
  const B: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 };
  const C: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 };
  const three = [A, B, C];
  const now = new Date("2026-10-05T12:00:00.000Z");

  function fresh(pct: number, ageMs = 60_000): AccountUsageMap[string] {
    return { fiveHourPct: pct, sevenDayPct: 0, scopedMaxPct: null, seenAt: new Date(now.getTime() - ageMs).toISOString() };
  }

  it("nextClaudeAccount: a fresh usage row reorders the forward wrap to the most-headroom free candidate", () => {
    // Forward wrap from A would plainly land on B first; B's usage is worse
    // than C's, so C must be picked instead.
    const usage: AccountUsageMap = { [B.name]: fresh(90), [C.name]: fresh(5) };
    expect(nextClaudeAccount(three, A.name, {}, now, new Set(), usage)?.name).toBe(C.name);
  });

  it("nextClaudeAccount: with NO usage data at all (default `{}`), the plain forward-wrap pick is unchanged", () => {
    expect(nextClaudeAccount(three, A.name)?.name).toBe(B.name);
  });

  it("nextClaudeAccount: never picks a candidate with a live fleet-wide limit, even if its usage pct is the lowest", () => {
    // B has the LOWEST usage pct (most headroom) but is fleet-wide limited
    // right now — selectByHeadroom only ever sees the already-free-filtered
    // candidate list, so it must still land on C.
    const limits = { [B.name]: { until: new Date(now.getTime() + 60_000).toISOString(), seenAt: now.toISOString() } };
    const usage: AccountUsageMap = { [B.name]: fresh(1), [C.name]: fresh(50) };
    expect(nextClaudeAccount(three, A.name, limits, now, new Set(), usage)?.name).toBe(C.name);
  });

  it("firstFreeAccount: a fresh usage row reorders the list-order scan to the most-headroom free candidate", () => {
    const usage: AccountUsageMap = { [A.name]: fresh(90), [B.name]: fresh(5) };
    expect(firstFreeAccount(three, new Set(), {}, now, usage)?.name).toBe(B.name);
  });

  it("firstFreeAccount: with NO usage data at all (default `{}`), the plain list-order pick is unchanged", () => {
    expect(firstFreeAccount(three, new Set(), {}, now)?.name).toBe(A.name);
  });

  it("firstFreeAccount: stale usage for every candidate falls back to list order, unchanged", () => {
    const usage: AccountUsageMap = { [A.name]: fresh(90, USAGE_ORDERING_FRESHNESS_MS), [B.name]: fresh(5, USAGE_ORDERING_FRESHNESS_MS) };
    expect(firstFreeAccount(three, new Set(), {}, now, usage)?.name).toBe(A.name);
  });

  it("selectFreeAccount: threads usage through to its own tier-1 call (nextClaudeAccount)", () => {
    // anchor 0, current A, not out-of-scope: tier 1 is nextClaudeAccount over
    // the whole list — same reordering nextClaudeAccount's own test proves.
    const usage: AccountUsageMap = { [B.name]: fresh(90), [C.name]: fresh(5) };
    expect(selectFreeAccount(three, 0, A.name, false, new Set(), {}, now, usage)?.name).toBe(C.name);
  });

  it("selectFreeAccount: threads usage through to its own tier-2 call (firstFreeAccount over the before-anchor slice)", () => {
    // anchor 2 (C is this studio's own primary): scopedAccounts = [C], and
    // nextClaudeAccount(scopedAccounts, current=C, ...) has no OTHER position
    // to step forward to, so tier 1 always misses here — tier 2 then scans
    // the before-anchor slice [A, B], and usage must reorder THAT scan too.
    const usage: AccountUsageMap = { [A.name]: fresh(90), [B.name]: fresh(5) };
    expect(selectFreeAccount(three, 2, C.name, false, new Set(), {}, now, usage)?.name).toBe(B.name);
  });

  it("selectFreeAccount: with no usage argument at all (default `{}`), behaves exactly as before this feature", () => {
    expect(selectFreeAccount(three, 0, A.name, false, new Set(), {}, now)?.name).toBe(B.name);
  });
});

// ---------------------------------------------------------------------------
// Issue #103 — the set of account names that are SOME OTHER repo's own
// CLAUDE_ACCOUNT_BY_REPO-mapped primary, fed to nextClaudeAccount's `reserved`
// so a wrap for THIS repo can never land on an account #271's map reserves
// exclusively for a different one.
// ---------------------------------------------------------------------------
describe("otherRepoPrimaries (issue #103)", () => {
  it("excludes every OTHER repo's mapped account, never the caller's own", () => {
    const env = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: '{"repo-a":2,"repo-b":4}' });
    expect(otherRepoPrimaries(env, "repo-a")).toEqual(new Set(["CLAUDE_CODE_OAUTH_TOKEN_4"]));
  });

  it("with no owning repo (null, or a repo absent from the map), every mapped account is reserved", () => {
    const env = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: '{"repo-a":2,"repo-b":4}' });
    expect(otherRepoPrimaries(env, null)).toEqual(new Set(["CLAUDE_CODE_OAUTH_TOKEN_2", "CLAUDE_CODE_OAUTH_TOKEN_4"]));
    expect(otherRepoPrimaries(env, "repo-c")).toEqual(new Set(["CLAUDE_CODE_OAUTH_TOKEN_2", "CLAUDE_CODE_OAUTH_TOKEN_4"]));
  });

  it("an empty or absent map reserves nothing", () => {
    const env = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1 });
    expect(otherRepoPrimaries(env, "repo-a")).toEqual(new Set());
    expect(otherRepoPrimaries(envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: "" }), "repo-a")).toEqual(new Set());
  });

  it("two repos colliding on the same (already-invalid) slot never reserves that slot against either", () => {
    // CLAUDE_ACCOUNT_BY_REPO mapping two repos to the same slot is already an
    // invalid config, but the exclusion must still be by SLOT NUMBER, not by
    // repo key: from repo-a's own point of view slot 2 is ITS primary too,
    // even though "repo-b" also maps there, so it must never be reserved
    // against repo-a.
    const env = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: '{"repo-a":2,"repo-b":2}' });
    expect(otherRepoPrimaries(env, "repo-a")).toEqual(new Set());
  });
});

describe("repoForAccount (issue #131, Stage B)", () => {
  it("the repo CLAUDE_ACCOUNT_BY_REPO maps this account's slot to", () => {
    const env = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: '{"repo-a":2,"repo-b":4}' });
    expect(repoForAccount(env, "CLAUDE_CODE_OAUTH_TOKEN_4")).toBe("repo-b");
  });

  it("null for an unmapped account, a name outside the list, or an absent map", () => {
    const env = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: '{"repo-a":2}' });
    expect(repoForAccount(env, "CLAUDE_CODE_OAUTH_TOKEN_4")).toBeNull();
    expect(repoForAccount(env, "not-a-real-secret")).toBeNull();
    expect(repoForAccount(envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1 }), "CLAUDE_CODE_OAUTH_TOKEN_2")).toBeNull();
  });
});

describe("nextBorrowedAccount (issue #131, Stage B) — the borrow second pass", () => {
  const four: ClaudeAccount[] = [
    { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 },
    { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 },
    { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 },
    { name: "CLAUDE_CODE_OAUTH_TOKEN_4", token: "sk-ant-oat01-" + "d".repeat(40) },
  ];

  it("picks the free reserved account with the LOWEST 5h burn, not list order", () => {
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_3", "CLAUDE_CODE_OAUTH_TOKEN_4"]);
    const burn = {
      CLAUDE_CODE_OAUTH_TOKEN_3: { window5hOutput: 9000 },
      CLAUDE_CODE_OAUTH_TOKEN_4: { window5hOutput: 100 },
    };
    expect(nextBorrowedAccount(four, reserved, {}, burn, NOW)?.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_4");
  });

  it("an account absent from the burn map reads as 0 burn — never excluded, and wins over a nonzero one", () => {
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_3", "CLAUDE_CODE_OAUTH_TOKEN_4"]);
    const burn = { CLAUDE_CODE_OAUTH_TOKEN_3: { window5hOutput: 5 } };
    expect(nextBorrowedAccount(four, reserved, {}, burn, NOW)?.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_4");
  });

  it("never considers an account outside `reserved`, however low its burn", () => {
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_4"]);
    const burn = { CLAUDE_CODE_OAUTH_TOKEN_2: { window5hOutput: 0 }, CLAUDE_CODE_OAUTH_TOKEN_4: { window5hOutput: 9000 } };
    expect(nextBorrowedAccount(four, reserved, {}, burn, NOW)?.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_4");
  });

  it("skips a reserved account that is itself fleet-wide limited, same rule accountIsFree gives the first pass", () => {
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_3", "CLAUDE_CODE_OAUTH_TOKEN_4"]);
    const limits = { CLAUDE_CODE_OAUTH_TOKEN_4: { until: new Date(NOW.getTime() + 60 * 60_000).toISOString(), seenAt: NOW.toISOString() } };
    expect(nextBorrowedAccount(four, reserved, limits, {}, NOW)?.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
  });

  it("null when every reserved candidate is limited, or reserved is empty", () => {
    expect(nextBorrowedAccount(four, new Set(), {}, {}, NOW)).toBeNull();
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_4"]);
    const limits = { CLAUDE_CODE_OAUTH_TOKEN_4: { until: new Date(NOW.getTime() + 60 * 60_000).toISOString(), seenAt: NOW.toISOString() } };
    expect(nextBorrowedAccount(four, reserved, limits, {}, NOW)).toBeNull();
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
  /** Maestro review of PR #152, round 2 — controls the fake `exec`'s response
   *  to `deadAccountScrollbackCmd()`, independently of `setPane`'s own
   *  response to `paneCaptureCmd()` — a test drives how many times the
   *  dead-account block appears in the pane's own tmux SCROLLBACK, separately
   *  from what the visible screen currently shows. */
  setScrollback(stdout: string): void;
  /** Finding 1, fresh-context review of PR #152 round 2 (2026-09-30) — a
   *  one-shot override of the scrollback exec's own RESULT (code/stdout/
   *  stderr), consumed by the very next `deadAccountScrollbackCmd()` call and
   *  then cleared, so a test can simulate a single transient exec failure (a
   *  container exec timeout, a tmux hiccup, a momentarily-unavailable pane
   *  target right after `respawn-pane -k`) on one SPECIFIC tick without
   *  disturbing `setScrollback`'s own steady-state behavior on every other
   *  tick. */
  setScrollbackExec(result: { code: number; stdout: string; stderr: string }): void;
  /** Issue #102: the fleet-wide fake `accountLimits` store, exposed so a test
   *  can seed another account as ALREADY limited (fleet-wide, from some other
   *  studio's own sighting) before running this one. Issue #141: `dead` rides
   *  along too, so a test can seed/observe a permanently-dead entry. */
  accountLimits: Map<string, { until: string | null; seenAt: string; dead?: true; kind?: "spend_cap" | "hold" }>;
  /** Issue #131 (Stage B): how many times `deps.accountBurn.read` was called
   *  — the mutation-style proof that the borrow second pass is never even
   *  consulted when the first pass already found somewhere to go. */
  accountBurnReads: number;
}

function harness(opts: {
  accounts: ClaudeAccount[];
  pane: string;
  initial?: StudioStatus;
  /** Issue #271: default ON here, so every #53 test below keeps switching. */
  autoFailover?: boolean;
  primary?: string | null;
  /** Review round 3 (2nd review of PR #135, 2026-09-30) — true only for a
   *  genuine #271 CLAUDE_ACCOUNT_BY_REPO entry for this repo (see
   *  FailoverDeps.primaryIsMapped's own doc comment, failover.ts). Absent:
   *  `false` — the SAFE default, matching production's real no-map shape,
   *  where `primary` is a non-null string (the first configured account) yet
   *  no genuine mapping exists. Every plain pre-#271 test below relies on
   *  this default; every genuinely #271-mapped Stage B test passes it `true`
   *  explicitly. */
  primaryIsMapped?: boolean;
  display?: (name: string) => string;
  now?: Date;
  /** Issue #102: seed a fleet-wide limit fixture, `{ name: until }`. */
  accountLimits?: Record<string, string | null>;
  /** Issue #103: accounts that are some OTHER repo's own mapped primary —
   *  never a candidate for THIS studio, regardless of fleet-wide limit state. */
  reservedAccounts?: Set<string>;
  /** Issue #131 (Stage B): seed a fleet-wide burn fixture for the borrow
   *  second pass's lowest-burn-first ordering, `{ name: window5hOutput }`. */
  accountBurn?: Record<string, number>;
  /** Issue #131 (Stage B): names the repo a borrowed account belongs to, for
   *  the loud borrow/return notify messages. */
  otherRepoOf?: (name: string) => string | null;
  /** Issue #238 (step 3): seed a fleet-wide headroom usage fixture, keyed by
   *  account name — absent entirely (the default) wires NO `deps.accountUsage`
   *  at all, so `runAccountFailover`'s own `deps.accountUsage ? ... : {}`
   *  ternary runs its "no dep" branch, same as every pre-#238 test. */
  accountUsage?: AccountUsageMap;
}): Harness {
  const execs: string[] = [];
  const recorded: StudioStatus[] = [];
  const notices: string[] = [];
  let pane = opts.pane;
  let scrollback = "";
  let scrollbackExecOverride: { code: number; stdout: string; stderr: string } | null = null;
  let relaunches = 0;
  let accountBurnReads = 0;
  const storage = fakeStorage(opts.initial ?? status()) as StudioStorage & ObservedStorage;
  const accountLimits = new Map<string, { until: string | null; seenAt: string; dead?: true; kind?: "spend_cap" | "hold" }>(
    Object.entries(opts.accountLimits ?? {}).map(([name, until]) => [name, { until, seenAt: NOW.toISOString() }]),
  );
  const h: Harness = {
    execs, recorded, notices, storage, accountLimits,
    get relaunches() { return relaunches; },
    get accountBurnReads() { return accountBurnReads; },
    setPane: (stdout: string) => { pane = stdout; },
    setScrollback: (stdout: string) => { scrollback = stdout; },
    setScrollbackExec: (result: { code: number; stdout: string; stderr: string }) => {
      scrollbackExecOverride = result;
    },
    deps: {
      accounts: opts.accounts,
      autoFailover: opts.autoFailover ?? true,
      ...(opts.primary !== undefined ? { primary: opts.primary } : {}),
      primaryIsMapped: opts.primaryIsMapped ?? false,
      ...(opts.display ? { display: opts.display } : {}),
      ...(opts.reservedAccounts ? { reservedAccounts: opts.reservedAccounts } : {}),
      ...(opts.otherRepoOf ? { otherRepoOf: opts.otherRepoOf } : {}),
      ...(opts.accountUsage ? { accountUsage: { read: async () => opts.accountUsage! } } : {}),
      now: () => opts.now ?? NOW,
      accountLimits: {
        read: async () => Object.fromEntries(accountLimits),
        write: async (name: string, until: string | null, seenAt: string, dead?: true, kind?: "spend_cap" | "hold") => {
          accountLimits.set(name, { until, seenAt, ...(dead ? { dead: true as const } : {}), ...(kind ? { kind } : {}) });
        },
      },
      accountBurn: {
        read: async () => {
          accountBurnReads++;
          return Object.fromEntries(
            Object.entries(opts.accountBurn ?? {}).map(([name, window5hOutput]) => [name, { window5hOutput }]),
          );
        },
      },
      exec: vi.fn(async (cmd: string) => {
        execs.push(cmd);
        if (cmd === paneCaptureCmd()) return { code: 0, stdout: pane, stderr: "" };
        // Maestro review of PR #152, round 2 — the occurrence-counting
        // scrollback read, distinguished from the ordinary pane capture the
        // same way this fake already distinguishes the bringup token-write
        // exec below: match the exact command string.
        if (cmd === deadAccountScrollbackCmd()) {
          if (scrollbackExecOverride) {
            const result = scrollbackExecOverride;
            scrollbackExecOverride = null;
            return result;
          }
          return { code: 0, stdout: scrollback, stderr: "" };
        }
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

const THREE_ACCOUNTS: ClaudeAccount[] = [
  { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 },
  { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 },
  { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 },
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

// ---------------------------------------------------------------------------
// Issue #238 (step 3) — `deps.accountUsage` wired into runAccountFailover's
// own tier-1/tier-2 cascade: absent behaves identically to every pre-#238
// test above (no dep at all, `{}` read, plain order); present and fresh
// genuinely changes which free account a switch lands on.
// ---------------------------------------------------------------------------
describe("runAccountFailover — issue #238 step 3: deps.accountUsage reorders the switch target by headroom", () => {
  it("absent deps.accountUsage: plain forward-wrap order, unchanged (both account 2 and 3 are free)", async () => {
    const h = harness({ accounts: THREE_ACCOUNTS, pane: captured(MODAL_PANE) });
    const out = await run(h);
    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
  });

  it("present and fresh deps.accountUsage: the switch lands on the free account with the most headroom, not the plain-order one", async () => {
    const h = harness({
      accounts: THREE_ACCOUNTS, pane: captured(MODAL_PANE),
      accountUsage: {
        // Plain forward wrap from account 1 would land on account 2 first;
        // account 2's own usage is far worse than account 3's, so the switch
        // must land on account 3 instead.
        CLAUDE_CODE_OAUTH_TOKEN_2: { fiveHourPct: 92, sevenDayPct: 10, scopedMaxPct: null, seenAt: NOW.toISOString() },
        CLAUDE_CODE_OAUTH_TOKEN_3: { fiveHourPct: 4, sevenDayPct: 10, scopedMaxPct: null, seenAt: NOW.toISOString() },
      },
    });
    const out = await run(h);
    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_3" });
  });

  it("present but STALE deps.accountUsage (seenAt past the 10-minute ceiling): falls back to plain order, unchanged", async () => {
    const stale = new Date(NOW.getTime() - USAGE_ORDERING_FRESHNESS_MS).toISOString();
    const h = harness({
      accounts: THREE_ACCOUNTS, pane: captured(MODAL_PANE),
      accountUsage: {
        CLAUDE_CODE_OAUTH_TOKEN_2: { fiveHourPct: 92, sevenDayPct: 10, scopedMaxPct: null, seenAt: stale },
        CLAUDE_CODE_OAUTH_TOKEN_3: { fiveHourPct: 4, sevenDayPct: 10, scopedMaxPct: null, seenAt: stale },
      },
    });
    const out = await run(h);
    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
  });

  // Maestro review round 2, MAJOR 2: a transient D1 hiccup on this read must
  // fail OPEN (plain order, same as if deps.accountUsage were absent), never
  // abort the whole failover tick -- that would leave a studio stuck on an
  // already-limited account until the next tick, purely because the
  // headroom-ordering nice-to-have failed.
  it("a throwing deps.accountUsage.read() fails open to plain order, instead of aborting the whole tick", async () => {
    const h = harness({ accounts: THREE_ACCOUNTS, pane: captured(MODAL_PANE) });
    h.deps.accountUsage = { read: async () => { throw new Error("D1 hiccup"); } };
    const out = await run(h);
    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
  });
});

// ---------------------------------------------------------------------------
// Issue #336 — the org MONTHLY spend cap holds the FROM account until the next
// UTC month start (kind spend_cap), not the 24h null-until grace a plain
// select modal gets — so the usage sync and the next 5h reset cannot free it.
// ---------------------------------------------------------------------------
describe("runAccountFailover — issue #336: an org monthly spend cap holds the account until month end", () => {
  it("switches off it and marks the FROM account spend_cap until the next UTC month start", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(ORG_SPEND_CAP_TAIL_PANE) });
    const out = await run(h);

    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN")).toEqual({
      until: "2026-10-01T00:00:00.000Z", seenAt: NOW.toISOString(), kind: "spend_cap",
    });
  });

  it("a plain window select modal still writes the old null-until row, no kind", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE.replace("org's monthly spend limit", "usage limit")) });
    await run(h);
    const row = h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN");
    expect(row?.until).toBeNull();
    expect(row?.kind).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #141 — a pane showing the org-disabled-subscription message marks the
// FROM account dead (fleet-wide, no auto-expiry) and switches off it exactly
// the way an exhausted account does — the same switch pipeline, no parallel
// one.
// ---------------------------------------------------------------------------
describe("runAccountFailover — issue #141: a dead account (org disabled subscription access) is marked dead and switched off", () => {
  it("switches to the second account, and marks the FROM account dead fleet-wide", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(ORG_DISABLED_PANE) });
    const out = await run(h);

    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN")).toMatchObject({ dead: true });
  });

  // Fresh-context review of this PR (2026-09-30): limitObservation's "has
  // anything changed" check compares `!!prior.dead === dead` alongside
  // `until`/`select` PRECISELY because a plain non-dead inline sighting
  // already on the row (this studio's own out-of-credits-style block, seen
  // an hour ago) has `until: null` and no `select` — the SAME shape a dead
  // verdict's own `until`/`select` present. Without the `dead` comparison
  // too, the transition to dead on a LATER tick would read as "nothing
  // changed" against that prior and `prior` itself would be returned
  // unwritten, silently swallowing the dead flag. This seeds exactly that
  // prior observation, then feeds the dead pane through the SAME row.
  it("a prior non-dead inline sighting (until: null) on the row still gets marked dead once the pane goes dead", async () => {
    const seenAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    const h = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(ORG_DISABLED_PANE),
      initial: status({ rateLimited: { until: null, seenAt } }),
    });
    const out = await run(h);

    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN")).toMatchObject({ dead: true });
  });

  it("never auto-expires: a LATER tick, 30 days on, still refuses to wrap back onto the dead account", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(ORG_DISABLED_PANE) });
    await run(h); // marks CLAUDE_CODE_OAUTH_TOKEN dead, switches to CLAUDE_CODE_OAUTH_TOKEN_2
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN")).toMatchObject({ dead: true });

    // 30 days later, the studio (now on CLAUDE_CODE_OAUTH_TOKEN_2) hits its
    // own limit and would ordinarily wrap back to CLAUDE_CODE_OAUTH_TOKEN. A
    // plain null-until entry would have cleared long ago
    // (NULL_UNTIL_CEILING_MS, 24h) — a dead one must not, so there is nowhere
    // left to go at all.
    const later = new Date(NOW.getTime() + 30 * 24 * 60 * 60_000);
    const h2 = harness({
      accounts: TWO_ACCOUNTS,
      pane: captured(MODAL_PANE),
      now: later,
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
    });
    // Share the same fleet-wide store the first tick wrote.
    h2.deps.accountLimits!.read = () => h.deps.accountLimits!.read();
    const out2 = await run(h2);

    expect(out2).toEqual({ kind: "exhausted", tried: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"] });
    // The dead entry itself must still read back dead — this tick's own
    // write (keyed to its OWN current account, CLAUDE_CODE_OAUTH_TOKEN_2)
    // must never have touched or cleared it.
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN")).toMatchObject({ dead: true });
  });
});

// ---------------------------------------------------------------------------
// Maestro review of PR #152 (2026-09-30), item 1 — the dead-account message
// carries NO variable text at all (headline, no resets), so
// limitBlockKey(verdict) is IDENTICAL for every account that shows it. This
// is exactly the real-world shape: an org-wide disable kills SEVERAL accounts
// at once. The rerender guard above used to have NO time bound at all —
// unlike the select-modal flap-guard right below it — on the assumption that
// a genuinely new limit always produces a DIFFERENT key (a different
// reset/headline). The dead-account message breaks that assumption: a
// SECOND, genuinely dead account produces the SAME key as the first
// account's own departure evidence, and was suppressed as a stale
// `--continue` rerender FOREVER — never marked dead, never switched off.
//
// Round 2 (maestro review of PR #152, 2026-09-30) — round 1's fix here was a
// TIME bound (FLAP_GUARD_MINUTES since the switch), and the reviewer's probe
// P7 (see the DEDICATED describe block further below) found it unsafe: a
// stale `--continue` redraw of the departed account's OWN evidence can sit on
// an idling, perfectly healthy pane for arbitrarily long, and a time bound
// alone cannot tell that apart from genuinely fresh evidence. This test is
// REWRITTEN to prove the same outcome (account 2 eventually gets marked dead
// and the studio moves on to account 3) via a GROWING OCCURRENCE COUNT in the
// pane's own tmux scrollback instead of elapsed time — see
// countDeadAccountOccurrences'/failoverBlockOccurrences' own doc comments
// (failover.ts/types.ts) for the full mechanism.
// ---------------------------------------------------------------------------
/** One dead-account block, exactly as `countDeadAccountOccurrences` requires
 *  to count it — the same two-line wrap the `ORG_DISABLED_PANE` fixture
 *  itself uses, repeated `n` times to simulate `n` occurrences in scrollback. */
function deadBlockOccurring(n: number): string {
  const block = [
    "● Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask",
    "  your admin to enable access",
  ].join("\n");
  return Array.from({ length: n }, () => block).join("\n");
}

describe("runAccountFailover — issue #141 review, round 2: a same-keyed dead-account block on the NEXT account is trusted once the scrollback occurrence count GROWS (not once time passes)", () => {
  it("tick 1 switches account 1 off (dead); tick 2 (same now) records the baseline and rerender-guards; tick 3 (still same now) sees a NEW occurrence and marks account 2 dead and switches on", async () => {
    const h = harness({ accounts: THREE_ACCOUNTS, pane: captured(ORG_DISABLED_PANE) });

    // Tick 1: account 1's own screen shows the dead message. The
    // scrollback-read branch is not reached on this tick (no recorded
    // failoverBlock yet to match against), so its response does not matter.
    const out1 = await run(h);
    expect(out1).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN")).toMatchObject({ dead: true });

    // Tick 2, SAME now — proving this mechanism is not time-dependent at all:
    // the SAME pane now represents account 2's own screen — genuinely ALSO
    // dead — and this is the FIRST sighting since the switch. The scrollback
    // shows the block occurring ONCE: this tick records that as the baseline
    // and rerender-guards, exactly like the very first `--continue` redraw
    // always has.
    h.setScrollback(deadBlockOccurring(1));
    const out2 = await run(h);
    expect(out2.kind).toBe("rerender");
    expect((await h.storage.get(STATUS_KEY))?.failoverBlockOccurrences).toBe(1);

    // Tick 3, STILL the same `now` — no time advance at all: the pane shows
    // the SAME block, but the scrollback now shows it occurring TWICE,
    // simulating account 2 genuinely, independently printing its own fresh
    // rejection — a real second occurrence, not a redraw of the first. This
    // is real, unambiguous, non-time-based evidence: account 2 gets marked
    // dead fleet-wide and the studio switches to account 3.
    h.setScrollback(deadBlockOccurring(2));
    const out3 = await run(h);
    expect(out3).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN_2", to: "CLAUDE_CODE_OAUTH_TOKEN_3" });
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN_2")).toMatchObject({ dead: true });
  });
});

// ---------------------------------------------------------------------------
// Fresh-context review of PR #152 round 2 (2026-09-30) — the `count >
// baseline` fall-through (the branch right after the one T1 fixture above
// exercises) issues no exec of its own, but it DOES fall through into the
// ordinary inline-evidence handling below, which can reach the `if (!next)`
// write (the exhausted/parked path) built from `existing` — a snapshot taken
// BEFORE the scrollback exec that just ran. Same destroy-race reasoning as
// the `baseline === null` branch's own `destroyLanded()` check just above
// (and the pre-existing switch-write guard, #123's "studio stopped during
// the account switch"): a destroy landing during THIS exec must be caught
// here too, before genuinely-new occurrence evidence is allowed to fall
// through to a write that could resurrect a row the destroy path already
// finalized.
// ---------------------------------------------------------------------------
describe("runAccountFailover — PR #152 round 3 review: a destroy landing during the dead-account scrollback's own `count > baseline` capture must not resurrect a finalized row", () => {
  it("tick 3's genuinely-new occurrence count is skipped (not switched, not exhausted) when a destroy completes during that exact scrollback exec", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(ORG_DISABLED_PANE) });

    // Tick 1: switches account 1 (dead) -> account 2.
    const out1 = await run(h);
    expect(out1).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });

    // Tick 2: first post-switch sighting on account 2 establishes the
    // baseline (count 1).
    h.setScrollback(deadBlockOccurring(1));
    const out2 = await run(h);
    expect(out2.kind).toBe("rerender");
    const afterTick2 = await h.storage.get(STATUS_KEY);
    expect(afterTick2?.failoverBlockOccurrences).toBe(1);

    // Tick 3: the scrollback genuinely grows to 2 occurrences — real, fresh
    // evidence that account 2 is ALSO dead — but a destroy completes DURING
    // this exact scrollback exec, same simulation shape as #123's own
    // "destroy lands during the account switch" test
    // (studio.start-gate-writeback.test.ts's `destroyCompletes`): the row
    // flips to `stopped` as a side effect of the exec that is in flight.
    // With only TWO_ACCOUNTS, nextClaudeAccount wraps forward from account 2
    // back to account 1 — already dead, so excluded — leaving nowhere else to
    // go (`next === null`), the exact `if (!next)` hazard the finding named.
    h.setScrollback(deadBlockOccurring(2));
    const originalExec = h.deps.exec;
    h.deps.exec = vi.fn(async (cmd: string, env?: Record<string, string>) => {
      const res = await originalExec(cmd, env);
      if (cmd === deadAccountScrollbackCmd()) {
        const existing = await h.storage.get(STATUS_KEY);
        await h.storage.put(STATUS_KEY, { ...(existing as StudioStatus), state: "stopped" });
      }
      return res;
    });

    const out3 = await run(h);

    expect(out3).toEqual({ kind: "skipped", reason: "studio stopped during the dead-account scrollback capture" });
    // Account 2 is never marked dead fleet-wide — the exhausted/parked write
    // this check prevents never ran at all.
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN_2")?.dead).not.toBe(true);
    // The row is exactly what the destroy itself left (`stopped`) plus
    // whatever tick 2 already recorded — never overwritten with a fresh
    // `degraded`/`running` snapshot built from the stale pre-exec `existing`.
    const finalRow = await h.storage.get(STATUS_KEY);
    expect(finalRow?.state).toBe("stopped");
    expect(finalRow?.failoverBlockOccurrences).toBe(afterTick2?.failoverBlockOccurrences);
    expect(finalRow?.claudeAccount).toBe(afterTick2?.claudeAccount);
  });
});

// ---------------------------------------------------------------------------
// Maestro review of PR #152, round 2 — reviewer probe P7. Round 1's time-
// bounded redraw guard (FLAP_GUARD_MINUTES) is UNSAFE: after a switch,
// claude's `--continue` can redraw the OLD dead account's departure evidence
// on the NEW account's own pane, and that pane can then simply IDLE — nothing
// typed, nothing new — because the account it is NOW on is perfectly healthy.
// That idle redraw can sit on screen, completely static, for arbitrarily
// long. A time bound alone cannot distinguish that from genuinely fresh
// evidence once elapsed time is the only test, so round 1's fix eventually
// marks a HEALTHY account permanently dead. This pins the fix: an occurrence
// count that never grows (a genuinely idle, never-reprinted redraw) must
// rerender-guard FOREVER, no matter how much time passes.
// ---------------------------------------------------------------------------
describe("runAccountFailover — issue #141 review, round 2, probe P7: an idle --continue redraw of a departed account's dead block never marks the NEW (healthy) account dead, no matter how much time passes", () => {
  it("stays rerender-guarded across many ticks, well past the old 5-minute bound, when the scrollback occurrence count never grows", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(ORG_DISABLED_PANE) });

    // Tick 1: switches account 1 (dead) -> account 2.
    const out1 = await run(h);
    expect(out1).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN")).toMatchObject({ dead: true });

    // Every subsequent tick sees the IDENTICAL pane (a static --continue
    // redraw of account 1's own departure evidence, now idling on account 2's
    // healthy pane) and the IDENTICAL scrollback — the block occurring
    // exactly ONCE, unchanged, no matter how many ticks pass. This is exactly
    // what a genuinely idle, never-reprinted redraw looks like.
    h.setScrollback(deadBlockOccurring(1));

    const advances = [10, 10, 10, 120]; // minutes per tick; last one is +2h
    let elapsedMs = 0;
    for (const minutes of advances) {
      elapsedMs += minutes * 60_000;
      h.deps.now = () => new Date(NOW.getTime() + elapsedMs);
      const out = await run(h);
      expect(out.kind).toBe("rerender");
      expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN_2")?.dead).not.toBe(true);
      // Only the original switch's own respawn-pane/relaunch — never a
      // second one from a wrongly-triggered switch off the healthy account.
      expect(h.relaunches).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Fresh-context review of PR #152's round-2 occurrence-count fix (2026-09-30),
// finding 1 — the scrollback exec's own result was trusted without checking
// `code` or `stdout`. A failed/empty capture on the VERY FIRST post-switch
// sighting (the `baseline === null` branch) used to record a wrongly-empty
// baseline of 0 (an empty stdout parses to 0 occurrences via
// `countDeadAccountOccurrences`), even though the real, already-present,
// NON-fresh count was 1. The next tick's successful capture would then read
// 1 > 0 as genuinely fresh evidence and wrongly mark a possibly-still-just-
// redrawing account dead — the exact P7 failure class (a non-fresh
// observation misread as new evidence), reached via exec unreliability
// instead of elapsed time. Fix: an invalid capture (non-zero `code`, or empty
// `stdout`) is NEVER evidence of anything, including a baseline — it must
// leave `failoverBlockOccurrences` completely untouched and fall back to
// `rerender`, the same false-negative-biased discipline every other guard in
// this file already uses (see `detectRateLimitModal`'s own "inconclusive"
// handling).
// ---------------------------------------------------------------------------
describe("runAccountFailover — fresh-context review of PR #152 round 2, finding 1: a failed/empty scrollback capture must never poison the occurrence baseline", () => {
  it("a failed capture on the first post-switch sighting leaves no baseline; the next, genuinely-first-valid capture establishes it instead of being misread as fresh evidence", async () => {
    const h = harness({ accounts: THREE_ACCOUNTS, pane: captured(ORG_DISABLED_PANE) });

    // Tick 1: account 1's own screen shows the dead message — switches off it,
    // as always.
    const out1 = await run(h);
    expect(out1).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN")).toMatchObject({ dead: true });

    // Tick 2 (first post-switch sighting): the scrollback capture FAILS — a
    // transient container exec timeout/tmux hiccup, simulated here as a
    // non-zero exit with empty stdout. The real, already-present (non-fresh)
    // count is actually 1, but this capture cannot see it.
    h.setScrollbackExec({ code: 1, stdout: "", stderr: "boom" });
    const out2 = await run(h);
    expect(out2.kind).toBe("rerender");
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN_2")?.dead).not.toBe(true);
    // The failed capture must not have poisoned a baseline at all.
    expect((await h.storage.get(STATUS_KEY))?.failoverBlockOccurrences ?? null).toBeNull();

    // Tick 3: the scrollback capture now SUCCEEDS and genuinely returns the
    // block occurring exactly ONCE — the true, still-stale count. This is now
    // treated as the first VALID baseline, not as "1 > a wrongly-recorded 0".
    h.setScrollback(deadBlockOccurring(1));
    const out3 = await run(h);
    expect(out3.kind).toBe("rerender");
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN_2")?.dead).not.toBe(true);
    expect((await h.storage.get(STATUS_KEY))?.failoverBlockOccurrences).toBe(1);

    // Tick 4: the scrollback genuinely grows to TWO occurrences — real, fresh
    // evidence. Account 2 is now marked dead and the studio moves on.
    h.setScrollback(deadBlockOccurring(2));
    const out4 = await run(h);
    expect(out4).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN_2", to: "CLAUDE_CODE_OAUTH_TOKEN_3" });
    expect(h.accountLimits.get("CLAUDE_CODE_OAUTH_TOKEN_2")).toMatchObject({ dead: true });
  });
});

// ---------------------------------------------------------------------------
// Second, independent fresh-context review of PR #135 (2026-09-30), review
// round 3 — the generalized write condition landed by finding 4 above
// (`deps.primary != null && next.name !== deps.primary`) is gated on
// `deps.primary != null`, but do.ts's REAL `failoverDeps()` wires `primary:
// this.primaryAccount()`, and `primaryAccount()`/accounts.ts's
// `launchAccount` NEVER returns null in the no-map case — it falls through to
// `accounts[0]`. So in production `deps.primary` is a string for every studio
// with at least one CLAUDE_CODE_OAUTH_TOKEN* secret set, whether or not
// CLAUDE_ACCOUNT_BY_REPO maps this repo at all. The `!= null` guard is true
// only inside this file's own harness (where `primary` defaults to
// `undefined`), never in real deployment.
//
// Concretely: a plain multi-account fleet that never configured
// CLAUDE_ACCOUNT_BY_REPO (the original, pre-#271 #53 feature) fails over from
// account 1 to account 2 — an entirely ordinary switch — and the old write
// condition wrongly sets `borrowedAccount` to account 2 anyway, arming
// hand-back to later kill+relaunch the pane back onto account 1, unrequested,
// for a fleet that never opted into Stage B at all.
//
// Fix: `FailoverDeps.primaryIsMapped` — true only when THIS studio's repo has
// a genuine CLAUDE_ACCOUNT_BY_REPO entry, false (the harness's own safe
// default, matching production's real no-map behaviour) otherwise. The write
// condition gates on THIS, not on `deps.primary != null`.
// ---------------------------------------------------------------------------
describe("runAccountFailover — review round 3: borrowedAccount must stay null for a repo with no CLAUDE_ACCOUNT_BY_REPO entry (2nd review of PR #135)", () => {
  it("a plain multi-account fleet with no map: an ordinary rate-limit switch never sets borrowedAccount", async () => {
    // `primary: "CLAUDE_CODE_OAUTH_TOKEN"` reproduces production's REAL
    // shape for an unmapped repo: primaryAccount() falls back to the first
    // configured account, so `deps.primary` is a non-null string even though
    // no CLAUDE_ACCOUNT_BY_REPO entry exists for this repo at all.
    // `primaryIsMapped` is deliberately omitted — the harness's own safe
    // default must match that no-map production reality.
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN" });
    const out = await run(h);

    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    const last = h.recorded.at(-1)!;
    expect(last.borrowedAccount).toBeNull();
    expect(last.borrowedFromRepo).toBeNull();
  });

  it("continuing from that state, hand-back never fires even once the original account looks free again", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: captured(MODAL_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN" });
    await run(h);
    expect((await h.storage.get(STATUS_KEY))?.borrowedAccount).toBeNull();

    // A later tick finds the pane idle (claude's own working/idle shape) —
    // exactly the tick hand-back's own guard fires on, gated on
    // `rowNow.borrowedAccount`. Since the switch above correctly never set
    // it, this must be an ordinary no-op tick, never a hand-back.
    h.setPane(captured(IDLE_PANE));
    const out = await run(h);

    expect(out.kind).not.toBe("returned");
    // Exactly the one respawn-pane from the original switch above — no
    // second one from a wrongly-fired hand-back.
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

    // Issue #109: this row is select-modal-shaped and genuinely exhausted, so
    // the anti-loop guard's own kind is now `auto-continue-waiting`, not the
    // old silent `already-degraded` — the first tick's own exhaustion write
    // already recorded a KNOWN reset (ALL_LIMITED's own future `until`, read
    // back via accountLimits), and `now` never advances across these three
    // calls, so every due-check still says "not yet". The invariant this
    // test exists to pin — no re-degrade, no re-notify, no retry — holds
    // exactly as before: due-ness false means zero writes and zero execs
    // beyond the probe, same as `already-degraded` always guaranteed.
    expect(second.kind).toBe("auto-continue-waiting");
    expect(third.kind).toBe("auto-continue-waiting");
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
    // Issue #336: a window modal — MODAL_PANE's org headline is a spend cap now.
    const windowPane = MODAL_PANE.replace("org's monthly spend limit", "usage limit              ");
    const h = harness({ accounts: [TWO_ACCOUNTS[0]], pane: captured(windowPane), autoFailover: false });
    expect(await run(h)).toEqual({ kind: "exhausted", tried: ["CLAUDE_CODE_OAUTH_TOKEN"] });
    expect(h.notices[0]).toBe(exhaustedMessage(STUDIO_ID, ["CLAUDE_CODE_OAUTH_TOKEN"]));
  });

  it("issue #336: a single account on the org spend cap names the month-start reset", async () => {
    const h = harness({ accounts: [TWO_ACCOUNTS[0]], pane: captured(MODAL_PANE), autoFailover: false });
    expect(await run(h)).toEqual({ kind: "exhausted", tried: ["CLAUDE_CODE_OAUTH_TOKEN"] });
    expect(h.notices[0]).toBe(exhaustedMessage(STUDIO_ID, ["CLAUDE_CODE_OAUTH_TOKEN"], "2026-10-01T00:00:00.000Z"));
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

  // -------------------------------------------------------------------
  // Issue #103 — the exact incident shape: repo A's own mapped primary is
  // slot 2, repo B's is slot 4. Repo A's studio, currently limited on slot 3,
  // wraps forward. Slot 4 is fleet-wide FREE, so the OLD code (no cross-repo
  // exclusion) would land there — stealing the account CLAUDE_ACCOUNT_BY_REPO
  // reserves exclusively for repo B. `reservedAccounts` must skip it, wrapping
  // back to repo A's own primary (slot 2) instead.
  // -------------------------------------------------------------------
  it("issue #103: a repo-A studio wrapping past a fleet-wide-limited account never lands on repo B's own mapped primary", async () => {
    const four: ClaudeAccount[] = [
      ...TWO_ACCOUNTS,
      { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_4", token: "sk-ant-oat01-" + "d".repeat(40) },
    ];
    const h = harness({
      accounts: four, pane: captured(MODAL_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2",
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" }),
      // account 3 fleet-wide limited (still live); account 4 left unseeded — fleet-wide FREE.
      accountLimits: { CLAUDE_CODE_OAUTH_TOKEN_3: new Date(NOW.getTime() + 60 * 60_000).toISOString() },
      reservedAccounts: new Set(["CLAUDE_CODE_OAUTH_TOKEN_4"]),
    });
    expect(await run(h)).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN_3", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
  });
});

// ---------------------------------------------------------------------------
// Issue #131 (Stage B) — borrow another repo's primary when every account
// reserved for THIS repo is limited at once, hand back the moment this
// studio's own primary is free again. The board's reassignment comment
// explicitly asks for "mutants, no regression in #104/#117 tests" — the
// golden #103 test just above is left completely untouched; the sibling test
// below proves the borrow path activates ONLY in the strictly stricter
// condition (the studio's OWN primary also limited, not merely reserved).
// ---------------------------------------------------------------------------
describe("runAccountFailover — borrow another repo's primary (issue #131, Stage B)", () => {
  const four: ClaudeAccount[] = [
    ...TWO_ACCOUNTS,
    { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 },
    { name: "CLAUDE_CODE_OAUTH_TOKEN_4", token: "sk-ant-oat01-" + "d".repeat(40) },
  ];
  const LIVE_UNTIL = new Date(NOW.getTime() + 60 * 60_000).toISOString();

  it("every account reserved for this repo limited (own primary too) + another repo's primary free -> borrows", async () => {
    const h = harness({
      accounts: four, pane: captured(MODAL_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" }),
      // account 2 (own primary) AND account 3 (current) both fleet-wide
      // limited — the strictly stricter condition than the golden #103 test
      // above, where account 2 stays free and the studio wraps back to it.
      // Review round 2 (maestro review of PR #135), finding 3: account 1
      // (positioned BEFORE the primary) is ALSO limited here — otherwise it
      // is a genuinely unclaimed spare (tier 2), which this fixture's own
      // "every account... limited" premise requires it not to be.
      accountLimits: {
        CLAUDE_CODE_OAUTH_TOKEN: LIVE_UNTIL, CLAUDE_CODE_OAUTH_TOKEN_2: LIVE_UNTIL, CLAUDE_CODE_OAUTH_TOKEN_3: LIVE_UNTIL,
      },
      reservedAccounts: new Set(["CLAUDE_CODE_OAUTH_TOKEN_4"]),
      otherRepoOf: (name) => (name === "CLAUDE_CODE_OAUTH_TOKEN_4" ? "repo-b" : null),
    });
    const out = await run(h);
    expect(out).toEqual({ kind: "borrowed", from: "CLAUDE_CODE_OAUTH_TOKEN_3", to: "CLAUDE_CODE_OAUTH_TOKEN_4", fromRepo: "repo-b" });
    const last = h.recorded.at(-1)!;
    expect(last.borrowedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_4");
    expect(last.borrowedFromRepo).toBe("repo-b");
    expect(last.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_4");
    // "Log it loudly" — names both this studio's own repo and the repo whose
    // primary was borrowed.
    expect(h.notices[0]).toContain("fleetflare");
    expect(h.notices[0]).toContain("repo-b");
    expect(h.notices[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN_4");
  });

  it("own primary resets -> hand-back moves the studio back immediately", async () => {
    const h = harness({
      accounts: four, pane: captured(IDLE_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
      initial: status({
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4",
        borrowedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", borrowedFromRepo: "repo-b",
      }),
      // account 2 (own primary) carries no entry at all — fleet-wide free again.
    });
    const out = await run(h);
    expect(out).toEqual({ kind: "returned", from: "CLAUDE_CODE_OAUTH_TOKEN_4", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    const last = h.recorded.at(-1)!;
    expect(last.borrowedAccount).toBeNull();
    expect(last.borrowedFromRepo).toBeNull();
    expect(last.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(last.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(last.state).toBe("running");
    expect(h.notices[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN_4");
    expect(h.notices[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  // -------------------------------------------------------------------
  // Review round 2 (maestro review of PR #135), finding 1 — the hand-back
  // guard above used to fire on ANY `"working"` verdict, including a
  // repainting (mid-turn) pane and a fresh OPERATION_KEY held by a
  // concurrent provision/restart/recycle/failover. Both are "a turn — or an
  // operation — is in flight right now", and hand-back's own
  // `accountSwitchCmd` (`respawn-pane -k`) kills whatever is running in the
  // pane, so firing it in either state loses real work. These two tests pin
  // the guard: hand-back must skip the tick (not error) and try again next
  // time.
  // -------------------------------------------------------------------
  it("own primary free, but the pane repainted (a turn in flight): hand-back does NOT fire this tick", async () => {
    const h = harness({
      accounts: four, pane: captured(MID_TURN_PANE_A, MID_TURN_PANE_B), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
      initial: status({
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4",
        borrowedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", borrowedFromRepo: "repo-b",
      }),
      // account 2 (own primary) carries no entry at all — fleet-wide free.
    });
    const out = await run(h);
    expect(out).toEqual({ kind: "no-modal", reason: expect.any(String) });
    expect(h.relaunches).toBe(0);
    expect(h.notices).toHaveLength(0);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.borrowedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_4");
    expect(stored?.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_4");
  });

  it("own primary free, pane idle, but OPERATION_KEY holds a FRESH lock: hand-back does NOT fire this tick", async () => {
    const h = harness({
      accounts: four, pane: captured(IDLE_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
      initial: status({
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4",
        borrowedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", borrowedFromRepo: "repo-b",
      }),
    });
    const freshSince = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    await h.storage.put(OPERATION_KEY, { op: "provision", since: freshSince });
    const out = await run(h);
    expect(out).toEqual({ kind: "no-modal", reason: expect.any(String) });
    expect(h.relaunches).toBe(0);
    expect(h.notices).toHaveLength(0);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.borrowedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_4");
    // The outer lock is untouched — hand-back never took, and never cleared, it.
    expect(await h.storage.get(OPERATION_KEY)).toEqual({ op: "provision", since: freshSince });
  });

  // Code review, 2026-09-30 (this issue's own review pass): handBack's own
  // doc comment above already STATES the missing observedStorage bring-up
  // re-verification as a deliberate, bounded residual — but nothing had ever
  // driven a hand-back WITH observedStorage passed to pin what that residual
  // actually does. This test is that pin: it proves, by running the code
  // rather than by reading its doc comment, that a hand-back leaves whatever
  // session-verdict/incarnation data observedStorage already held completely
  // untouched — no bring-up observation exec at all, unlike the ordinary
  // switch path just above (runAccountFailover — incarnation token write
  // (issue #85)) which always runs one. NOT a behavior change: handBack
  // itself is untouched by this test.
  it("hand-back does not re-verify observedStorage (residual, tracked)", async () => {
    const h = harness({
      accounts: four, pane: captured(IDLE_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
      initial: status({
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4",
        borrowedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", borrowedFromRepo: "repo-b",
      }),
      // account 2 (own primary) carries no entry at all — fleet-wide free again.
    });
    // Seed observedStorage with the same incarnation-token shape the
    // ordinary switch path itself writes (issue #85) — something concrete
    // to prove UNCHANGED by the hand-back below.
    await mergeObserved(h.storage, { incarnation: "pre-handback-incarnation-token", lastShipOkAt: "2026-09-20T00:00:00.000Z" });
    const before = await getObserved(h.storage);

    const out = await runAccountFailover(h.deps, h.storage, STUDIO_ID, async (s) => { h.recorded.push(s); }, h.storage);

    expect(out).toEqual({ kind: "returned", from: "CLAUDE_CODE_OAUTH_TOKEN_4", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    // No bring-up observation exec at all — handBack skips it entirely,
    // unlike the ordinary switch path (which always runs BRINGUP_TOKEN_WRITE_SECTION).
    expect(h.execs.some((c) => c.includes(BRINGUP_TOKEN_WRITE_SECTION))).toBe(false);
    const after = await getObserved(h.storage);
    expect(after.incarnation).toBe(before.incarnation);
    expect(after.session).toBe(before.session);
    expect(after).toEqual(before);
  });

  it("not yet borrowed, own primary free, no limit on screen: hand-back never fires (nothing to hand back)", async () => {
    const h = harness({
      accounts: four, pane: captured(IDLE_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
    });
    const out = await run(h);
    expect(out).toEqual({ kind: "no-modal", reason: expect.any(String) });
    expect(h.notices).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Review round 2 (maestro review of PR #135), finding 5b — mutation gap:
  // the existing hand-back tests either seed the primary as already free
  // (fires) or never seed borrowedAccount at all (nothing to fire). Neither
  // proves hand-back is actually GATED on the primary's freeness, as opposed
  // to firing unconditionally whenever borrowedAccount happens to be set. A
  // genuine ping-pong — stays borrowed while STILL limited, returns the
  // moment it frees up — is that proof.
  // -------------------------------------------------------------------
  it("ping-pong: hand-back stays borrowed while the primary is STILL limited, and fires the moment it frees up", async () => {
    const h = harness({
      accounts: four, pane: captured(IDLE_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
      initial: status({
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4",
        borrowedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", borrowedFromRepo: "repo-b",
      }),
      // own primary still fleet-wide limited.
      accountLimits: { CLAUDE_CODE_OAUTH_TOKEN_2: LIVE_UNTIL },
    });

    const stillLimited = await run(h);
    expect(stillLimited).toEqual({ kind: "no-modal", reason: expect.any(String) });
    expect(h.relaunches).toBe(0);
    expect((await h.storage.get(STATUS_KEY))?.borrowedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_4");

    // Own primary frees up.
    h.accountLimits.delete("CLAUDE_CODE_OAUTH_TOKEN_2");
    const freedNow = await run(h);
    expect(freedNow).toEqual({ kind: "returned", from: "CLAUDE_CODE_OAUTH_TOKEN_4", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(h.relaunches).toBe(1);
    expect((await h.storage.get(STATUS_KEY))?.borrowedAccount).toBeNull();
  });

  // -------------------------------------------------------------------
  // Maestro review of PR #152 (2026-09-30), item 3b — hand-back must never
  // return a studio onto its OWN primary while that primary is dead
  // (permanently disabled, issue #141), not merely "still fleet-wide
  // limited". accountIsFree already checks `dead` first, unconditionally,
  // before anything else (src/studio/accounts.ts) — this pins that with a
  // real runAccountFailover tick rather than trusting the doc comment: a
  // studio borrowed onto another repo's primary, its OWN mapped primary
  // marked dead, fed a working/idle pane (hand-back only fires on
  // `kind: "working"`), must stay borrowed.
  // -------------------------------------------------------------------
  it("own primary DEAD (not merely limited): hand-back never returns the studio onto it", async () => {
    const h = harness({
      accounts: four, pane: captured(IDLE_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
      initial: status({
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4",
        borrowedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", borrowedFromRepo: "repo-b",
      }),
    });
    // Own primary marked DEAD fleet-wide (until: null — a dead entry has no
    // reset at all, see accounts.ts's own AccountLimits shape).
    h.accountLimits.set("CLAUDE_CODE_OAUTH_TOKEN_2", { until: null, seenAt: NOW.toISOString(), dead: true });

    const out = await run(h);
    expect(out).toEqual({ kind: "no-modal", reason: expect.any(String) });
    expect(h.relaunches).toBe(0);
    expect(h.notices).toHaveLength(0);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.borrowedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_4");
    expect(stored?.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_4");
  });

  it("lowest-burn-first: two free other-repo primaries, the lower-burn one is chosen, not list order", async () => {
    const five: ClaudeAccount[] = [
      ...four,
      { name: "CLAUDE_CODE_OAUTH_TOKEN_5", token: "sk-ant-oat01-" + "e".repeat(40) },
    ];
    const h = harness({
      accounts: five, pane: captured(MODAL_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" }),
      // Review round 2 (maestro review of PR #135), finding 3: account 1
      // (before the primary) is limited too — see the sibling test above.
      accountLimits: {
        CLAUDE_CODE_OAUTH_TOKEN: LIVE_UNTIL, CLAUDE_CODE_OAUTH_TOKEN_2: LIVE_UNTIL, CLAUDE_CODE_OAUTH_TOKEN_3: LIVE_UNTIL,
      },
      reservedAccounts: new Set(["CLAUDE_CODE_OAUTH_TOKEN_4", "CLAUDE_CODE_OAUTH_TOKEN_5"]),
      // list order would try account 4 before account 5; burn order must win.
      accountBurn: { CLAUDE_CODE_OAUTH_TOKEN_4: 500, CLAUDE_CODE_OAUTH_TOKEN_5: 10 },
    });
    const out = await run(h);
    expect(out).toEqual({ kind: "borrowed", from: "CLAUDE_CODE_OAUTH_TOKEN_3", to: "CLAUDE_CODE_OAUTH_TOKEN_5", fromRepo: null });
  });

  // -------------------------------------------------------------------
  // Mutation-style proof: the second pass genuinely only runs AFTER the
  // first pass fails. A reserved account that would be the "lowest burn" if
  // ever considered must NEVER outrank a free account still in this
  // studio's own chain — a mutant that ran both passes unconditionally and
  // picked lowest-burn globally would silently reopen #103/#117's
  // starvation bug. `accountBurnReads` proves the second pass's own read
  // port was never even touched, not just that its answer lost.
  // -------------------------------------------------------------------
  it("the first pass's own free candidate wins, and the second pass is never even consulted", async () => {
    const h = harness({
      accounts: four, pane: captured(MODAL_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
      initial: status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" }),
      // account 3 (current) limited; account 2 (own primary) FREE — the
      // first pass wraps back to it, same shape the golden #103 test uses.
      accountLimits: { CLAUDE_CODE_OAUTH_TOKEN_3: LIVE_UNTIL },
      reservedAccounts: new Set(["CLAUDE_CODE_OAUTH_TOKEN_4"]),
      // Reserved account 4 is free AND would have the lowest burn of all —
      // if the second pass ran at all, it would win over account 2.
      accountBurn: { CLAUDE_CODE_OAUTH_TOKEN_2: 9000, CLAUDE_CODE_OAUTH_TOKEN_4: 0 },
    });
    const out = await run(h);
    expect(out).toEqual({ kind: "switched", from: "CLAUDE_CODE_OAUTH_TOKEN_3", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(h.accountBurnReads).toBe(0);
    const last = h.recorded.at(-1)!;
    expect(last.borrowedAccount).toBeNull();
  });

  // -------------------------------------------------------------------
  // Review round 2 (maestro review of PR #135), finding 3 — the first pass
  // (`nextClaudeAccount` over `scopedAccounts`) only ever scans this
  // studio's OWN chain (primary forward); the borrow pass only ever scans
  // `reserved` names. An account that is BOTH positioned before this
  // studio's own primary AND not `reserved` for another repo — a genuinely
  // unclaimed spare — fell into a blind spot neither pass ever looked at,
  // so the old code jumped straight to borrowing another repo's primary
  // while a plain free spare sat unused.
  // -------------------------------------------------------------------
  describe("tier 2 — an unclaimed spare before this studio's own primary (review round 2, finding 3)", () => {
    const RESERVED_OTHER: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_6", token: "sk-ant-oat01-" + "f".repeat(40) };
    const SPARE: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_7", token: "sk-ant-oat01-" + "g".repeat(40) };
    const OWN_PRIMARY: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 };
    const OWN_CHAIN: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 };
    // List order: [repo-B's primary (reserved), a free plain spare, this
    // studio's own primary, the rest of its own chain] — the exact fixture
    // shape the maestro's own review comment describes.
    const accountsTier2: ClaudeAccount[] = [RESERVED_OTHER, SPARE, OWN_PRIMARY, OWN_CHAIN];

    it("scans every non-primary account, not just its own chain: the unclaimed spare wins over another repo's reserved primary", async () => {
      const h = harness({
        accounts: accountsTier2, pane: captured(MODAL_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
        initial: status({ claudeAccount: OWN_CHAIN.name }),
        // own primary AND the rest of the own chain (the current account)
        // both limited; the spare and the reserved other-repo primary are
        // left free.
        accountLimits: { [OWN_PRIMARY.name]: LIVE_UNTIL, [OWN_CHAIN.name]: LIVE_UNTIL },
        reservedAccounts: new Set([RESERVED_OTHER.name]),
      });
      const out = await run(h);
      expect(out).toEqual({ kind: "switched", from: OWN_CHAIN.name, to: SPARE.name });
      const last = h.recorded.at(-1)!;
      // Away from primary — tracked so hand-back can bring it home later
      // (finding 4), even though this was never a reserved-primary borrow.
      expect(last.borrowedAccount).toBe(SPARE.name);
      expect(last.borrowedFromRepo).toBeNull();
    });

    it("regression pin: when the spare is ALSO limited, it correctly falls through to borrowing the reserved primary", async () => {
      const h = harness({
        accounts: accountsTier2, pane: captured(MODAL_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
        initial: status({ claudeAccount: OWN_CHAIN.name }),
        accountLimits: { [OWN_PRIMARY.name]: LIVE_UNTIL, [OWN_CHAIN.name]: LIVE_UNTIL, [SPARE.name]: LIVE_UNTIL },
        reservedAccounts: new Set([RESERVED_OTHER.name]),
        otherRepoOf: (n) => (n === RESERVED_OTHER.name ? "repo-b" : null),
      });
      const out = await run(h);
      expect(out).toEqual({ kind: "borrowed", from: OWN_CHAIN.name, to: RESERVED_OTHER.name, fromRepo: "repo-b" });
    });
  });

  // -------------------------------------------------------------------
  // Review round 2 (maestro review of PR #135), finding 4 — once tier 2
  // (above) can land a studio on an account positioned BEFORE its own
  // primary, the #273 r2 widening (`Math.min(start, currentIdx)`) would,
  // left unguarded, let a LATER tick's ordinary first pass wrap back onto
  // ANOTHER pre-primary account too (violating #271) the moment that
  // borrowed account also became limited.
  // -------------------------------------------------------------------
  describe("scope stays anchored while actively borrowed (review round 2, finding 4)", () => {
    it("write-condition regression pin: a plain first-pass landing on a non-primary own-chain slot ALSO keeps borrowedAccount set, not just a reserved-primary borrow", async () => {
      const SPARE_BORROWED: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_6", token: "sk-ant-oat01-" + "m".repeat(40) };
      const PRIMARY: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 };
      const OWN_CHAIN_SLOT: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 };
      const h = harness({
        accounts: [SPARE_BORROWED, PRIMARY, OWN_CHAIN_SLOT], pane: captured(MODAL_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
        initial: status({
          claudeAccount: SPARE_BORROWED.name, launchedAccount: SPARE_BORROWED.name,
          borrowedAccount: SPARE_BORROWED.name, borrowedFromRepo: null,
        }),
        // The borrowed spare hits its own limit too; own primary is STILL
        // limited; the rest of the own chain (account 3) is free — pass 1
        // wraps to it, landing on a non-primary account yet again.
        accountLimits: { [SPARE_BORROWED.name]: LIVE_UNTIL, [PRIMARY.name]: LIVE_UNTIL },
      });
      const out = await run(h);
      expect(out).toEqual({ kind: "switched", from: SPARE_BORROWED.name, to: OWN_CHAIN_SLOT.name });
      const last = h.recorded.at(-1)!;
      // The OLD, buggy write cleared this here — `isBorrow` is false (this
      // landed via the ordinary first pass, never the reserved-primary
      // borrow pass) even though the studio is STILL away from its own
      // primary. Hand-back would then never have fired again once the
      // primary freed up.
      expect(last.borrowedAccount).toBe(OWN_CHAIN_SLOT.name);
      expect(last.borrowedFromRepo).toBeNull();
    });

    it("the search anchor never widens back to include an account before `start` while borrowed, even when one would otherwise be picked", async () => {
      // List order: [X (a free unclaimed spare, BEFORE the borrowed
      // account), the currently-borrowed account (now ALSO limited), Y (a
      // SECOND free unclaimed spare, BETWEEN the borrowed account and
      // primary — exactly the position the old #273 r2 widening bug would
      // expose to the ordinary first pass), primary (limited), a reserved
      // other-repo primary. If the first pass's own scope had widened back
      // to cover `current` (the old bug), stepping FORWARD from it would
      // land on Y (the very next position) — never X, which sits BEFORE
      // `current` and was never reachable by that widening even under the
      // old bug. Landing on X instead proves the first pass's own scope
      // stayed anchored at `start`: X is reachable ONLY via tier 2's own
      // explicit, list-order scan, never via the first pass stepping
      // forward from an out-of-scope `current`.
      const X: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_6", token: "sk-ant-oat01-" + "h".repeat(40) };
      const CUR: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_7", token: "sk-ant-oat01-" + "i".repeat(40) };
      const Y: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_8", token: "sk-ant-oat01-" + "j".repeat(40) };
      const PRIMARY: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 };
      const RESERVED: ClaudeAccount = { name: "CLAUDE_CODE_OAUTH_TOKEN_9", token: "sk-ant-oat01-" + "k".repeat(40) };
      const h = harness({
        accounts: [X, CUR, Y, PRIMARY, RESERVED], pane: captured(MODAL_PANE), primary: "CLAUDE_CODE_OAUTH_TOKEN_2", primaryIsMapped: true,
        initial: status({
          claudeAccount: CUR.name, launchedAccount: CUR.name, borrowedAccount: CUR.name, borrowedFromRepo: null,
        }),
        accountLimits: { [CUR.name]: LIVE_UNTIL, [PRIMARY.name]: LIVE_UNTIL },
        reservedAccounts: new Set([RESERVED.name]),
      });
      const out = await run(h);
      expect(out).toEqual({ kind: "switched", from: CUR.name, to: X.name });
      const last = h.recorded.at(-1)!;
      expect(last.borrowedAccount).toBe(X.name);
    });
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

  // Issue #249: a glm-lead studio has no claude account at all — `name` is
  // ignored, envAccount is undefined (there is nothing to record), and
  // envVars carries the ANTHROPIC_* pair instead.
  it("launchFields(..., \"glm\") ignores `name` and produces the ANTHROPIC_* env, envAccount undefined", () => {
    const f = launchFields(ENV, STUDIO_ID, SPAWN, "whatever", "glm");
    expect(f.envAccount).toBeUndefined();
    expect(f.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(f.envVars.ANTHROPIC_AUTH_TOKEN).toBe(SPAWN);
  });

  // #357 review item 1: the REAL StudioDO.failoverDeps closure, not a
  // test-built stand-in — called on a fake `this` holding only what the
  // closure reads (env, ctx.storage, selfId, primaryAccount, primaryIsMapped)
  // and the two fields it must set.
  it("StudioDO's own onSwitched sets BOTH the token it boots and the account it records to the new account", async () => {
    const mem = new Map<string, unknown>();
    const fakeThis = {
      env: ENV,
      ctx: { storage: { get: async (k: string) => mem.get(k), put: async (k: string, v: unknown) => { mem.set(k, v); } } },
      selfId: () => STUDIO_ID,
      primaryAccount: () => "CLAUDE_CODE_OAUTH_TOKEN",
      // Review round 3 (2nd review of PR #135, 2026-09-30): failoverDeps()
      // now also reads this — see do.ts's own method of the same name.
      primaryIsMapped: () => false,
      envVars: launchFields(ENV, STUDIO_ID, SPAWN, "CLAUDE_CODE_OAUTH_TOKEN").envVars,
      envAccount: "CLAUDE_CODE_OAUTH_TOKEN" as string | undefined,
    };
    const deps = (StudioDO.prototype as unknown as { failoverDeps(this: unknown): FailoverDeps }).failoverDeps.call(fakeThis);
    await deps.onSwitched!("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(fakeThis.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_2);
    expect(fakeThis.envAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  // Review round 2 (#210), finding 1 (BLOCKER, FIXED) — round 1's own test
  // here pinned `force: true`, reasoning it was the ONLY thing this
  // automated trigger overrides. That was wrong: `destroyStudio`'s own
  // `discardUnsynced: discardUnsynced || force` wiring ALSO turns a
  // probe-failure or a CONFIRMED rescue-push-failure refusal into "proceed
  // anyway" the moment `force` is `true` — exactly backwards for this
  // UNATTENDED trigger, which must never destroy without a successful
  // rescue. Fixed: `force: false` (so `discardUnsynced` stays exactly
  // `false`) and `skipOpenTaskGate: true` (the NEW 4th arg) does the job
  // `force: true` was actually reaching for — skip ONLY the open-task gate.
  it("StudioDO's own stopParkedStudio passes force=false, skipOpenTaskGate=true (never discardUnsynced) and hands back destroyStudio's real outcome", async () => {
    const REFUSAL: DestroyOutcome = {
      ok: false, refused: true,
      reason: "studio fleetflare--release-studio has an open assigned board task; pass --force to destroy anyway",
    };
    const destroyStudio = vi.fn(async (_force: boolean, _discardUnsynced: boolean, _park: boolean, _skipOpenTaskGate: boolean) => REFUSAL);
    const fakeThis = {
      env: ENV,
      ctx: { storage: { get: async () => undefined, put: async () => {} } },
      selfId: () => STUDIO_ID,
      primaryAccount: () => "CLAUDE_CODE_OAUTH_TOKEN",
      primaryIsMapped: () => false,
      envVars: launchFields(ENV, STUDIO_ID, SPAWN, "CLAUDE_CODE_OAUTH_TOKEN").envVars,
      envAccount: "CLAUDE_CODE_OAUTH_TOKEN" as string | undefined,
      destroyStudio,
    };
    const deps = (StudioDO.prototype as unknown as { failoverDeps(this: unknown): FailoverDeps }).failoverDeps.call(fakeThis);
    const outcome = await deps.stopParkedStudio!();

    // force=false, discardUnsynced=false (2nd arg) — a failed probe or an
    // unconfirmed rescue-push must still refuse exactly like it does today,
    // this call never pays for a human's `--discard-unsynced` choice.
    // park=true (3rd arg) — the exact "fleet destroy --park" verb.
    // skipOpenTaskGate=true (4th arg, NEW) — the ONLY thing this automated
    // trigger overrides: an open assigned board task alone must not block
    // it, with nobody there to retry `--force` by hand.
    expect(destroyStudio).toHaveBeenCalledWith(false, false, true, true);
    expect(outcome).toEqual(REFUSAL);
  });
});
