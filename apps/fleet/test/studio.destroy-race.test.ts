import { describe, it, expect, vi, afterEach } from "vitest";
import { Sandbox } from "@cloudflare/sandbox";
import { StudioDO, SPAWN_TOKEN_KEY, DELIVERED_TASK_KEY, START_REFUSED_PREFIX, type RefreshDeps } from "../src/studio/do";
import {
  STATUS_KEY, DESTROYING_KEY, DESTROY_EPOCH_KEY, ROLE_ENV_KEY, freshStatus, PROVISIONED_OK, PROVISIONED_UNKNOWN, OPERATION_STALE_MS,
  type ProvisionDeps, type StudioStorage,
} from "../src/studio/provision";
import { destroyWithSync } from "../src/studio/destroy";
import type { SessionSyncStorage } from "../src/studio/session-sync";
import type { StudioState, StudioStatus, ProvisionConfig } from "../src/studio/types";
import { assignDigest } from "../src/board/assign-wake";
import { BRINGUP_TOKEN_WRITE_SECTION } from "../src/studio/observed";

// ---------------------------------------------------------------------------
// Issue #152 — a genuine destroy EPOCH, replacing the prior (insufficient)
// fix's snapshot heuristics.
//
// The reviewer's real-SDK simulation proved the FIRST fix (commit 020f505)
// let a second container boot in 18 of 24 destroy-race scenarios, including
// the exact scenario (S8c) it was written for: `watchForDestroy`'s
// point-in-time snapshot goes blind whenever a destroy runs start-to-finish
// inside the gap between the snapshot and the check it feeds — destroy.ts's
// own `finally` clears DESTROYING_KEY at the very end of `destroyWithSync`,
// so a check taken after that sees no marker and a possibly-already-
// resurrected row.
//
// This suite pins the REPLACEMENT design: `DESTROY_EPOCH_KEY`, a counter that
// only ever increases (bumped twice by a clean destroy.ts run, once by a
// destroy that dies mid-flight — see provision.ts's own doc comment on
// `bumpDestroyEpoch`), and `OpCtx` — one per outer operation entry point
// (do.ts's `allowingStart`), snapshotting the epoch at the moment the
// operation begins so `ctx.moved()` can answer "did a destroy land since I
// started" at ANY later point, no matter how many storage reads separate the
// two in time.
//
// Same technique test/studio.start-gate.test.ts already established: a live
// StudioDO cannot be constructed under vitest-pool-workers (do.ts's own
// header), so each test below runs the REAL StudioDO methods
// (provision/restartStudio/recycle/syncSession's heal path) against a fake
// `this`, with @cloudflare/sandbox's Container.prototype start methods spied
// so "a container was started" is an observed call into the pinned SDK, not
// a flag this suite invented. This exercises provisionWithStorage/
// restartWithStorage's own tail guards too (do.ts's real methods call them
// for real) — a scenario worth pinning at the provision.ts/destroy.ts level
// directly, independent of the DO, lives in test/studio.destroy.test.ts
// instead (destroyWithSync's own two-bump epoch contract).
// ---------------------------------------------------------------------------

const ID = "fleetflare--web-studio";
const REPO = "fleetflare";
const TOKEN = "spawn-token-fixture";
const ContainerProto = Object.getPrototypeOf(Sandbox.prototype) as {
  startAndWaitForPorts: (...args: unknown[]) => Promise<void>;
  start: (...args: unknown[]) => Promise<void>;
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared DO-level harness
// ---------------------------------------------------------------------------

function row(state: StudioState, over: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: ID, state, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: `rafarc21/${REPO}`,
    ...over,
  } as StudioStatus;
}

const ROLE_ENV = { ROLE_PROMPT_B64: "aGk=", ROLE_ALLOWED_TOOLS: "Bash(git *)", ROLE_EFFORT: "" };

/** A ProvisionDeps.fetchBlueprintFile fixture resolving a trivial "scratch"
 *  role — same shape the old #152 investigation used, and the same
 *  fleet.json/role-file/org.json triple resolveBringupEnv reads. */
function scratchBlueprint(): ProvisionDeps["fetchBlueprintFile"] {
  return vi.fn(async (_repo: string, path: string) => {
    if (path === "fleet.json") {
      return JSON.stringify({ blueprint: { repo: `rafarc21/${REPO}`, ref: "main" }, roles: ["scratch"], instance_type: "standard-2" });
    }
    if (path === "fleet/blueprint/org.json") return JSON.stringify({ edges: {}, gates: {} });
    if (path.startsWith("fleet/blueprint/studios/")) throw new Error(`fetch ${path}@main failed (404): Not Found`);
    return "---\nname: scratch\nskills: []\nallowedTools: Bash(git *)\nmay_spawn: []\nreports_to: operator\ngates: []\n---\nhi\n";
  });
}

/** D1's own `fleet_state` write, faked at the `env.DB` boundary (registry.ts's
 *  recordStudio -> state.ts's setFlag) rather than by mocking the registry
 *  module — this is the real write path, just backed by an in-memory list
 *  instead of a real D1 binding. `states()` decodes each write's own JSON
 *  value back to a StudioStatus so a test can assert on what state (if any)
 *  actually reached the registry. */
function fakeDB(onWrite?: () => void) {
  const writes: string[] = [];
  const db = {
    prepare: (_sql: string) => ({
      bind: (...args: unknown[]) => ({
        // `onWrite` fires AFTER this write lands (not before): the boundary a
        // test marks from inside it must count THIS write as the last
        // legitimate, pre-destroy one, not the first "after" one.
        run: async () => { writes.push(args[1] as string); onWrite?.(); return {}; },
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
    }),
  };
  return { db, writes, states: () => writes.map((w) => JSON.parse(w) as StudioStatus) };
}

/** Simulates destroy.ts's own `destroyWithSync` landing AND FULLY COMPLETING,
 *  applied directly to the storage map a running op is reading/writing
 *  through — the two-bump contract DESTROY_EPOCH_KEY's own doc comment
 *  describes: bump, (pre-destroy steps elided — this suite is not testing
 *  destroy.ts itself, see studio.destroy.test.ts for that), the stopped-row
 *  write, bump again, then the DESTROYING_KEY marker clears. */
function simulateDestroyCompletes(map: Map<string, unknown>) {
  const before = (map.get(DESTROY_EPOCH_KEY) as number | undefined) ?? 0;
  map.set(DESTROY_EPOCH_KEY, before + 1);
  map.set(DESTROYING_KEY, new Date().toISOString());
  const existing = map.get(STATUS_KEY) as StudioStatus | undefined;
  map.set(STATUS_KEY, { ...(existing ?? freshStatus(ID)), state: "stopped", error: null, containerRunningSince: null });
  map.set(DESTROY_EPOCH_KEY, before + 2);
  map.set(DESTROYING_KEY, null);
}

/** T7's fixture: a destroy that is ALREADY mid-flight (one bump already
 *  spent, DESTROYING_KEY already fresh) when the op's own ctx snapshots the
 *  epoch — so the op legitimately starts (its ctx.epoch matches the live
 *  one, same as the existing "starts through a FRESH DESTROYING marker"
 *  coverage in studio.start-gate.test.ts). Call `seed` BEFORE building the
 *  harness/starting the op; call `complete` once, later, to land the SAME
 *  destroy's own second bump + stopped-row write + marker clear — the part
 *  that must move the op's ctx out from under it. */
function inFlightDestroy(map: Map<string, unknown>) {
  return {
    seed: () => {
      map.set(DESTROY_EPOCH_KEY, 1);
      map.set(DESTROYING_KEY, new Date().toISOString());
    },
    complete: () => {
      const existing = map.get(STATUS_KEY) as StudioStatus | undefined;
      map.set(STATUS_KEY, { ...(existing ?? freshStatus(ID)), state: "stopped", error: null, containerRunningSince: null });
      map.set(DESTROY_EPOCH_KEY, 2);
      map.set(DESTROYING_KEY, null);
    },
  };
}

/** A destroy that died before reaching its own stopped-row write: ONE bump,
 *  an ORPHANED DESTROYING_KEY marker, and the row untouched — T8's fixture. */
function simulateDeadDestroy(map: Map<string, unknown>) {
  const before = (map.get(DESTROY_EPOCH_KEY) as number | undefined) ?? 0;
  map.set(DESTROY_EPOCH_KEY, before + 1);
  map.set(DESTROYING_KEY, new Date().toISOString());
}

interface Harness {
  doObj: StudioDO;
  map: Map<string, unknown>;
  container: { running: boolean; start: ReturnType<typeof vi.fn> };
  baseStart: ReturnType<typeof vi.spyOn>;
  baseStartOnly: ReturnType<typeof vi.spyOn>;
  db: ReturnType<typeof fakeDB>;
  sbExecCalls: string[];
  /** D1 writes at-or-after this index happened AFTER the simulated destroy
   *  landed — see makeHarness's own `onCommand` doc comment. -1 = no destroy
   *  was simulated in this test. */
  writesAfterDestroy: () => StudioStatus[];
  /** Real Container.prototype start calls made AFTER the simulated destroy
   *  landed — same boundary-marking idea as writesAfterDestroy. */
  startsAfterDestroy: () => number;
}

/**
 * Builds a fake `this` for StudioDO exactly like studio.start-gate.test.ts's
 * own `studio()` helper, then goes further: `deps()`/`refreshDeps()`/
 * `syncDeps()` (all private methods StudioDO's real provision/restart/
 * recycle bodies call) are overridden with fully-controlled fakes, so a test
 * can inject "a destroy lands and completes" at an EXACT point in the exec
 * sequence via `onCommand`. Container.prototype.start/startAndWaitForPorts
 * stay spied on the REAL SDK prototype (not faked away) — resolving
 * successfully and flipping `container.running` true, so the op can run
 * past its own first start and a test can still count genuine container-
 * start calls, the same observability studio.start-gate.test.ts relies on.
 */
function makeHarness(opts: {
  state?: StudioState;
  running?: boolean;
  roleEnv?: typeof ROLE_ENV | null;
  // `writeBoundary` receives the index into `db.writes` AT THE MOMENT the
  // destroy is simulated — everything at or after that index is a D1 publish
  // that happened AFTER the destroy landed, and T10's own assertion is about
  // exactly that slice, not about every write this op ever makes (an early,
  // pre-destroy write — e.g. ensureSpawnToken's own hash-settle — legitimately
  // still says `running`, because the destroy had not landed yet).
  onCommand?: (cmd: string, map: Map<string, unknown>, markDestroyBoundary: () => void) => void;
  /** Per-command canned exec responses (e.g. a `bare` provisioned-check
   *  verdict, to arm the #71 heal for T3) — `undefined` falls back to the
   *  harness's own default `{code:0, stdout:"", stderr:""}`. */
  respond?: (cmd: string) => { code: number; stdout: string; stderr: string } | undefined;
  /** T6: fires on the FIRST D1 write this op makes (ensureSpawnToken's own
   *  hash-settle, the true first async step of provisionUngated/
   *  restartUngated, well before either ever touches a container) — lets a
   *  test simulate a destroy landing and fully completing BEFORE the op's
   *  own first container-start attempt is ever reached. */
  onFirstDbWrite?: (map: Map<string, unknown>, markDestroyBoundary: () => void) => void;
} = {}): Harness {
  const map = new Map<string, unknown>();
  if (opts.state) map.set(STATUS_KEY, row(opts.state));
  map.set(SPAWN_TOKEN_KEY, TOKEN);
  if (opts.roleEnv !== undefined && opts.roleEnv !== null) map.set(ROLE_ENV_KEY, opts.roleEnv);
  const storage: StudioStorage & { delete: (k: string) => Promise<boolean> } = {
    get: (async (k: string) => map.get(k)) as StudioStorage["get"],
    put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
    delete: async (k: string) => map.delete(k),
  };

  const container = { running: opts.running ?? false, start: vi.fn(async () => { container.running = true; }) };

  let destroyWriteBoundary = -1;
  let destroyStartBoundary = -1;
  let firstDbWriteSeen = false;
  const db = fakeDB(() => {
    if (firstDbWriteSeen) return;
    firstDbWriteSeen = true;
    opts.onFirstDbWrite?.(map, () => {
      destroyWriteBoundary = db.writes.length;
      destroyStartBoundary = baseStart.mock.calls.length + baseStartOnly.mock.calls.length;
    });
  });
  const sbExecCalls: string[] = [];
  const sbExec = vi.fn(async (cmd: string, _env?: Record<string, string>) => {
    sbExecCalls.push(cmd);
    opts.onCommand?.(cmd, map, () => {
      destroyWriteBoundary = db.writes.length;
      destroyStartBoundary = baseStart.mock.calls.length + baseStartOnly.mock.calls.length;
    });
    // Issue #62: a real rescue verdict — unparseable output is an UNCONFIRMED rescue now, which refuses.
    return opts.respond?.(cmd) ?? { code: 0, stdout: cmd.includes("status --porcelain") ? "RESCUE_CLEAN" : "", stderr: "" };
  });
  const provisionDeps: ProvisionDeps = {
    sbExec, recordStudio: async (s: StudioStatus) => { db.writes.push(JSON.stringify(s)); }, now: () => new Date().toISOString(),
    fetchBlueprintFile: scratchBlueprint(),
  };

  const baseStart = vi.spyOn(ContainerProto, "startAndWaitForPorts").mockImplementation(async () => { container.running = true; });
  const baseStartOnly = vi.spyOn(ContainerProto, "start").mockImplementation(async () => { container.running = true; });

  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  const doObj = Object.create(StudioDO.prototype) as StudioDO;
  Object.assign(doObj, {
    ctx: { id: { name: ID }, storage, container, acceptWebSocket: noop, getWebSockets: () => [] },
    container,
    env: { DB: db.db, AGENT_REPO: `rafarc21/${REPO}` },
    logger,
    containerTimeouts: { instanceGetTimeoutMS: 30_000, portReadyTimeoutMS: 90_000, waitIntervalMS: 300 },
    activeOps: new Set(),
    // Issue #240 fix E: `Object.create(StudioDO.prototype)` never runs class
    // field initializers (no constructor is called), so this class field
    // would otherwise start life as `undefined` rather than its real default
    // of `0` — same reason `activeOps` above is seeded explicitly rather than
    // left to its own `= new Set()` initializer. Left uninitialized,
    // `destroyStudio`'s own `+= 1` would silently compute `undefined + 1 ===
    // NaN`, and `NaN > 0` is `false` — defeating the counter's own gate
    // without ever throwing, in a REAL DO this never happens (the runtime
    // always constructs it via `new`, running the initializer for real).
    destroyInFlightCount: 0,
    getState: async () => ({ status: container.running ? "healthy" : "stopped" }),
    state: { getState: async () => ({ status: "healthy" }) },
    schedule: vi.fn(async () => ({})),
    deleteSchedules: vi.fn(() => {}),
    // Issue #152: bypasses the real SDK's exec plumbing entirely, so a test
    // gets exact, per-command control over the provisioning sequence —
    // real StudioDO composition (provisionUngated/restartUngated/
    // recycleWithSync/checkAndRecordReadiness/armTicks) still runs for real.
    deps: () => provisionDeps,
    refreshDeps: () => ({
      mintToken: async () => "ghs_faketoken",
      sbExec, recordStudio: async (s: StudioStatus) => { db.writes.push(JSON.stringify(s)); },
      notify: async () => {}, now: () => new Date().toISOString(),
    }),
    syncDeps: () => ({
      exec: sbExec, r2Put: async () => {}, r2List: async () => [], r2Delete: async () => {},
      now: () => new Date(), notify: async () => {}, burnAlertThresholdTokens: 0,
    }),
    memoryDeps: () => ({ resolveMemoryRepo: async () => `rafarc21/${REPO}`, commitFile: async () => {} }),
    lastSyncedAt: async () => new Date(),
    destroy: vi.fn(async () => { container.running = false; }),
  });
  return {
    doObj, map, container, baseStart, baseStartOnly, db, sbExecCalls,
    writesAfterDestroy: () => (destroyWriteBoundary < 0 ? [] : db.states().slice(destroyWriteBoundary)),
    startsAfterDestroy: () => (destroyStartBoundary < 0
      ? 0
      : (baseStart.mock.calls.length + baseStartOnly.mock.calls.length) - destroyStartBoundary),
  };
}

function cfg(): ProvisionConfig {
  return { repo: REPO, role: "scratch" };
}

function startCount(h: Harness): number {
  return h.baseStart.mock.calls.length + h.baseStartOnly.mock.calls.length;
}

// ---------------------------------------------------------------------------
// T1 — provision on an already-stopped row; destroy completes mid-clone/setup
// ---------------------------------------------------------------------------

describe("T1 — provision (ff on a stopped row): destroy completes mid-provision", () => {
  it("final row is stopped, no non-stopped D1 publish after the destroy, zero starts after it, zero ticks armed", async () => {
    const h = makeHarness({
      state: "stopped",
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (cmd.includes("git clone")) { markDestroyBoundary(); simulateDestroyCompletes(map); }
      },
    });
    const status = await h.doObj.provision(cfg());

    expect(status.state).toBe("stopped");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    // No tick was armed: destroy landed before provisionUngated's own tail.
    expect((h.doObj as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule).not.toHaveBeenCalled();
    // No D1 write made AFTER the destroy landed may say `running`/`degraded`.
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
    // The FIRST start (the stopped row's own explicit boot) is expected;
    // nothing should start the container again after the destroy landed.
    expect(h.startsAfterDestroy()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T2 — the original S8c shape: restart of a currently-running row; destroy
// completes during the pre-restart refresh step AND during the pre-restart
// session-sync step (two separate landing points, same assertions).
// ---------------------------------------------------------------------------

describe("T2 — restart of a running row: destroy completes during the pre-restart steps", () => {
  it.each([
    ["the credential refresh exec", (cmd: string) => cmd.includes("credential.helper")],
    // Narrowed to the session-sync dir specifically (not the bare "mkdir -p"
    // prefix): issue #85 PR1's own bringupObservationCmd (observed.ts) ALSO
    // starts with "mkdir -p", so a bare-prefix match would ambiguously catch
    // either exec depending on ordering, rather than uniquely identifying
    // this destroy epoch suite's own pre-restart session-sync command.
    ["the pre-restart session-sync exec", (cmd: string) => cmd.startsWith("mkdir -p /workspace/.session-sync")],
  ] as const)("destroy landing during %s: row stays stopped, never degraded, no ticks, no marker meddling", async (_label, matches) => {
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (matches(cmd)) { markDestroyBoundary(); simulateDestroyCompletes(map); }
      },
    });
    const status = await h.doObj.restartStudio();

    expect(status.state).toBe("stopped");
    expect(status.state).not.toBe("degraded");
    const finalRow = h.map.get(STATUS_KEY) as StudioStatus;
    expect(finalRow.state).toBe("stopped");
    expect(finalRow.state).not.toBe("degraded");
    // Only destroy.ts ever writes DESTROYING_KEY — simulateDestroyCompletes
    // leaves it `null` (its own finally), and the restart op must not touch
    // it at all, in either direction.
    expect(h.map.get(DESTROYING_KEY)).toBeNull();
    expect((h.doObj as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule).not.toHaveBeenCalled();
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
    expect(h.startsAfterDestroy()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T3 — heal (syncSession -> healBareContainer -> restartStudio): same shape
// as T2, since heal literally IS a restartStudio() call.
// ---------------------------------------------------------------------------

describe("T3 — heal (syncSession's bare-container self-heal): destroy completes mid-heal", () => {
  it("row stays stopped (never degraded), no ticks, no marker meddling — heal is restartStudio under the hood", async () => {
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      // The readiness check inside syncSessionCycle must see BARE for
      // decideHeal to arm the heal at all — see provisionedCheckCmd's own
      // shape (provision.ts) for why "pane_current_command" pins the exec.
      respond: (cmd) => (cmd.includes("pane_current_command")
        ? { code: 0, stdout: "no git checkout at /workspace/fleetflare", stderr: "" }
        : undefined),
      onCommand: (cmd, map, markDestroyBoundary) => {
        // Fires inside heal()'s own restartStudio() call — the credential
        // refresh is restartUngated's own first container touch.
        if (cmd.includes("credential.helper")) { markDestroyBoundary(); simulateDestroyCompletes(map); }
      },
    });

    await h.doObj.syncSession();

    const finalRow = h.map.get(STATUS_KEY) as StudioStatus;
    expect(finalRow.state).toBe("stopped");
    expect(finalRow.state).not.toBe("degraded");
    expect(h.map.get(DESTROYING_KEY)).toBeNull();
    // Zero `schedule` calls: runScheduledTick's own finally (issue #100 N5)
    // already stands down its OWN reschedule once the row reads `stopped`,
    // and the aborted restartStudio() call inside heal() must not have armed
    // the three armTicks loops (refreshToken/shipTranscript/syncSession)
    // either.
    const scheduleSpy = (h.doObj as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule;
    expect(scheduleSpy).not.toHaveBeenCalled();
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
    expect(h.startsAfterDestroy()).toBe(0);
    // The heal's own post-heal note (BARE_SELF_HEALED) must never land on
    // the row a destroy has since stopped — healBareContainer's own guard.
    expect(finalRow.error ?? "").not.toContain("self-healed");
  });
});

// ---------------------------------------------------------------------------
// T4 — re-provision of an already-running row ("ff" on a live studio);
// destroy lands during the internal refresh call.
// ---------------------------------------------------------------------------

describe("T4 — re-provision of a running row: destroy lands during the internal refresh", () => {
  it("final row state is stopped", async () => {
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (cmd.includes("credential.helper")) { markDestroyBoundary(); simulateDestroyCompletes(map); }
      },
    });
    const status = await h.doObj.provision(cfg());

    expect(status.state).toBe("stopped");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
    expect(h.startsAfterDestroy()).toBe(0);
  });

  // Issue #123's own `watchForDestroy` (do.ts's refreshWithStorage) snapshots
  // "was the row already stopped when I started" and only reports a landed
  // destroy on a FALSE -> TRUE transition — so a destroy that fully lands and
  // stops the row BEFORE refreshWithStorage's own snapshot is taken (here:
  // during ensureSpawnToken's own D1 write, one step earlier) is invisible to
  // it: `wasStopped` is already true, and the "went stopped" check can never
  // fire. `ctx.moved()` (this op's own epoch-based ctx, layered in ADDITION
  // to watchForDestroy) is what catches this specific case; the test above
  // (destroy landing DURING refreshWithStorage's own exec) is what
  // watchForDestroy ALONE already caught even before #152.
  it("destroy lands and fully completes BEFORE refreshWithStorage's own snapshot (watchForDestroy's own blind spot) — still caught", async () => {
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      onFirstDbWrite: (map, markDestroyBoundary) => { markDestroyBoundary(); simulateDestroyCompletes(map); },
    });
    const status = await h.doObj.provision(cfg());

    expect(status.state).toBe("stopped");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
  });
});

// ---------------------------------------------------------------------------
// T5 — recycle: an EXTERNAL destroy completes during recycle's own FIRST
// internal reprovision attempt.
// ---------------------------------------------------------------------------

describe("T5 — recycle: an external destroy completes during recycle's own reprovision", () => {
  it("provisioning runs exactly once, final row stopped, exactly 1 container start total", async () => {
    let cloneCalls = 0;
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (cmd.includes("git clone")) {
          cloneCalls++;
          markDestroyBoundary();
          simulateDestroyCompletes(map);
        }
      },
    });
    const status = await h.doObj.recycle(cfg());

    // recycleWithSync's own internal `this.destroy()` (a raw Sandbox.destroy,
    // never destroy.ts's destroyWithSync) never bumps the epoch itself — the
    // "external destroy" here is entirely the onCommand-injected one, landing
    // and fully completing during the FIRST provision(cfg) attempt.
    expect(cloneCalls).toBe(1); // provisioning ran exactly once, never retried
    expect(status.state).toBe("stopped");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
    // recycle's own sbAwaitReady (post-destroy() reconciliation) is the ONLY
    // real container start this whole call should make — provisionCore's own
    // conditional start is skipped once that one already flipped `running`.
    expect(h.startsAfterDestroy()).toBe(0);
    expect(startCount(h)).toBe(1);
  });

  // T5's own scenario has the destroy land during the FIRST provision
  // attempt, which recycleWithSync's FIRST ctx.moved() check catches before
  // the "bare -> retry once" branch is even reached. This variant forces a
  // `bare` verdict on the first attempt (so the retry genuinely runs) and
  // lands the destroy during THAT retry's own clone exec, so it is the
  // SECOND, independent ctx.moved() check (recycleWithSync's own retry-attempt
  // guard) that has to catch it.
  it("an external destroy completing during recycle's own RETRY reprovision attempt is caught too", async () => {
    let cloneCalls = 0;
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      // Bare on the first provisioned-check (drives the "reprovision once"
      // retry); recycleWithSync never reaches a second check here because
      // the destroy it lands on the retry's own clone aborts it first.
      respond: (cmd) => (cmd.includes("pane_current_command")
        ? { code: 0, stdout: "no git checkout at /workspace/fleetflare", stderr: "" }
        : undefined),
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (cmd.includes("git clone")) {
          cloneCalls++;
          if (cloneCalls === 2) { markDestroyBoundary(); simulateDestroyCompletes(map); }
        }
      },
    });
    const status = await h.doObj.recycle(cfg());

    expect(cloneCalls).toBe(2); // the retry genuinely ran once, never a third time
    expect(status.state).toBe("stopped");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
  });
});

// ---------------------------------------------------------------------------
// T6 — destroy lands and fully completes while the op is still awaiting
// something BEFORE its own first container-start attempt.
// ---------------------------------------------------------------------------

describe("T6 — destroy lands before the op's own first container-start attempt", () => {
  it("the first start is refused outright: zero real Container.prototype.start invocations reach the container layer", async () => {
    const h = makeHarness({
      state: "stopped",
      // ensureSpawnToken's own D1 hash-settle is provisionUngated's true
      // first async step — well before `if (!this.ctx.container?.running)
      // await sbAwaitReady(this)` (its own first container touch) is ever
      // reached.
      onFirstDbWrite: (map, markDestroyBoundary) => { markDestroyBoundary(); simulateDestroyCompletes(map); },
    });
    // The op's OWN ctx epoch is now stale relative to the live one (the
    // destroy landed before this op ever reached its own first start), so
    // `explicitStartAllowed()` no longer covers it — refuseStart's gate
    // refuses the attempt outright (a thrown StartRefusedError, same 409
    // shape #123's own start gate already produces for a plain stopped
    // studio with no op in flight at all) BEFORE the spied SDK method is
    // ever reached.
    //
    // Issue #217 review: pinned at the source, same reason
    // studio.account-gate-do.test.ts now pins LaunchRefusedError's own
    // message prefix directly rather than only via `instanceof`/substring —
    // routes.ts's launchOrStartRefusalResponse recognises this refusal ONLY
    // by this exact prefix once it has crossed the Worker<->DO RPC boundary
    // (a class never survives Workers RPC), so this is the one real DO call
    // site proving `START_REFUSED_PREFIX` is genuinely on the message
    // `provision()` throws here, not merely documented as such.
    await expect(h.doObj.provision(cfg())).rejects.toThrow(new RegExp(`^${START_REFUSED_PREFIX}.*stopped`));
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    expect(startCount(h)).toBe(0);
  });

  // checkAndRecordReadiness's own `status.state === "stopped"` early return
  // (do.ts) already covers every OTHER scenario in this suite, because by
  // the time provision()/restartStudio()'s own post-op readiness check runs,
  // a destroy that fully completed has already written `stopped` to
  // STATUS_KEY. This is the one window where that early return does NOT
  // fire: a destroy that has bumped the epoch ONCE (mid-flight — still
  // running its own probe/sync/rescue/harvest steps) but has not yet reached
  // its own stopped-row write, so STATUS_KEY still reads `running`.
  // `ctx.moved()` (already true — epoch 0 -> 1) is what has to catch this,
  // since the state-based early return cannot.
  it("readiness check never execs when a destroy is mid-flight but has not written `stopped` yet", async () => {
    const h = makeHarness({
      state: "running", running: true,
      onFirstDbWrite: (map) => {
        // ONE bump only, row left untouched — the destroy is still mid-
        // flight from this op's own vantage point (see inFlightDestroy's own
        // `seed` for the identical shape, used here inline since this op's
        // OWN ctx must snapshot BEFORE the bump, unlike T7's pre-seeded one).
        const before = (map.get(DESTROY_EPOCH_KEY) as number | undefined) ?? 0;
        map.set(DESTROY_EPOCH_KEY, before + 1);
      },
    });
    await h.doObj.provision(cfg());

    // The provisioned-check's own command names the tmux pane; its absence
    // is direct proof the exec never ran.
    expect(h.sbExecCalls.some((c) => c.includes("pane_current_command"))).toBe(false);
  });

  // A destroy landing DURING the readiness check's own exec (as opposed to
  // before the check ever starts, above) — G9's pre-exec check does not fire
  // here (ctx had not moved yet when the check began); the POST-exec check
  // is what has to catch it.
  it("readiness check never WRITES a fresh verdict when the destroy lands during its own exec", async () => {
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (cmd.includes("pane_current_command")) { markDestroyBoundary(); simulateDestroyCompletes(map); }
      },
    });
    await h.doObj.provision(cfg());

    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
  });
});

// ---------------------------------------------------------------------------
// T7 — the op begins while a destroy is ALREADY mid-flight (epoch bumped
// once, DESTROYING_KEY already fresh) — legitimately starting through it,
// same as #123's own dead-destroy-recovery coverage — and then that SAME
// destroy completes (its own second bump) before the op's own tail runs.
// ---------------------------------------------------------------------------

describe("T7 — op starts through an in-flight destroy, which then completes before the op's own tail", () => {
  it("the op aborts: final row stopped", async () => {
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (cmd.includes("credential.helper")) { markDestroyBoundary(); destroyFixture.complete(); }
      },
    });
    const destroyFixture = inFlightDestroy(h.map);
    // Seeded BEFORE the op starts: the SAME destroy has already bumped the
    // epoch once and left DESTROYING_KEY fresh — restartStudio()'s own ctx
    // snapshots epoch=1 here, matching live, so it starts legitimately.
    destroyFixture.seed();

    const status = await h.doObj.restartStudio();

    expect(status.state).toBe("stopped");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
  });
});

// ---------------------------------------------------------------------------
// T8 — a "dead" destroy: one bump only, an orphaned DESTROYING_KEY marker,
// the row untouched. A LATER, fresh op (its own ctx snapshotted AFTER the
// dead destroy) must never be permanently blocked by the stale bump.
// ---------------------------------------------------------------------------

describe("T8 — a dead destroy's stale single bump never blocks a later, legitimate op", () => {
  it("a later fresh `fleet provision` starts completely normally: row ends running, ticks armed", async () => {
    const h = makeHarness({ state: "stopped" });
    simulateDeadDestroy(h.map);

    const status = await h.doObj.provision(cfg());

    expect(status.state).toBe("running");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("running");
    expect((h.doObj as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule).toHaveBeenCalledTimes(3);
    expect(startCount(h)).toBe(1);
  });

  it("a later fresh `fleet restart` starts completely normally: row ends running, ticks armed", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV });
    simulateDeadDestroy(h.map);

    const status = await h.doObj.restartStudio();

    expect(status.state).toBe("running");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("running");
    expect((h.doObj as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// T9 — baseline: no destroy at all. Every op behaves completely unchanged.
// This is the regression check — it should already be green on 020f505 (and
// on unmodified main), and must stay green on this rework.
// ---------------------------------------------------------------------------

describe("T9 — baseline (no destroy ever lands): unchanged behaviour", () => {
  it("provision: 1 start, final row running, 3 ticks armed", async () => {
    const h = makeHarness({ state: "stopped" });
    const status = await h.doObj.provision(cfg());

    expect(status.state).toBe("running");
    expect(startCount(h)).toBe(1);
    expect((h.doObj as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule).toHaveBeenCalledTimes(3);
  });

  it("restart: final row running, 3 ticks armed", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV });
    const status = await h.doObj.restartStudio();

    expect(status.state).toBe("running");
    expect((h.doObj as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule).toHaveBeenCalledTimes(3);
  });

  it("recycle: 1 start (the post-destroy awaitReady), final row running, 3 ticks armed", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV });
    const status = await h.doObj.recycle(cfg());

    expect(status.state).toBe("running");
    expect(startCount(h)).toBe(1);
    expect((h.doObj as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule).toHaveBeenCalledTimes(3);
  });

  it("heal (syncSession's bare-container self-heal): final row running (self-healed), 3 ticks armed", async () => {
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      respond: (cmd) => (cmd.includes("pane_current_command")
        ? { code: 0, stdout: "no git checkout at /workspace/fleetflare", stderr: "" }
        : undefined),
    });
    await h.doObj.syncSession();

    const finalRow = h.map.get(STATUS_KEY) as StudioStatus;
    expect(finalRow.state).toBe("running");
    expect(finalRow.error ?? "").toContain("self-healed");
    const scheduleSpy = (h.doObj as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule;
    // 3 from restartStudio()'s own armTicks, plus 1 from syncSession's own
    // reschedule of itself (runScheduledTick's unconditional finally, since
    // the row is NOT stopped this time).
    expect(scheduleSpy).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// T10 — D1's recordStudio must never receive a call reporting `running` or
// `degraded` for any write made after a destroy has completed within that
// same op's window.
// ---------------------------------------------------------------------------

describe("T10 — D1 recordStudio never republishes running/degraded once a destroy has landed", () => {
  it("across a provision racing a destroy, every D1 write from the destroy point onward is `stopped`, never running/degraded", async () => {
    const h = makeHarness({
      state: "stopped",
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (cmd.includes("git clone")) { markDestroyBoundary(); simulateDestroyCompletes(map); }
      },
    });
    await h.doObj.provision(cfg()).catch(() => {});

    // Confirms the simulation actually fired (never vacuously true because
    // the destroy never landed) — the epoch bumped twice and the row is
    // `stopped`, exactly destroy.ts's own two-bump contract.
    expect(h.map.get(DESTROY_EPOCH_KEY)).toBe(2);
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    // The strong guarantee the guards below actually provide: D1 receives
    // NO write at all once ctx.moved() is true — never merely a `stopped`
    // one, since a write here would mean SOME code path decided to publish
    // this op's own (necessarily stale) view of the studio.
    expect(h.writesAfterDestroy()).toHaveLength(0);
  });

  it("across a restart racing a destroy, every D1 write from the destroy point onward is `stopped`, never running/degraded", async () => {
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (cmd.includes("credential.helper")) { markDestroyBoundary(); simulateDestroyCompletes(map); }
      },
    });
    await h.doObj.restartStudio().catch(() => {});

    expect(h.map.get(DESTROY_EPOCH_KEY)).toBe(2);
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    expect(h.writesAfterDestroy()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Round 3 (PR #174, review round 2): rebase onto issue #85 PR1 plus five
// fixes the reviewer's follow-up sim found — recycle's own final writes and
// catch path were unguarded (V6d/V6e), the first epoch bump fired before
// #129's own probe-refusal decision so a REFUSED destroy still aborted an
// unrelated in-flight restart (V10), and the "kill window" between the first
// bump and the stopped-row write/second bump cannot be closed by epoch
// comparison alone (T7k) — see this suite's own header additions in the PR
// body for the full writeup.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// K-V6d — recycle's own tail: a destroy lands DURING recycleVerdict's own
// readiness exec (not before it, and not before the provision() call that
// precedes it — both of those were already guarded). Before fix 1, nothing
// re-checked ctx.moved() between recycleVerdict returning and the "provisioned"
// tail write, so a destroy that landed during that exact exec still got
// overwritten by a fresh `running` row and D1 publish.
// ---------------------------------------------------------------------------

describe("K-V6d — recycle: destroy lands during recycleVerdict's own readiness exec", () => {
  it("final row stopped, no non-stopped D1 publish once the destroy has landed", async () => {
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      // Answering PROVISIONED_OK is what drives recycleVerdict to the
      // "provisioned" tail-write branch this fix guards — see readinessOf's
      // callers in do.ts.
      respond: (cmd) => (cmd.includes("pane_current_command")
        ? { code: 0, stdout: PROVISIONED_OK, stderr: "" }
        : undefined),
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (cmd.includes("pane_current_command")) { markDestroyBoundary(); simulateDestroyCompletes(map); }
      },
    });
    const status = await h.doObj.recycle(cfg());

    expect(status.state).toBe("stopped");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
  });
});

// ---------------------------------------------------------------------------
// K-V6e — recycle's own catch: an EXTERNAL destroy bumps the epoch during the
// window between recycle's own internal `destroy()` (a raw Sandbox kill,
// never bumping the epoch itself) and its own `awaitReady()` call. Once the
// epoch has moved, recycle's own ctx is stale, so its post-destroy
// `sbAwaitReady` call gets refused by the very same #123 start gate every
// other start goes through (the row now reads `stopped`, and
// `explicitStartAllowed()` no longer matches recycle's ctx) — landing in
// recycleWithSync's destroy/awaitReady catch block. Before fix 2, that catch
// unconditionally overwrote the row `destroy` had JUST correctly left as
// `stopped` with `degraded`, and published that to D1.
// ---------------------------------------------------------------------------

describe("K-V6e — recycle: awaitReady refused by an external destroy", () => {
  it("final row stopped, never degraded — recycle's own catch defers to the row destroy already left", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV });
    const rawDestroy = (h.doObj as unknown as { destroy: () => Promise<void> }).destroy;
    (h.doObj as unknown as { destroy: () => Promise<void> }).destroy = vi.fn(async () => {
      await rawDestroy();
      // The SEPARATE, external `fleet destroy` landing and fully completing
      // in this exact window: recycle's own ctx (snapshotted before this
      // whole call began) is now stale by the time `awaitReady()` runs next.
      simulateDestroyCompletes(h.map);
    });

    const status = await h.doObj.recycle(cfg());

    expect(status.state).toBe("stopped");
    expect(status.state).not.toBe("degraded");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    expect(h.db.states().some((s) => s.state === "degraded")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P-E21 (issue #240, a #174 follow-up) — K-V6e's own sibling: that test lands
// the external destroy BEFORE awaitReady() is even called, so awaitReady()
// itself gets REFUSED (a throw), landing in recycleWithSync's own catch,
// which already checks ctx.moved(). This test lands the SAME kind of external
// destroy DURING awaitReady()'s own wait instead — after refuseStart()'s own
// pre-call check has already passed (recycle's ctx still matched the live
// epoch at that instant) but before the call resolves — modeling the SDK's
// own retry (#129 F2, destroy.ts) bringing the container back up and letting
// awaitReady() resolve SUCCESSFULLY even though the destroy has, by then,
// already fully landed. Before this fix, nothing re-checked ctx.moved()
// between a successful awaitReady() and the fall-through to provision(cfg)
// right after it — the NEXT check (already-existing, right after
// provision(cfg) returns) was too late: provision(cfg) had already run.
// ---------------------------------------------------------------------------

describe("P-E21 — recycle: an external destroy fully completes DURING awaitReady's own SUCCESSFUL wait", () => {
  it("final row stopped, zero ticks armed, no running write ever reaches D1, provision(cfg) never even attempted", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV });
    // Overrides the harness's default "just resolve" mock for the exact SDK
    // call `sbAwaitReady` makes (startAndWaitForPorts). refuseStart()'s own
    // pre-call check (StudioDO's override, do.ts) runs and passes BEFORE this
    // body ever executes — this landing point is strictly AFTER that check,
    // strictly BEFORE the call's own successful resolution.
    h.baseStart.mockImplementation(async () => {
      simulateDestroyCompletes(h.map);
      h.container.running = true;
    });

    const status = await h.doObj.recycle(cfg());

    expect(status.state).toBe("stopped");
    expect(status.state).not.toBe("degraded");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    expect((h.doObj as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule).not.toHaveBeenCalled();
    expect(h.db.states().some((s) => s.state === "running")).toBe(false);
    // provision(cfg)'s own first container touch (a git clone) is proof the
    // fall-through never reached it at all.
    expect(h.sbExecCalls.some((c) => c.includes("git clone"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// K-V10 — issue #129's own probe-refusal (a RUNNING-but-unresponsive
// container, no --force/--discard-unsynced) throws before destroyWithSync
// ever touches the container or the row. Before fix 3, the first epoch bump
// was the very first line of destroyWithSync — BEFORE that refusal decision
// — so even a destroy attempt that accomplished nothing at all still bumped
// the epoch once, aborting any op that happened to be mid-flight at the
// time. Fix 3 moves that bump to AFTER the refusal decision, so a refused
// destroy leaves the epoch completely untouched.
// ---------------------------------------------------------------------------

describe("K-V10 — a refused destroy (#129 probe fails, no --force) landing mid-restart", () => {
  it("the restart completes normally: row running, ticks armed, epoch never moves", async () => {
    let destroyAttempt: Promise<unknown> | null = null;
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      onCommand: (cmd, map) => {
        // Fires once, during restartUngated's own credential-refresh exec —
        // the same landing point T2 uses — well before the restart's own
        // tail. The attempted destroy runs concurrently, on its own
        // storage/exec ports, never touching the restart's own sbExec.
        if (cmd.includes("credential.helper") && destroyAttempt === null) {
          const storage = {
            get: async (k: string) => map.get(k),
            put: async (k: string, v: unknown) => { map.set(k, v); },
          } as unknown as StudioStorage & SessionSyncStorage;
          destroyAttempt = destroyWithSync(
            {
              exec: async () => { throw new Error("container did not answer"); },
              r2Put: async () => {}, r2List: async () => [], r2Delete: async () => {},
              now: () => new Date(), notify: async () => {}, burnAlertThresholdTokens: 0,
            },
            storage, ID,
            async () => {}, // never reached: the probe refusal throws first
            async () => {}, REPO,
            async () => `rafarc21/${REPO}`, async () => {},
            // #129: running, but the probe fails, and no discard flag was
            // passed — this is the refusal itself, not a completed destroy.
            { containerRunning: () => true, discardUnsynced: false },
          ).catch((err: unknown) => err);
        }
      },
    });
    const status = await h.doObj.restartStudio();
    await destroyAttempt;

    expect(status.state).toBe("running");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("running");
    expect((h.doObj as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule).toHaveBeenCalledTimes(3);
    // The refused destroy accomplished nothing at all — not even a single
    // bump. Absent entirely (never written), same as a studio nobody ever
    // attempted to destroy.
    expect(h.map.has(DESTROY_EPOCH_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// K-T7k — the "kill window": the gap between destroy's first bump and its
// own stopped-row write/second bump, during which the container is
// PHYSICALLY being torn down regardless of what any epoch says. An op that
// snapshots its OWN ctx epoch inside this exact window sees it agreeing with
// the live epoch (nothing has bumped a SECOND time yet) — epoch comparison
// alone cannot distinguish that from an ordinary, uncontested start. Fix 4's
// in-memory `destroyInFlightCount` counter (a bare boolean until issue #240 —
// see that field's own doc comment in do.ts) is what closes it: > 0 for
// exactly as long as THIS isolate has a live destroy call inside
// `runDestroy`, regardless of epoch, and never inherited from a marker left
// behind by a destroy that died in a PREVIOUS isolate (T8's own orphan-marker
// recovery stays intact).
// ---------------------------------------------------------------------------

describe("K-T7k — an op begins during a destroy's own kill window (destroyInFlightCount, not epoch)", () => {
  it("the op's own start is refused; final row stopped, no container left running", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV });
    // This isolate's own live destroy, physically mid-kill: bump 1 has
    // already landed (epoch 0 -> 1) and DESTROYING_KEY is fresh, but the
    // stopped-row write and the second bump have not happened yet, and the
    // container has already been (raw-)killed (`container.running` reads
    // false). A concurrent op snapshotting its ctx epoch RIGHT NOW would see
    // epoch === 1, matching the live epoch exactly — epoch agreement ALONE
    // would wrongly wave it through.
    h.map.set(DESTROY_EPOCH_KEY, 1);
    h.map.set(DESTROYING_KEY, new Date().toISOString());
    h.container.running = false;
    (h.doObj as unknown as { destroyInFlightCount: number }).destroyInFlightCount = 1;

    await expect(h.doObj.restartStudio()).rejects.toThrow(/destroy/i);
    expect(startCount(h)).toBe(0);

    // The same destroy now genuinely completes (its own kill window closes).
    (h.doObj as unknown as { destroyInFlightCount: number }).destroyInFlightCount = 0;
    const existing = h.map.get(STATUS_KEY) as StudioStatus;
    h.map.set(STATUS_KEY, { ...existing, state: "stopped", error: null });
    h.map.set(DESTROY_EPOCH_KEY, 2);
    h.map.set(DESTROYING_KEY, null);

    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    expect(h.container.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// K10 — a destroy lands and fully completes BEFORE an op's own refresh
// snapshot (refreshWithStorage's ctx.moved() guard, layered onto its own
// pre-existing watchForDestroy check), and the refresh's own credential exec
// ALSO happens to return a failing exit code. The moved-ctx guard must win
// outright — no alert, no D1 `degraded` write — never race the credential
// failure path to decide which one gets to write first.
// ---------------------------------------------------------------------------

describe("K10 — refresh inside an op: destroy lands before the op's own refresh snapshot", () => {
  it("credential exec returns 1, but the moved-ctx guard wins: row stopped, no alert, no D1 degraded write", async () => {
    const notifyCalls: string[] = [];
    const h = makeHarness({
      // Already running (not stopped): a stopped row's own first start would
      // itself be refused by T6's own gate the instant the epoch moves,
      // never reaching refreshWithStorage's credential exec at all. Running
      // already skips that first-start check entirely (same setup T4's own
      // "destroy lands before refreshWithStorage's own snapshot" test uses).
      state: "running", running: true, roleEnv: ROLE_ENV,
      respond: (cmd) => (cmd.includes("credential.helper") ? { code: 1, stdout: "", stderr: "auth error" } : undefined),
      onFirstDbWrite: (map, markDestroyBoundary) => { markDestroyBoundary(); simulateDestroyCompletes(map); },
    });
    const baseRefreshDeps = (h.doObj as unknown as { refreshDeps: () => RefreshDeps }).refreshDeps;
    (h.doObj as unknown as { refreshDeps: () => RefreshDeps }).refreshDeps = () => ({
      ...baseRefreshDeps(), notify: async (m: string) => { notifyCalls.push(m); },
    });

    const status = await h.doObj.provision(cfg());

    expect(status.state).toBe("stopped");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    expect(notifyCalls).toHaveLength(0);
    expect(h.writesAfterDestroy().some((s) => s.state === "degraded")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// K21 — an external destroy landing during the RETRY's own recycleVerdict
// readiness exec (the SECOND pane_current_command call) — fix 1's SECOND
// checkpoint, distinct from K-V6d (the FIRST attempt's recycleVerdict) and
// from T5's own second test (which lands during the retry's own git CLONE,
// caught by the earlier post-provision check instead).
//
// Round 2 correction (this round's own reviewer): this test's title and
// comment used to claim it proves recycle's nested reprovision reuses a
// SHARED ctx (`provisionCore`'s own `sharedCtx` parameter, do.ts:3585) rather
// than a fresh one. It does not actually prove that. A mutant dropping the
// shared `ctx` argument at that call site (`this.provisionCore(c, "recycle")`
// instead of `this.provisionCore(c, "recycle", ctx)` — a DIFFERENT mutant
// than issue #240's own "P-E21" above, despite the similar name) survives
// this test: with this round's own fix D (the `awaitReady`-success-path
// `moved()` check, do.ts ~line 850) already in place, there is no I/O between
// fix D's own check and provisionCore's fresh-ctx snapshot that could let a
// shared ctx and a fresh one diverge here in practice, so this test passes
// either way. Only the source-pinned tests in
// test/studio.exec-deadlines.test.ts and test/studio.refresh.test.ts (which
// grep the call-site string directly) actually kill that mutant. What this
// test DOES pin: fix 1's own retry-tail guard — an external destroy landing
// during the retry's own readiness exec is still caught, leaving the row
// stopped, never degraded.
// ---------------------------------------------------------------------------

describe("K21 — recycle's retry reprovision: an external destroy during the retry's own readiness exec", () => {
  it("the retry's own recycleVerdict tail is refused too: final row stopped, never degraded", async () => {
    let paneCalls = 0;
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      // First pane_current_command call: bare (drives the "reprovision once"
      // retry). Second call (the retry's OWN recycleVerdict readiness exec):
      // the destroy lands here — see onCommand below — so its PROVISIONED_OK
      // answer must never reach a tail write.
      respond: (cmd) => (cmd.includes("pane_current_command")
        ? { code: 0, stdout: paneCalls === 1 ? "no git checkout at /workspace/fleetflare" : PROVISIONED_OK, stderr: "" }
        : undefined),
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (!cmd.includes("pane_current_command")) return;
        paneCalls++;
        if (paneCalls === 2) { markDestroyBoundary(); simulateDestroyCompletes(map); }
      },
    });
    const status = await h.doObj.recycle(cfg());

    expect(paneCalls).toBe(2); // the retry's own readiness exec ran exactly once
    expect(status.state).toBe("stopped");
    expect(status.state).not.toBe("degraded");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
  });
});

// ---------------------------------------------------------------------------
// K12 / K23 — the post-op readiness check (provisionWithFreshVerdict /
// restartWithFreshVerdict, both backed by the same checkAndRecordReadiness)
// must never even ATTEMPT its own exec once the op's ctx has moved — not
// just skip writing the result. T6 already pins this for provision; these
// two pin the identical guarantee explicitly for BOTH verbs, since
// restartWithFreshVerdict is a separate call site round 3 threads `ctx`
// through independently.
//
// Each also doubles as fix 5's own mutation-check target: PR1's
// recordBringupObservation runs earlier in the SAME tail (provisionWithStorage/
// restartWithStorage, before either verb's own post-op readiness check), and
// runProvision/runRestart's own local view of `status.state` reads "running"
// here regardless of the destroy (the pure logic layer has no ctx of its
// own) — so absent fix 5's guard, recordBringupObservation's own exec
// (bringupObservationCmd, observed.ts) would still fire on a destroyed
// studio. The ---FLEET-BRINGUP-TOKEN--- marker is that exec's own,
// unmistakable signature.
// ---------------------------------------------------------------------------

describe("K12 — provision: readiness check never execs once the op's ctx has moved", () => {
  it("no readiness exec runs, no readiness write happens, no bring-up observation exec either", async () => {
    const h = makeHarness({
      state: "stopped",
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (cmd.includes("git clone")) { markDestroyBoundary(); simulateDestroyCompletes(map); }
      },
    });
    await h.doObj.provision(cfg());

    expect(h.sbExecCalls.some((c) => c.includes("pane_current_command"))).toBe(false);
    expect(h.sbExecCalls.some((c) => c.includes("---FLEET-BRINGUP-TOKEN---"))).toBe(false);
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
  });
});

describe("K23 — restart: readiness check never execs once the op's ctx has moved", () => {
  it("no readiness exec runs, no readiness write happens, no bring-up observation exec either", async () => {
    const h = makeHarness({
      state: "running", running: true, roleEnv: ROLE_ENV,
      onCommand: (cmd, map, markDestroyBoundary) => {
        if (cmd.includes("credential.helper")) { markDestroyBoundary(); simulateDestroyCompletes(map); }
      },
    });
    await h.doObj.restartStudio();

    expect(h.sbExecCalls.some((c) => c.includes("pane_current_command"))).toBe(false);
    expect(h.sbExecCalls.some((c) => c.includes("---FLEET-BRINGUP-TOKEN---"))).toBe(false);
    for (const s of h.writesAfterDestroy()) { expect(s.state).not.toBe("running"); expect(s.state).not.toBe("degraded"); }
  });
});

// ---------------------------------------------------------------------------
// Fix round on issue #213 (PR #229), rebased onto issue #174's OpCtx destroy-
// epoch guard (issue #152's own race-safety mechanism): #229's own bring-up
// task-delivery feature (`deliverTaskOnBringup`, wired into provision(),
// restartUngated() and recycle()'s wiring into recycleWithSync) must honor
// the SAME `ctx.moved()` guard #174 already threads through every other
// bring-up write — a destroy landing mid-bring-up has to veto the delivery
// too, exactly like it already vetoes the STATUS_KEY write.
//
// Pinned here, through the REAL StudioDO verbs (provision/restartStudio/
// recycle), using the SAME makeHarness this suite's other describes already
// use. `openTasksNeedingRebriefOnBoard` and `wakeStudioOnAssignment` are the
// two seams `deliverTaskOnBringup` calls through (do.ts) — overridden here
// exactly like deps()/refreshDeps()/syncDeps() already are inside makeHarness
// itself, Object.assign onto the fake `this`, no DO construction.
//
// Issue #137 widened `deliverAssignedTaskOnBringup`'s `boardLookup` from a
// single task-or-null to an array, so `boardLookup` below now returns
// `[task]` or `[]` — the wake mock's own shape (called with just a rendered
// `prompt` string) is UNCHANGED, since `wakeStudioOnAssignment` itself is
// still called with only `prompt`; the new per-task `taskNumber` argument is
// consumed one layer up, inside `deliverTaskOnBringup`'s own wrapping
// closure, purely for its refusal log line.
// ---------------------------------------------------------------------------

describe("board issue #213 (fix round) — bring-up task delivery honors the #174 destroy-epoch guard", () => {
  const TASK = { taskNumber: 826, title: "Fix the thing" };

  // Board issue #37's three-verdict split: PROVISIONED_OK drives the
  // "provisioned" tail write every bring-up choke point gates its own
  // deliverTaskOnBringup call on; PROVISIONED_UNKNOWN is an inconclusive
  // check (never a "bare" one — see runProvisionedCheck's own doc comment for
  // why UNKNOWN is read first) that must retry silently and deliver nothing.
  const provisionedRespond = (cmd: string) =>
    (cmd.includes("pane_current_command") ? { code: 0, stdout: PROVISIONED_OK, stderr: "" } : undefined);
  const inconclusiveRespond = (cmd: string) =>
    (cmd.includes("pane_current_command") ? { code: 0, stdout: PROVISIONED_UNKNOWN, stderr: "" } : undefined);

  /** Wires `openTasksNeedingRebriefOnBoard`/`wakeStudioOnAssignment` test
   *  doubles onto an already-built harness's `doObj` — the two seams
   *  `deliverTaskOnBringup` calls through. `onLookup` fires INSIDE the
   *  board-lookup call itself, so a test can simulate a destroy landing
   *  during that exact round trip (the same shape studio.wake-gate.test.ts's
   *  own `lookup` fake uses for the unit-level version of this same
   *  guarantee). Assertions run OUTSIDE `wake`/`boardLookup` themselves —
   *  never inside a callback `deliverAssignedTaskOnBringup`'s own total
   *  try/catch could swallow — so a wrong call shape fails the test for
   *  real, not silently. */
  function withDelivery(h: Harness, opts: {
    task?: { taskNumber: number; title: string } | null;
    onLookup?: () => void;
    wakeOutcome?: () => { ok: boolean; skipped?: boolean; error?: string };
  } = {}) {
    const boardLookup = vi.fn(async () => {
      opts.onLookup?.();
      const task = opts.task === undefined ? TASK : opts.task;
      return task === null ? [] : [task];
    });
    const readinessAtWake: Array<string | undefined> = [];
    const wake = vi.fn(async (_prompt: string) => {
      // Recorded INSIDE the wake mock, read back after the call returns
      // (never asserted on here) — pins that STATUS_KEY's readiness reads
      // "provisioned" AT THE MOMENT of the wake, not before and not after.
      readinessAtWake.push((h.map.get(STATUS_KEY) as StudioStatus | undefined)?.readiness?.kind);
      return opts.wakeOutcome?.() ?? { ok: true };
    });
    Object.assign(h.doObj, { openTasksNeedingRebriefOnBoard: boardLookup, wakeStudioOnAssignment: wake });
    return { boardLookup, wake, readinessAtWake };
  }

  it("provision of a stopped row: exactly one wake, naming the assigned task, readiness already 'provisioned' at the moment of the wake", async () => {
    const h = makeHarness({ state: "stopped", respond: provisionedRespond });
    const { wake, readinessAtWake } = withDelivery(h);

    await h.doObj.provision(cfg());

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(assignDigest({ number: TASK.taskNumber, title: TASK.title }));
    expect(readinessAtWake).toEqual(["provisioned"]);
  });

  it("restartStudio of a running row: exactly one wake", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV, respond: provisionedRespond });
    const { wake } = withDelivery(h);

    await h.doObj.restartStudio();

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(assignDigest({ number: TASK.taskNumber, title: TASK.title }));
  });

  it("recycle of a running row: exactly one wake, sent only AFTER the STATUS_KEY row is recorded as up", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV, respond: provisionedRespond });
    const { wake, readinessAtWake } = withDelivery(h);

    await h.doObj.recycle(cfg());

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(assignDigest({ number: TASK.taskNumber, title: TASK.title }));
    // Mutation-proof step 4, mutation 7: delivering BEFORE the STATUS_KEY put
    // would read the row's PRE-recycle readiness (or none) at the moment of
    // the wake, never "provisioned" — this pins the row as already recorded
    // up before the wake goes out.
    expect(readinessAtWake).toEqual(["provisioned"]);
  });

  it("provision: an INCONCLUSIVE readiness verdict delivers nothing — zero wakes, zero board lookups", async () => {
    const h = makeHarness({ state: "stopped", respond: inconclusiveRespond });
    const { wake, boardLookup } = withDelivery(h);

    await h.doObj.provision(cfg());

    expect(wake).not.toHaveBeenCalled();
    expect(boardLookup).not.toHaveBeenCalled();
  });

  it("restartStudio: an INCONCLUSIVE readiness verdict delivers nothing — zero wakes, zero board lookups", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV, respond: inconclusiveRespond });
    const { wake, boardLookup } = withDelivery(h);

    await h.doObj.restartStudio();

    expect(wake).not.toHaveBeenCalled();
    expect(boardLookup).not.toHaveBeenCalled();
  });

  it("recycle: an INCONCLUSIVE readiness verdict delivers nothing — zero wakes, zero board lookups", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV, respond: inconclusiveRespond });
    const { wake, boardLookup } = withDelivery(h);

    await h.doObj.recycle(cfg());

    expect(wake).not.toHaveBeenCalled();
    expect(boardLookup).not.toHaveBeenCalled();
  });

  it("provision: a destroy landing DURING the board lookup itself vetoes the wake — zero wakes, DELIVERED_TASK_KEY never set", async () => {
    const h = makeHarness({ state: "stopped", respond: provisionedRespond });
    const { wake } = withDelivery(h, { onLookup: () => simulateDestroyCompletes(h.map) });

    await h.doObj.provision(cfg());

    expect(wake).not.toHaveBeenCalled();
    expect(h.map.get(DELIVERED_TASK_KEY)).toBeUndefined();
  });

  it("recycle: a destroy landing DURING the board lookup itself vetoes the wake — zero wakes, DELIVERED_TASK_KEY never set", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV, respond: provisionedRespond });
    const { wake } = withDelivery(h, { onLookup: () => simulateDestroyCompletes(h.map) });

    await h.doObj.recycle(cfg());

    expect(wake).not.toHaveBeenCalled();
    expect(h.map.get(DELIVERED_TASK_KEY)).toBeUndefined();
  });

  it("provision, then restartStudio, for the SAME task: exactly one wake TOTAL — the dedup marker suppresses the second", async () => {
    const h = makeHarness({ state: "stopped", respond: provisionedRespond });
    const { wake } = withDelivery(h);

    await h.doObj.provision(cfg());
    // Second bring-up on the same storage: provision() above already left the
    // row running with a stored ROLE_ENV_KEY (production code's own write —
    // see provisionCore), so this is restartStudio's own ordinary path, not a
    // second provision.
    await h.doObj.restartStudio();

    expect(wake).toHaveBeenCalledTimes(1);
  });

  // PR #143 fix-first review coverage gap: `recordBringupObservation`
  // (provision.ts ~3329) mints a BRAND NEW `crypto.randomUUID()` on EVERY
  // bring-up unconditionally, not only when a real container replacement
  // happened — unlike `deliverSurvivalOnBringup`'s own allowlist-gated
  // feature, this delivery path shares none of that restriction. The dedup
  // test right above only proves "one wake total" because this harness's
  // `provisionedRespond` never answers the bring-up-observation exec with a
  // successful token write, so `Observed.incarnation` never actually changes
  // between the two calls — the SAME gap the reviewer's own note calls out
  // ("the destroy-race harness never changes the token, so add one test that
  // does"). This test arms that exec for real (matching on
  // `BRINGUP_TOKEN_WRITE_SECTION`, observed.ts), so `provision()` and the
  // following `restartStudio()` each mint and persist a genuinely different
  // incarnation token, and pins that the SAME still-open task earns a SEPARATE
  // wake on each — the incarnation-scoped dedup (`taskWakesDeliveredFor`)
  // correctly treats each as a fresh container identity, end-to-end through
  // the real StudioDO methods (not just at the do.ts-unit level
  // studio.wake-gate.test.ts already covers).
  it("provision, then restartStudio, for the SAME task, but a DIFFERENT incarnation each time: TWO wakes — the token change earns a fresh delivery", async () => {
    const respondWithTokenWrite = (cmd: string) => {
      if (cmd.includes("pane_current_command")) return { code: 0, stdout: PROVISIONED_OK, stderr: "" };
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        return { code: 0, stdout: `${BRINGUP_TOKEN_WRITE_SECTION}\nyes\n`, stderr: "" };
      }
      return undefined;
    };
    const h = makeHarness({ state: "stopped", respond: respondWithTokenWrite });
    const { wake } = withDelivery(h);

    await h.doObj.provision(cfg());
    await h.doObj.restartStudio();

    expect(wake).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// P-N7 / P-N8 (issue #240, a #174 follow-up) — the ONLY existing coverage of
// `destroyInFlight` (K-T7k above) never calls the real `StudioDO.destroyStudio()`
// at all: it pokes the private field directly, both to set it true and to
// clear it back to false. That leaves two real mutants alive: one where
// `destroyStudio()` never actually SETS the flag before its own kill, one
// where it never CLEARS it in its own `finally`. These two tests call the
// REAL, public `destroyStudio(true)` (force=true skips the board-task check
// entirely — runDestroy never even calls `checkOpenTask` — reaching the real
// destroy path directly, same as every other test in this file reaches
// `provision`/`restartStudio`/`recycle` through their own real entry points).
// `running: false` throughout: a container already running is never refused
// (`refuseStart`'s own doc comment) — the refusal path this suite is proving
// only fires when a start is genuinely attempted.
// ---------------------------------------------------------------------------

describe("P-N7 — issue #240: a REAL destroyStudio() call refuses a REAL concurrent restartStudio() while its own kill is still in flight", () => {
  it("the concurrent restart is refused; no container ends up running under the row destroy leaves stopped", async () => {
    const h = makeHarness({ state: "running", running: false, roleEnv: ROLE_ENV });
    let restartAttempt: Promise<StudioStatus> | null = null;
    const rawDestroy = (h.doObj as unknown as { destroy: () => Promise<void> }).destroy;
    (h.doObj as unknown as { destroy: () => Promise<void> }).destroy = vi.fn(async () => {
      // Fired from INSIDE destroyStudio's own kill step — this.destroyInFlightCount
      // (do.ts) is already > 0 (incremented before runDestroy ever ran) and
      // DESTROYING_KEY is already fresh (written by destroyWithSync before
      // this callback runs). Awaited to settle HERE, before this destroy call
      // itself is allowed to resolve (and thus before destroyWithSync's own
      // `finally` can clear DESTROYING_KEY, or destroyStudio's own `finally`
      // can decrement the counter) — keeping this destroy genuinely "mid-kill"
      // for the concurrent restart's own entire attempt, not just its start.
      restartAttempt = h.doObj.restartStudio();
      await restartAttempt.catch(() => {});
      await rawDestroy();
    });

    const outcome = await h.doObj.destroyStudio(true);
    await expect(restartAttempt).rejects.toThrow(/destroy/i);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.status.state).toBe("stopped");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    expect(h.container.running).toBe(false);
  });
});

describe("P-N8 — issue #240: after a REAL destroyStudio() fully completes, a REAL provision() starts completely normally", () => {
  it("the flag was genuinely CLEARED by destroyStudio's own finally, not merely by a test poking the field", async () => {
    const h = makeHarness({ state: "running", running: true, roleEnv: ROLE_ENV });

    const outcome = await h.doObj.destroyStudio(true);
    expect(outcome.ok).toBe(true);
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");

    // A plain, unrelated, later `fleet provision` — no fixture ever touches
    // destroyInFlight for this call. If destroyStudio's own `finally` had not
    // genuinely run (or had not genuinely cleared the flag), this would be
    // refused exactly like P-N7's concurrent attempt above.
    const status = await h.doObj.provision(cfg());

    expect(status.state).toBe("running");
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("running");
    expect(startCount(h)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #240 fix E — `destroyInFlight` was a bare boolean: with TWO
// overlapping `destroyStudio()` calls, the SECOND call's own `finally` sets it
// back to `false` while the FIRST is still mid-`runDestroy`, incorrectly
// opening the door for a concurrent restart to slip through
// `explicitStartAllowed()`. The fix turns it into a counter
// (`destroyInFlightCount`), incremented before each call's own `runDestroy`
// and decremented (never below 0) in each call's own `finally` — so
// `explicitStartAllowed()`'s gate (`destroyInFlightCount > 0`) stays closed
// until EVERY overlapping destroy has genuinely finished, not just the last
// one to start.
// ---------------------------------------------------------------------------

describe("issue #240 fix E — destroyInFlight is a COUNTER: a second destroy's own finally must not clear the first destroy's still-in-flight guard", () => {
  it("a restart attempted while the FIRST of two overlapping destroys is still mid-kill (the second having already finished) is still refused; only once BOTH finish is a start allowed again", async () => {
    const h = makeHarness({ state: "running", running: false, roleEnv: ROLE_ENV });
    let releaseFirstDestroy: (() => void) | null = null;
    let destroyCalls = 0;
    const rawDestroy = (h.doObj as unknown as { destroy: () => Promise<void> }).destroy;
    (h.doObj as unknown as { destroy: () => Promise<void> }).destroy = vi.fn(async () => {
      destroyCalls += 1;
      const myCall = destroyCalls;
      if (myCall === 1) {
        // The FIRST destroy's own kill hangs here, deliberately, for the rest
        // of this test — modeling a `runDestroy` that has not settled yet.
        await new Promise<void>((resolve) => { releaseFirstDestroy = resolve; });
      }
      await rawDestroy();
    });

    const firstDestroy = h.doObj.destroyStudio(true);
    const secondDestroy = h.doObj.destroyStudio(true);
    const secondOutcome = await secondDestroy;
    expect(secondOutcome.ok).toBe(true);
    // The SECOND call's own `finally` has now run (count 2 -> 1), and — a
    // separate, EXPECTED effect of that same successful completion —
    // DESTROYING_KEY (a single shared persisted key, not counter-aware) and
    // STATUS_KEY have already been written to their post-destroy values by
    // the second call's own destroyAndRecord. So this refusal falls through
    // to the STATE-based branch ("stopped"), not the marker-based one — the
    // load-bearing proof here is that it refuses AT ALL: this restart's own
    // freshly-created ctx trivially matches the CURRENT live epoch (nothing
    // bumped it again since), so epoch comparison alone would wave it
    // straight through. Only `destroyInFlightCount` still being 1 (the FIRST
    // destroy still mid-kill; a plain boolean would have been reset to
    // `false` by the second call's own `finally` above) closes that gap.
    await expect(h.doObj.restartStudio()).rejects.toThrow(/stopped|destroy/i);

    releaseFirstDestroy!();
    const firstOutcome = await firstDestroy;
    expect(firstOutcome.ok).toBe(true);

    // NOW both destroys have genuinely finished (count 1 -> 0) — an ordinary,
    // later start is allowed again.
    const status = await h.doObj.provision(cfg());
    expect(status.state).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Issue #240 fix F — the hung-`runDestroy` bound. The issue's own concern: "if
// runDestroy never settles in a live isolate, destroyInFlight[Count] stays set
// and explicit starts are refused until the DESTROYING marker goes stale (15
// min)." Traced end to end: `explicitStartAllowed()`'s in-memory counter check
// (do.ts) only ever affects the `explicit` argument passed into `startRefusal`
// — when the counter is stuck, `explicit` is simply `false`, and
// `startRefusal` (do.ts) falls through to `destroyingMarkerFresh` (provision.ts),
// which reads the PERSISTED `DESTROYING_KEY` timestamp against
// `OPERATION_STALE_MS` (15 min) — a check entirely independent of the
// in-memory counter's own value. Past that bound, a stuck counter does NOT
// block a start forever: the marker reads stale, `startRefusal` falls through
// to `STATUS_KEY`'s own recorded `state`, and a studio whose last known state
// was "running" (never rewritten to "stopped", because the hang happened
// BEFORE `runDestroy` ever reached that write) is correctly let through. This
// test proves that reasoning directly, rather than re-deriving it from a live
// read next time.
// ---------------------------------------------------------------------------

describe("issue #240 fix F — a stuck destroyInFlightCount does not block a start forever: the persisted DESTROYING_KEY marker's own 15-minute staleness bound wins once it's past", () => {
  it("counter stuck at 1, marker present but stale, row still says running: a start is ALLOWED", async () => {
    const h = makeHarness({ state: "running", running: false, roleEnv: ROLE_ENV });
    // Simulates a `runDestroy` that hung in THIS isolate and never settled:
    // the counter incremented on entry, but its own `finally` never ran.
    (h.doObj as unknown as { destroyInFlightCount: number }).destroyInFlightCount = 1;
    // The marker a hung destroy would have written before hanging — present,
    // but well past OPERATION_STALE_MS now.
    h.map.set(DESTROYING_KEY, new Date(Date.now() - OPERATION_STALE_MS - 1000).toISOString());
    // STATUS_KEY (seeded "running" by makeHarness) was never rewritten to
    // "stopped" — exactly what a destroy hanging BEFORE its own stopped-row
    // write would leave behind.

    const status = await h.doObj.restartStudio();

    expect(status.state).toBe("running");
    // The stuck counter never cleared during this call — proof the ALLOW
    // came from the marker's own staleness, not from the counter resolving.
    expect((h.doObj as unknown as { destroyInFlightCount: number }).destroyInFlightCount).toBe(1);
  });

  it("counter stuck at 1, marker still FRESH: a start is refused (the 15-minute bound has not passed yet)", async () => {
    const h = makeHarness({ state: "running", running: false, roleEnv: ROLE_ENV });
    (h.doObj as unknown as { destroyInFlightCount: number }).destroyInFlightCount = 1;
    h.map.set(DESTROYING_KEY, new Date().toISOString());

    await expect(h.doObj.restartStudio()).rejects.toThrow(/destroy/i);
  });
});

// ---------------------------------------------------------------------------
// P-N8t (issue #240 survivor E3, round 2) — P-N8 above only proves the
// decrement runs on a SUCCESSFUL `runDestroy`. A mutant moving
// `destroyInFlightCount`'s decrement out of `destroyStudio`'s own `finally`
// and into a plain statement placed only AFTER a successful `await
// runDestroy(...)` survives the whole suite: the real failure shape this
// matters for is a container kill that throws on its FIRST attempt, but a
// LATER retried `destroyStudio()` call succeeds — with the mutant, the FIRST
// call's increment is never balanced (its own `runDestroy` threw, so the
// moved decrement statement never runs), leaving the counter permanently off
// by one for the isolate's whole life, even after the studio is genuinely
// fully destroyed and a later legitimate `provision()`/`ff` attempt should be
// allowed again.
// ---------------------------------------------------------------------------

describe("P-N8t — issue #240 survivor E3: destroyInFlightCount's decrement must run even when runDestroy throws", () => {
  it("first destroyStudio() throws (container kill failed) and degrades the row; a later retry succeeds; a later provision() is then allowed", async () => {
    const h = makeHarness({ state: "running", running: false, roleEnv: ROLE_ENV });
    let destroyCalls = 0;
    const rawDestroy = (h.doObj as unknown as { destroy: () => Promise<void> }).destroy;
    (h.doObj as unknown as { destroy: () => Promise<void> }).destroy = vi.fn(async () => {
      destroyCalls += 1;
      if (destroyCalls === 1) throw new Error("container kill failed");
      await rawDestroy();
    });

    // 1. The first destroyStudio() call: its own container-kill step throws
    // on this first attempt — destroyAndRecord (destroy.ts) degrades the row
    // and rethrows "destroy failed: ...".
    await expect(h.doObj.destroyStudio(true)).rejects.toThrow(/destroy failed/);
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("degraded");

    // 2. A later retried destroyStudio() call: this time the kill step
    // succeeds for real. If the FIRST call's own `finally` had not decremented
    // destroyInFlightCount (the E3 mutant), the counter would already be
    // stuck above 0 here, but that alone does not fail this second call —
    // destroyStudio's own `+= 1`/`finally` pair is unconditional regardless
    // of the counter's starting value.
    const outcome = await h.doObj.destroyStudio(true);
    expect(outcome.ok).toBe(true);
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");

    // 3. A later, genuinely unrelated provision() attempt. Under the E3
    // mutant the counter is stuck at 1 (the first call's increment was never
    // balanced), so `explicitStartAllowed()` stays `false` forever in this
    // isolate and this call is wrongly refused, even though the studio is
    // now fully, cleanly destroyed. With the real `finally`-based decrement,
    // the counter is back to 0 and this succeeds normally.
    const status = await h.doObj.provision(cfg());
    expect(status.state).toBe("running");
    expect(startCount(h)).toBeGreaterThan(0);
  });
});
