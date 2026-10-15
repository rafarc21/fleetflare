import { describe, expect, it } from "vitest";
import {
  ageSeconds, formatReady, formatCheckedAt, formatAge, readyOverride, formatSession, formatState,
  formatSessionGuards, formatObservedLines, formatSurvivalBriefs,
} from "../cli/readiness-format";
import type { StudioStatus } from "../src/studio/types";
import type { Burn } from "../src/studio/burn";
import { emptyObserved, type SurvivalBriefPending } from "../src/studio/observed";
import type { Activity } from "../src/studio/activity";
import type { MemberAlert } from "../src/studio/member-alerts";
import { SHIP_TRANSCRIPT_SECONDS } from "../src/studio/ship-cadence";
import { REAL_PILOT_PANE } from "./fixtures/rate-limit-panes";
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

  it("issue #189: provisioned with a tailnet warning names it beside the verdict, never as bare", () => {
    expect(formatReady({ kind: "provisioned", warning: "tailnet: quota reached", checkedAt: "2026-08-28T12:00:00.000Z" }))
      .toBe("provisioned (tailnet: quota reached)");
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

describe("ageSeconds (cli/readiness-format.ts)", () => {
  const NOW = new Date("2026-08-28T12:00:00.000Z");

  it("valid ISO: whole seconds since, floored", () => {
    expect(ageSeconds("2026-08-28T11:59:53.000Z", NOW)).toBe(7);
    expect(ageSeconds("2026-08-28T09:00:00.000Z", NOW)).toBe(3 * 3600);
    // 7.75s elapsed: floor 7, round 8 — pins Math.floor against a round regression.
    expect(ageSeconds("2026-08-28T11:59:52.250Z", NOW)).toBe(7);
  });

  it("unparseable string reads 0, never NaN", () => {
    expect(ageSeconds("not-a-date", NOW)).toBe(0);
  });

  it("future timestamp (clock skew) reads 0, never negative", () => {
    expect(ageSeconds("2026-08-28T12:00:30.000Z", NOW)).toBe(0);
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

describe("formatSession (cli/readiness-format.ts) — never a bare \"?\" or literal \"unknown\" when a snapshot age is known", () => {
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

describe("formatSessionGuards (cli/readiness-format.ts)", () => {
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

  // Issue #115: a stuck FRESH_SESSION_PENDING_KEY (provision.ts) was
  // previously invisible on `fleet ls` — this closes that gap, mirrored from
  // do.ts's mirrorBurnToRegistry the same way sessionForceArmedAt is.
  it("a pending fresh-session intent gets its own line, silent once cleared", () => {
    const pending = { id: "m--x", freshSessionPending: true } as StudioStatus;
    const cleared = { id: "n--x", freshSessionPending: false } as StudioStatus;
    const neverPending = { id: "o--x" } as StudioStatus;

    expect(formatSessionGuards([pending])).toEqual([
      "FRESH SESSION m--x: fresh-session pending",
    ]);
    expect(formatSessionGuards([cleared])).toEqual([]);
    expect(formatSessionGuards([neverPending])).toEqual([]);
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
describe("formatObservedLines (cli/readiness-format.ts)", () => {
  it("case 1: full observed, a session verdict present", () => {
    const observed = {
      ...emptyObserved(),
      replacedAt: "2026-09-24T11:54:00.000Z",
      session: {
        verdict: "resumed" as const, at: "2026-09-24T11:55:00.000Z", via: "restart" as const,
        restore: "restored" as const, snapshotAgeS: 30, turnsBefore: 12, reason: null,
      },
    };
    // Issue #192: replacedAt set gates the activity: line to "—", never "?"
    // or a stale word — matches readyOverride's own "replaced ... — not
    // brought up" render for this exact state.
    expect(formatObservedLines(observed)).toEqual([
      "replaced:     yes, since 2026-09-24T11:54:00.000Z",
      "unreachable:  no",
      "session:      resumed (via restart)",
      "activity:     —",
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

  // Issue #231 — bring-up log provenance: which trigger caused
  // `freshSession: true`. Rendered right after `via`, before `reason`.
  it("issue #231: a session verdict with freshSessionSource renders it after via, before the reason", () => {
    const observed = {
      ...emptyObserved(),
      session: {
        verdict: "lost" as const, at: "2026-09-24T11:55:00.000Z", via: "provision" as const,
        restore: "not-attempted" as const, snapshotAgeS: null, turnsBefore: 40, reason: "no --continue",
        freshSessionSource: "flag" as const,
      },
    };
    expect(formatObservedLines(observed)).toEqual([
      "replaced:     no",
      "unreachable:  no",
      "session:      lost (via provision, fresh: flag) — no --continue",
      "activity:     ?",
    ]);
  });

  it("issue #231: freshSessionSource absent renders exactly as before (no 'fresh:' segment)", () => {
    const observed = {
      ...emptyObserved(),
      session: {
        verdict: "lost" as const, at: "2026-09-24T11:55:00.000Z", via: "provision" as const,
        restore: "not-attempted" as const, snapshotAgeS: null, turnsBefore: 40, reason: "no --continue",
      },
    };
    expect(formatObservedLines(observed)).toEqual([
      "replaced:     no",
      "unreachable:  no",
      "session:      lost (via provision) — no --continue",
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
    // Issue #192: replacedAt set gates the activity: line to "—" here too.
    expect(formatObservedLines(observed, NOW)).toEqual([
      "replaced:     yes, since 2026-09-24T11:54:00.000Z",
      "unreachable:  yes, since 2026-09-24T11:50:00.000Z",
      "session:      ? (no verdict recorded yet)",
      "activity:     —",
    ]);
  });

  // Issue #192 — a replaced-but-not-yet-confirmed-back studio must not show
  // the `activity:` line's stale leftover word side by side with
  // `replaced: yes` above it. Unlike case 4's bare `emptyObserved()`
  // activity (null, already renders "?"), this one seeds a FRESH-looking
  // stale `Activity` record to prove the gate fires on `replacedAt`
  // itself, not merely on staleness.
  it("issue #192: replacedAt set gates the activity: line to — regardless of a fresh-looking stored activity record", () => {
    const NOW = new Date("2026-09-25T12:02:00.000Z");
    const observed = {
      ...emptyObserved(),
      replacedAt: "2026-09-25T12:00:00.000Z",
      activity: {
        state: "waiting-members" as const, since: "2026-09-25T11:56:00.000Z", anchored: true,
        observedAt: "2026-09-25T12:01:30.000Z", source: "pane" as const, reason: null, membersTickingAt: null,
      },
    };
    expect(formatObservedLines(observed, NOW)).toEqual([
      "replaced:     yes, since 2026-09-25T12:00:00.000Z",
      "unreachable:  no",
      "session:      ? (no verdict recorded yet)",
      "activity:     —",
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

describe("formatSurvivalBriefs (cli/readiness-format.ts)", () => {
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
