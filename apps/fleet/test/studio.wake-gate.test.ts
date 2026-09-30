// Board issue #100: the wake gate, tested through the REAL code StudioDO runs.
//
// PR #97's route tests passed with do.ts reverted: their fake re-built the DO's
// wiring around runGatedWake by hand, so nothing tested what `wakeStudio`
// itself does. `wakeStudioWith` is that body, extracted (the same pattern
// syncSessionCycle / checkAndRecordReadiness follow) — swap its runGatedWake
// back to the raw runWake and every stopped-studio test below goes red.
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  wakeStudioWith, sweepWake, checkProvisionedGated, destroyingMarkerFresh, runScheduledTick, decideHeal,
  healBareContainer, deliverAssignedTaskOnBringup, DELIVERED_TASK_KEY,
} from "../src/studio/do";
import { LIMIT_SIGHTING_KEY, type LimitSighting } from "../src/studio/rate-limit";
import { V2_SESSION_LIMIT_PANE } from "./fixtures/rate-limit-panes";
import { spawnDeps } from "../src/studio/routes";
import type { Env } from "../src/env";
import { runDestroy } from "../src/studio/destroy";
import { runGatedWake, wakeCmd, logWakeOutcome, PANE_PROBE_CMD, PANE_SCREEN_CMD, type WakeOutcome } from "../src/studio/wake";
import { STATUS_KEY, DESTROYING_KEY, DESTROY_IN_FLIGHT, type StudioStorage } from "../src/studio/provision";
import { runInspect } from "../src/studio/inspect";
import type { SessionSyncDeps } from "../src/studio/session-sync";
import type { StudioStatus } from "../src/studio/types";
import { assignDigest } from "../src/board/assign-wake";

const STUDIO_ID = "fleetflare--maestro";
const NOW = new Date("2026-09-24T12:00:00.000Z");

function status(state: StudioStatus["state"]): StudioStatus {
  return { id: STUDIO_ID, state, tailscaleHost: null, lastRefresh: null, error: null } as StudioStatus;
}

function fakeStorage(seed?: StudioStatus) {
  const map = new Map<string, unknown>();
  if (seed) map.set(STATUS_KEY, seed);
  return {
    map,
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => { map.set(key, value); }) as StudioStorage["put"],
  };
}

/** A container whose pane answers `pane`, recording every command. */
function container(pane = "claude") {
  const cmds: string[] = [];
  const exec = vi.fn(async (cmd: string) => {
    cmds.push(cmd);
    return cmd === PANE_PROBE_CMD
      ? { code: 0, stdout: `studio:claude ${pane}\n`, stderr: "" }
      : { code: 0, stdout: "", stderr: "" };
  });
  return { cmds, exec };
}

describe("wakeStudioWith — StudioDO.wakeStudio's real body", () => {
  it("a STOPPED studio: zero execs, no sweep re-arm, and the refusal is a deliberate skip", async () => {
    const storage = fakeStorage(status("stopped"));
    const { cmds, exec } = container();
    const armSweep = vi.fn(async () => {});
    const outcome = await wakeStudioWith(storage, exec, true, armSweep, "WAKE EVENT #2 20s", () => NOW);
    expect(cmds).toEqual([]);
    expect(armSweep).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("stopped");
  });

  it("a never-provisioned studio (no recorded status): zero execs — a wake must not mint a container", async () => {
    const storage = fakeStorage();
    const { cmds, exec } = container();
    const outcome = await wakeStudioWith(storage, exec, true, vi.fn(async () => {}), "WAKE", () => NOW);
    expect(cmds).toEqual([]);
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBe(true);
  });

  it("a landed wake on a maestro re-arms the sweep exactly once", async () => {
    const storage = fakeStorage(status("running"));
    const { cmds, exec } = container("claude");
    const armSweep = vi.fn(async () => {});
    const outcome = await wakeStudioWith(storage, exec, true, armSweep, "WAKE sweep 3", () => NOW);
    expect(outcome).toEqual({ ok: true });
    expect(cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd("WAKE sweep 3")]);
    expect(armSweep).toHaveBeenCalledTimes(1);
  });

  it("a refused wake (bash in the pane) does NOT re-arm the sweep", async () => {
    const storage = fakeStorage(status("running"));
    const { cmds, exec } = container("bash");
    const armSweep = vi.fn(async () => {});
    const outcome = await wakeStudioWith(storage, exec, true, armSweep, "WAKE sweep 3", () => NOW);
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBeUndefined();
    expect(cmds).toEqual([PANE_PROBE_CMD]);
    expect(armSweep).not.toHaveBeenCalled();
  });

  it("a landed wake on a NON-maestro never arms the sweep", async () => {
    const storage = fakeStorage(status("running"));
    const { exec } = container("claude");
    const armSweep = vi.fn(async () => {});
    const outcome = await wakeStudioWith(storage, exec, false, armSweep, "WAKE", () => NOW);
    expect(outcome.ok).toBe(true);
    expect(armSweep).not.toHaveBeenCalled();
  });

  it("a destroy in flight (fresh marker) reads as stopped: zero execs", async () => {
    const storage = fakeStorage(status("running"));
    await storage.put(DESTROYING_KEY, new Date(NOW.getTime() - 5_000).toISOString());
    const { cmds, exec } = container("claude");
    const outcome = await wakeStudioWith(storage, exec, true, vi.fn(async () => {}), "WAKE", () => NOW);
    expect(cmds).toEqual([]);
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBe(true);
  });

  it("a STALE destroy marker (isolate died mid-destroy) does not block wakes forever", async () => {
    const storage = fakeStorage(status("running"));
    await storage.put(DESTROYING_KEY, new Date(NOW.getTime() - 60 * 60 * 1000).toISOString());
    const { cmds, exec } = container("claude");
    const outcome = await wakeStudioWith(storage, exec, false, vi.fn(async () => {}), "WAKE", () => NOW);
    expect(outcome.ok).toBe(true);
    expect(cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd("WAKE")]);
  });
});

// ---------------------------------------------------------------------------
// Fix pass D (#170, D4/D5): the sighting key the wake gate reads is the SAME
// key failover writes. The source pin in test/bun/wake-gate-wiring.test.ts
// says every call site goes through limitSightingIn; this says limitSightingIn
// reads the right key, through the real sweepWake.
// ---------------------------------------------------------------------------
describe("sweepWake reads the first sighting from LIMIT_SIGHTING_KEY (#170 D4/D5)", () => {
  it("a block first seen 12:00Z (reset 13:30Z) is history at +21h, and the sweep wake types", async () => {
    const storage = fakeStorage(status("running"));
    // Straight into the map: the sighting key is deliberately OFF
    // StudioStorage's overloads (see failover.ts's SightingStorage).
    storage.map.set(LIMIT_SIGHTING_KEY, {
      block: "You've hit your session limit · 1:30pm (UTC)", printed: "1:30pm (UTC)",
      until: "2026-09-24T13:30:00.000Z", seenAt: "2026-09-24T12:00:00.000Z",
    } satisfies LimitSighting);
    const cmds: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      return { code: 0, stdout: `${V2_SESSION_LIMIT_PANE}\n`, stderr: "" };
    });
    const outcome = await sweepWake(storage, exec, STUDIO_ID, "WAKE", () => new Date("2026-09-25T09:00:00.000Z"));
    expect(outcome.ok).toBe(true);
    expect(cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd("WAKE")]);
  });
});

describe("logWakeOutcome — webhook and spawn wakes share one logging rule (#100 F5)", () => {
  it("a deliberate skip is info, a real failure is an error, a landed wake is silent", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const infos = vi.spyOn(console, "log").mockImplementation(() => {});
    logWakeOutcome("maestro wake (x--maestro)", { ok: false, skipped: true, error: "refused: stopped" });
    expect(infos).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    logWakeOutcome("maestro wake (x--maestro)", { ok: false, error: "wake failed (1): no window" });
    expect(errors).toHaveBeenCalledTimes(1);
    logWakeOutcome("maestro wake (x--maestro)", { ok: true });
    expect(infos).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
    infos.mockRestore();
  });

  it("the stopped refusal's copy fits every caller — no board-task promise a webhook cannot keep", async () => {
    const outcome = await runGatedWake({ recordedState: async () => "stopped", exec: vi.fn() }, "WAKE");
    expect(outcome.error).not.toContain("task is waiting");
  });
});

describe("destroyingMarkerFresh", () => {
  it("null/absent is not a destroy in flight", () => {
    expect(destroyingMarkerFresh(null, NOW)).toBe(false);
    expect(destroyingMarkerFresh(undefined, NOW)).toBe(false);
  });
});

describe("runGatedWake — the destroy race (#100 F3)", () => {
  it("re-reads the recorded state before TYPING, so a destroy that landed after the probe gets no keystrokes", async () => {
    // First read: running (gate 1 passes, probe runs). The destroy lands
    // during the probe. Second read, immediately before the wake exec: stopped.
    const states = ["running", "stopped"];
    const recordedState = vi.fn(async () => states.shift() ?? "stopped");
    const { cmds, exec } = container("claude");
    const outcome = await runGatedWake({ recordedState, exec }, "WAKE");
    expect(cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD]);
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBe(true);
  });
});

describe("runDestroy — writes its stop marker BEFORE destroy() (#100 F3)", () => {
  function syncDeps(): SessionSyncDeps {
    return {
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
      r2Put: vi.fn(async () => {}),
      r2List: vi.fn(async () => []),
      r2Delete: vi.fn(async () => {}),
      now: () => NOW,
      notify: vi.fn(async () => {}),
      burnAlertThresholdTokens: 0,
    } as unknown as SessionSyncDeps;
  }

  it("the marker is set while destroy() runs and cleared once it resolves", async () => {
    const storage = fakeStorage(status("running"));
    let markerDuringDestroy: unknown = "never read";
    const outcome = await runDestroy(
      async () => ({ ok: true, hasOpenTask: false }), STUDIO_ID, "rafarc21/fleetflare", false,
      syncDeps(), storage as never, STUDIO_ID,
      async () => { markerDuringDestroy = storage.map.get(DESTROYING_KEY); },
      async () => {}, "fleetflare",
      async () => "rafarc21/blueprint", async () => {},
      // #113: not running = straight to destroy, so the marker is what is under test.
      { containerRunning: () => false },
    );
    expect(outcome.ok).toBe(true);
    expect(typeof markerDuringDestroy).toBe("string");
    expect(storage.map.get(DESTROYING_KEY) ?? null).toBeNull();
    expect(storage.map.get(STATUS_KEY)).toMatchObject({ state: "stopped" });
  });

  it("a FAILED destroy clears the marker too — a degraded studio stays wakeable", async () => {
    const storage = fakeStorage(status("running"));
    await expect(runDestroy(
      async () => ({ ok: true, hasOpenTask: false }), STUDIO_ID, "rafarc21/fleetflare", false,
      syncDeps(), storage as never, STUDIO_ID,
      async () => { throw new Error("boom"); },
      async () => {}, "fleetflare",
      async () => "rafarc21/blueprint", async () => {},
      // #113: not running = straight to destroy, so the marker is what is under test.
      { containerRunning: () => false },
    )).rejects.toThrow("boom");
    expect(storage.map.get(DESTROYING_KEY) ?? null).toBeNull();
    expect(storage.map.get(STATUS_KEY)).toMatchObject({ state: "degraded" });
  });
});

describe("checkProvisionedGated — GET /studio/:id/provisioned never starts a stopped studio", () => {
  function syncDeps(exec: SessionSyncDeps["exec"]): SessionSyncDeps {
    return { exec, now: () => NOW } as unknown as SessionSyncDeps;
  }

  it("a STOPPED studio answers inconclusive with zero execs", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const verdict = await checkProvisionedGated(fakeStorage(status("stopped")), syncDeps(exec), "fleetflare");
    expect(exec).not.toHaveBeenCalled();
    expect(verdict.kind).toBe("inconclusive");
    expect((verdict as { reason: string }).reason).toContain("stopped");
  });

  it("a never-provisioned studio answers inconclusive with zero execs", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const verdict = await checkProvisionedGated(fakeStorage(), syncDeps(exec), "fleetflare");
    expect(exec).not.toHaveBeenCalled();
    expect(verdict.kind).toBe("inconclusive");
  });

  it("a running studio still runs the real check", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    await checkProvisionedGated(fakeStorage(status("running")), syncDeps(exec), "fleetflare");
    expect(exec).toHaveBeenCalled();
  });
});

// StudioDO cannot be constructed under vitest-pool-workers (do.ts header), so
// the thin class methods are pinned against their source: each must forward
// to the tested function above and hold exactly ONE container adapter.
describe("StudioDO source pins (#100 F7)", () => {
  const src: string = env.TEST_STUDIO_DO_SRC;
  function body(signature: string): string {
    const start = src.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  }", start));
  }
  const count = (s: string, needle: string) => s.split(needle).length - 1;

  it("wakeStudio forwards to wakeStudioWith with exactly one sbExec( and no raw runWake(", () => {
    const b = body("  async wakeStudio(prompt: string): Promise<WakeOutcome> {");
    expect(count(b, "wakeStudioWith(")).toBe(1);
    expect(count(b, "sbExec(")).toBe(1);
    expect(b).not.toContain("runWake(");
  });

  it("wakeStudioOnAssignment reads the gate state via gatedStateIn, never STATUS_KEY directly (#100 N2)", () => {
    const b = body("  async wakeStudioOnAssignment(prompt: string, clearDraftFirst = false): Promise<WakeOutcome> {");
    expect(count(b, "gatedStateIn(")).toBe(1);
    expect(b).not.toContain("STATUS_KEY");
  });

  it("inspect reads the gate state via gatedStateIn, never STATUS_KEY directly (#100 N5)", () => {
    // Issue #85 widened this method's return type to `InspectOutcome &
    // { observed: Observed }` (it now also answers with the DO's stored
    // Observed record); issue #228 item 5 widened it again to also carry
    // `sessionForceArmedAt` (read via getStatusWithStorage, never a raw
    // STATUS_KEY read, so the "never STATUS_KEY directly" assertion below
    // still holds) — the signature pinned here has to match both, or this
    // source-text search never finds the method at all.
    const b = body(
      "  async inspect(repo: string, tailLines?: number): "
      + "Promise<InspectOutcome & { observed: Observed; sessionForceArmedAt: string | null }> {",
    );
    expect(count(b, "gatedStateIn(")).toBe(1);
    expect(b).not.toContain("STATUS_KEY");
  });

  it("checkProvisioned forwards to checkProvisionedGated", () => {
    const b = body("  async checkProvisioned(repo: string): Promise<ProvisionedVerdict> {");
    expect(count(b, "checkProvisionedGated(")).toBe(1);
    expect(b).not.toContain("checkProvisionedWithRetry(");
  });
});

// --- PR #108 review fix pass ------------------------------------------------

describe("the destroy marker's refusal names itself (#100 N4)", () => {
  it("a wake during a destroy says 'a destroy is in flight', still a deliberate skip", async () => {
    const storage = fakeStorage(status("running"));
    await storage.put(DESTROYING_KEY, new Date(NOW.getTime() - 5_000).toISOString());
    const { exec } = container("claude");
    const outcome = await wakeStudioWith(storage, exec, false, vi.fn(async () => {}), "WAKE", () => NOW);
    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("a destroy is in flight");
  });

  it("/provisioned during a destroy says the same, with zero execs", async () => {
    const storage = fakeStorage(status("running"));
    await storage.put(DESTROYING_KEY, new Date(NOW.getTime() - 5_000).toISOString());
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const verdict = await checkProvisionedGated(storage, { exec, now: () => NOW } as unknown as SessionSyncDeps, "fleetflare");
    expect(exec).not.toHaveBeenCalled();
    expect((verdict as { reason: string }).reason).toContain("a destroy is in flight");
  });
});

describe("destroyWithSync clears its marker in a real finally (#100 N4)", () => {
  it("a throwing status write after destroy() still clears the marker", async () => {
    const storage = fakeStorage(status("running"));
    const put = storage.put;
    let destroyed = false;
    storage.put = (async (k: string, v: unknown) => {
      if (destroyed && k === STATUS_KEY) throw new Error("storage write failed");
      return (put as (k: string, v: unknown) => Promise<void>)(k, v);
    }) as StudioStorage["put"];
    await expect(runDestroy(
      async () => ({ ok: true, hasOpenTask: false }), STUDIO_ID, "rafarc21/fleetflare", false,
      { exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })), now: () => NOW } as unknown as SessionSyncDeps,
      storage as never, STUDIO_ID,
      async () => { destroyed = true; },
      async () => {}, "fleetflare", async () => "rafarc21/blueprint", async () => {},
      { containerRunning: () => false },
    )).rejects.toThrow("storage write failed");
    expect(storage.map.get(DESTROYING_KEY) ?? null).toBeNull();
  });
});

describe("the destroy race, TICK side (#100 N5)", () => {
  it("runScheduledTick skips the tick BODY while a destroy is in flight, and still re-arms", async () => {
    const storage = fakeStorage(status("running"));
    await storage.put(DESTROYING_KEY, new Date(Date.now() - 5_000).toISOString());
    const tick = vi.fn(async () => {});
    const rearm = vi.fn(async () => {});
    await runScheduledTick(storage, tick, rearm);
    expect(tick).not.toHaveBeenCalled();
    expect(rearm).toHaveBeenCalledTimes(1);
  });

  it("a null marker (#103: the released shape) is no marker — the tick runs", async () => {
    const storage = fakeStorage(status("running"));
    await storage.put(DESTROYING_KEY, null);
    const tick = vi.fn(async () => {});
    await runScheduledTick(storage, tick, vi.fn(async () => {}));
    expect(tick).toHaveBeenCalledTimes(1);
  });

  const bare = { kind: "bare" as const, reason: "no checkout", checkedAt: NOW.toISOString() };

  it("decideHeal stands down on a fresh destroy marker", () => {
    const since = new Date(NOW.getTime() - 5_000).toISOString();
    const d = decideHeal(status("running"), bare, undefined, null, NOW, since);
    expect(d).toEqual({ kind: "stand-down", why: "a destroy is in flight" });
    expect(decideHeal(status("running"), bare, undefined, null, NOW, null).kind).toBe("heal");
  });

  it("healBareContainer reads the marker from storage: no restart undoes a destroy", async () => {
    const storage = fakeStorage(status("running"));
    await storage.put(DESTROYING_KEY, new Date(NOW.getTime() - 5_000).toISOString());
    const heal = vi.fn(async () => {});
    const d = await healBareContainer(storage as never, STUDIO_ID, status("running"), bare, () => NOW, heal, async () => {});
    expect(d.kind).toBe("stand-down");
    expect(heal).not.toHaveBeenCalled();
  });
});

describe("spawn's notifyMaestro shares the skip-is-info rule (#100 N2)", () => {
  it("a stopped maestro's skip logs at info, never as an error", async () => {
    // Issue #107 fix-first: getStudioStub (notifyMaestro's own dispatch)
    // now reads the registry row first, so this needs a real DB binding —
    // `...env` supplies it (cloudflare:test's own `env`, imported above),
    // same as every other real-D1-backed test in this file/suite.
    const testEnv = {
      ...env,
      STUDIO: {
        idFromName: (n: string) => n,
        get: () => ({ wakeStudio: async () => ({ ok: false, skipped: true, error: "refused: this studio is stopped" }) }),
      },
    } as unknown as Env;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const infos = vi.spyOn(console, "log").mockImplementation(() => {});
    await spawnDeps(testEnv, vi.fn(), vi.fn()).notifyMaestro("fleetflare--maestro", "WAKE");
    expect(errors).not.toHaveBeenCalled();
    expect(infos.mock.calls.flat().join(" ")).toContain("stopped");
    errors.mockRestore();
    infos.mockRestore();
  });
});

describe("runInspect refuses while a destroy is in flight (#100 N5)", () => {
  it("zero execs, and says why", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const out = await runInspect({ recordedState: async () => DESTROY_IN_FLIGHT, exec }, "fleetflare");
    expect(exec).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain("a destroy is in flight");
  });
});

// ---------------------------------------------------------------------------
// Board issue #213: `resolveBringupEnv`'s brief only reaches a genuinely NEW
// claude conversation. A bring-up that instead RESUMES an existing tmux
// session (this codebase's own worktree-session-adopt machinery) never reads
// that brief at all — measured live, a stopped studio with a task assigned
// came back healthy on a plain `fleet provision` and never heard about the
// task. `deliverAssignedTaskOnBringup` is the fix: a wake, typed the SAME
// way `wakeOnAssign` (assign-wake.ts) already types one into a RUNNING
// studio, fired after bring-up is verified.
//
// Board issue #137 widened this twice: (1) EVERY open working/input_required
// task gets its own wake, not only the single newest one, and (2) the dedup
// gate is scoped to the bring-up's own `incarnation` token, not the task
// number alone — `DELIVERED_TASK_KEY` (still asserted on below) is now only
// `harvestLearnings`'s teardown pointer and no longer gates delivery.
//
// Same DI shape as `wakeStudioWith`/`sweepWake` above: a fake StudioStorage
// and fake thunks, no DO construction (this file's own header explains why
// that is required, not merely convenient).
// ---------------------------------------------------------------------------
describe("deliverAssignedTaskOnBringup — board issue #213/#137's bring-up delivery wake", () => {
  const TASK = { taskNumber: 826, title: "Fix the thing" };
  const INC_1 = "11111111-1111-4111-8111-111111111111";
  const INC_2 = "22222222-2222-4222-8222-222222222222";

  it("a stopped studio with a filed task, then a verified bring-up: exactly one gated wake naming that task", async () => {
    const storage = fakeStorage(status("running"));
    const boardLookup = vi.fn(async () => [TASK]);
    const wake = vi.fn(async () => ({ ok: true }));
    await deliverAssignedTaskOnBringup(storage, INC_1, boardLookup, wake);
    expect(boardLookup).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
    // The SAME one-line pointer format a running studio's assign-time wake
    // uses — never resolveLatestAssignedBrief's own multi-line `prompt`,
    // which would arrive at a live pane as several broken half-prompts.
    expect(wake).toHaveBeenCalledWith(assignDigest({ number: TASK.taskNumber, title: TASK.title }), TASK.taskNumber);
    // The OLD marker is still written, unconditionally, for harvestLearnings.
    expect(storage.map.get(DELIVERED_TASK_KEY)).toBe(826);
  });

  it("no task currently assigned: no wake, nothing recorded", async () => {
    const storage = fakeStorage(status("running"));
    const boardLookup = vi.fn(async () => []);
    const wake = vi.fn(async () => ({ ok: true }));
    await deliverAssignedTaskOnBringup(storage, INC_1, boardLookup, wake);
    expect(wake).not.toHaveBeenCalled();
    expect(storage.map.get(DELIVERED_TASK_KEY)).toBeUndefined();
  });

  it("a task already delivered: no second wake, across two separate bring-ups on the SAME incarnation", async () => {
    const storage = fakeStorage(status("running"));
    const boardLookup = vi.fn(async () => [TASK]);
    const wake = vi.fn(async () => ({ ok: true }));
    await deliverAssignedTaskOnBringup(storage, INC_1, boardLookup, wake);
    await deliverAssignedTaskOnBringup(storage, INC_1, boardLookup, wake);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(storage.map.get(DELIVERED_TASK_KEY)).toBe(826);
  });

  // Issue #137's own fix, pinned directly: the OLD code recorded
  // DELIVERED_TASK_KEY forever with no notion of container identity, so a
  // task delivered once was never re-delivered on any later bring-up for
  // that same task — even after the container was fully destroyed and
  // rebuilt (an image rollout). A bring-up with a DIFFERENT incarnation than
  // the one that last delivered this task must earn a fresh wake.
  it("board issue #137: the SAME task, on the SAME storage, but a DIFFERENT incarnation — re-delivered, not suppressed", async () => {
    const storage = fakeStorage(status("running"));
    const boardLookup = vi.fn(async () => [TASK]);
    const wake = vi.fn(async () => ({ ok: true }));
    await deliverAssignedTaskOnBringup(storage, INC_1, boardLookup, wake);
    await deliverAssignedTaskOnBringup(storage, INC_2, boardLookup, wake);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenNthCalledWith(1, assignDigest({ number: TASK.taskNumber, title: TASK.title }), TASK.taskNumber);
    expect(wake).toHaveBeenNthCalledWith(2, assignDigest({ number: TASK.taskNumber, title: TASK.title }), TASK.taskNumber);
  });

  it("a limit modal on screen: refused, and NOTHING is persisted, so the next bring-up retries and delivers", async () => {
    const storage = fakeStorage(status("running"));
    const boardLookup = vi.fn(async () => [TASK]);
    const refusedWake = vi.fn(async (): Promise<WakeOutcome> => ({ ok: false, skipped: true, error: "refused: a modal is on screen" }));
    await deliverAssignedTaskOnBringup(storage, INC_1, boardLookup, refusedWake);
    expect(refusedWake).toHaveBeenCalledTimes(1);
    expect(storage.map.get(DELIVERED_TASK_KEY)).toBeUndefined();

    // The retry: same task, same incarnation, this time the gate lets the
    // wake land.
    const okWake = vi.fn(async () => ({ ok: true }));
    await deliverAssignedTaskOnBringup(storage, INC_1, boardLookup, okWake);
    expect(okWake).toHaveBeenCalledTimes(1);
    expect(storage.map.get(DELIVERED_TASK_KEY)).toBe(826);
  });

  it("two simultaneously open tasks in ONE boardLookup call: each gets its own wake, each independently recorded", async () => {
    const storage = fakeStorage(status("running"));
    const OTHER = { taskNumber: 900, title: "A second open task" };
    const wake = vi.fn(async () => ({ ok: true }));
    await deliverAssignedTaskOnBringup(storage, INC_1, async () => [TASK, OTHER], wake);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenNthCalledWith(1, assignDigest({ number: TASK.taskNumber, title: TASK.title }), TASK.taskNumber);
    expect(wake).toHaveBeenNthCalledWith(2, assignDigest({ number: OTHER.taskNumber, title: OTHER.title }), OTHER.taskNumber);
    // The OLD marker only ever holds the LAST one written — "last delivered
    // wins", unchanged, for harvestLearnings' own teardown read.
    expect(storage.map.get(DELIVERED_TASK_KEY)).toBe(900);

    // Same incarnation, a THIRD bring-up sees the same two tasks still open
    // plus a newly-assigned one: only the new one gets a fresh wake — the
    // first two are still correctly deduped within the same incarnation.
    const THIRD = { taskNumber: 901, title: "A third, newly assigned task" };
    await deliverAssignedTaskOnBringup(storage, INC_1, async () => [TASK, OTHER, THIRD], wake);
    expect(wake).toHaveBeenCalledTimes(3);
    expect(wake).toHaveBeenNthCalledWith(3, assignDigest({ number: THIRD.taskNumber, title: THIRD.title }), THIRD.taskNumber);
  });

  it("incarnation === null behaves like the old marker always did: forever, no reset", async () => {
    const storage = fakeStorage(status("running"));
    const boardLookup = vi.fn(async () => [TASK]);
    const wake = vi.fn(async () => ({ ok: true }));
    await deliverAssignedTaskOnBringup(storage, null, boardLookup, wake);
    await deliverAssignedTaskOnBringup(storage, null, boardLookup, wake);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  // Fix round on issue #213 (PR #229), rebased onto issue #174's OpCtx destroy-
  // epoch guard (issue #152's own race-safety mechanism): a destroy that lands
  // between "we decided to deliver" (dedup check passed, a task was found) and
  // "we actually sent the wake" must veto the send — exactly like #174 already
  // vetoes every other bring-up write. `moved` is checked AFTER the dedup
  // check but BEFORE the wake itself: the `lookup` fake below flips its own
  // `moved` flag true the moment it is called (standing in for a destroy
  // landing during the board round trip that lookup represents), then still
  // returns a task — proving the veto is a SEPARATE check, not something the
  // dedup logic already covers.
  it("a destroy landing between deciding to deliver and sending the wake vetoes the send (5th `moved` param)", async () => {
    const storage = fakeStorage(status("running"));
    let moved = false;
    const lookup = vi.fn(async () => {
      moved = true;
      return [TASK];
    });
    const wake = vi.fn(async () => ({ ok: true }));
    await deliverAssignedTaskOnBringup(storage, INC_1, lookup, wake, async () => moved);
    expect(wake).not.toHaveBeenCalled();
    expect(storage.map.get(DELIVERED_TASK_KEY)).toBeUndefined();
  });
});
