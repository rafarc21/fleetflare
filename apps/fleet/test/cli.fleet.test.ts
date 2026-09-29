import { describe, expect, it } from "vitest";
import { fleetTotals } from "../cli/fleet-totals";
import {
  formatReady, formatCheckedAt, formatAge, readyOverride, formatSession, formatState, formatSessionGuards,
  formatObservedLines, formatSurvivalBriefs, formatActivity, ACTIVITY_DO_STALE_SECONDS, lsJsonRows,
} from "../cli/readiness-format";
import type { StudioStatus } from "../src/studio/types";
import type { Burn } from "../src/studio/burn";
import { emptyObserved, type SurvivalBriefPending } from "../src/studio/observed";
import { readActivityFrame, nextActivity, type Activity } from "../src/studio/activity";
import type { MemberAlert } from "../src/studio/member-alerts";
import { REAL_PILOT_PANE } from "./fixtures/rate-limit-panes";
import { DEAD_FRAME } from "./studio.failover-real-panes.test";

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

function burn(overrides: Partial<Burn> = {}): Burn {
  return {
    turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    window5hStart: "2026-08-16T00:00:00.000Z", window5hOutput: 0,
    ...overrides,
  };
}

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "websites--pilot", state: "running", tailscaleHost: null, lastRefresh: null,
    error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

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

// Fleet ls readiness fix ("a dead studio looks alive" — P5a Task 5's
// Finding 2). cli/readiness-format.ts, not cli/fleet.ts itself, for the
// SAME Bun-free-module reason this file's own header gives for
// cli/fleet-totals.ts.
describe("formatReady (cli/readiness-format.ts)", () => {
  it("never checked (readiness null): \"?\"", () => {
    expect(formatReady(null)).toBe("?");
  });

  it("never checked (readiness undefined — a pre-existing row): \"?\", same as null", () => {
    expect(formatReady(undefined)).toBe("?");
  });

  it("provisioned: the bare word, matching /studio/:id/provisioned's own vocabulary", () => {
    expect(formatReady({ kind: "provisioned", checkedAt: "2026-08-28T12:00:00.000Z" })).toBe("provisioned");
  });

  it("bare: \"bare: <reason>\", the container's own words", () => {
    expect(formatReady({ kind: "bare", reason: "no git checkout at /workspace/websites", checkedAt: "2026-08-28T12:00:00.000Z" }))
      .toBe("bare: no git checkout at /workspace/websites");
  });

  it("inconclusive: starts with \"?\" — never reads as a stale yes or a stale no", () => {
    const rendered = formatReady({ kind: "inconclusive", reason: "check unreachable: timeout", checkedAt: "2026-08-28T12:00:00.000Z" });
    expect(rendered.startsWith("?")).toBe(true);
    expect(rendered).toBe("? check unreachable: timeout");
  });

  it("a multi-line/whitespace-heavy reason collapses to one line, same as the ERROR column's own convention", () => {
    const rendered = formatReady({ kind: "bare", reason: "line one\nline  two\ttabbed", checkedAt: "2026-08-28T12:00:00.000Z" });
    expect(rendered).toBe("bare: line one line two tabbed");
  });
});

// Issue #37: "the default listing must say plainly how old each verdict is."
// A raw ISO timestamp does not — an operator comparing it against now, in
// their head, in UTC, is exactly how a 300s-old "bare" got read as current
// on 2026-09-23. The column is an AGE now; `now` is a parameter so this stays
// pure and there is no hidden clock to test around.
describe("formatCheckedAt (cli/readiness-format.ts)", () => {
  const NOW = new Date("2026-08-28T12:00:00.000Z");

  it("never checked: \"never\", never a bare dash that could read as \"just now\"", () => {
    expect(formatCheckedAt(null, NOW)).toBe("never");
    expect(formatCheckedAt(undefined, NOW)).toBe("never");
  });

  it("seconds, minutes, hours and days, in the largest whole unit", () => {
    const at = (iso: string) => formatCheckedAt({ kind: "provisioned", checkedAt: iso }, NOW);
    expect(at("2026-08-28T11:59:53.000Z")).toBe("7s ago");
    expect(at("2026-08-28T11:55:00.000Z")).toBe("5m ago");
    expect(at("2026-08-28T09:00:00.000Z")).toBe("3h ago");
    expect(at("2026-08-26T12:00:00.000Z")).toBe("2d ago");
  });

  it("a bare verdict's age reads the same way a provisioned one's does", () => {
    expect(formatCheckedAt({ kind: "bare", reason: "x", checkedAt: "2026-08-28T11:55:00.000Z" }, NOW)).toBe("5m ago");
  });

  it("a verdict stamped in the future (clock skew) reads 0s ago, never a negative age", () => {
    expect(formatCheckedAt({ kind: "provisioned", checkedAt: "2026-08-28T12:00:30.000Z" }, NOW)).toBe("0s ago");
  });

  it("an unparseable timestamp is shown verbatim rather than rendered as an age it is not", () => {
    expect(formatCheckedAt({ kind: "provisioned", checkedAt: "not-a-date" }, NOW)).toBe("not-a-date");
  });

  // Issue #85 review round 4, NIT 13 — this PR's own formatAge (used by
  // readyOverride/formatSession) deliberately promotes to hours/days only on
  // an EXACT multiple. The CHECKED column is not that: it is a plain
  // "how-stale-is-this-verdict" reading that predates this PR, and this PR
  // must not silently change its established, simple floor-based bucketing.
  // 484 minutes is not an exact multiple of 60 — main's own (pre-#85)
  // formatCheckedAt read this "8h ago" (Math.floor(484/60)); this PR's own
  // formatAge would instead read it "484m ago", dropping the remainder onto
  // the floor rather than the hour.
  it("CHECKED keeps the OLD simple floor-based bucketing, never formatAge's exact-multiple-only promotion", () => {
    const at = (iso: string) => formatCheckedAt({ kind: "provisioned", checkedAt: iso }, NOW);
    // NOW is 2026-08-28T12:00:00.000Z; 484 minutes earlier is 03:56:00.000Z.
    expect(at("2026-08-28T03:56:00.000Z")).toBe("8h ago");
  });
});

describe("formatAge (cli/readiness-format.ts)", () => {
  it("bare bucketed age, no suffix", () => {
    expect(formatAge(7)).toBe("7s");
    expect(formatAge(300)).toBe("5m");
    expect(formatAge(3 * 3600)).toBe("3h");
    expect(formatAge(2 * 86400)).toBe("2d");
  });
});

describe("readyOverride (cli/readiness-format.ts)", () => {
  const NOW = new Date("2026-09-24T12:00:00.000Z");

  // T1
  it("T1: replacedAt 6m ago, readiness still provisioned", () => {
    const s = status({
      state: "running",
      readiness: { kind: "provisioned", checkedAt: "2026-09-24T11:59:00.000Z" },
      observed: { ...emptyObserved(), replacedAt: "2026-09-24T11:54:00.000Z" },
    });
    expect(readyOverride(s, NOW)).toBe("replaced 6m ago — not brought up");
  });

  // T1b
  it("T1b: no observed at all (pre-feature row) — falls through to null", () => {
    const s = status({ state: "running", readiness: { kind: "provisioned", checkedAt: "2026-09-24T11:59:00.000Z" } });
    expect(readyOverride(s, NOW)).toBeNull();
  });

  // T2
  it("T2: unreachableSince 6m ago, a snapshot on file — the message carries its own cost (maestro correction #11)", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        unreachableSince: "2026-09-24T11:54:00.000Z",
        execFailures: 3,
        lastShipOkAt: "2026-09-24T11:53:00.000Z", // 7m before NOW — well past board issue #183's 90s
        lastSnapshotAt: "2026-09-24T10:57:00.000Z", // 63m before NOW
      },
    });
    expect(readyOverride(s, NOW)).toBe("unreachable 6m — wedged; recycle loses work since snap 63m");
  });

  it("T2b: unreachableSince set, no snapshot on file at all — never a bare '→ recycle' (maestro correction #11)", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(), unreachableSince: "2026-09-24T11:54:00.000Z", execFailures: 3,
        lastShipOkAt: "2026-09-24T11:53:00.000Z",
      },
    });
    expect(readyOverride(s, NOW)).toBe("unreachable 6m — wedged; recycle loses everything unshipped (no snapshot on file)");
  });

  // Board issue #183: replaces the old fixed `execFailures >= 3` gate with
  // "≥2 consecutive failures AND ≥90s since <anchor>". Review round 2,
  // MUST-FIX 2 — the anchor is `lastShipOkAt ?? unreachableSince`: a studio
  // wedged from its very FIRST tick never records a `lastShipOkAt` at all, so
  // falling back to `unreachableSince` (stamped at the first failure of a
  // streak, needing only one failure, never a prior success) is what lets
  // this override ever fire for exactly the studios most in need of it. See
  // `isUnreachable`'s own doc comment (observed.ts).
  it("board issue #183, MUST-FIX 2: unreachableSince set, execFailures >= 2, lastShipOkAt null — falls back to unreachableSince as the anchor and DOES override", () => {
    const s = status({
      state: "running",
      observed: { ...emptyObserved(), unreachableSince: "2026-09-24T11:54:00.000Z", execFailures: 2 }, // 6m before NOW
    });
    expect(readyOverride(s, NOW)).toBe("unreachable 6m — wedged; recycle loses everything unshipped (no snapshot on file)");
  });

  it("board issue #183, MUST-FIX 2: BOTH lastShipOkAt and unreachableSince null — genuinely nothing to measure from, no override", () => {
    const s = status({
      state: "running",
      observed: { ...emptyObserved(), execFailures: 2 }, // unreachableSince also null here
    });
    expect(readyOverride(s, NOW)).toBeNull();
  });

  it("board issue #183: unreachableSince set, execFailures >= 2, lastShipOkAt known but < 90s ago — no override yet", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(), unreachableSince: "2026-09-24T11:54:00.000Z", execFailures: 2,
        lastShipOkAt: "2026-09-24T11:58:35.000Z", // 85s before NOW — under the 90s threshold
      },
    });
    expect(readyOverride(s, NOW)).toBeNull();
  });

  // Board issue #183 review round 2, MUST-FIX 3(a) — an END-TO-END,
  // render-level pin: exactly 2 failures AND elapsed exactly the 90s
  // threshold must make `readyOverride`'s own output STRING actually show
  // "unreachable", not merely `isUnreachable`'s boolean (observed.ts already
  // has its own unit-level boundary test — this proves the render path wires
  // it through correctly end to end).
  it("MUST-FIX 3(a): execFailures === 2 AND elapsed EXACTLY 90s — readyOverride's own output string shows unreachable", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(), unreachableSince: "2026-09-24T11:58:30.000Z", execFailures: 2,
        lastShipOkAt: "2026-09-24T11:58:30.000Z", // exactly 90s before NOW
      },
    });
    const override = readyOverride(s, NOW);
    expect(override).not.toBeNull();
    expect(override).toContain("unreachable");
    expect(override).toBe("unreachable 1m — wedged; recycle loses everything unshipped (no snapshot on file)");
  });

  // MUST-FIX 3(a) negative half — one millisecond short of 90s must NOT show
  // unreachable, pinning the boundary is a genuine `>=`, not a looser `>`.
  it("MUST-FIX 3(a): execFailures === 2 AND elapsed 90s minus 1ms — readyOverride does not show unreachable", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(), unreachableSince: "2026-09-24T11:58:30.001Z", execFailures: 2,
        lastShipOkAt: "2026-09-24T11:58:30.001Z", // 1ms short of the 90s threshold
      },
    });
    expect(readyOverride(s, NOW)).toBeNull();
  });

  // T3
  it("T3: checkedAt 14m old, nothing else set", () => {
    const s = status({
      state: "running",
      readiness: { kind: "provisioned", checkedAt: "2026-09-24T11:46:00.000Z" },
      observed: { ...emptyObserved() },
    });
    expect(readyOverride(s, NOW)).toBe("unverified 14m — checks not completing → fleet inspect");
  });

  it("readiness null AND observed empty: no override, falls through", () => {
    const s = status({ state: "running", observed: { ...emptyObserved() } });
    expect(readyOverride(s, NOW)).toBeNull();
  });

  // T9
  it("T9: stopped studio — no override regardless of observed fields", () => {
    const s = status({
      state: "stopped",
      observed: { ...emptyObserved(), replacedAt: "2026-09-24T11:54:00.000Z" },
    });
    expect(readyOverride(s, NOW)).toBeNull();
  });

  // T10 — maestro correction #4: this is a RENDER-LOGIC regression test only
  // (readyOverride correctly does nothing for a non-"running" state). It does
  // NOT prove the operation lock actually protects a real bring-up — D1's own
  // STATUS_KEY read stays "running" for the WHOLE duration of a real
  // operation (provisionWithStorage/restartWithStorage write it only AFTER
  // runProvision/runRestart return), so this state never actually occurs in
  // a live D1 row. The REAL proof is the DO-level test in Task 4's
  // `test/studio.observation-tick.test.ts` ("runShipTickWithObservation —
  // op-lock guard"), which reads OPERATION_KEY directly, the way the real
  // ship tick does.
  it("T10: render-logic only (see Task 4's DO-level test for the real op-lock proof) — a non-running state never gets an override", () => {
    const s = status({
      state: "provisioning",
      observed: { ...emptyObserved(), unreachableSince: "2026-09-24T11:54:00.000Z" },
    });
    expect(readyOverride(s, NOW)).toBeNull();
  });

  it("first match wins: replaced beats unreachable beats unverified", () => {
    const s = status({
      state: "running",
      readiness: { kind: "provisioned", checkedAt: "2026-09-24T11:00:00.000Z" }, // stale too
      observed: {
        ...emptyObserved(),
        replacedAt: "2026-09-24T11:54:00.000Z",
        unreachableSince: "2026-09-24T11:50:00.000Z",
      },
    });
    expect(readyOverride(s, NOW)).toBe("replaced 6m ago — not brought up");
  });
});

describe("formatSession (cli/readiness-format.ts) — maestro correction #8: never a bare \"?\" or literal \"unknown\" when a snapshot age is known", () => {
  const NOW = new Date("2026-09-24T12:00:00.000Z");

  it("no observed at all, no snapshot known: \"?\" alone is the honest floor", () => {
    expect(formatSession(status({}), NOW)).toBe("? · snap ?");
  });

  it("no session recorded yet, but a snapshot age IS known: never throws away the snapshot info", () => {
    const s = status({
      observed: { ...emptyObserved(), lastSnapshotAt: "2026-09-24T11:57:00.000Z" },
    });
    expect(formatSession(s, NOW)).toBe("? · snap 3m");
  });

  it("verdict unknown: renders \"?\", never the literal word \"unknown\"", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T11:57:00.000Z",
        session: {
          verdict: "unknown", at: "2026-09-24T11:00:00.000Z", via: "adopted",
          restore: "not-attempted", snapshotAgeS: null, turnsBefore: 12, reason: "adopted: launch history unknown",
        },
      },
    });
    const rendered = formatSession(s, NOW);
    expect(rendered).toBe("? · snap 3m");
    expect(rendered).not.toContain("unknown");
  });

  // T4
  it("T4: resumed, snapshot 61m old at restore time", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T11:59:00.000Z",
        session: {
          verdict: "resumed", at: "2026-09-24T11:00:00.000Z", via: "recycle",
          restore: "restored", snapshotAgeS: 61 * 60, turnsBefore: 9, reason: null,
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("resumed · from snap 61m old · snap 1m");
  });

  // Review round 3 (issue #85 PR1), MUST-FIX 8(d): an upper-bound age
  // renders with a leading `≤` — the reader must never read it as exact.
  it("MUST-FIX 8(d): an upper-bound snapshot age renders with a leading ≤", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T11:59:00.000Z",
        session: {
          verdict: "resumed", at: "2026-09-24T11:00:00.000Z", via: "restart",
          restore: "restored", snapshotAgeS: 61 * 60, turnsBefore: 9, reason: null,
          snapshotAgeIsUpperBound: true,
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("resumed · from snap ≤61m old · snap 1m");
  });

  it("fresh, no snapshot age suffix, snap age shown", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T11:57:00.000Z",
        session: {
          verdict: "fresh", at: "2026-09-24T11:00:00.000Z", via: "provision",
          restore: "skip:no-snapshot", snapshotAgeS: null, turnsBefore: 0, reason: null,
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("fresh · snap 3m");
  });

  it("LOST: uppercase verdict, had <n> turns, no snap yet", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        session: {
          verdict: "lost", at: "2026-09-24T11:00:00.000Z", via: "restart",
          restore: "skip:has-projects", snapshotAgeS: null, turnsBefore: 412, reason: "no --continue",
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("LOST · had 412 turns · snap ?");
  });

  // T8
  it("T8: lastSnapshotAt 61m old, running -> STALE suffix", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T10:59:00.000Z",
        session: {
          verdict: "resumed", at: "2026-09-24T10:00:00.000Z", via: "heal",
          restore: "restored", snapshotAgeS: 30, turnsBefore: 4, reason: null,
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("resumed · snap 61m STALE");
  });

  it("a stale snapshot on a STOPPED studio never renders STALE", () => {
    const s = status({
      state: "stopped",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T10:59:00.000Z",
        session: {
          verdict: "resumed", at: "2026-09-24T10:00:00.000Z", via: "heal",
          restore: "restored", snapshotAgeS: 30, turnsBefore: 4, reason: null,
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("resumed · snap 61m");
  });

  // Board #250 (#85/#118 follow-up) — a keeper-sourced restore renders
  // distinctly (`from daily <date> snap N old`) rather than the plain
  // `from snap N old` a `latest` restore gets, since `snapshotAgeS` alone
  // gives an operator no way to tell the two apart.
  it("#250: session.snapshotSource set (keeper restore) renders 'from daily <date> snap N old', not the plain 'from snap N old'", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T11:59:00.000Z",
        session: {
          verdict: "resumed", at: "2026-09-24T11:00:00.000Z", via: "restart",
          restore: "restored", snapshotAgeS: 3 * 24 * 60 * 60, turnsBefore: 9, reason: null,
          snapshotSource: "daily 2026-09-20",
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("resumed · from daily 2026-09-20 snap 3d old · snap 1m");
  });

  // Same fixture, no `snapshotSource` at all (a `latest` restore, or the
  // absence of one) — the untouched, existing rendering, pinned here right
  // alongside #250's own new case so a regression in either direction shows
  // up as a single diff.
  it("#250: session.snapshotSource absent (latest restore) renders the plain 'from snap N old', unchanged", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T11:59:00.000Z",
        session: {
          verdict: "resumed", at: "2026-09-24T11:00:00.000Z", via: "restart",
          restore: "restored", snapshotAgeS: 3 * 24 * 60 * 60, turnsBefore: 9, reason: null,
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("resumed · from snap 3d old · snap 1m");
  });
});

// Issue #95: a studio recorded stopped whose container is running is billing
// with nothing in the registry to say so. STATE carries the detector's
// verdict, so the one column an operator scans for "is this off" cannot lie.
describe("formatState (cli/readiness-format.ts)", () => {
  it("stopped + container seen running: says RUNNING, since when (UTC), and billing", () => {
    expect(formatState(status({ state: "stopped", containerRunningSince: "2026-09-24T12:39:08.000Z" })))
      .toBe("stopped (container RUNNING since 12:39Z — billing)");
  });

  it("stopped with no mismatch recorded: the bare state", () => {
    expect(formatState(status({ state: "stopped" }))).toBe("stopped");
    expect(formatState(status({ state: "stopped", containerRunningSince: null }))).toBe("stopped");
  });

  it("a stale mark on a studio that is no longer stopped is not rendered: a running container is expected there", () => {
    expect(formatState(status({ state: "running", containerRunningSince: "2026-09-24T12:39:08.000Z" }))).toBe("running");
  });

  it("an unparseable timestamp is shown verbatim", () => {
    expect(formatState(status({ state: "stopped", containerRunningSince: "garbage" })))
      .toBe("stopped (container RUNNING since garbage — billing)");
  });
});

describe("formatSessionGuards (cli/readiness-format.ts) — issue #94", () => {
  const row = (id: string, sessionGuard?: StudioStatus["sessionGuard"]) => ({ id, sessionGuard }) as StudioStatus;

  // PR #46 review (#37): an aside session not reaching R2 is on `fleet ls`.
  it("one ASIDE line per unshipped aside dir; silent when asideShip is null", () => {
    const lines = formatSessionGuards([
      { id: "e--x", asideShip: null } as StudioStatus,
      { id: "f--x", asideShip: { at: "2026-09-29T10:00:00.000Z", failed: [
        { dir: "fleet-aside-1-k", reason: "aside dir 2000000000 bytes raw exceeds SESSION_ASIDE_RAW_MAX 1073741824; left on disk, not shipped" },
      ] } } as StudioStatus,
    ]);
    expect(lines).toEqual([
      "ASIDE f--x: NOT SHIPPED fleet-aside-1-k as of 2026-09-29T10:00:00.000Z (aside dir 2000000000 bytes raw exceeds SESSION_ASIDE_RAW_MAX 1073741824; left on disk, not shipped)",
    ]);
  });

  it("one line per studio whose last candidate was displaced; silent for the rest", () => {
    const lines = formatSessionGuards([
      row("a--x"),
      row("b--x", null),
      row("c--x", { at: "2026-09-24T09:52:00.000Z", key: "sessions/c--x/displaced/2026-09-24T09:52:00.000Z.tar.gz", reason: "missing newest session file f" }),
    ]);
    expect(lines).toEqual([
      "SESSION GUARD c--x: kept latest at 2026-09-24T09:52:00.000Z, candidate -> sessions/c--x/displaced/2026-09-24T09:52:00.000Z.tar.gz (missing newest session file f)",
    ]);
  });

  it("an oversize refusal gets its own line: not synced since when, how big, latest stale, burn frozen (#176)", () => {
    const lines = formatSessionGuards([
      row("d--x", {
        at: "2026-09-24T10:00:00.000Z", key: "", reason: "oversize: …",
        tarBytes: 35 * 1024 * 1024 + 512 * 1024, capBytes: 32 * 1024 * 1024,
      }),
    ]);
    expect(lines).toEqual([
      "SESSION GUARD d--x: NOT SYNCED since 2026-09-24T10:00:00.000Z; tar 35.5 MiB > cap 32 MiB; latest stale; burn not updating",
    ]);
  });

  // Issue #228 item 5: an armed force-next-sync override was previously
  // invisible on `fleet ls` — this closes that gap.
  it("an armed force-next-sync override gets its own line, silent once cleared", () => {
    const armed = { id: "e--x", sessionForceArmedAt: "2026-09-24T10:00:00.000Z" } as StudioStatus;
    const cleared = { id: "f--x", sessionForceArmedAt: null } as StudioStatus;
    const neverArmed = { id: "g--x" } as StudioStatus;

    expect(formatSessionGuards([armed])).toEqual([
      "SESSION GUARD e--x: force-next-sync armed since 2026-09-24T10:00:00.000Z",
    ]);
    expect(formatSessionGuards([cleared])).toEqual([]);
    expect(formatSessionGuards([neverArmed])).toEqual([]);
  });

  // HOLD fix round NIT: the pair of lines this test exercises is realistic
  // for an OVERSIZE refusal (clearSessionGuard deliberately leaves that one
  // alone — issue #176) or a candidate displaced AFTER arming (blank,
  // unreadable, or un-forceable) — NOT, as this test used to claim, "the
  // armed override still showing the OLD refusal until the next tick" —
  // clearSessionGuard nulls a non-oversize refusal on the SAME write that
  // arms the override. See formatSessionGuards's own doc comment
  // (readiness-format.ts) for the corrected explanation.
  it("a studio can carry BOTH a refusal and an armed override at once — two lines, refusal first", () => {
    const s = {
      id: "h--x",
      sessionGuard: { at: "2026-09-24T09:52:00.000Z", key: "sessions/h--x/displaced/2026-09-24T09:52:00.000Z.tar.gz", reason: "missing newest session file f" },
      sessionForceArmedAt: "2026-09-24T10:00:00.000Z",
    } as StudioStatus;

    expect(formatSessionGuards([s])).toEqual([
      "SESSION GUARD h--x: kept latest at 2026-09-24T09:52:00.000Z, candidate -> sessions/h--x/displaced/2026-09-24T09:52:00.000Z.tar.gz (missing newest session file f)",
      "SESSION GUARD h--x: force-next-sync armed since 2026-09-24T10:00:00.000Z",
    ]);
  });

  // Issue #258 round-3 (maestro brief item 3): `StudioStatus.burnPersistError`
  // (round 2 wired the write side onto the registry row; this closes the
  // render gap on `fleet ls` itself) — a DISTINCT failure from `sessionGuard`,
  // its own line, silent once absent/cleared.
  it("a burn cursor/burn persist failure gets its own line, silent once cleared", () => {
    const failed = {
      id: "i--x",
      burnPersistError: { at: "2026-09-25T00:00:00.000Z", reason: "burn cursor/burn persist failed: value too large" },
    } as StudioStatus;
    const cleared = { id: "j--x", burnPersistError: null } as StudioStatus;
    const neverFailed = { id: "k--x" } as StudioStatus;

    expect(formatSessionGuards([failed])).toEqual([
      "BURN PERSIST i--x: FAILED since 2026-09-25T00:00:00.000Z (burn cursor/burn persist failed: value too large)",
    ]);
    expect(formatSessionGuards([cleared])).toEqual([]);
    expect(formatSessionGuards([neverFailed])).toEqual([]);
  });

  it("a studio can carry a sessionGuard refusal AND a burn-persist failure at once — two distinct lines", () => {
    const s = {
      id: "l--x",
      sessionGuard: { at: "2026-09-24T09:52:00.000Z", key: "sessions/l--x/displaced/2026-09-24T09:52:00.000Z.tar.gz", reason: "missing newest session file f" },
      burnPersistError: { at: "2026-09-25T00:00:00.000Z", reason: "value too large" },
    } as StudioStatus;

    expect(formatSessionGuards([s])).toEqual([
      "SESSION GUARD l--x: kept latest at 2026-09-24T09:52:00.000Z, candidate -> sessions/l--x/displaced/2026-09-24T09:52:00.000Z.tar.gz (missing newest session file f)",
      "BURN PERSIST l--x: FAILED since 2026-09-25T00:00:00.000Z (value too large)",
    ]);
  });
});

// Board issue #85 review, BLOCKER 2: `fleet inspect` used to read
// `body.observed.replacedAt`/`.unreachableSince`/`.session` unconditionally,
// crashing (TypeError: Cannot read properties of undefined) whenever the
// response body carried no `observed` field at all — either the DO-side
// "Worker->DO call failed" failure branch (routes.ts, a rejection from
// `stub.inspect` itself, never reaching `runInspect`), or a Worker deployed
// before this feature landed, talking to a NEWER CLI. `formatObservedLines`
// is the pure formatter `cmdInspect` now calls, extracted so these 4 body
// shapes are provable without any CLI I/O.
describe("formatObservedLines (cli/readiness-format.ts) — issue #85 review BLOCKER 2", () => {
  it("case 1: full observed, a session verdict present", () => {
    const observed = {
      ...emptyObserved(),
      replacedAt: "2026-09-24T11:54:00.000Z",
      session: {
        verdict: "resumed" as const, at: "2026-09-24T11:55:00.000Z", via: "restart" as const,
        restore: "restored" as const, snapshotAgeS: 30, turnsBefore: 12, reason: null,
      },
    };
    expect(formatObservedLines(observed)).toEqual([
      "replaced:     yes, since 2026-09-24T11:54:00.000Z",
      "unreachable:  no",
      "session:      resumed (via restart)",
      "activity:     ?",
    ]);
  });

  it("case 2: observed present but session is null", () => {
    const observed = { ...emptyObserved() };
    expect(formatObservedLines(observed)).toEqual([
      "replaced:     no",
      "unreachable:  no",
      "session:      ? (no verdict recorded yet)",
      "activity:     ?",
    ]);
  });

  // Review round 6, MUST-FIX 3: `cmdInspect` (cli/fleet.ts) cannot tell these
  // two apart — both reach it as `body.observed === undefined` — so the
  // wording says both rather than guessing one.
  it("case 3: observed is undefined (pre-#85 Worker, or the DO-call-failed branch) — never crashes", () => {
    expect(formatObservedLines(undefined)).toEqual([
      "observed:     ? (DO call failed, or Worker predates #85)",
    ]);
  });

  // Issue #85 review round 4, NIT 15 — the verdict's own `reason` (LOST/
  // unknown carry one; resumed/fresh never do — observed.ts's own
  // ObservedSession doc comment) is worth the same real estate on `fleet
  // inspect` as `via` already gets: an operator reading "lost (via restart)"
  // still has to go dig for WHY before deciding anything.
  it("NIT 15: a session verdict with a reason appends it, em-dash separated", () => {
    const observed = {
      ...emptyObserved(),
      session: {
        verdict: "lost" as const, at: "2026-09-24T11:55:00.000Z", via: "restart" as const,
        restore: "not-attempted" as const, snapshotAgeS: null, turnsBefore: 40, reason: "no --continue",
      },
    };
    expect(formatObservedLines(observed)).toEqual([
      "replaced:     no",
      "unreachable:  no",
      "session:      lost (via restart) — no --continue",
      "activity:     ?",
    ]);
  });

  it("NIT 15: a session verdict with no reason (resumed/fresh) renders exactly as before — no trailing em-dash", () => {
    const observed = {
      ...emptyObserved(),
      session: {
        verdict: "resumed" as const, at: "2026-09-24T11:55:00.000Z", via: "restart" as const,
        restore: "restored" as const, snapshotAgeS: 30, turnsBefore: 12, reason: null,
      },
    };
    expect(formatObservedLines(observed)).toEqual([
      "replaced:     no",
      "unreachable:  no",
      "session:      resumed (via restart)",
      "activity:     ?",
    ]);
  });

  it("case 4: replacedAt AND unreachableSince both set at once (the simultaneous edge case)", () => {
    const NOW = new Date("2026-09-24T12:00:00.000Z");
    const observed = {
      ...emptyObserved(),
      replacedAt: "2026-09-24T11:54:00.000Z",
      unreachableSince: "2026-09-24T11:50:00.000Z",
      execFailures: 3,
      lastShipOkAt: "2026-09-24T11:49:00.000Z", // 11m before NOW — well past board issue #183's 90s
    };
    expect(formatObservedLines(observed, NOW)).toEqual([
      "replaced:     yes, since 2026-09-24T11:54:00.000Z",
      "unreachable:  yes, since 2026-09-24T11:50:00.000Z",
      "session:      ? (no verdict recorded yet)",
      "activity:     ?",
    ]);
  });

  // Board issue #183: `unreachableSince` is stamped at the FIRST failure of a
  // streak (do.ts, issue #85 review round 3 MUST-FIX 7), not once the studio
  // is actually considered unreachable — so a streak that has NOT yet
  // crossed the render threshold (>=2 consecutive failures AND >=90s since
  // `lastShipOkAt`, matching `readyOverride`'s own gate) must not read
  // "unreachable: yes" off `unreachableSince` alone.
  it("MUST-FIX 3: a 1-failure streak (below the failure-count threshold) does not claim unreachable", () => {
    const NOW = new Date("2026-09-24T12:00:00.000Z");
    const observed = {
      ...emptyObserved(),
      unreachableSince: "2026-09-24T11:58:00.000Z",
      execFailures: 1,
      lastShipOkAt: "2026-09-24T11:58:00.000Z",
    };
    expect(formatObservedLines(observed, NOW)).toEqual([
      "replaced:     no",
      "unreachable:  no (1 failed ticks since 2026-09-24T11:58:00.000Z)",
      "session:      ? (no verdict recorded yet)",
      "activity:     ?",
    ]);
  });

  it("board issue #183: a 2-failure streak but lastShipOkAt < 90s ago does not claim unreachable", () => {
    const NOW = new Date("2026-09-24T12:00:00.000Z");
    const observed = {
      ...emptyObserved(),
      unreachableSince: "2026-09-24T11:59:00.000Z",
      execFailures: 2,
      lastShipOkAt: "2026-09-24T11:58:35.000Z", // 85s before NOW
    };
    expect(formatObservedLines(observed, NOW)).toEqual([
      "replaced:     no",
      "unreachable:  no (2 failed ticks since 2026-09-24T11:59:00.000Z)",
      "session:      ? (no verdict recorded yet)",
      "activity:     ?",
    ]);
  });

  it("board issue #183: a 2-failure streak with lastShipOkAt >= 90s ago crosses the threshold — same as readyOverride's own gate", () => {
    const NOW = new Date("2026-09-24T12:00:00.000Z");
    const observed = {
      ...emptyObserved(),
      unreachableSince: "2026-09-24T11:59:00.000Z",
      execFailures: 2,
      lastShipOkAt: "2026-09-24T11:58:00.000Z", // 120s before NOW
    };
    expect(formatObservedLines(observed, NOW)).toEqual([
      "replaced:     no",
      "unreachable:  yes, since 2026-09-24T11:59:00.000Z",
      "session:      ? (no verdict recorded yet)",
      "activity:     ?",
    ]);
  });

  // Board issue #183 review round 2, MUST-FIX 2 — a studio wedged from its
  // very first tick never records a `lastShipOkAt`, but DOES stamp
  // `unreachableSince` at that first failure. With the `lastShipOkAt ??
  // unreachableSince` anchor, an hour with `execFailures >= 2` and no
  // `lastShipOkAt` at all now correctly claims unreachable — this exact
  // studio is the one this fix exists for.
  it("board issue #183, MUST-FIX 2: execFailures >= 2, lastShipOkAt null, unreachableSince old enough — falls back and claims unreachable", () => {
    const NOW = new Date("2026-09-24T12:00:00.000Z");
    const observed = {
      ...emptyObserved(),
      unreachableSince: "2026-09-24T11:00:00.000Z",
      execFailures: 5,
    };
    expect(formatObservedLines(observed, NOW)).toEqual([
      "replaced:     no",
      "unreachable:  yes, since 2026-09-24T11:00:00.000Z",
      "session:      ? (no verdict recorded yet)",
      "activity:     ?",
    ]);
  });

  it("board issue #183, MUST-FIX 2: BOTH lastShipOkAt and unreachableSince null — genuinely nothing to measure from, never claims unreachable", () => {
    const NOW = new Date("2026-09-24T12:00:00.000Z");
    const observed = { ...emptyObserved(), execFailures: 5 };
    expect(formatObservedLines(observed, NOW)).toEqual([
      "replaced:     no",
      "unreachable:  no",
      "session:      ? (no verdict recorded yet)",
      "activity:     ?",
    ]);
  });

  // ---------------------------------------------------------------------------
  // Issue #221 fix round 2, Fix 5 — `fleet inspect` never printed an ACTIVITY
  // line at all before this fix, despite reading the DO's own `activity` key
  // directly (zero container cost). These pin the new `activity:` line and
  // its own 90s (`ACTIVITY_DO_STALE_SECONDS`, three ship ticks) budget —
  // distinct from `fleet ls`'s looser 660s D1-mirror budget.
  // ---------------------------------------------------------------------------
  it("Fix 5: activity line prints the stored word when fresh (DO-direct read)", () => {
    const NOW = new Date("2026-09-25T12:02:00.000Z");
    const observed = {
      ...emptyObserved(),
      activity: {
        state: "working" as const, since: "2026-09-25T12:00:00.000Z", anchored: true,
        observedAt: "2026-09-25T12:01:45.000Z", source: "pane" as const, reason: null, membersTickingAt: null,
      },
    };
    expect(formatObservedLines(observed, NOW)).toEqual([
      "replaced:     no",
      "unreachable:  no",
      "session:      ? (no verdict recorded yet)",
      "activity:     WORKING 2m",
    ]);
  });

  it("Fix 5: activity line renders '? stale <age>' past the 90s DO-direct budget, never the stored word (ACTIVITY_DO_STALE_SECONDS actually wired now)", () => {
    const NOW = new Date("2026-09-25T12:02:00.000Z"); // 105s after observedAt below
    const observed = {
      ...emptyObserved(),
      activity: {
        state: "working" as const, since: "2026-09-25T12:00:00.000Z", anchored: true,
        observedAt: "2026-09-25T12:00:15.000Z", source: "pane" as const, reason: null, membersTickingAt: null,
      },
    };
    const lines = formatObservedLines(observed, NOW);
    expect(lines[3]).toBe("activity:     ? stale 1m");
    expect(lines[3]).not.toContain("WORKING");
  });

  it("Fix 5: a 'probe failed' verdict prints its own reason, not a bare '?'", () => {
    const NOW = new Date("2026-09-25T12:00:10.000Z");
    const observed = {
      ...emptyObserved(),
      activity: {
        state: "unknown" as const, since: "2026-09-25T12:00:00.000Z", anchored: false,
        observedAt: "2026-09-25T12:00:00.000Z", source: "pane" as const, reason: "probe failed", membersTickingAt: null,
      },
    };
    expect(formatObservedLines(observed, NOW)).toEqual([
      "replaced:     no",
      "unreachable:  no",
      "session:      ? (no verdict recorded yet)",
      "activity:     ? probe failed",
    ]);
  });

  // Issue #311 — one "member alert:" line per current MemberAlert, appended
  // after the fixed 4-line block above. `activity:`'s OWN line 4-of-4 shape
  // is unchanged by this feature (see every OTHER case in this describe
  // block, none of which seed memberAlerts and all of which still assert an
  // EXACT 4-line array — that is this addition's own regression guard: a
  // null/absent memberAlerts must add nothing).
  it("issue #311: appends one 'member alert:' line per current alert", () => {
    const NOW = new Date("2026-09-25T12:10:00.000Z");
    const alerts: MemberAlert[] = [
      {
        kind: "memguard-kill", name: "vitest", at: "2026-09-25T12:08:00.000Z",
        detail: "comm=vitest rss_mib=612 pid=42", confidence: "measured",
      },
      {
        kind: "poll-loop", name: "frontend-developer", at: "2026-09-25T11:30:00.000Z",
        detail: "40m per its own clock, 400,000 tokens", confidence: "measured",
      },
    ];
    const observed = { ...emptyObserved(), memberAlerts: alerts };
    const lines = formatObservedLines(observed, NOW);
    expect(lines).toHaveLength(6);
    expect(lines[4]).toBe("member alert: member killed by memguard 2m ago (comm=vitest rss_mib=612 pid=42)");
    expect(lines[5]).toBe("member alert: long-running member frontend-developer 40m ago (40m per its own clock, 400,000 tokens)");
  });

  it("issue #311: no member alerts (null or empty) adds nothing — the 4-line shape is unchanged", () => {
    const NOW = new Date("2026-09-25T12:10:00.000Z");
    expect(formatObservedLines({ ...emptyObserved(), memberAlerts: null }, NOW)).toHaveLength(4);
    expect(formatObservedLines({ ...emptyObserved(), memberAlerts: [] }, NOW)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Issue #249 (PR4b) round 2, item 2 — the row says when a re-brief is owed, and
// when the studio has STOPPED trying. #107's whole complaint is a lead that was
// never told what survived and nothing anywhere saying so.
// ---------------------------------------------------------------------------

describe("formatSurvivalBriefs (cli/readiness-format.ts) — issue #249 round 2", () => {
  const pending = (over: Partial<SurvivalBriefPending> = {}): SurvivalBriefPending => ({
    incarnation: "inc-aaaaaaaa", via: "recycle", replacementDetected: false,
    session: {
      verdict: "resumed", at: "2026-09-25T12:00:00.000Z", via: "recycle", restore: "restored",
      snapshotAgeS: 600, turnsBefore: 12, reason: null,
    },
    since: "2026-09-25T12:00:00.000Z", attempts: 2, reason: "pane repainted within 3s — a turn is in flight",
    ...over,
  });
  const row = (id: string, p?: SurvivalBriefPending | null) =>
    ({ id, observed: p === undefined ? undefined : { ...emptyObserved(), survivalBriefPending: p } }) as StudioStatus;

  it("silent for a studio that owes nothing, and for one whose Worker predates the field", () => {
    expect(formatSurvivalBriefs([row("a--x"), row("b--x", null)])).toEqual([]);
  });

  it("a brief still being retried says so, with the attempt count and the last reason", () => {
    expect(formatSurvivalBriefs([row("c--x", pending())])).toEqual([
      "SURVIVAL c--x: re-brief pending since 2026-09-25T12:00:00.000Z, 2 attempts so far — pane repainted within 3s — a turn is in flight",
    ]);
  });

  it("MUTANT: drop the give-up state and this goes red — `re-brief undelivered` on the row", () => {
    // The literal phrase the round-2 review asked the row to carry once the
    // bound is exceeded and the studio stops retrying.
    const lines = formatSurvivalBriefs([
      row("d--x", pending({ attempts: 6, gaveUpAt: "2026-09-25T12:30:00.000Z", reason: "6 delivery attempts, none landed (limit 6)" })),
    ]);
    expect(lines).toEqual([
      "SURVIVAL d--x: re-brief undelivered since 2026-09-25T12:00:00.000Z, gave up 2026-09-25T12:30:00.000Z after 6 attempts — 6 delivery attempts, none landed (limit 6)",
    ]);
    expect(lines[0]).toContain("re-brief undelivered");
  });

  it("an empty reason renders honestly rather than as a dangling dash", () => {
    expect(formatSurvivalBriefs([row("e--x", pending({ reason: "" }))])[0]).toContain("no reason recorded");
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

  // Issue #311 — a fresh member alert appends a " · <note>" suffix onto the
  // column, the ACTIVITY-column half of "surfaces as an ACTIVITY state ...
  // and a row note" (the OTHER half is formatObservedLines's own
  // "member alert:" line, above). No alerts at all: every test ABOVE this
  // one in this describe block never seeds memberAlerts and still asserts
  // an EXACT string with no suffix — that is this addition's own
  // regression guard.
  describe("member alert suffix (issue #311)", () => {
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
describe("lsJsonRows (issue #70)", () => {
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
      lead: "working", leadSince: "2026-09-25T12:01:20.000Z", limitResetsAt: null, activity: "WORKING 40s" });
    expect(row({ observed: { ...emptyObserved(), activity: act({ state: "waiting-question" }) } }).lead).toBe("waiting-question");
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
});

