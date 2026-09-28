import { describe, it, expect, vi } from "vitest";
import {
  runScheduledTick, disarmStudioTicks, STUDIO_TICKS, syncSessionCycle, checkAndRecordReadiness, StudioDO,
} from "../src/studio/do";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import type { SessionSyncDeps } from "../src/studio/session-sync";
import type { StudioStatus, StudioState } from "../src/studio/types";

// ---------------------------------------------------------------------------
// A stopped studio stays stopped.
//
// MEASURED 2026-09-24 (wrangler tail on the deployed Worker, 7 min): sandbox.exec ran in
// 19 distinct containers while only 7 studios were running. Every one of the
// 12 stopped studios took an exec every ~5 minutes, each logging "session
// sync tick failed: tar: .claude/projects: Cannot stat" — the signature of an
// EMPTY container that the exec itself had just booted. `fleet destroy` wrote
// `state: "stopped"` and left every schedule loop (refreshToken,
// shipTranscript, syncSession, sweepMaestro) armed; each tick re-armed itself
// in `finally` and execed with no state check. sbExec STARTS a container
// that is not running, so billing restarted on every tick, forever.
//
// A live StudioDO cannot be constructed under vitest-pool-workers (see
// src/studio/do.ts's header), so this targets the exported guard every tick
// forwards through, driven with the REAL syncSessionCycle body.
// ---------------------------------------------------------------------------

const STUDIO_ID = "fleetflare--web-studio";

function status(state: StudioState): StudioStatus {
  return { id: STUDIO_ID, state, tailscaleHost: null, lastRefresh: null, error: null } as StudioStatus;
}

function fakeStorage(seed?: StudioStatus) {
  const map = new Map<string, unknown>();
  if (seed) map.set(STATUS_KEY, seed);
  return {
    map,
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

function execDeps() {
  const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const deps = {
    exec,
    r2Put: vi.fn(async () => {}),
    r2List: vi.fn(async () => []),
    r2Delete: vi.fn(async () => {}),
    now: () => new Date("2026-09-24T09:00:00.000Z"),
    notify: vi.fn(async () => {}),
    burnAlertThresholdTokens: 0,
  } as unknown as SessionSyncDeps;
  return { exec, deps };
}

describe("runScheduledTick — a stopped studio's tick never touches the container", () => {
  it("a stopped studio's syncSession tick execs nothing and does not re-arm", async () => {
    const s = fakeStorage(status("stopped"));
    const { exec, deps } = execDeps();
    const rearm = vi.fn(async () => {});

    await runScheduledTick(s as never, () => syncSessionCycle(deps, s as never, STUDIO_ID, async () => {}), rearm);

    expect(exec).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
  });

  // getStatus answers "stopped" for a DO with no stored status; a tick has
  // no more business booting a never-provisioned container than a stopped one.
  it("a studio with no stored status is treated as stopped", async () => {
    const s = fakeStorage();
    const tick = vi.fn(async () => {});
    const rearm = vi.fn(async () => {});

    await runScheduledTick(s as never, tick, rearm);

    expect(tick).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
  });

  it.each<StudioState>(["running", "degraded", "provisioning"])(
    "a %s studio's tick runs and re-arms exactly as before",
    async (state) => {
      const s = fakeStorage(status(state));
      const { exec, deps } = execDeps();
      const rearm = vi.fn(async () => {});

      await runScheduledTick(s as never, () => syncSessionCycle(deps, s as never, STUDIO_ID, async () => {}), rearm);

      expect(exec).toHaveBeenCalled();
      expect(rearm).toHaveBeenCalledTimes(1);
    },
  );

  // Same guarantee refreshToken()'s own doc comment gives: one unguarded
  // throw must not end a running studio's loop.
  it("a running studio's tick that throws still re-arms, and the throw propagates", async () => {
    const s = fakeStorage(status("running"));
    const rearm = vi.fn(async () => {});

    await expect(
      runScheduledTick(s as never, async () => { throw new Error("boom"); }, rearm),
    ).rejects.toThrow("boom");
    expect(rearm).toHaveBeenCalledTimes(1);
  });

  // A tick already in flight when `fleet destroy` lands must not re-arm the
  // loop the destroy just cancelled.
  it("a tick whose studio was stopped while it ran does not re-arm", async () => {
    const s = fakeStorage(status("running"));
    const rearm = vi.fn(async () => {});

    await runScheduledTick(s as never, async () => { await s.put(STATUS_KEY, status("stopped")); }, rearm);

    expect(rearm).not.toHaveBeenCalled();
  });
});

describe("disarmStudioTicks — destroy cancels every loop", () => {
  it("deletes the schedule of every tick StudioDO runs", () => {
    const deleted: string[] = [];
    disarmStudioTicks((name) => deleted.push(name));
    expect(deleted.sort()).toEqual(["refreshToken", "shipTranscript", "sweepMaestro", "syncSession"]);
  });

  // The list is the contract: a name here that is not a real callback would
  // cancel nothing and leave the real loop running.
  it("names only real StudioDO scheduled callbacks", () => {
    for (const name of STUDIO_TICKS) {
      expect(typeof (StudioDO.prototype as unknown as Record<string, unknown>)[name]).toBe("function");
    }
  });
});

// `fleet ls --fresh` POSTs /check to EVERY studio in the listing, stopped ones
// included. A readiness check on a stopped studio has nothing to measure —
// and its exec would boot the container it is asking about.
describe("checkAndRecordReadiness — a stopped studio is not probed", () => {
  it("answers the stored row without an exec or a registry write", async () => {
    const stopped = status("stopped");
    const s = fakeStorage(stopped);
    const { exec, deps } = execDeps();
    const record = vi.fn(async () => {});

    const answer = await checkAndRecordReadiness(deps, s as never, STUDIO_ID, record);

    expect(exec).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(answer).toEqual(stopped);
  });

  it("a running studio is still probed", async () => {
    const s = fakeStorage(status("running"));
    const { exec, deps } = execDeps();

    await checkAndRecordReadiness(deps, s as never, STUDIO_ID, async () => {});

    expect(exec).toHaveBeenCalled();
  });
});
