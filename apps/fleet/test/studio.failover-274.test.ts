// Issue #274 — a degraded/limit-parked row must stop lying within roughly ONE
// FAST (30s) ship tick, not wait for the next ~300s runAccountFailover cycle.
//
// MEASURED TWICE:
//   1. 2026-09-25 09:3xZ (cto-d7): after a session reset, three BETA studios
//      all read `degraded`; only one was genuinely still parked, one had
//      resumed on its own, one was already dismissed. The screen was the
//      only reliable discriminator.
//   2. 2026-09-25 10:0xZ: fleetflare--pilot and fleetflare--scratch both
//      lone-Esc dismissed at 10:02Z; `fleet ls` still read `degraded | limit
//      modal open` at 10:03Z (unsurprising either way — no cadence, old or
//      new, had run again by then); actually cleared ~10:12Z, ten minutes
//      later, under the OLD 300s-only cadence.
//
// The fix: reuse issue #221's already-captured 30s ship-tick pane frame
// (transcript.ts's SECTION_PANE, now handed back as ShipResult.paneFrame) to
// run the SAME degraded-row-recovery check runAccountFailover's own `working`
// branch performs — failover.ts's extracted `evaluateDegradedRecovery` — from
// do.ts's `runShipTickWithObservation`, without waiting for the next 300s
// cycle. Zero added execs: the frame already rides the existing 30s tick.
import { describe, it, expect, vi } from "vitest";
import { runShipTickWithObservation } from "../src/studio/do";
import {
  runAccountFailover, exhaustedMessage, evaluateDegradedRecovery, paneCaptureCmd, PANE_CAPTURE_MARKER,
  detectLimitOnScreen, AUTO_CONTINUE_PROMPT, type FailoverDeps,
} from "../src/studio/failover";
import { wakeCmd, PANE_PROBE_CMD, PANE_SCREEN_CMD } from "../src/studio/wake";
import { STATUS_KEY, OPERATION_KEY, type OperationInFlight, type StudioStorage } from "../src/studio/provision";
import { OBSERVED_KEY, emptyObserved, type Observed, type ObservedStorage } from "../src/studio/observed";
import type { TranscriptStorage } from "../src/studio/transcript";
import type { StudioStatus } from "../src/studio/types";
import { V2_SESSION_LIMIT_RULE_PANE, V1_STOP_AND_WAIT_PANE, RULE_PROMPT } from "./fixtures/rate-limit-panes";

const STUDIO_ID = "fleetflare--scratch";
const TOKEN_NAME = "CLAUDE_CODE_OAUTH_TOKEN";
const EXHAUSTED = exhaustedMessage(STUDIO_ID, [TOKEN_NAME]);

/** An idle lead, back at its input box after a lone-Esc dismissal: claude's
 *  footer IS the bottom row, no limit block anywhere. */
const RECOVERED_IDLE = ["⏺ Resumed after the Esc.", "", ...RULE_PROMPT].join("\n");

/** Still genuinely parked: a live inline session-limit block, bottom-anchored
 *  (V2_SESSION_LIMIT_RULE_PANE's own reset, "1:30pm (UTC)", is ahead of every
 *  `now` this file uses). */
const STILL_PARKED = V2_SESSION_LIMIT_RULE_PANE;

/** A live SELECT-modal limit screen (V1's own verbatim "Stop and wait for
 *  limit to reset" / "Upgrade your plan" pane, headline-less) — the other
 *  branch `detectLimitOnScreen` recognizes (`bottomLimitModal`), never
 *  exercised by STILL_PARKED above (an INLINE block, `inlineLimitBlock`'s own
 *  branch). Test 2 below. */
const STILL_PARKED_SELECT_MODAL = V1_STOP_AND_WAIT_PANE;

/**
 * Test 2's second fixture — a DIFFERENT kind of modal claude sometimes shows,
 * unrelated to rate limits: "Esc to cancel" chrome with no limit wording
 * anywhere on it. No committed fixture in test/fixtures/rate-limit-panes.ts
 * matches this shape (grepped for "Enter to confirm"/"What do you want to
 * do?" across the whole repo — every hit is limit-flavored). Built here by
 * taking V1_THREE_OPTION_PANE's own frame VERBATIM (transcript preamble, the
 * ▔ rule, "What do you want to do?", the footer) and deleting its three
 * limit-specific option lines — no new pane text invented, only an omission
 * of the fixture's own limit-specific rows.
 */
const QUESTION_MENU_NO_LIMIT_PANE = [
  "⏺ Running the migration dry-run before the release.",
  "",
  "⏺ Bash(bun run migrate:dry)",
  "  ⎿  3 migrations pending",
  "",
  "▔".repeat(120),
  "   What do you want to do?",
  "",
  "   Enter to confirm · Esc to cancel",
].join("\n");

function degradedStatus(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STUDIO_ID, state: "degraded", tailscaleHost: null, lastRefresh: null, error: EXHAUSTED,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    claudeAccount: TOKEN_NAME, ...overrides,
  };
}

/** UTF-8 aware base64 — a pane frame carries claude's own box-drawing glyphs,
 *  which plain `btoa` throws on outright (Latin1 only). Same helper
 *  test/studio.observation-tick.test.ts already uses for the same reason. */
function b64Utf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

/** A minimal ship-tick stdout: boot-id + stat(-1, "no file") + incarnation +
 *  the pane section — the same "no-file" shape
 *  test/studio.observation-tick.test.ts's own `stdoutWithPane` uses to
 *  isolate the pane/activity path from the transcript-shipping path, which
 *  this feature does not touch. */
function stdoutWithPane(pane: string, incarnation = "11111111-2222-3333-4444-555555555555"): string {
  return [
    "---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", incarnation,
    "---FLEET-PANE---", b64Utf8(pane),
  ].join("\n");
}

/** One Map-backed fake satisfying every narrow port `runShipTickWithObservation`
 *  needs at once — same shape test/studio.observation-tick.test.ts's own
 *  `fakeStorage` already uses. */
function fakeStorage(seed?: { status?: StudioStatus; observed?: Observed; operation?: OperationInFlight | null }) {
  const map = new Map<string, unknown>();
  if (seed?.status) map.set(STATUS_KEY, seed.status);
  if (seed?.observed) map.set(OBSERVED_KEY, seed.observed);
  if (seed?.operation !== undefined && seed.operation !== null) map.set(OPERATION_KEY, seed.operation);
  const storage = {
    map,
    get: (async (key: string) => map.get(key)) as unknown as (TranscriptStorage & ObservedStorage & StudioStorage)["get"],
    put: (async (keyOrEntries: unknown, value?: unknown) => {
      if (typeof keyOrEntries === "object" && keyOrEntries !== null) {
        for (const [k, v] of Object.entries(keyOrEntries as Record<string, unknown>)) map.set(k, v);
        return;
      }
      map.set(keyOrEntries as string, value);
    }) as unknown as (TranscriptStorage & ObservedStorage & StudioStorage)["put"],
  };
  return storage;
}

function shipDeps(stdout: string, now: string) {
  return { exec: vi.fn(async () => ({ code: 0, stdout, stderr: "" })), r2Put: vi.fn(async () => {}), now: () => new Date(now) };
}

// ---------------------------------------------------------------------------
// 1 — a resumed pane clears the row on the FAST (30s) path, no 300s wait.
// ---------------------------------------------------------------------------
describe("#274 (1) — a resumed pane clears the degraded row on the fast 30s tick", () => {
  it("dismissed modal, lead back at its input box: running, error gone, off ONE ship tick", async () => {
    const storage = fakeStorage({ status: degradedStatus() });

    await runShipTickWithObservation(shipDeps(stdoutWithPane(RECOVERED_IDLE), "2026-09-25T10:02:30.000Z"), storage, STUDIO_ID, undefined, 5000);

    const row = storage.map.get(STATUS_KEY) as StudioStatus;
    expect(row.state).toBe("running");
    expect(row.error).toBeNull();
    expect(row.exhaustionClearedAt).toBe("2026-09-25T10:02:30.000Z");
  });

  it("the D1 mirror is called with the cleared row", async () => {
    const storage = fakeStorage({ status: degradedStatus() });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});

    await runShipTickWithObservation(shipDeps(stdoutWithPane(RECOVERED_IDLE), "2026-09-25T10:02:30.000Z"), storage, STUDIO_ID, recordStudioFn, 5000);

    expect(recordStudioFn).toHaveBeenCalled();
    expect(recordStudioFn.mock.calls.at(-1)?.[0]).toMatchObject({ state: "running", error: null });
  });

  it("costs no extra exec: the ship tick's own single exec is the only one issued", async () => {
    const storage = fakeStorage({ status: degradedStatus() });
    const deps = shipDeps(stdoutWithPane(RECOVERED_IDLE), "2026-09-25T10:02:30.000Z");

    await runShipTickWithObservation(deps, storage, STUDIO_ID, undefined, 5000);

    expect(deps.exec).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 2 — still parked (a live limit block) never clears on the fast path either.
// #239/#232's position-free veto must hold on BOTH the fast and slow path.
// ---------------------------------------------------------------------------
describe("#274 (2) — a still-parked pane stays degraded on the fast tick", () => {
  it("a live limit block bottom-anchored: the row is untouched", async () => {
    const storage = fakeStorage({ status: degradedStatus() });

    await runShipTickWithObservation(shipDeps(stdoutWithPane(STILL_PARKED), "2026-09-25T10:02:30.000Z"), storage, STUDIO_ID, undefined, 5000);

    const row = storage.map.get(STATUS_KEY) as StudioStatus;
    expect(row.state).toBe("degraded");
    expect(row.error).toBe(EXHAUSTED);
  });

  it("a live limit block anywhere in the tail (#232's position-free veto) still refuses, off-anchor", async () => {
    // Same still-live block as above, but no longer the immediate bottom
    // anchor — a "Waiting for N background agent" row (real, measured shape,
    // see failover-214's own BACKGROUND_AGENT_PANE) sits between it and the
    // footer. detectLimitOnScreen's own bottom-anchored detector misses this;
    // #232's position-free veto (anyLiveLimitLineOnScreen) must not.
    const offAnchorPane = STILL_PARKED.replace(
      "\n\n" + RULE_PROMPT.join("\n"),
      "\n\n✻ Waiting for 1 background agent to finish\n\n" + RULE_PROMPT.join("\n"),
    );
    const storage = fakeStorage({ status: degradedStatus() });

    await runShipTickWithObservation(shipDeps(stdoutWithPane(offAnchorPane), "2026-09-25T10:02:30.000Z"), storage, STUDIO_ID, undefined, 5000);

    const row = storage.map.get(STATUS_KEY) as StudioStatus;
    expect(row.state).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// 3 — the exact measured timeline (2026-09-25 10:02Z -> 10:03Z -> 10:12Z),
// restructured to prove the fix: a fast-tick check shortly after the
// dismissal already shows cleared, not still degraded ten minutes later.
// ---------------------------------------------------------------------------
describe("#274 (3) — the measured 10:02Z dismissal clears within the next fast tick, not at 10:12Z", () => {
  it("dismissed at 10:02Z, a fast tick at 10:03Z already reads cleared", async () => {
    const storage = fakeStorage({ status: degradedStatus() });

    // The lone-Esc dismissal happened at 10:02Z; this is the FIRST fast
    // (30s-cadence) ship tick to observe the resumed pane, landing at
    // 10:03Z under the fix — not the ~10:12Z the OLD 300s-only cadence
    // measured for the same real dismissal.
    await runShipTickWithObservation(shipDeps(stdoutWithPane(RECOVERED_IDLE), "2026-09-25T10:03:00.000Z"), storage, STUDIO_ID, undefined, 5000);

    const row = storage.map.get(STATUS_KEY) as StudioStatus;
    expect(row.state).toBe("running");
    expect(row.exhaustionClearedAt).toBe("2026-09-25T10:03:00.000Z");
    expect(row.exhaustionClearedAt).not.toBe("2026-09-25T10:12:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// 4 — the shared function backs BOTH call sites identically: no forked logic.
// ---------------------------------------------------------------------------
describe("#274 (4) — evaluateDegradedRecovery backs both the 30s and 300s paths identically", () => {
  const NOW = new Date("2026-09-25T10:02:30.000Z");

  it("the pure function itself agrees on the SAME evidence, called twice (once per call site's own shape)", () => {
    const row = degradedStatus();
    const a = evaluateDegradedRecovery(row, STUDIO_ID, RECOVERED_IDLE, NOW, null);
    const b = evaluateDegradedRecovery(row, STUDIO_ID, RECOVERED_IDLE, NOW, null);
    expect(a).toEqual(b);
    expect(a.shouldHeal).toBe(true);

    const stillParked = evaluateDegradedRecovery(row, STUDIO_ID, STILL_PARKED, NOW, null);
    expect(stillParked.shouldHeal).toBe(false);
  });

  it("runAccountFailover (300s) and runShipTickWithObservation (30s) clear the SAME resumed pane the same way", async () => {
    // 300s path.
    const map = new Map<string, unknown>([[STATUS_KEY, degradedStatus()]]);
    const slowStorage: StudioStorage = {
      get: (async (k: string) => map.get(k)) as StudioStorage["get"],
      put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
    };
    const captured = `${RECOVERED_IDLE}\n${PANE_CAPTURE_MARKER}\n${RECOVERED_IDLE}\n`;
    const deps: FailoverDeps = {
      accounts: [{ name: TOKEN_NAME, token: "sk-ant-oat01-" + "a".repeat(40) }],
      now: () => NOW,
      exec: vi.fn(async (cmd: string) => ({ code: 0, stdout: cmd === paneCaptureCmd() ? captured : "", stderr: "" })),
      relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      notify: vi.fn(async () => {}),
      autoFailover: true,
    };
    const slowOutcome = await runAccountFailover(deps, slowStorage, STUDIO_ID, async () => {});
    expect(slowOutcome).toMatchObject({ kind: "recovered" });
    const slowRow = map.get(STATUS_KEY) as StudioStatus;

    // 30s path, same pane, same status, same instant.
    const fastStorage = fakeStorage({ status: degradedStatus() });
    await runShipTickWithObservation(shipDeps(stdoutWithPane(RECOVERED_IDLE), NOW.toISOString()), fastStorage, STUDIO_ID, undefined, 5000);
    const fastRow = fastStorage.map.get(STATUS_KEY) as StudioStatus;

    expect(fastRow.state).toBe(slowRow.state);
    expect(fastRow.error).toBe(slowRow.error);
    expect(fastRow.exhaustionClearedAt).toBe(slowRow.exhaustionClearedAt);
  });
});

// ---------------------------------------------------------------------------
// Round 2, Test 1 (MEDIUM) — the fast path must yield to an in-flight bring-up.
//
// do.ts's own fast-path block (runShipTickWithObservation) already computes
// `recoveryOpFresh = operationLockFresh(await storage.get(OPERATION_KEY),
// deps.now())` and gates the whole heal on `!recoveryOpFresh` — the SAME
// freshness rule runAccountFailover's own `heal` line ANDs onto
// `evaluateDegradedRecovery`'s `shouldHeal` for the 300s path. This is
// COVERAGE for that existing guard, proven by mutant below (see this file's
// own round-2 report for the demonstration): removing the `!recoveryOpFresh`
// conjunct from do.ts turns this test red, restoring it turns it green again.
// No production gap found.
// ---------------------------------------------------------------------------
describe("#274 (5) — a fresh operation lock defers the fast-path clear to whenever it releases", () => {
  it("a bring-up mid-flight (OPERATION_KEY fresh): the fast tick does NOT clear an otherwise-recovered pane", async () => {
    const storage = fakeStorage({
      status: degradedStatus(),
      // 30s old — comfortably inside OPERATION_STALE_MS (15 minutes), so this
      // reads as a bring-up genuinely still in flight, not stale wreckage.
      operation: { op: "restart", since: "2026-09-25T10:02:00.000Z" },
    });

    await runShipTickWithObservation(shipDeps(stdoutWithPane(RECOVERED_IDLE), "2026-09-25T10:02:30.000Z"), storage, STUDIO_ID, undefined, 5000);

    const row = storage.map.get(STATUS_KEY) as StudioStatus;
    // Same posture failover.ts's own 300s path documents for this identical
    // race (runAccountFailover's `heal` comment, "#85 PR1's op lock"): "when
    // someone else holds it, this tick declines and the next one ... clears
    // instead" — deferred to whenever the lock releases, never overwritten
    // out from under a bring-up that owns this row right now.
    expect(row.state).toBe("degraded");
    expect(row.error).toBe(EXHAUSTED);
    expect(row.exhaustionClearedAt).toBeUndefined();
  });

  it("the SAME pane, lock released (stale past OPERATION_STALE_MS): the fast tick clears it", async () => {
    // Control: proves the test above fails because of the LOCK, not because
    // RECOVERED_IDLE stopped being recognized as recovered.
    const storage = fakeStorage({
      status: degradedStatus(),
      operation: { op: "restart", since: "2026-09-25T09:00:00.000Z" }, // >15 min stale
    });

    await runShipTickWithObservation(shipDeps(stdoutWithPane(RECOVERED_IDLE), "2026-09-25T10:02:30.000Z"), storage, STUDIO_ID, undefined, 5000);

    const row = storage.map.get(STATUS_KEY) as StudioStatus;
    expect(row.state).toBe("running");
    expect(row.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round 2, Test 2 (LOW) — fast-path "still limited" fixtures beyond the plain
// inline rate-limit block Test (2) above already covers. Both exercise
// detectLimitOnScreen's OTHER branches: a live SELECT modal (bottomLimitModal)
// and a non-limit menu (neither branch matches at all, so claudeOnScreen —
// not the limit detector — is what keeps the row degraded).
// ---------------------------------------------------------------------------
describe("#274 (6) — two more still-limited screen shapes never clear on the fast tick", () => {
  it("a live SELECT-modal limit screen (V1's verbatim 'Stop and wait' / 'Upgrade your plan' modal) stays degraded", async () => {
    const storage = fakeStorage({ status: degradedStatus() });

    await runShipTickWithObservation(
      shipDeps(stdoutWithPane(STILL_PARKED_SELECT_MODAL), "2026-09-25T10:02:30.000Z"), storage, STUDIO_ID, undefined, 5000,
    );

    const row = storage.map.get(STATUS_KEY) as StudioStatus;
    expect(row.state).toBe("degraded");
    expect(row.error).toBe(EXHAUSTED);
  });

  it("a generic 'Esc to cancel' question-menu with NO limit wording at all stays degraded too", async () => {
    const storage = fakeStorage({ status: degradedStatus() });

    await runShipTickWithObservation(
      shipDeps(stdoutWithPane(QUESTION_MENU_NO_LIMIT_PANE), "2026-09-25T10:02:30.000Z"), storage, STUDIO_ID, undefined, 5000,
    );

    const row = storage.map.get(STATUS_KEY) as StudioStatus;
    expect(row.state).toBe("degraded");
    expect(row.error).toBe(EXHAUSTED);
  });

  it("the select modal exercises detectLimitOnScreen's kind==='modal' branch directly; the question-menu genuinely carries no limit at all", () => {
    const row = degradedStatus();
    const NOW = new Date("2026-09-25T10:02:30.000Z");

    const selectModal = evaluateDegradedRecovery(row, STUDIO_ID, STILL_PARKED_SELECT_MODAL, NOW, null);
    expect(selectModal.shouldHeal).toBe(false);
    expect(detectLimitOnScreen(STILL_PARKED_SELECT_MODAL.replace(/\s+$/, ""), NOW, null).kind).toBe("modal");

    const questionMenu = evaluateDegradedRecovery(row, STUDIO_ID, QUESTION_MENU_NO_LIMIT_PANE, NOW, null);
    expect(questionMenu.shouldHeal).toBe(false);
    // Not a limit-modal false negative papering over a bug: the detector
    // genuinely finds no limit here. What refuses the heal is claudeOnScreen
    // (claude's own idle footer is not the bottom of THIS pane) — a different
    // guard than the select-modal case above.
    expect(detectLimitOnScreen(QUESTION_MENU_NO_LIMIT_PANE, NOW, null).kind).toBe("working");
    expect(questionMenu.claudeOnScreen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #158 review finding 3 (fresh-context re-review, same PR) — the #158
// heal wake must fire on the FAST (30s) ship-tick path too, not only
// runAccountFailover's own slower 300s `working` branch: because the fast
// path runs ~10x more often, it almost always heals a recovered row BEFORE
// the slow path ever sees `state === "degraded"` again, which would make a
// wake that only lived in runAccountFailover unreachable in the common case.
// Mirrors this file's own #274 (1) harness (`fakeStorage`/`shipDeps`-shaped
// exec, `stdoutWithPane`), extended with a cmd-discriminating exec so the
// wake's OWN PANE_PROBE_CMD/PANE_SCREEN_CMD/wakeCmd execs (issued from
// INSIDE this same ship tick) get sensible answers rather than the ship
// tick's own raw stdout.
// ---------------------------------------------------------------------------
describe("#158 (7) — the fast (30s) ship-tick path also fires the heal wake, not only the 300s path", () => {
  it("an inline-exhausted row, reset passed, healed entirely by the FAST path: exactly one gated wake fires", async () => {
    // Same shape test/studio.auto-continue.test.ts's own "reset passed and
    // the pane is idle" case gives a row healed by runAccountFailover — a
    // genuine inline exhaustion (no select, no dead) whose printed reset has
    // already passed `now` below.
    const status = degradedStatus({
      rateLimited: { until: "2026-09-25T09:45:00.000Z", seenAt: "2026-09-25T09:15:00.000Z" },
    });
    const storage = fakeStorage({ status });
    const wake = wakeCmd(AUTO_CONTINUE_PROMPT);
    const execCalls: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      if (cmd === PANE_SCREEN_CMD) return { code: 0, stdout: `${RECOVERED_IDLE}\n`, stderr: "" };
      if (cmd === wake) return { code: 0, stdout: "__FLEET_WAKE__ sent\n", stderr: "" };
      // The ship tick's own single exec (shipTickCmd) — anything else.
      return { code: 0, stdout: stdoutWithPane(RECOVERED_IDLE), stderr: "" };
    });
    const deps = { exec, r2Put: vi.fn(async () => {}), now: () => new Date("2026-09-25T10:02:30.000Z") };

    await runShipTickWithObservation(deps, storage, STUDIO_ID, undefined, 5000);

    const row = storage.map.get(STATUS_KEY) as StudioStatus;
    expect(row.state).toBe("running");
    // The row still heals even on a build that cannot reach this assertion —
    // what THIS test pins is the wake, the gap review finding 3 found.
    expect(execCalls).toContain(wake);
  });

  it("the SAME row, but runAccountFailover's 300s path never ran this tick at all: the fast path alone is enough", async () => {
    // Belt-and-suspenders over the test above: no runAccountFailover call
    // anywhere in this test, proving the wake does not secretly depend on
    // it having run first (the exact race finding 3 describes — the fast
    // path healing BEFORE the slow path ever gets a turn).
    const status = degradedStatus({
      rateLimited: { until: "2026-09-25T09:00:00.000Z", seenAt: "2026-09-25T08:30:00.000Z" },
    });
    const storage = fakeStorage({ status });
    const wake = wakeCmd(AUTO_CONTINUE_PROMPT);
    const execCalls: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      if (cmd === PANE_SCREEN_CMD) return { code: 0, stdout: `${RECOVERED_IDLE}\n`, stderr: "" };
      if (cmd === wake) return { code: 0, stdout: "__FLEET_WAKE__ sent\n", stderr: "" };
      return { code: 0, stdout: stdoutWithPane(RECOVERED_IDLE), stderr: "" };
    });
    const deps = { exec, r2Put: vi.fn(async () => {}), now: () => new Date("2026-09-25T09:30:00.000Z") };

    await runShipTickWithObservation(deps, storage, STUDIO_ID, undefined, 5000);

    const row = storage.map.get(STATUS_KEY) as StudioStatus;
    expect(row.state).toBe("running");
    expect(execCalls.filter((c) => c === wake)).toHaveLength(1);
  });
});
