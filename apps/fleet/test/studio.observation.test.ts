import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import {
  STATUS_KEY, HEAL_ATTEMPT_KEY, OPERATION_KEY, LAST_STOP_KEY, type StudioStorage,
} from "../src/studio/provision";
import {
  recordContainerStop, statusDetailWithStorage,
  type CommitLearningFile, type LastStopStorage, type ResolveMemoryRepo,
} from "../src/studio/do";
import { destroyWithSync, runDestroy, DESTROY_REFUSED_PREFIX } from "../src/studio/destroy";
import { DESTROYING_KEY } from "../src/studio/provision";
import { LIVENESS_RULE } from "../src/studio/recycle-cost";
import { sbContainerBooting } from "../src/studio/sandbox-api";
import type { SessionSyncDeps, SessionSyncStorage } from "../src/studio/session-sync";
import type { StudioStatus } from "../src/studio/types";

// ---------------------------------------------------------------------------
// Issue #104, observation half. `fleet destroy` had NO probe: on a wedged
// container its sync/rescue/harvest execs hung and destroy never ran. The
// container's own exit (code + reason) was logged only at debug, so a
// spontaneous exit (~1-2/day, e.g. acme-os--web-studio 11:42:38) left no
// trace an operator could read.
// ---------------------------------------------------------------------------

const STUDIO_ID = "websites--pilot";
const doSrc: string = env.TEST_STUDIO_DO_SRC;

type CombinedStorage = StudioStorage & SessionSyncStorage & LastStopStorage;

function fakeStorage(seed: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed));
  const storage = {
    get: (async (key: string) => map.get(key)) as CombinedStorage["get"],
    put: (async (key: string, value: unknown) => { map.set(key, value); }) as CombinedStorage["put"],
    // Issue #228 item 4: SessionSyncStorage.delete is now required — this
    // fake never arms/consumes SESSION_FORCE_KEY itself.
    delete: (async (key: string) => map.delete(key)) as NonNullable<SessionSyncStorage["delete"]>,
  };
  return { map, storage };
}

function running(): StudioStatus {
  return {
    id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
  };
}

/** A wedged container: every exec is accepted and never answered. */
function wedgedSyncDeps(): SessionSyncDeps & { execCalls: string[] } {
  const execCalls: string[] = [];
  return {
    execCalls,
    exec: (cmd: string) => {
      execCalls.push(cmd);
      return new Promise(() => {});
    },
    r2Put: async () => {},
    r2List: async () => [],
    r2Delete: async () => {},
    now: () => new Date("2026-09-24T12:00:00.000Z"),
    notify: async () => {},
    burnAlertThresholdTokens: 0,
  } as SessionSyncDeps & { execCalls: string[] };
}

const noopCommit: CommitLearningFile = async () => {};
const noopResolve: ResolveMemoryRepo = async () => "unused/blueprint";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("destroyWithSync — probes first, like recycle", () => {
  const LAST_SYNC = new Date("2026-09-24T11:20:00.000Z"); // 40m before wedgedSyncDeps' now

  it("a container that is NOT running is never touched: zero execs, destroy once, stopped (#113 F1)", async () => {
    // An exec STARTS a stopped container; a probe that gives up mid-boot
    // leaves the SDK's 503 retry to start a SECOND one after destroy — which
    // then bills under a stopped row. Nothing to rescue either: disk is gone.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { storage, map } = fakeStorage({ [STATUS_KEY]: running() });
    const deps = wedgedSyncDeps();
    const destroy = vi.fn(async () => {});
    const status = await destroyWithSync(
      deps, storage, STUDIO_ID, destroy, async () => {}, "websites", noopResolve, noopCommit,
      { containerRunning: () => false },
    );
    expect(deps.execCalls).toEqual([]);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(status.state).toBe("stopped");
    expect((map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
  });

  it("a RUNNING container that fails the probe is REFUSED, naming the snapshot age — like recycle (#113 M3)", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { storage, map } = fakeStorage({ [STATUS_KEY]: running() });
    const deps = wedgedSyncDeps();
    const destroy = vi.fn(async () => {});
    const outcome = runDestroy(
      undefined, STUDIO_ID, "acme-org/websites", true, deps, storage, STUDIO_ID, destroy, async () => {},
      "websites", noopResolve, noopCommit,
      { containerRunning: () => true, discardUnsynced: false, lastSyncedAt: async () => LAST_SYNC },
    );
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.startsWith(DESTROY_REFUSED_PREFIX)).toBe(true);
      expect(result.reason).toContain("40m old");
      expect(result.reason).toContain(`fleet destroy ${STUDIO_ID} --discard-unsynced`);
    }
    expect(destroy).not.toHaveBeenCalled();
    expect(deps.execCalls).toEqual(["printf ok"]);
    expect((map.get(STATUS_KEY) as StudioStatus).state).toBe("running");
  });

  it("--discard-unsynced destroys a wedged running container anyway, and SAYS it was not rescued", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { storage, map } = fakeStorage({ [STATUS_KEY]: running() });
    const deps = wedgedSyncDeps();
    const destroy = vi.fn(async () => {});
    const p = destroyWithSync(
      deps, storage, STUDIO_ID, destroy, async () => {}, "websites", noopResolve, noopCommit,
      { containerRunning: () => true, discardUnsynced: true, lastSyncedAt: async () => LAST_SYNC },
    );
    await vi.advanceTimersByTimeAsync(8_000);
    const status = await p;
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(deps.execCalls).toEqual(["printf ok"]);
    expect(status.state).toBe("stopped");
    expect(status.error).toContain("destroyed without rescue");
    expect((map.get(STATUS_KEY) as StudioStatus).error).toContain("destroyed without rescue");
  });
});

describe("destroyWithSync — a MID-BOOT container is waited out first (#129 F2)", () => {
  // Running (start() called) but not listening yet. A probe that quits at 8s
  // and a destroy() that kills the boot leave the in-flight exec's 503 to the
  // SDK's retry, which starts a SECOND container after destroy — billing
  // under a stopped row. Wait the boot out first; then everything is as today.
  const LAST_SYNC = new Date("2026-09-24T11:20:00.000Z");

  function orderedDeps(order: string[], answers: boolean) {
    const deps = wedgedSyncDeps();
    deps.exec = (cmd: string) => {
      order.push(cmd);
      deps.execCalls.push(cmd);
      return answers ? Promise.resolve({ code: 0, stdout: "", stderr: "" }) : new Promise(() => {});
    };
    return deps;
  }

  it("awaits the boot BEFORE the probe", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    const { storage } = fakeStorage({ [STATUS_KEY]: running() });
    await destroyWithSync(
      orderedDeps(order, true), storage, STUDIO_ID, async () => { order.push("destroy"); }, async () => {},
      "websites", noopResolve, noopCommit,
      {
        containerRunning: () => true,
        containerBooting: async () => true,
        awaitBoot: async () => { order.push("awaitBoot"); },
      },
    );
    expect(order[0]).toBe("awaitBoot");
    expect(order[1]).toBe("printf ok");
    expect(order.at(-1)).toBe("destroy");
  });

  it("a boot that never completes still probes, and the refusal still stands", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    const { storage, map } = fakeStorage({ [STATUS_KEY]: running() });
    const destroy = vi.fn(async () => {});
    const p = runDestroy(
      undefined, STUDIO_ID, "acme-org/websites", true, orderedDeps(order, false), storage, STUDIO_ID,
      destroy, async () => {}, "websites", noopResolve, noopCommit,
      {
        containerRunning: () => true,
        containerBooting: async () => true,
        awaitBoot: async () => { throw new Error("ports never opened"); },
        lastSyncedAt: async () => LAST_SYNC,
      },
    );
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await p;
    expect(order).toEqual(["printf ok"]);
    expect(result.ok).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    // A refusal never set the stop marker, so wakes/ticks are not blocked.
    expect(map.get(DESTROYING_KEY) ?? null).toBeNull();
    if (!result.ok) {
      expect(result.reason).toContain("the next provision");
      expect(result.reason).toContain(LIVENESS_RULE);
    }
  });

  it("a boot that ends with the container gone skips the probe entirely", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    let up = true;
    const { storage } = fakeStorage({ [STATUS_KEY]: running() });
    await destroyWithSync(
      orderedDeps(order, true), storage, STUDIO_ID, async () => { order.push("destroy"); }, async () => {},
      "websites", noopResolve, noopCommit,
      {
        containerRunning: () => up,
        containerBooting: async () => true,
        awaitBoot: async () => { up = false; throw new Error("container exited during boot"); },
      },
    );
    expect(order).toEqual(["destroy"]);
  });

  it("a healthy container is not waited on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const awaitBoot = vi.fn(async () => {});
    const { storage } = fakeStorage({ [STATUS_KEY]: running() });
    await destroyWithSync(
      orderedDeps([], true), storage, STUDIO_ID, async () => {}, async () => {}, "websites", noopResolve, noopCommit,
      { containerRunning: () => true, containerBooting: async () => false, awaitBoot },
    );
    expect(awaitBoot).not.toHaveBeenCalled();
  });

  it("a studio recorded STOPPED is destroyed without a probe — destroy already rescued it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = orderedDeps([], false);
    const destroy = vi.fn(async () => {});
    const { storage } = fakeStorage({ [STATUS_KEY]: { ...running(), state: "stopped" } });
    const status = await destroyWithSync(
      deps, storage, STUDIO_ID, destroy, async () => {}, "websites", noopResolve, noopCommit,
      { containerRunning: () => true, discardUnsynced: false },
    );
    expect(deps.execCalls).toEqual([]);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(status.state).toBe("stopped");
  });

  it("the unrescued note names the flag actually passed", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { storage } = fakeStorage({ [STATUS_KEY]: running() });
    const p = destroyWithSync(
      orderedDeps([], false), storage, STUDIO_ID, async () => {}, async () => {}, "websites", noopResolve, noopCommit,
      { containerRunning: () => true, discardUnsynced: true, discardFlag: "--force" },
    );
    await vi.advanceTimersByTimeAsync(8_000);
    const status = await p;
    expect(status.error).toContain("(--force)");
    expect(status.error).not.toContain("--discard-unsynced");
  });
});

describe("sbContainerBooting — running but not yet healthy", () => {
  it("reads the containers library's own state, never an exec", async () => {
    expect(await sbContainerBooting({ getState: async () => ({ status: "running" }) })).toBe(true);
    expect(await sbContainerBooting({ getState: async () => ({ status: "healthy" }) })).toBe(false);
  });
});

describe("recordContainerStop — each onStop call leaves a readable record", () => {
  it("persists the exit code, reason and time, and logs at info level", async () => {
    const { storage, map } = fakeStorage();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordContainerStop(storage, STUDIO_ID, { exitCode: 137, reason: "exit" }, new Date("2026-09-24T11:42:38.000Z"));
    expect(map.get(LAST_STOP_KEY)).toEqual({ exitCode: 137, reason: "exit", at: "2026-09-24T11:42:38.000Z" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("exit code 137"));
    expect(log.mock.calls[0]![0]).toContain(STUDIO_ID);
  });

  it("never throws into the containers library, even when storage does", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = {
      get: async () => undefined,
      put: async () => { throw new Error("storage down"); },
    } as unknown as LastStopStorage;
    await expect(recordContainerStop(storage, STUDIO_ID, { exitCode: 0, reason: "exit" }, new Date())).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});

describe("statusDetailWithStorage — what /status now answers", () => {
  it("adds lastStop, healAttempt and operationInFlight to the status row", async () => {
    const lastStop = { exitCode: 1, reason: "exit", at: "2026-09-24T11:42:38.000Z" };
    const heal = { armed: true, attemptedAt: "2026-09-24T11:43:00.000Z", reason: "bare" };
    const op = { op: "restart", since: new Date(Date.now() - 60_000).toISOString() }; // fresh lock
    const { storage } = fakeStorage({
      [STATUS_KEY]: running(), [LAST_STOP_KEY]: lastStop, [HEAL_ATTEMPT_KEY]: heal, [OPERATION_KEY]: op,
    });
    const detail = await statusDetailWithStorage(storage, STUDIO_ID);
    expect(detail).toMatchObject({ id: STUDIO_ID, state: "running", lastStop, healAttempt: heal, operationInFlight: op });
  });

  it("a stale (>15 min) operation lock is not shown as in flight", async () => {
    const stale = { op: "restart", since: new Date(Date.now() - 16 * 60 * 1000).toISOString() };
    const { storage } = fakeStorage({ [STATUS_KEY]: running(), [OPERATION_KEY]: stale });
    expect((await statusDetailWithStorage(storage, STUDIO_ID)).operationInFlight).toBeNull();
  });

  it("answers null for each when nothing was ever recorded", async () => {
    const { storage } = fakeStorage();
    const detail = await statusDetailWithStorage(storage, STUDIO_ID);
    expect(detail.lastStop).toBeNull();
    expect(detail.healAttempt).toBeNull();
    expect(detail.operationInFlight).toBeNull();
    expect(detail.state).toBe("stopped");
  });
});

describe("StudioDO wiring (source-pinned — the class cannot be constructed here)", () => {
  const body = (sig: string) => {
    const start = doSrc.indexOf(sig);
    expect(start).toBeGreaterThan(-1);
    return doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
  };

  it("onStop runs the library's own onStop first, then records the stop", () => {
    const b = body("  async onStop(");
    expect(b).toContain("await super.onStop(params)");
    expect(b).toContain("recordContainerStop(");
    expect(b.indexOf("super.onStop")).toBeLessThan(b.indexOf("recordContainerStop("));
  });

  // Issue #221 fix round 2, Fix 4 — a stopped container has no lead for
  // `since`/`anchored` to keep describing; onStop must clear both keys so a
  // later bring-up starts from a fresh state, never a survivor.
  it("onStop also clears activity state (issue #221 fix round 2, Fix 4)", () => {
    const b = body("  async onStop(");
    expect(b).toContain("clearActivityState(this.ctx.storage)");
  });

  // Issue #221 fix round 2, Fix 4 — the other half: a FRESH bring-up
  // (provision/restart/recycle/heal) must not let a stale `since` from
  // before the bring-up survive either. `provisionUngated` and
  // `restartUngated` are do.ts's own bring-up entry points (the same two
  // functions test/studio.replacement.test.ts already exercises through
  // `provisionWithStorage`/`restartWithSync`), private methods on the class
  // itself, so — same as onStop above — pinned by source rather than
  // constructed.
  it("provisionUngated clears activity state after a successful provision", () => {
    const b = body("  private async provisionUngated(");
    expect(b).toContain("clearActivityState(this.ctx.storage)");
    expect(b.indexOf("provisionWithStorage(")).toBeLessThan(b.indexOf("clearActivityState("));
  });

  it("restartUngated clears activity state after a successful restart/recycle/heal", () => {
    const b = body("  private async restartUngated(");
    expect(b).toContain("clearActivityState(this.ctx.storage)");
    expect(b.indexOf("restartWithSync(")).toBeLessThan(b.indexOf("clearActivityState("));
  });

  it("onStart runs the library's own onStart and logs at info level", () => {
    const b = body("  async onStart(");
    expect(b).toContain("await super.onStart()");
    expect(b).toContain("console.log(");
  });

  it("destroyStudio waits out a mid-boot container, and --force counts as a stated discard (#129)", () => {
    const b = body("  async destroyStudio(");
    expect(b).toContain("containerBooting: () => sbContainerBooting(this)");
    expect(b).toContain("awaitBoot: () => sbAwaitReady(this)");
    expect(b).toContain("discardUnsynced: discardUnsynced || force");
    expect(b).toContain('discardFlag: discardUnsynced ? "--discard-unsynced" : "--force"');
  });

  it("destroyStudio tells destroy whether the container is running — a property, never an exec", () => {
    const b = body("  async destroyStudio(");
    expect(b).toContain("containerRunning: () => this.ctx.container?.running === true");
    expect(b).toContain("lastSyncedAt: () => this.lastSyncedAt()");
  });

  it("getStatusDetail forwards to statusDetailWithStorage", () => {
    expect(body("  async getStatusDetail(")).toContain("statusDetailWithStorage(this.ctx.storage");
  });
});
