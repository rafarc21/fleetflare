import { describe, expect, it } from "vitest";
import { fleetTotals } from "../cli/fleet-totals";
import {
  formatDeadAccounts, formatActivity, lsJsonRows, ACTIVITY_DO_STALE_SECONDS,
} from "../cli/readiness-format";
import type { StudioStatus } from "../src/studio/types";
import type { Burn } from "../src/studio/burn";
import { emptyObserved } from "../src/studio/observed";
import { readActivityFrame, nextActivity, type Activity } from "../src/studio/activity";
import type { MemberAlert } from "../src/studio/member-alerts";
import { SHIP_TRANSCRIPT_SECONDS } from "../src/studio/ship-cadence";
import { REAL_PILOT_PANE } from "./fixtures/rate-limit-panes";
import { DEAD_FRAME } from "./studio.failover-real-panes.test";
import { row, burnRow } from "./helpers/studio-row";

// Fleet Spawn P3, Task 5 (R-P3-4: "fleet ls totals line if cheap"). Imports
// cli/fleet-totals.ts specifically, NOT cli/fleet.ts — the same reason
// test/cli.backoff.test.ts and test/cli.input.test.ts import cli/backoff.ts
// and cli/input.ts directly rather than cli/fleet.ts itself: cli/fleet.ts
// (and its own ./paste-mac import) touches `node:os`/`node:fs`/`Bun.file`/
// `Bun.spawn`, which type-checks fine under cli/tsconfig.json's own
// `"types": ["bun"]`, but would transitively drag those same declarations
// into the ROOT tsconfig.json's compilation graph the moment anything under
// test/ imported it — and the root project's `types` array has no "bun"
// entry, so `bun run check`'s first step would fail to resolve the `Bun`
// global. cli/fleet-totals.ts is a deliberately Bun/node-free pure module
// (see its own header) for exactly this reason.

// Sweep-18 F9 (#596): both fold onto test/helpers/studio-row. This file's
// burn() pins the FROZEN window5hStart (grid's uses `now`, per issue #181 —
// burnRow leaves the key required for exactly this divergence).
const burn = (o: Partial<Burn> = {}) => burnRow({ window5hStart: "2026-08-16T00:00:00.000Z", ...o });
const status = (o: Partial<StudioStatus> = {}) => row({ id: "websites--pilot", state: "running", ...o });

describe("fleetTotals (cli/fleet.ts)", () => {
  it("sums turns/outputTokens/window5hOutput across every studio", () => {
    const totals = fleetTotals([
      status({ id: "a", burn: burn({ turns: 7, outputTokens: 4231, window5hOutput: 908 }) }),
      status({ id: "b", burn: burn({ turns: 3, outputTokens: 100, window5hOutput: 50 }) }),
    ]);
    expect(totals).toEqual({ turns: 10, outputTokens: 4331, window5hOutput: 958 });
  });

  it("a null-burn studio (never synced yet) contributes zero, not NaN/crash", () => {
    const totals = fleetTotals([
      status({ id: "a", burn: null }),
      status({ id: "b", burn: burn({ turns: 5, outputTokens: 20, window5hOutput: 20 }) }),
    ]);
    expect(totals).toEqual({ turns: 5, outputTokens: 20, window5hOutput: 20 });
  });

  it("empty fleet yields all-zero totals", () => {
    expect(fleetTotals([])).toEqual({ turns: 0, outputTokens: 0, window5hOutput: 0 });
  });

  it("matches src/studio/grid.ts's computeFleetTotals field-for-field (same math, independent copies)", async () => {
    const { computeFleetTotals } = await import("../src/studio/grid");
    const b = burn({ turns: 4, outputTokens: 77, window5hOutput: 12 });
    const cliResult = fleetTotals([status({ burn: b })]);
    const gridResult = computeFleetTotals([{ burn: b }]);
    expect(cliResult).toEqual(gridResult);
  });
});

describe("formatDeadAccounts (cli/readiness-format.ts)", () => {
  it("no dead accounts at all: silent", () => {
    expect(formatDeadAccounts([])).toEqual([]);
    expect(formatDeadAccounts([{ name: "CLAUDE_CODE_OAUTH_TOKEN", label: null, dead: false, seenAt: null }])).toEqual([]);
  });

  it("one dead account, unlabelled: names the secret and the docs anchor", () => {
    const lines = formatDeadAccounts([
      { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, dead: true, seenAt: "2026-09-30T12:00:00.000Z" },
    ]);
    expect(lines).toEqual([
      "dead account: CLAUDE_CODE_OAUTH_TOKEN_2 — seen 2026-09-30T12:00:00.000Z — see docs/operations.md#clearing-a-dead-claude-account to clear it",
    ]);
  });

  it("one dead account, labelled: label first, secret name in parens", () => {
    const lines = formatDeadAccounts([
      { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: "ops@acme.com", dead: true, seenAt: "2026-09-30T12:00:00.000Z" },
    ]);
    expect(lines).toEqual([
      "dead account: ops@acme.com (CLAUDE_CODE_OAUTH_TOKEN_2) — seen 2026-09-30T12:00:00.000Z — see docs/operations.md#clearing-a-dead-claude-account to clear it",
    ]);
  });

  it("a non-dead account in the list is never printed, even alongside a dead one", () => {
    const lines = formatDeadAccounts([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", label: null, dead: false, seenAt: null },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, dead: true, seenAt: "2026-09-30T12:00:00.000Z" },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^dead account: CLAUDE_CODE_OAUTH_TOKEN_2\b/);
  });
});

// ---------------------------------------------------------------------------
// Issue #221 (PR3a, Task 5) — formatActivity, the ACTIVITY column's pure
// renderer. Every string here is pinned exactly to the design's own state
// table (docs/superpowers/specs/2026-09-24-row-tells-truth-design.md).
// ---------------------------------------------------------------------------
describe("formatActivity (cli/readiness-format.ts)", () => {
  const NOW = new Date("2026-09-25T12:02:00.000Z");

  function activity(overrides: Partial<Activity> = {}): Activity {
    return {
      state: "idle", since: "2026-09-25T12:00:00.000Z", anchored: true,
      observedAt: "2026-09-25T12:01:30.000Z", source: "pane", reason: null, membersTickingAt: null,
      ...overrides,
    };
  }

  it("WORKING <age>, from the mutated REAL_PILOT_PANE fixture read through readActivityFrame/nextActivity", () => {
    const pane = REAL_PILOT_PANE.replace("✻ Cogitated for 0s", "✻ Cogitating… (3s · esc to interrupt)");
    const verdict = readActivityFrame(pane);
    // anchored via a prior, DIFFERENT state — an observed change, not the
    // lower-bound first-ever tick (that case is IDLE ≥<age>, below).
    const prev = activity({ state: "idle", since: "2026-09-25T11:00:00.000Z" });
    const at = nextActivity(prev, verdict, null, null, new Date("2026-09-25T12:00:00.000Z"));
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    expect(formatActivity(s, new Date("2026-09-25T12:02:00.000Z"))).toBe("WORKING 2m");
  });

  // Issue #221 (PR3b) — the rendered string names a hook source when it was
  // one (spec, verbatim: "WORKING 40s (hook)"). source: "pane" (every PR3a
  // verdict, and any PR3b tick the hook did not win) is unchanged.
  it("WORKING <age> (hook) — the hook-sourced suffix, spec's own example string", () => {
    const at = activity({ state: "working", since: "2026-09-25T12:01:20.000Z", source: "hook" });
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    expect(formatActivity(s, NOW)).toBe("WORKING 40s (hook)");
  });

  it("a pane-sourced verdict never carries the hook suffix", () => {
    const at = activity({ state: "working", since: "2026-09-25T12:01:20.000Z", source: "pane" });
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    expect(formatActivity(s, NOW)).toBe("WORKING 40s");
  });

  it("WAITING MEMBERS <age>", () => {
    const at = activity({ state: "waiting-members", since: "2026-09-25T11:56:00.000Z" });
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    expect(formatActivity(s, NOW)).toBe("WAITING MEMBERS 6m");
  });

  // Issue #221 fix round 2, Fix 6 — a select-style menu (a permission prompt
  // included) is its own state, never a flavour of idle.
  it("WAITING QUESTION <age>", () => {
    const at = activity({ state: "waiting-question", since: "2026-09-25T11:58:00.000Z" });
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    expect(formatActivity(s, NOW)).toBe("WAITING QUESTION 4m");
  });

  it("IDLE <age>, anchored", () => {
    const at = activity({ state: "idle", since: "2026-09-25T11:15:00.000Z", anchored: true });
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    expect(formatActivity(s, new Date("2026-09-25T12:02:00.000Z"))).toBe("IDLE 47m");
  });

  it("IDLE ≥<age> — not yet anchored (no observed state CHANGE)", () => {
    const at = activity({ state: "idle", since: "2026-09-25T11:59:00.000Z", anchored: false });
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    expect(formatActivity(s, NOW)).toBe("IDLE ≥3m");
  });

  it("LIMIT · resets <clock> (UTC) — from row.rateLimited, never re-parsed", () => {
    const s = status({
      rateLimited: { until: "2026-09-25T13:30:00.000Z", seenAt: "2026-09-25T12:00:00.000Z" },
      observed: { ...emptyObserved(), activity: activity({ state: "limit" }) },
    });
    expect(formatActivity(s, NOW)).toBe("LIMIT · resets 1:30pm (UTC)");
  });

  it("LIMIT · modal — Esc (ff <id>) — a select modal, no clock ends it", () => {
    const s = status({
      id: "demosite-life--pilot",
      rateLimited: { until: null, seenAt: "2026-09-25T12:00:00.000Z", select: true },
      observed: { ...emptyObserved(), activity: activity({ state: "limit" }) },
    });
    expect(formatActivity(s, NOW)).toBe("LIMIT · modal — Esc (ff demosite-life--pilot)");
  });

  it("issue #141: DEAD · org disabled subscription access — outranks the select-modal branch too", () => {
    const s = status({
      rateLimited: { until: null, seenAt: "2026-09-25T12:00:00.000Z", dead: true },
      observed: { ...emptyObserved(), activity: activity({ state: "limit" }) },
    });
    expect(formatActivity(s, NOW)).toBe("DEAD · org disabled subscription access");
  });

  it("LIMIT outranks a stale-looking activity entry underneath it", () => {
    const s = status({
      rateLimited: { until: "2026-09-25T13:30:00.000Z", seenAt: "2026-09-25T12:00:00.000Z" },
      observed: { ...emptyObserved(), activity: activity({ state: "limit", observedAt: "2026-09-25T11:00:00.000Z" }) },
    });
    expect(formatActivity(s, NOW)).toBe("LIMIT · resets 1:30pm (UTC)");
  });

  it("? claude not on screen — DEAD_FRAME through the real pipeline", () => {
    const verdict = readActivityFrame(DEAD_FRAME);
    const at = nextActivity(null, verdict, null, null, new Date("2026-09-25T12:00:00.000Z"));
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    expect(formatActivity(s, new Date("2026-09-25T12:00:05.000Z"))).toBe("? claude not on screen");
  });

  it("? unrecognised frame", () => {
    const at = activity({ state: "unknown", reason: "unrecognised frame" });
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    expect(formatActivity(s, NOW)).toBe("? unrecognised frame");
  });

  it("? probe failed — the exec itself failed, a statement about the probe", () => {
    const at = activity({ state: "unknown", reason: "probe failed" });
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    expect(formatActivity(s, NOW)).toBe("? probe failed");
  });

  it("? stale <age> on the DO budget (90s) — renders the AGE, never the stored word", () => {
    const at = activity({ state: "working", observedAt: "2026-09-25T12:00:00.000Z" });
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    const now = new Date("2026-09-25T12:01:31.000Z"); // 91s later
    expect(formatActivity(s, now, ACTIVITY_DO_STALE_SECONDS)).toBe("? stale 1m"); // formatAge's own bucketing: 91s -> "1m"
    expect(formatActivity(s, now, ACTIVITY_DO_STALE_SECONDS)).not.toContain("WORKING");
  });

  it("? stale <age> on the D1-mirror budget (660s) — a fresher-looking word never survives past it", () => {
    const at = activity({ state: "idle", observedAt: "2026-09-25T12:00:00.000Z" });
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    const now = new Date("2026-09-25T12:11:01.000Z"); // 661s later
    expect(formatActivity(s, now)).toBe("? stale 11m");
    expect(formatActivity(s, now)).not.toContain("IDLE");
  });

  it("not yet stale (under the mirror budget): renders the stored word normally", () => {
    const at = activity({ state: "idle", since: "2026-09-25T11:00:00.000Z", observedAt: "2026-09-25T12:00:00.000Z" });
    const s = status({ observed: { ...emptyObserved(), activity: at } });
    const now = new Date("2026-09-25T12:10:00.000Z"); // 600s later, under 660s
    expect(formatActivity(s, now)).toBe("IDLE 70m");
  });

  it("— for a stopped studio", () => {
    const s = status({ state: "stopped" });
    expect(formatActivity(s, NOW)).toBe("—");
  });

  it("— for a stopped studio even with a stale-looking activity record left over", () => {
    const s = status({ state: "stopped", observed: { ...emptyObserved(), activity: activity({ state: "working" }) } });
    expect(formatActivity(s, NOW)).toBe("—");
  });

  // Issue #192 — a rollout can replace a running studio's container without
  // going through a clean onStop first, so the DO's stale `activity` key
  // from BEFORE the replacement survives (clearActivityState, activity.ts,
  // only fires on a graceful stop or a completed bring-up). `readyOverride`
  // (this same file) already renders "replaced <age> ago — not brought up"
  // off `observed.replacedAt` for exactly this state; the ACTIVITY column
  // must not contradict it with a leftover WORKING/WAITING-MEMBERS word.
  it("— for a running studio whose container was just replaced, even with a stale-looking activity record left over", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        replacedAt: "2026-09-25T12:00:00.000Z",
        activity: activity({ state: "waiting-members", since: "2026-09-25T11:56:00.000Z" }),
      },
    });
    expect(formatActivity(s, NOW)).toBe("—");
  });

  // Issue #403 — characterization table: every precedence kind, pinned on
  // BOTH surfaces before the leadGate fold. These pin CURRENT behavior;
  // the fold must keep every string byte-identical.
  it("#403 table: degraded state renders exactly as running", () => {
    const at = activity({ state: "working", since: "2026-09-25T12:01:20.000Z" });
    const s = status({ state: "degraded", observed: { ...emptyObserved(), activity: at } });
    expect(formatActivity(s, NOW)).toBe("WORKING 40s");
  });

  it("#403 table: bare LIMIT — until null, no select modal", () => {
    const s = status({
      rateLimited: { until: null, seenAt: "2026-09-25T12:00:00.000Z" },
      observed: { ...emptyObserved(), activity: activity({ state: "limit" }) },
    });
    expect(formatActivity(s, NOW)).toBe("LIMIT");
  });

  it("#403 table: a past reset falls through to the stored verdict underneath", () => {
    const s = status({
      rateLimited: { until: "2026-09-25T11:00:00.000Z", seenAt: "2026-09-25T10:00:00.000Z" },
      observed: { ...emptyObserved(), activity: activity({ state: "idle", since: "2026-09-25T11:15:00.000Z" }) },
    });
    expect(formatActivity(s, NOW)).toBe("IDLE 47m");
  });

  it("#403 table: an unparseable until falls through to the stored verdict underneath", () => {
    const s = status({
      rateLimited: { until: "not a date", seenAt: "2026-09-25T12:00:00.000Z" },
      observed: { ...emptyObserved(), activity: activity({ state: "idle", since: "2026-09-25T11:15:00.000Z" }) },
    });
    expect(formatActivity(s, NOW)).toBe("IDLE 47m");
  });

  it("#403 table: a stopped studio renders — for its activity regardless of a rateLimited record", () => {
    const s = status({
      state: "stopped",
      rateLimited: { until: "2026-09-25T13:30:00.000Z", seenAt: "2026-09-25T12:00:00.000Z" },
    });
    expect(formatActivity(s, NOW)).toBe("—");
  });

  it("#403 table: a stopped studio never carries the member-alert suffix", () => {
    const alerts: MemberAlert[] = [{
      kind: "memguard-kill", name: "vitest", at: "2026-09-25T12:00:00.000Z",
      detail: "comm=vitest rss_mib=612 pid=42", confidence: "measured",
    }];
    const s = status({ state: "stopped", observed: { ...emptyObserved(), memberAlerts: alerts } });
    expect(formatActivity(s, NOW)).toBe("—");
  });

  // The mirror of the stopped test above — the S1 line-pair's OTHER half.
  // `case "stopped"` early-returns bare; `case "replaced"` falls through to
  // the suffix, and that difference is invisible in the switch itself — this
  // pin is what keeps a future tidy-up from "unifying" them silently.
  it("#403 table: a replaced studio keeps the member-alert suffix on its —", () => {
    const alerts: MemberAlert[] = [{
      kind: "memguard-kill", name: "vitest", at: "2026-09-25T12:00:00.000Z",
      detail: "comm=vitest rss_mib=612 pid=42", confidence: "measured",
    }];
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        replacedAt: "2026-09-25T12:00:00.000Z",
        memberAlerts: alerts,
      },
    });
    expect(formatActivity(s, NOW)).toBe("— · member killed by memguard 2m ago (comm=vitest rss_mib=612 pid=42)");
  });

  it("#403 table: provisioning also renders — (no lead at all)", () => {
    const s = status({ state: "provisioning" });
    expect(formatActivity(s, NOW)).toBe("—");
  });

  // Issue #311 — a fresh member alert appends a " · <note>" suffix onto the
  // column, the ACTIVITY-column half of "surfaces as an ACTIVITY state ...
  // and a row note" (the OTHER half is formatObservedLines's own
  // "member alert:" line, above). No alerts at all: every test ABOVE this
  // one in this describe block never seeds memberAlerts and still asserts
  // an EXACT string with no suffix — that is this addition's own
  // regression guard.
  describe("member alert suffix", () => {
    it("appends the freshest alert's own formatted note", () => {
      const at = activity({ state: "idle", since: "2026-09-25T11:15:00.000Z" });
      const alerts: MemberAlert[] = [
        {
          kind: "memguard-kill", name: "vitest", at: "2026-09-25T12:00:00.000Z",
          detail: "comm=vitest rss_mib=612 pid=42", confidence: "measured",
        },
      ];
      const s = status({ observed: { ...emptyObserved(), activity: at, memberAlerts: alerts } });
      expect(formatActivity(s, NOW)).toBe("IDLE 47m · member killed by memguard 2m ago (comm=vitest rss_mib=612 pid=42)");
    });

    it("an inferred member-gone alert's suffix is marked [inferred]", () => {
      const at = activity({ state: "idle", since: "2026-09-25T11:15:00.000Z" });
      const alerts: MemberAlert[] = [
        {
          kind: "member-gone", name: "frontend-developer", at: "2026-09-25T12:00:00.000Z",
          detail: "frontend-developer — row vanished", confidence: "inferred",
        },
      ];
      const s = status({ observed: { ...emptyObserved(), activity: at, memberAlerts: alerts } });
      expect(formatActivity(s, NOW)).toContain("[inferred]");
    });

    it("no member alerts: no suffix at all", () => {
      const at = activity({ state: "idle", since: "2026-09-25T11:15:00.000Z" });
      const s = status({ observed: { ...emptyObserved(), activity: at, memberAlerts: [] } });
      expect(formatActivity(s, NOW)).toBe("IDLE 47m");
    });

    it("the suffix rides even a LIMIT row (the alert axis is independent of the lead's own state)", () => {
      const s = status({
        rateLimited: { until: "2026-09-25T13:30:00.000Z", seenAt: "2026-09-25T12:00:00.000Z" },
        observed: {
          ...emptyObserved(), activity: activity({ state: "limit" }),
          memberAlerts: [{
            kind: "poll-loop", name: "x", at: NOW.toISOString(),
            detail: "40m per its own clock, 400,000 tokens", confidence: "measured",
          }],
        },
      });
      expect(formatActivity(s, NOW)).toBe("LIMIT · resets 1:30pm (UTC) · long-running member x 0s ago (40m per its own clock, 400,000 tokens)");
    });
  });
});

// Issue #70 ask 4: coordinators scraped the table (and blank attach tabs) to
// learn what each lead was doing. `fleet ls --json`: one machine-readable
// lead state per studio, from the same data the ACTIVITY column renders.
describe("lsJsonRows", () => {
  const NOW = new Date("2026-09-25T12:02:00.000Z");
  const act = (o: Partial<Activity>): Activity => ({
    state: "idle", since: "2026-09-25T12:00:00.000Z", anchored: true,
    observedAt: "2026-09-25T12:01:30.000Z", source: "pane", reason: null, membersTickingAt: null, ...o,
  });
  const row = (o: Partial<StudioStatus>) => lsJsonRows([status(o)], NOW)[0];

  it("working / idle / waiting-* straight from the verdict, with since + the ACTIVITY text", () => {
    const r = row({ id: "demo--web-studio", repoSlug: "example-org/demo",
      observed: { ...emptyObserved(), activity: act({ state: "working", since: "2026-09-25T12:01:20.000Z" }) } });
    expect(r).toEqual({ id: "demo--web-studio", state: "running", repo: "example-org/demo",
      lead: "working", leadSince: "2026-09-25T12:01:20.000Z", limitResetsAt: null, activity: "WORKING 40s",
      lastLine: null, leadType: "claude", leadModel: null });
    expect(row({ observed: { ...emptyObserved(), activity: act({ state: "waiting-question" }) } }).lead).toBe("waiting-question");
  });

  it("issue #108: observed.lastMessageLine flows through to row.lastLine unchanged", () => {
    const r = row({ observed: { ...emptyObserved(), lastMessageLine: "Fixed the bug, running tests now." } });
    expect(r.lastLine).toBe("Fixed the bug, running tests now.");
    expect(row({}).lastLine).toBeNull();
  });

  it("limit with its reset time; modal when the limit menu is up", () => {
    const until = "2026-09-25T15:00:00.000Z";
    const seenAt = "2026-09-25T11:30:00.000Z";
    const r = row({ rateLimited: { until, seenAt } });
    expect(r.lead).toBe("limit");
    expect(r.limitResetsAt).toBe(until);
    expect(r.leadSince).toBe(seenAt);
    expect(row({ rateLimited: { until: null, seenAt, select: true } }).lead).toBe("modal");
  });

  it("issue #141: dead — permanent, no limitResetsAt, never falls through to 'modal' or 'limit'", () => {
    const seenAt = "2026-09-25T11:30:00.000Z";
    const r = row({ rateLimited: { until: null, seenAt, dead: true } });
    expect(r.lead).toBe("dead");
    expect(r.leadSince).toBe(seenAt);
    expect(r.limitResetsAt).toBeNull();
  });

  it("no verdict, or a stale one, is unknown -- never a guess", () => {
    expect(row({}).lead).toBe("unknown");
    const stale = act({ state: "working", observedAt: "2026-09-25T10:00:00.000Z" });
    expect(row({ observed: { ...emptyObserved(), activity: stale } }).lead).toBe("unknown");
  });

  it("a studio that is not running has no lead", () => {
    const r = row({ state: "stopped", observed: { ...emptyObserved(), activity: act({ state: "working" }) } });
    expect(r.lead).toBe("stopped");
    expect(r.leadSince).toBeNull();
  });

  // Issue #192 — a running studio whose container was just replaced
  // (replacedAt set, not yet confirmed back up) must report `lead:
  // "unknown"`, never a leftover verdict from before the replacement, even
  // when the stored activity record still looks fresh under the staleness
  // budget.
  it("issue #192: a replaced-but-not-yet-confirmed studio is unknown, never a leftover verdict", () => {
    const r = row({
      observed: {
        ...emptyObserved(),
        replacedAt: "2026-09-25T12:00:00.000Z",
        activity: act({ state: "waiting-members", since: "2026-09-25T11:56:00.000Z" }),
      },
    });
    expect(r.lead).toBe("unknown");
    expect(r.leadSince).toBeNull();
    expect(r.limitResetsAt).toBeNull();
  });

  // Board issue #332: `openPrs` per row — this studio's unmerged-PR count,
  // present ONLY when the open-prs route answered for its repo (fleet ls
  // passes the map openPrsByStudio built). Absence means "no data" (a route
  // that 404ed, an old Worker), never a silent 0 — the exact false-clean
  // reading this whole issue exists to prevent.
  it("#332: openPrs rides along only when the route answered for the studio", () => {
    const counted = lsJsonRows([status({ id: "websites--web-studio" })], NOW, undefined, new Map([["websites--web-studio", 2]]))[0];
    expect(counted.openPrs).toBe(2);
    const zero = lsJsonRows([status({ id: "websites--pilot" })], NOW, undefined, new Map([["websites--pilot", 0]]))[0];
    expect(zero.openPrs).toBe(0);
    // No map entry for this studio: NO openPrs key at all.
    const absent = lsJsonRows([status({ id: "beta--pilot" })], NOW, undefined, new Map([["websites--pilot", 1]]))[0];
    expect(Object.hasOwn(absent, "openPrs")).toBe(false);
    // No map passed (a caller predating this feature): unchanged shape.
    const noMap = lsJsonRows([status({ id: "websites--pilot" })], NOW)[0];
    expect(Object.hasOwn(noMap, "openPrs")).toBe(false);
  });

  // Issue #403 — the OTHER surface of the same characterization table:
  // same precedence kinds, same order, asserted on the JSON lead field.
  it("#403 table: degraded state is live — a fresh verdict flows through", () => {
    const r = row({ state: "degraded", observed: { ...emptyObserved(), activity: act({ state: "working", since: "2026-09-25T12:01:20.000Z" }) } });
    expect(r.lead).toBe("working");
    expect(r.leadSince).toBe("2026-09-25T12:01:20.000Z");
  });

  it("#403 table: bare limit — until null, no select — lead limit, reset null", () => {
    const r = row({ rateLimited: { until: null, seenAt: "2026-09-25T11:30:00.000Z" } });
    expect(r.lead).toBe("limit");
    expect(r.leadSince).toBe("2026-09-25T11:30:00.000Z");
    expect(r.limitResetsAt).toBeNull();
  });

  it("#403 table: a past reset falls through to the verdict underneath", () => {
    const r = row({
      rateLimited: { until: "2026-09-25T11:00:00.000Z", seenAt: "2026-09-25T10:00:00.000Z" },
      observed: { ...emptyObserved(), activity: act({ state: "working", since: "2026-09-25T12:01:20.000Z" }) },
    });
    expect(r.lead).toBe("working");
  });

  it("#403 table: an unparseable until falls through to the verdict underneath", () => {
    const r = row({
      rateLimited: { until: "not a date", seenAt: "2026-09-25T12:00:00.000Z" },
      observed: { ...emptyObserved(), activity: act({ state: "working", since: "2026-09-25T12:01:20.000Z" }) },
    });
    expect(r.lead).toBe("working");
  });

  it("#403 table: a stopped studio ignores a rateLimited record entirely", () => {
    const r = row({
      state: "stopped",
      rateLimited: { until: "2026-09-25T13:30:00.000Z", seenAt: "2026-09-25T12:00:00.000Z" },
    });
    expect(r.lead).toBe("stopped");
    expect(r.leadSince).toBeNull();
    expect(r.limitResetsAt).toBeNull();
  });

  it("#403 table: a stored limit verdict (no row.rateLimited) maps to lead limit with its own since", () => {
    const r = row({ observed: { ...emptyObserved(), activity: act({ state: "limit", since: "2026-09-25T11:00:00.000Z" }) } });
    expect(r.lead).toBe("limit");
    expect(r.leadSince).toBe("2026-09-25T11:00:00.000Z");
    expect(r.limitResetsAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Board issue #513 — the 90s staleness twins, pinned mechanically. Two budgets
// gate the same stored activity verdict on opposite sides of the Worker/CLI
// split: `ACTIVITY_DO_STALE_SECONDS` (cli/readiness-format.ts, the reader-side
// "?" budget) and `HOOK_STALE_BUDGET_MS` (src/studio/activity.ts, the
// hook-consumption budget). Both DERIVE from the ship tick's cadence
// (`SHIP_TRANSCRIPT_SECONDS`, src/studio/ship-cadence.ts) rather than each
// hardcoding its own 90 — bump the cadence and both budgets follow. The first
// pin checks the CLI constant against the cadence leaf directly; the second
// drives `nextActivity` to the Worker-side budget's exact boundary, because
// that budget is module-private and only observable through behavior.
// ---------------------------------------------------------------------------
describe("staleness-budget twins derive from SHIP_TRANSCRIPT_SECONDS (issue #513)", () => {
  it("ACTIVITY_DO_STALE_SECONDS is three ship ticks of the shared cadence", () => {
    expect(ACTIVITY_DO_STALE_SECONDS).toBe(SHIP_TRANSCRIPT_SECONDS * 3);
  });

  it("the hook-consumption budget is the same three ticks: a hook one second past them loses to the pane, one exactly at them still wins", () => {
    // Hook and pane AGREE on `idle` — the same shape the budget tests in
    // test/studio.activity.test.ts use — so the round-3 working-pane
    // asymmetry guard can never mask either outcome; only the budget
    // decides. prev.observedAt (12:00:00) predates both hook stamps, so the
    // "newer than last look" check passes for both too.
    const READ_AT = new Date("2026-09-25T12:10:00.000Z");
    const budgetMs = 3 * SHIP_TRANSCRIPT_SECONDS * 1000;
    const prev = nextActivity(null, { kind: "working" }, null, null, new Date("2026-09-25T12:00:00.000Z"));
    // One second PAST three ticks: stale, the pane's own verdict wins.
    const stale = nextActivity(prev, { kind: "idle" }, null, null, READ_AT, {
      state: "idle", at: new Date(READ_AT.getTime() - budgetMs - 1000).toISOString(),
    });
    expect(stale.source).toBe("pane");
    // Exactly three ticks old: the last instant that still wins.
    const fresh = nextActivity(prev, { kind: "idle" }, null, null, READ_AT, {
      state: "idle", at: new Date(READ_AT.getTime() - budgetMs).toISOString(),
    });
    expect(fresh.source).toBe("hook");
  });
});

// Issue #1074 ask 1: the lead model is verifiable without reading a screen —
// a MODEL column plus `leadType` / `leadModel` on every `fleet ls --json` row.
import { leadModelOf, formatLeadModelCell } from "../cli/lead-model";

describe("lead model (#1074): MODEL column and --json leadType/leadModel", () => {
  const T = new Date("2026-09-25T12:00:00.000Z");
  const ASSIGN: Record<string, string> = {
    "websites--pilot": "@cf/moonshotai/kimi-k2.7-code",
    "beta--pilot": "@cf/zai-org/glm-5.3",
  };

  it("a claude-led studio reads leadType claude and no leadModel", () => {
    expect(leadModelOf(status({ id: "websites--pilot" }), ASSIGN)).toEqual({ leadType: "claude", leadModel: null });
  });

  it("a glm-led studio assigned the kimi pool model reads leadType kimi and the short model id", () => {
    expect(leadModelOf(status({ id: "websites--pilot", leadType: "glm" }), ASSIGN))
      .toEqual({ leadType: "kimi", leadModel: "kimi-k2.7-code" });
  });

  it("a glm-led studio assigned the glm pool model reads leadType glm and its short model id", () => {
    expect(leadModelOf(status({ id: "beta--pilot", leadType: "glm" }), ASSIGN))
      .toEqual({ leadType: "glm", leadModel: "glm-5.3" });
  });

  it("a glm-led studio with no assignment reads leadType glm and no leadModel", () => {
    expect(leadModelOf(status({ id: "gamma--pilot", leadType: "glm" }), ASSIGN))
      .toEqual({ leadType: "glm", leadModel: null });
  });

  it("the MODEL cell is the lead type, plus the short model id when there is one", () => {
    expect(formatLeadModelCell({ leadType: "claude", leadModel: null })).toBe("claude");
    expect(formatLeadModelCell({ leadType: "kimi", leadModel: "kimi-k2.7-code" })).toBe("kimi kimi-k2.7-code");
  });

  it("lsJsonRows carries leadType and leadModel on every row", () => {
    const rows = lsJsonRows(
      [status({ id: "websites--pilot", leadType: "glm" }), status({ id: "gamma--pilot" })],
      T, undefined, undefined, undefined, ASSIGN,
    );
    expect(rows[0]).toMatchObject({ id: "websites--pilot", leadType: "kimi", leadModel: "kimi-k2.7-code" });
    expect(rows[1]).toMatchObject({ id: "gamma--pilot", leadType: "claude", leadModel: null });
  });

  it("lsJsonRows with no assignments map still names the lead type (glm, no model)", () => {
    const row = lsJsonRows([status({ id: "beta--pilot", leadType: "glm" })], T)[0];
    expect(row).toMatchObject({ leadType: "glm", leadModel: null });
  });
});
