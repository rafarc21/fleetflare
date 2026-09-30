import { describe, it, expect, vi } from "vitest";
import {
  withObserved, recordSnapshotOnSuccess, applyStudioGitSafetyPort, studioGitSafetyCmd,
  runShipTickWithObservation, STALE_SHELL_NUDGE_KEY, STALE_SHELL_NUDGE_EVERY_MS,
} from "../src/studio/do";
import { emptyObserved, OBSERVED_KEY, type Observed, type ObservedStorage } from "../src/studio/observed";
import type { StudioStatus } from "../src/studio/types";
import type { SyncResult } from "../src/studio/session-sync";
import { ACTIVITY_KEY, type Activity } from "../src/studio/activity";
import { MEMBER_ALERTS_KEY, type MemberAlert } from "../src/studio/member-alerts";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import { SECTION_PANE, type TranscriptStorage, type ShipDeps } from "../src/studio/transcript";

// Issue #85, maestro correction #1. `withObserved` is the seam every
// StudioStatus leaving a StudioDO passes through on its way to D1
// (recordStudio) or straight back to an HTTP caller — without it, D1 (and
// so `fleet ls`, which reads D1 only) would never carry `observed` no
// matter how much of the rest of this feature landed. Kept in its own file,
// distinct from test/studio.registry.test.ts's D1-write-boundary coverage
// (cleanObserved) and test/studio.readiness.test.ts's own
// checkAndRecordReadiness coverage — this is do.ts's own attach-before-write
// seam, a distinct enough concern to earn its own file, the same call
// test/studio.readiness.test.ts's header already makes for its own feature.

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "websites--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

function fakeObservedStorage(seed?: Observed): ObservedStorage {
  const map = new Map<string, unknown>();
  if (seed) map.set(OBSERVED_KEY, seed);
  return {
    get: (async (key: string) => map.get(key)) as ObservedStorage["get"],
    put: (async (key: string, value: unknown) => { map.set(key, value); }) as ObservedStorage["put"],
  };
}

describe("withObserved — the seam every outbound StudioStatus passes through (issue #85)", () => {
  it("attaches the currently-stored Observed record onto a copy of the status", async () => {
    const storage = fakeObservedStorage({ ...emptyObserved(), incarnation: "tok-1" });
    const base = status({ id: "websites--reg1" });
    const withObs = await withObserved(storage, base);
    expect(withObs.observed).toEqual({ ...emptyObserved(), incarnation: "tok-1" });
    expect(withObs).not.toBe(base); // does not mutate the input
  });

  it("no stored record yet: attaches emptyObserved(), never leaves it undefined", async () => {
    const storage = fakeObservedStorage();
    const withObs = await withObserved(storage, status({ id: "websites--reg2" }));
    expect(withObs.observed).toEqual(emptyObserved());
  });
});

// Issue #221 (PR3a, Task 4) — `activity` lives under its OWN DO storage key
// (activity.ts's ACTIVITY_KEY), never inside OBSERVED_KEY's own read-patch-
// write cycle, but every StudioStatus leaving through `withObserved` still
// carries it as `observed.activity` — the D1/GET-status mirror this feature's
// design promises "with no further plumbing".
describe("withObserved — also attaches the DO's own ACTIVITY_KEY (issue #221)", () => {
  it("merges the stored Activity onto observed.activity", async () => {
    const storage = fakeObservedStorage({ ...emptyObserved(), incarnation: "tok-1" });
    const activity: Activity = {
      state: "working", since: "2026-09-25T12:00:00.000Z", anchored: true,
      observedAt: "2026-09-25T12:00:30.000Z", source: "pane", reason: null, membersTickingAt: null,
    };
    await (storage as unknown as { put(key: string, v: unknown): Promise<void> }).put(ACTIVITY_KEY, activity);
    const withObs = await withObserved(storage, status({ id: "websites--reg3" }));
    expect(withObs.observed?.activity).toEqual(activity);
  });

  it("no activity stored yet: attaches null, never leaves it undefined", async () => {
    const storage = fakeObservedStorage();
    const withObs = await withObserved(storage, status({ id: "websites--reg4" }));
    expect(withObs.observed?.activity).toBeNull();
  });
});

// Issue #311 — MEMBER_ALERTS_KEY (member-alerts.ts) rides the SAME
// own-DO-key/attach-at-withObserved seam ACTIVITY_KEY already established.
describe("withObserved — also attaches the DO's own MEMBER_ALERTS_KEY (issue #311)", () => {
  it("merges the stored MemberAlert[] onto observed.memberAlerts", async () => {
    const storage = fakeObservedStorage({ ...emptyObserved(), incarnation: "tok-1" });
    const alerts: MemberAlert[] = [
      {
        kind: "memguard-kill", name: "vitest", at: "2026-09-25T12:00:00.000Z",
        detail: "comm=vitest rss_mib=612 pid=42", confidence: "measured",
      },
    ];
    await (storage as unknown as { put(key: string, v: unknown): Promise<void> }).put(MEMBER_ALERTS_KEY, alerts);
    const withObs = await withObserved(storage, status({ id: "websites--reg5" }));
    expect(withObs.observed?.memberAlerts).toEqual(alerts);
  });

  it("no member alerts stored yet: attaches null, never leaves it undefined", async () => {
    const storage = fakeObservedStorage();
    const withObs = await withObserved(storage, status({ id: "websites--reg6" }));
    expect(withObs.observed?.memberAlerts).toBeNull();
  });
});

// Issue #85 review round 4 (TEST 12b) — `result.skipped` is the ONLY place
// `syncSessionTick` (session-sync.ts) signals its own R2 put did NOT run
// (the oversize guard); `recordSnapshotOnSuccess`'s own doc comment already
// gates on `result.skipped === undefined` by construction, but the review
// wants this proven directly rather than left as an inference from reading
// the gate.
function syncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return { bytes: 0, split: false, parts: 1, dailyWritten: false, pruned: 0, ...overrides };
}

describe("recordSnapshotOnSuccess — oversize skip leaves lastSnapshotAt untouched (issue #85)", () => {
  it("an oversize-skipped tick does NOT bump lastSnapshotAt", async () => {
    const storage = fakeObservedStorage({ ...emptyObserved(), lastSnapshotAt: "2026-09-24T09:00:00.000Z" });
    await recordSnapshotOnSuccess(storage, syncResult({ skipped: "oversize" }), "2026-09-24T10:00:00.000Z");
    const stored = await storage.get(OBSERVED_KEY);
    expect(stored?.lastSnapshotAt).toBe("2026-09-24T09:00:00.000Z"); // unchanged — never nulled, never bumped to "now"
  });

  it("a real, unskipped success DOES bump lastSnapshotAt to now — the contrasting case", async () => {
    const storage = fakeObservedStorage({ ...emptyObserved(), lastSnapshotAt: "2026-09-24T09:00:00.000Z" });
    await recordSnapshotOnSuccess(storage, syncResult(), "2026-09-24T10:00:00.000Z");
    const stored = await storage.get(OBSERVED_KEY);
    expect(stored?.lastSnapshotAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("a displaced-skip (issue #94) also leaves lastSnapshotAt untouched — any truthy `skipped` reason, not just oversize", async () => {
    const storage = fakeObservedStorage({ ...emptyObserved(), lastSnapshotAt: "2026-09-24T09:00:00.000Z" });
    await recordSnapshotOnSuccess(storage, syncResult({ skipped: "displaced", displaced: "some/key" }), "2026-09-24T10:00:00.000Z");
    const stored = await storage.get(OBSERVED_KEY);
    expect(stored?.lastSnapshotAt).toBe("2026-09-24T09:00:00.000Z");
  });

  it("no observedStorage at all: no-op, never throws", async () => {
    await expect(recordSnapshotOnSuccess(undefined, syncResult({ skipped: "oversize" }), "2026-09-24T10:00:00.000Z")).resolves.toBeUndefined();
    await expect(recordSnapshotOnSuccess(null, syncResult(), "2026-09-24T10:00:00.000Z")).resolves.toBeUndefined();
  });
});

// Board issue #253, maestro round 2 item 5. `deps()` is a private method on the
// StudioDO, so the port it builds for ProvisionDeps.applyStudioGitSafety was
// unreachable from every suite in this repo — and the mutant "the port never
// runs the install command at all" therefore survived the whole round-1 suite
// while leaving every studio unguarded. The body now lives in
// applyStudioGitSafetyPort, which `deps()` wires and nothing else, so these
// assertions are assertions about what the DO actually does. (The same gap
// still stands for writeBlueprintCredential's own port next to it — named in
// PR #259's body, not closed here.)
describe("applyStudioGitSafetyPort — do.ts's own side of the #253 wiring", () => {
  it("execs studioGitSafetyCmd()'s EXACT string, once, and reports ok", async () => {
    const exec = vi.fn(async (_cmd: string) => ({ code: 0, stdout: "", stderr: "" }));

    await expect(applyStudioGitSafetyPort(exec)).resolves.toEqual({ ok: true });

    expect(exec).toHaveBeenCalledTimes(1);
    // Not "contains git config", not "looks like an install": the exact command
    // the generator returns. A port that execs something else, or nothing at
    // all, is a studio that can still push the default branch.
    expect(exec.mock.calls[0][0]).toBe(studioGitSafetyCmd());
  });

  it("a non-zero exit is an error, carrying the code and the command's stderr", async () => {
    const exec = vi.fn(async () => ({ code: 137, stdout: "", stderr: "Killed" }));

    const res = await applyStudioGitSafetyPort(exec);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("137");
    expect(res.ok === false && res.error).toContain("Killed");
  });

  it("a thrown exec is caught, never propagated — a provision must not die on this", async () => {
    const exec = vi.fn(async (): Promise<{ code: number; stdout: string; stderr: string }> => {
      throw new Error("session busy");
    });

    const res = await applyStudioGitSafetyPort(exec);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("session busy");
  });
});

// ---------------------------------------------------------------------------
// Issue #106 — "idle lead + stale background shell: detect and nudge".
// `applyActivityVerdict`'s own new `onStaleBackgroundShell` edge, exercised
// via the FULL `runShipTickWithObservation` path — same "proves the wiring,
// not just the pure decision" split test/studio.observation-tick.test.ts's
// own "onLeadWorking (issue #86)" describe block already established for
// `autoWorking`'s identical rate-bound-edge shape. `nextActivity`'s own pure
// `backgroundShellSince` tracking has its dedicated coverage in
// test/studio.activity.test.ts; this file only proves do.ts's OWN wiring:
// the edge fires exactly once per real 15-minute crossing, rate-bound by
// STALE_SHELL_NUDGE_EVERY_MS, and never for a plain idle tick or a tick that
// never carried the background-shell flavour at all.
// ---------------------------------------------------------------------------
describe("runShipTickWithObservation — onStaleBackgroundShell (issue #106)", () => {
  const MIN = 60_000;
  const T0 = new Date("2026-09-30T12:00:00.000Z");
  const TOK_1 = "11111111-2222-3333-4444-555555555555";

  /** UTF-8 aware base64 — same reasoning as test/studio.observation-tick.
   *  test.ts's own identical helper: a pane frame carries claude's own
   *  box-drawing glyphs, which plain `btoa` throws on outright. */
  function b64Utf8(s: string): string {
    return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  }

  function stdoutWithPane(pane: string, incarnation = TOK_1): string {
    return [
      "---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", incarnation,
      SECTION_PANE, b64Utf8(pane),
    ].join("\n");
  }

  // Turn ended, empty input box, footer carries a "7 shells" counter — the
  // SAME #86/#106 background-shell flavour shape test/studio.activity.
  // test.ts's own "#86: a live background shell/monitor/task is waiting"
  // describe block builds from REAL_WEBSTUDIO_PANE.
  const SHELLS_IDLE_PANE = [
    "⏺ Done.", "", "─".repeat(68), "❯ ", "─".repeat(68),
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · 7 shells",
  ].join("\n");
  // Same pane, counter cleared — plain idle, no background-shell flavour.
  const CLEAN_IDLE_PANE = [
    "⏺ Done.", "", "─".repeat(68), "❯ ", "─".repeat(68),
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");

  function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
    return {
      id: "websites--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      ...overrides,
    };
  }

  /** Same "one Map-backed fake satisfying every narrow port
   *  runShipTickWithObservation needs at once" shape test/studio.
   *  observation-tick.test.ts's own `fakeStorage` already establishes,
   *  rebuilt locally here per this issue's own file boundary. */
  function fakeStorage(seed?: {
    status?: StudioStatus;
    activity?: Activity;
  }): (TranscriptStorage & ObservedStorage & StudioStorage) & { map: Map<string, unknown> } {
    const map = new Map<string, unknown>();
    if (seed?.status) map.set(STATUS_KEY, seed.status);
    if (seed?.activity) map.set(ACTIVITY_KEY, seed.activity);
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

  const shipDeps = (pane: string, now: Date): ShipDeps => ({
    exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPane(pane), stderr: "" })),
    r2Put: vi.fn(async () => {}),
    now: () => now,
  });

  const run = (
    pane: string, now: Date, storage: ReturnType<typeof fakeStorage>, onStaleBackgroundShell: () => Promise<void>,
  ) => runShipTickWithObservation(
    shipDeps(pane, now), storage, "websites--pilot", undefined, 5000, undefined, undefined, onStaleBackgroundShell,
  );

  it("does NOT fire on the first tick that reads a background-shell counter (age 0, well under the 15-minute budget)", async () => {
    const storage = fakeStorage({ status: status() });
    const cb = vi.fn(async () => {});
    await run(SHELLS_IDLE_PANE, T0, storage, cb);
    expect(cb).not.toHaveBeenCalled();
    expect((storage.map.get(ACTIVITY_KEY) as Activity).backgroundShellSince).toBe(T0.toISOString());
  });

  it("fires exactly once on the tick that CROSSES 15 minutes — not on an earlier still-fresh tick, not again the next tick", async () => {
    const storage = fakeStorage({ status: status() });
    const cb = vi.fn(async () => {});
    await run(SHELLS_IDLE_PANE, T0, storage, cb); // stamps backgroundShellSince = T0

    const stillFresh = new Date(T0.getTime() + 10 * MIN);
    await run(SHELLS_IDLE_PANE, stillFresh, storage, cb);
    expect(cb).not.toHaveBeenCalled(); // 10min < 15min — not yet stale

    const crossing = new Date(T0.getTime() + 16 * MIN);
    await run(SHELLS_IDLE_PANE, crossing, storage, cb);
    expect(cb).toHaveBeenCalledTimes(1); // the crossing tick itself
    expect(storage.map.get(STALE_SHELL_NUDGE_KEY)).toBe(crossing.toISOString());

    const stillStale = new Date(T0.getTime() + 17 * MIN);
    await run(SHELLS_IDLE_PANE, stillStale, storage, cb);
    expect(cb).toHaveBeenCalledTimes(1); // still stale next tick too — NOT a new crossing, no second fire
  });

  it("never fires for a plain idle tick that never carried the background-shell flavour at all", async () => {
    const storage = fakeStorage({ status: status() });
    const cb = vi.fn(async () => {});
    await run(CLEAN_IDLE_PANE, T0, storage, cb);
    const later = new Date(T0.getTime() + 20 * MIN);
    await run(CLEAN_IDLE_PANE, later, storage, cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("resets the clock (and never fires) once the counter clears before 15 minutes have passed", async () => {
    const storage = fakeStorage({ status: status() });
    const cb = vi.fn(async () => {});
    await run(SHELLS_IDLE_PANE, T0, storage, cb);
    const cleared = new Date(T0.getTime() + 10 * MIN);
    await run(CLEAN_IDLE_PANE, cleared, storage, cb);
    expect((storage.map.get(ACTIVITY_KEY) as Activity).backgroundShellSince).toBeNull();
    const later = new Date(T0.getTime() + 26 * MIN); // 16 min after it cleared
    await run(CLEAN_IDLE_PANE, later, storage, cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("rate-bound: a nudge already stamped within STALE_SHELL_NUDGE_EVERY_MS suppresses even a real, new crossing", async () => {
    const storage = fakeStorage({ status: status() });
    const cb = vi.fn(async () => {});
    await run(SHELLS_IDLE_PANE, T0, storage, cb); // stamps backgroundShellSince = T0, no nudge key yet

    const crossing = new Date(T0.getTime() + 16 * MIN);
    // A nudge fired 5 minutes before this tick's own `now` — well inside the
    // 15-minute rate-limit window (STALE_SHELL_NUDGE_EVERY_MS), so this
    // otherwise-real crossing must still be refused.
    storage.map.set(STALE_SHELL_NUDGE_KEY, new Date(crossing.getTime() - 5 * MIN).toISOString());
    await run(SHELLS_IDLE_PANE, crossing, storage, cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("a throwing callback never fails the tick; activity is still stored", async () => {
    const storage = fakeStorage({ status: status() });
    await run(SHELLS_IDLE_PANE, T0, storage, async () => {});
    const crossing = new Date(T0.getTime() + 16 * MIN);
    await expect(run(SHELLS_IDLE_PANE, crossing, storage, async () => { throw new Error("wake refused"); }))
      .resolves.toBeDefined();
    expect((storage.map.get(ACTIVITY_KEY) as Activity).state).toBe("waiting-members");
  });
});
