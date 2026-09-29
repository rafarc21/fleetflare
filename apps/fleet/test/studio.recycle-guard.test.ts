import { describe, it, expect, vi } from "vitest";
import {
  recycleWithSync, RECYCLE_REFUSED_PREFIX, decideHeal, RESCUE_FAILED_PREFIX, RESCUE_PUSHED_PREFIX, HARVEST_NO_RECORD,
} from "../src/studio/do";
import { asideListCmd, asidePackCmd, asideMarkCmd } from "../src/studio/session-sync";
const RESCUE_CLEAN_LINE = "RESCUE_CLEAN";
import {
  PROVISIONED_OK, provisionedCheckCmd, STATUS_KEY, OPERATION_KEY, OPERATION_STALE_MS, provisionWithStorage,
  BRINGUP_CMD, type StudioStorage, type ProvisionDeps, type OperationInFlight,
} from "../src/studio/provision";
import { BRINGUP_TOKEN_WRITE_SECTION, type ObservedStorage } from "../src/studio/observed";
import type { SessionSyncDeps, SessionSyncStorage } from "../src/studio/session-sync";
import type { ProvisionConfig, StudioStatus, StudioReadiness } from "../src/studio/types";

/**
 * Issue #96, maestro amendment. Measured 2026-09-24: the BETA coordinator
 * recycled wedged studios 3 times believing it free. Each recycle's probe
 * failed, so session sync and rescue-push were skipped and up to 63 minutes
 * of conversation were discarded — while the lead was often still alive.
 *
 * A failed probe now REFUSES by default, naming the price; only an explicit
 * `--discard-unsynced` pays it.
 */
const ID = "demosite-life--web-studio";
const CFG: ProvisionConfig = { repo: "demosite-life", role: "web-studio" };
const NOW = new Date("2026-09-24T12:15:00.000Z");
const SYNCED_63_MIN_AGO = new Date("2026-09-24T11:12:00.000Z");

/** A wedged container: the probe never answers; the post-provision check
 *  (against the FRESH container) does. */
function wedgedDeps(): SessionSyncDeps & { execCalls: string[] } {
  const execCalls: string[] = [];
  return {
    execCalls,
    exec: async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === "printf ok") throw new Error("Network connection lost.");
      if (cmd === provisionedCheckCmd(CFG.repo)) return { code: 0, stdout: PROVISIONED_OK, stderr: "" };
      throw new Error(`unexpected exec against a wedged container: ${cmd}`);
    },
    r2Put: async () => {},
    r2List: async () => [],
    r2Delete: async () => {},
    now: () => NOW,
    notify: async () => {},
    burnAlertThresholdTokens: 0,
  };
}

function storage(state = "running"): StudioStorage & SessionSyncStorage {
  const map = new Map<string, unknown>([[STATUS_KEY, { id: ID, state }]]);
  return {
    get: (async (k: string) => map.get(k)) as never,
    put: (async (k: string, v: unknown) => { map.set(k, v); }) as never,
    // Issue #228 item 4: SessionSyncStorage.delete is now required — this
    // fake never arms/consumes SESSION_FORCE_KEY itself.
    delete: (async (k: string) => map.delete(k)) as never,
  } as StudioStorage & SessionSyncStorage;
}

// Review round 5, Finding 1 — the SAME Map-backed fake satisfies ObservedStorage
// too (a generic get/put keyed the same way as every other studio storage
// fake), so a single fixture works as the third-typed storage
// `provisionWithStorage` accepts below.
function fullStorage(state = "running"): StudioStorage & SessionSyncStorage & ObservedStorage {
  return storage(state) as StudioStorage & SessionSyncStorage & ObservedStorage;
}

const FAKE_FLEET_JSON = JSON.stringify({
  blueprint: { repo: "rafarc21/fleetflare", ref: "main" }, roles: ["web-studio"], instance_type: "standard-2",
});
const FAKE_ROLE_MD = `---
name: web-studio
skills: []
allowedTools: Bash(git *) Bash(fleet *) Edit Write
may_spawn: []
reports_to: operator
gates: []
---
You are web-studio. Sandbox role, low stakes.
`;
const FAKE_ORG_JSON = JSON.stringify({ edges: { cto: ["release"] }, gates: { merge: ["release"] } });

/**
 * Review round 5, Finding 1 — a REAL `provisionWithStorage`-shaped
 * `ProvisionDeps`, the exact production shape `provisionCore` (do.ts) hands
 * `recycleWithSync`'s `provision` callback, so this fixture can actually see
 * `provisionWithStorage`'s OWN independent OPERATION_KEY set/clear — the
 * bare `vi.fn(async () => ({...}))` stub this file used before could not,
 * since it never touched storage at all. Same fixture shape as
 * test/studio.replacement.test.ts's own `provisionDeps` helper (that file's
 * own header explains why it owns this convention).
 */
function realProvisionDeps(): ProvisionDeps & { cmds: string[] } {
  const cmds: string[] = [];
  const sbExec = vi.fn(async (cmd: string) => {
    cmds.push(cmd);
    return { code: 0, stdout: "", stderr: "" };
  });
  const fetchBlueprintFile = vi.fn(async (_repo: string, path: string) => {
    if (path === "fleet.json") return FAKE_FLEET_JSON;
    if (path === "fleet/blueprint/roles/web-studio.md") return FAKE_ROLE_MD;
    if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
    throw new Error(`fetch ${path} failed (404): Not Found`);
  });
  return { sbExec, recordStudio: async () => {}, now: () => NOW.toISOString(), fetchBlueprintFile, cmds };
}

function run(guard?: { discardUnsynced: boolean; lastSyncedAt: () => Promise<Date | null> }) {
  const syncDeps = wedgedDeps();
  const destroy = vi.fn(async () => {});
  const awaitReady = vi.fn(async () => {});
  const provision = vi.fn(async () => ({ id: ID, state: "running" }) as StudioStatus);
  const promise = recycleWithSync(
    syncDeps, storage(), ID, destroy, awaitReady, provision, async () => {}, CFG,
    async () => "unused", async () => {}, guard,
  );
  return { promise, destroy, provision, syncDeps };
}

describe("recycle guard — a failed probe refuses instead of silently discarding", () => {
  it("probe fails, no flag: refuses, and destroy is NEVER called", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { promise, destroy, provision } = run({
        discardUnsynced: false, lastSyncedAt: async () => SYNCED_63_MIN_AGO,
      });
      await expect(promise).rejects.toThrow(RECYCLE_REFUSED_PREFIX);
      expect(destroy).toHaveBeenCalledTimes(0);
      expect(provision).toHaveBeenCalledTimes(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("the refusal names the snapshot age, what is lost, and the flag that pays for it", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { promise } = run({ discardUnsynced: false, lastSyncedAt: async () => SYNCED_63_MIN_AGO });
      const message = await promise.then(() => "", (err: Error) => err.message);
      expect(message.startsWith(RECYCLE_REFUSED_PREFIX)).toBe(true);
      expect(message).toContain("1h 3m old");
      expect(message).toContain("The LEAD MAY STILL BE WORKING");
      expect(message).toContain("discards everything since");
      expect(message).toContain(`fleet recycle ${ID} --discard-unsynced`);
      // Wording rule (#96 amendment 1.3): no commits is never permission.
      expect(message).toContain("No commits is NOT evidence");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("no guard argument at all still refuses — the safe side is the default", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { promise, destroy } = run();
      await expect(promise).rejects.toThrow(RECYCLE_REFUSED_PREFIX);
      expect(destroy).toHaveBeenCalledTimes(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("no synced snapshot exists: the refusal says the whole session is lost", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { promise } = run({ discardUnsynced: false, lastSyncedAt: async () => null });
      const message = await promise.then(() => "", (err: Error) => err.message);
      expect(message).toContain("no synced snapshot");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a lastSyncedAt lookup that throws still refuses — an unknown age is not a free recycle", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { promise, destroy } = run({
        discardUnsynced: false, lastSyncedAt: async () => { throw new Error("R2 down"); },
      });
      const message = await promise.then(() => "", (err: Error) => err.message);
      expect(message.startsWith(RECYCLE_REFUSED_PREFIX)).toBe(true);
      expect(message).toContain("unknown");
      expect(destroy).toHaveBeenCalledTimes(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("probe fails WITH --discard-unsynced: proceeds to destroy + reprovision, and says so in the log", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { promise, destroy, provision } = run({
        discardUnsynced: true, lastSyncedAt: async () => SYNCED_63_MIN_AGO,
      });
      const status = await promise;
      expect(status.state).toBe("running");
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(provision).toHaveBeenCalledTimes(1);
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("--discard-unsynced");
      expect(logged).toContain("1h 3m old");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("probe ANSWERS, no flag: the guard never fires — a healthy recycle is unchanged", async () => {
    const lastSyncedAt = vi.fn(async () => SYNCED_63_MIN_AGO);
    const execCalls: string[] = [];
    const syncDeps: SessionSyncDeps = {
      ...wedgedDeps(),
      exec: async (cmd: string) => {
        execCalls.push(cmd);
        if (cmd.startsWith("mkdir -p")) return { code: 0, stdout: "0\n1758067200", stderr: "" }; // #202: size + tar-start watermark
        if (cmd === provisionedCheckCmd(CFG.repo)) return { code: 0, stdout: PROVISIONED_OK, stderr: "" };
        return { code: 0, stdout: "ok", stderr: "" };
      },
    };
    const destroy = vi.fn(async () => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await recycleWithSync(
        syncDeps, storage(), ID, destroy, async () => {},
        async () => ({ id: ID, state: "running" }) as StudioStatus, async () => {}, CFG,
        async () => "unused", async () => {}, { discardUnsynced: false, lastSyncedAt },
      );
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(lastSyncedAt).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  // Review M2: `fleet destroy` already rescued and wiped a STOPPED studio. The
  // probe would boot its container (maybe missing 8s), falsely refuse, and
  // leave a keepAlive container billing under a stopped row.
  it("recorded STOPPED: no probe exec at all, no refusal — destroy once, provision once", async () => {
    const syncDeps = wedgedDeps();
    const destroy = vi.fn(async () => {});
    const provision = vi.fn(async () => ({ id: ID, state: "running" }) as StudioStatus);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const status = await recycleWithSync(
        syncDeps, storage("stopped"), ID, destroy, async () => {}, provision, async () => {}, CFG,
        async () => "unused", async () => {}, { discardUnsynced: false, lastSyncedAt: async () => SYNCED_63_MIN_AGO },
      );
      expect(status.state).toBe("running");
      expect(syncDeps.execCalls).not.toContain("printf ok");
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(provision).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  // Review nit: omitting the guard does not KNOW there is no snapshot.
  it("no guard argument: the refusal says the age is unknown, never 'no synced snapshot'", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { promise } = run();
      const message = await promise.then(() => "", (err: Error) => err.message);
      expect(message).toContain("age unknown");
      expect(message).not.toContain("no synced snapshot");
      expect(message).toContain("an 8s probe");
    } finally {
      errSpy.mockRestore();
    }
  });
});

// Review round 3 (issue #85 PR1), MUST-FIX 5: recycleWithSync must hold
// OPERATION_KEY across its whole destroy -> reprovision window, the same
// op-lock coverage provision/restart already have — both for the heal's
// "already running" guard and the ship tick's failure-counting skip (see
// test/studio.observation-tick.test.ts's own MUST-FIX 5 coverage).
describe("recycleWithSync — op-lock coverage (issue #85 review round 3, MUST-FIX 5)", () => {
  it("writes OPERATION_KEY {op: 'recycle'} before destroy, still held during destroy, cleared once recycle finishes", async () => {
    const syncDeps = wedgedDeps();
    const s = storage("stopped"); // recordedStopped skips the probe/rescue steps entirely
    let opDuringDestroy: unknown;
    const destroy = vi.fn(async () => {
      opDuringDestroy = await s.get(OPERATION_KEY);
    });
    const provision = vi.fn(async () => ({ id: ID, state: "running" }) as StudioStatus);

    const result = await recycleWithSync(
      syncDeps, s, ID, destroy, async () => {}, provision, async () => {}, CFG,
      async () => "unused", async () => {},
    );

    expect(result.state).toBe("running");
    expect(opDuringDestroy).toEqual({ op: "recycle", since: expect.any(String) });
    expect(await s.get(OPERATION_KEY)).toBeNull();
  });

  it("clears OPERATION_KEY in a finally even when destroy() throws", async () => {
    const syncDeps = wedgedDeps();
    const s = storage("stopped");
    const destroy = vi.fn(async () => {
      throw new Error("container gone");
    });
    const provision = vi.fn(async () => ({ id: ID, state: "running" }) as StudioStatus);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        recycleWithSync(syncDeps, s, ID, destroy, async () => {}, provision, async () => {}, CFG, async () => "unused", async () => {}),
      ).rejects.toThrow();
      expect(await s.get(OPERATION_KEY)).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  // Review round 5, Finding 1 — the two tests above drove `provision` as a
  // bare `vi.fn(async () => ({...}))` stub that never touches OPERATION_KEY
  // at all, so neither could ever have caught `provisionWithStorage`
  // independently clearing the SAME key out from under recycleWithSync's own
  // still-running lock. Replaced here with the real
  // `provisionWithStorage`-shaped closure `provisionCore` (do.ts) actually
  // hands `recycleWithSync` in production, so this class of bug can no
  // longer hide behind a stub that was structurally incapable of seeing it.
  it("OPERATION_KEY survives a REAL nested provisionWithStorage call, not just a stub", async () => {
    const syncDeps = wedgedDeps();
    const s = fullStorage("stopped"); // recordedStopped skips the probe/rescue steps entirely
    const deps = realProvisionDeps();
    let opRightAfterNestedProvision: unknown;
    const provisionFn = async (c: ProvisionConfig) => {
      const result = await provisionWithStorage(deps, s, c, "rafarc21/fleetflare", "recycle", s);
      // The exact instant the nested provisionWithStorage call has returned,
      // but before recycleWithSync's own remaining work (recycleVerdict, a
      // possible retry pass, the final D1 writes) has run.
      opRightAfterNestedProvision = await s.get(OPERATION_KEY);
      return result;
    };

    const result = await recycleWithSync(
      syncDeps, s, ID, async () => {}, async () => {}, provisionFn, async () => {}, CFG,
      async () => "unused", async () => {},
    );

    expect(result.state).toBe("running");
    expect(opRightAfterNestedProvision).toEqual({ op: "recycle", since: expect.any(String) });
    expect(await s.get(OPERATION_KEY)).toBeNull();
  });

  it("provisionWithStorage's OWN direct callers still set/clear OPERATION_KEY exactly as before (no nesting, no regression)", async () => {
    const s = fullStorage("stopped");
    const deps = realProvisionDeps();
    let opDuringBringup: unknown;
    deps.sbExec = vi.fn(async (cmd: string) => {
      deps.cmds.push(cmd);
      if (cmd === BRINGUP_CMD) opDuringBringup = await s.get(OPERATION_KEY);
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await provisionWithStorage(deps, s, CFG, "rafarc21/fleetflare", "provision", s);

    expect(result.state).toBe("running");
    expect(opDuringBringup).toEqual({ op: "provision", since: expect.any(String) });
    expect(await s.get(OPERATION_KEY)).toBeNull();
  });

  // Review round 6, Blocker 2 — the round-5 fix above (check-before-set/
  // check-before-clear) read "already held" as "OPERATION_KEY is non-null, at
  // all", with no check on whether that existing value is actually FRESH or
  // wreckage an isolate left behind before reaching its own `finally`. A
  // STALE lock made `alreadyLocked` read true forever, so provisionWithStorage
  // never refreshed it and never cleared it — permanently defeating the exact
  // heal-suppression guard this key exists to provide, in the OPPOSITE
  // direction from a stale lock being correctly ignored (decideHeal, do.ts).
  it("a STALE lock is ignored — provisionWithStorage takes its OWN fresh lock during bring-up, clears it after", async () => {
    const s = fullStorage("stopped");
    const deps = realProvisionDeps();
    const staleSince = new Date(NOW.getTime() - OPERATION_STALE_MS - 1000).toISOString();
    await s.put(OPERATION_KEY, { op: "provision", since: staleSince });
    let opDuringBringup: unknown;
    deps.sbExec = vi.fn(async (cmd: string) => {
      deps.cmds.push(cmd);
      if (cmd === BRINGUP_CMD) opDuringBringup = await s.get(OPERATION_KEY);
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await provisionWithStorage(deps, s, CFG, "rafarc21/fleetflare", "provision", s);

    expect(result.state).toBe("running");
    // This call's OWN fresh lock, not the stale one it found.
    expect(opDuringBringup).toEqual({ op: "provision", since: NOW.toISOString() });
    // Cleared exactly as if there had been no pre-existing lock at all.
    expect(await s.get(OPERATION_KEY)).toBeNull();

    // And the interaction with decideHeal end to end: the lock this call
    // established while it was mid-flight is exactly what makes decideHeal
    // stand down instead of healing over a live bring-up. The real stored
    // status (not a hand-built fixture) is what a tick would actually read.
    const readiness: StudioReadiness = { kind: "bare", reason: "test fixture", checkedAt: NOW.toISOString() };
    const storedStatus = (await s.get(STATUS_KEY)) as StudioStatus;
    const decision = decideHeal(storedStatus, readiness, undefined, opDuringBringup as OperationInFlight, NOW);
    expect(decision.kind).toBe("stand-down");
  });
});

/**
 * Issue #16. A LIVE container whose rescue-push CONFIRMS a loss
 * (`RESCUE_FAILED <wt> <step>`) used to log "continuing" and recycle anyway —
 * the work was gone. Now it refuses exactly like destroy.ts already does,
 * unless the caller passed --discard-unsynced.
 */
function liveDeps(rescueStdout: string): SessionSyncDeps {
  return {
    exec: async (cmd: string) => {
      if (cmd === "printf ok") return { code: 0, stdout: "ok", stderr: "" };
      if (cmd.startsWith("mkdir -p")) return { code: 0, stdout: "0\n1758067200", stderr: "" };
      if (cmd.includes("status --porcelain")) return { code: 0, stdout: rescueStdout, stderr: "" };
      if (cmd.includes(HARVEST_NO_RECORD)) return { code: 0, stdout: HARVEST_NO_RECORD, stderr: "" };
      if (cmd === provisionedCheckCmd(CFG.repo)) return { code: 0, stdout: PROVISIONED_OK, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    r2Put: async () => {},
    r2List: async () => [],
    r2Delete: async () => {},
    now: () => NOW,
    notify: async () => {},
    burnAlertThresholdTokens: 0,
  };
}

function runLive(rescueStdout: string, discardUnsynced: boolean, provisioned: Partial<StudioStatus> = {}) {
  const destroy = vi.fn(async () => {});
  const provision = vi.fn(async () => ({ id: ID, state: "running", error: null, ...provisioned }) as StudioStatus);
  const s = storage();
  const promise = recycleWithSync(
    liveDeps(rescueStdout), s, ID, destroy, async () => {}, provision, async () => {}, CFG,
    async () => "unused", async () => {}, { discardUnsynced, lastSyncedAt: async () => SYNCED_63_MIN_AGO },
  );
  return { promise, destroy, provision, storage: s };
}

describe("recycle guard — a CONFIRMED rescue-push failure refuses (issue #16)", () => {
  it("rescue failed, no flag: refuses naming the worktree and the flag; destroy NEVER called", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { promise, destroy, provision } = runLive(`${RESCUE_FAILED_PREFIX} agent-a1 push`, false);
      const message = await promise.then(() => "", (err: Error) => err.message);
      expect(message.startsWith(RECYCLE_REFUSED_PREFIX)).toBe(true);
      expect(message).toContain("agent-a1 (push)");
      expect(message).toContain(`fleet recycle ${ID} --discard-unsynced`);
      expect(destroy).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("one worktree pushed, one failed: still refuses, naming both", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stdout = `${RESCUE_PUSHED_PREFIX} fleet/rescue/${ID}-20260924121500 2 files\n${RESCUE_FAILED_PREFIX} agent-a2 push`;
      const { promise, destroy } = runLive(stdout, false);
      const message = await promise.then(() => "", (err: Error) => err.message);
      expect(message.startsWith(RECYCLE_REFUSED_PREFIX)).toBe(true);
      expect(message).toContain(`fleet/rescue/${ID}-20260924121500`);
      expect(message).toContain("agent-a2 (push)");
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("rescue failed + --discard-unsynced: proceeds, and the row names what was discarded", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { promise, destroy, provision } = runLive(`${RESCUE_FAILED_PREFIX} agent-a1 push`, true);
      const result = await promise;
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(provision).toHaveBeenCalledWith(CFG);
      expect(result.state).toBe("running");
      expect(result.error).toMatch(/agent-a1/);
      expect(result.error).toMatch(/--discard-unsynced/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("rescue failed + --discard-unsynced, provision leaves its own error: the discard note is appended, never hidden", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { promise } = runLive(`${RESCUE_FAILED_PREFIX} agent-a1 push`, true, { error: "provision warning" });
      const result = await promise;
      expect(result.error).toContain("provision warning");
      expect(result.error).toMatch(/agent-a1/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("rescue failed + --discard-unsynced, reprovision ends degraded: the degraded row still names the discarded worktree", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { promise, storage: s } = runLive(`${RESCUE_FAILED_PREFIX} agent-a1 push`, true, { state: "degraded", error: "bring-up failed" });
      await expect(promise).rejects.toThrow(/agent-a1/);
      const row = (await s.get(STATUS_KEY)) as StudioStatus;
      expect(row.state).toBe("degraded");
      expect(row.error).toMatch(/agent-a1/);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// Issue #37: an aside dir ships before the container is destroyed — the
// recycle's pre-teardown sync is its last chance.
describe("recycle — aside sessions ship before destroy (issue #37)", () => {
  it("lists, packs, ships and marks the aside dir, all before destroy", async () => {
    const DIR = "fleet-aside-20260929T100000Z-42--workspace-websites";
    const order: string[] = [];
    const d = liveDeps(RESCUE_CLEAN_LINE);
    const inner = d.exec;
    d.exec = async (cmd: string, env?: Record<string, string>) => {
      if (cmd === asideListCmd()) { order.push("list"); return { code: 0, stdout: `${DIR}\n`, stderr: "" }; }
      if (cmd === asidePackCmd(DIR)) return { code: 0, stdout: "10\nabc\n", stderr: "" };
      // The mark command also names `<tar>.part-*` (it removes them): first.
      if (cmd === asideMarkCmd(DIR)) { order.push("mark"); return { code: 0, stdout: "", stderr: "" }; }
      if (cmd.includes(`${DIR}.tar.gz.part-`)) return { code: 0, stdout: btoa("x".repeat(10)), stderr: "" };
      return env ? inner(cmd, env) : inner(cmd);
    };
    const puts: string[] = [];
    d.r2Put = async (key: string) => { puts.push(key); };
    const destroy = vi.fn(async () => { order.push("destroy"); });
    const provision = vi.fn(async () => ({ id: ID, state: "running", error: null }) as StudioStatus);
    await recycleWithSync(
      d, storage(), ID, destroy, async () => {}, provision, async () => {}, CFG,
      async () => "unused", async () => {}, { discardUnsynced: false, lastSyncedAt: async () => SYNCED_63_MIN_AGO },
    );
    expect(puts).toContain(`sessions/${ID}/aside/${DIR}/manifest.json`);
    expect(order).toEqual(["list", "mark", "destroy"]);
  });
});

// PR #46 review: an aside dir that could not ship before a recycle is named
// on the row it returns — the container (and the dir) is about to be gone.
describe("recycle — unshipped aside named on the row (PR #46 review)", () => {
  it("pack fails: recycle proceeds, row error names the dir", async () => {
    const DIR = "fleet-aside-20260929T100000Z-42--workspace-websites";
    const d = liveDeps(RESCUE_CLEAN_LINE);
    const inner = d.exec;
    d.exec = async (cmd: string, env?: Record<string, string>) => {
      if (cmd === asideListCmd()) return { code: 0, stdout: `${DIR}\n`, stderr: "" };
      if (cmd === asidePackCmd(DIR)) return { code: 2, stdout: "", stderr: "tar: disk full" };
      return env ? inner(cmd, env) : inner(cmd);
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const provision = vi.fn(async () => ({ id: ID, state: "running", error: null }) as StudioStatus);
      const result = await recycleWithSync(
        d, storage(), ID, vi.fn(async () => {}), async () => {}, provision, async () => {}, CFG,
        async () => "unused", async () => {}, { discardUnsynced: false, lastSyncedAt: async () => SYNCED_63_MIN_AGO },
      );
      expect(result.error).toContain(`aside session NOT shipped: ${DIR}`);
      expect(result.error).toContain("disk full");
    } finally {
      errSpy.mockRestore();
    }
  });
});

// Issue #39: recycle's row names every worktree's rescue outcome; a refusal
// names them too, not only the failed one.
describe("recycle — per-worktree rescue report (issue #39)", () => {
  it("success: the returned row carries one line per worktree", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stdout = `RESCUE_WT checkout nothing\nRESCUE_WT agent-a1 pushed fleet/rescue/x\n${RESCUE_PUSHED_PREFIX} fleet/rescue/x 1 files`;
      const result = await runLive(stdout, false).promise;
      expect(result.rescueReport).toEqual(["checkout: nothing to push", "agent-a1: pushed fleet/rescue/x"]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("refusal: names every worktree's outcome", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stdout = `RESCUE_WT checkout nothing\n${RESCUE_FAILED_PREFIX} agent-a1 push\nRESCUE_WT agent-a1 failed push`;
      const message = await runLive(stdout, false).promise.then(() => "", (err: Error) => err.message);
      expect(message.startsWith(RECYCLE_REFUSED_PREFIX)).toBe(true);
      expect(message).toContain("checkout: nothing to push");
      expect(message).toContain("agent-a1: FAILED (push)");
    } finally {
      errSpy.mockRestore();
    }
  });
});
