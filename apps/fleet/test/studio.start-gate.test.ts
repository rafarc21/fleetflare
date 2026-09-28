import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Sandbox } from "@cloudflare/sandbox";
import * as authModule from "../src/studio/auth";
import { handleStudio } from "../src/studio/routes";
import { attachRefusal } from "../cli/backoff";
import type { Env } from "../src/env";
import { StudioDO, SPAWN_TOKEN_KEY } from "../src/studio/do";
import { STATUS_KEY, DESTROYING_KEY, OPERATION_KEY, createOpCtx, type OpCtx } from "../src/studio/provision";
import { hashSpawnToken } from "../src/studio/org";
import { TERMINAL_PATH } from "../src/studio/terminal";
import type { StudioState, StudioStatus } from "../src/studio/types";

// ---------------------------------------------------------------------------
// Issue #123: a stopped or destroying studio must never start a container.
//
// Live repro 2026-09-24 16:01Z: after `fleet destroy`, a surviving
// `fleet attach` client reconnected; /ws/terminal went StudioDO.fetch ->
// Sandbox -> containerFetch -> startAndWaitForPorts and booted a NEW bare
// container under a row reading `stopped`.
//
// A live StudioDO cannot be constructed under vitest-pool-workers (see
// studio.ws.test.ts), so each test runs the REAL StudioDO / Sandbox /
// Container prototype methods against a fake `this`. The one thing faked
// below the gate is the base Container's start path: its
// startAndWaitForPorts and start are spied on Container.prototype, so
// "a container was started" is an observed call into the pinned SDK, not a
// flag this suite invented.
// ---------------------------------------------------------------------------

const ID = "fleetflare--web-studio";
const TOKEN = "spawn-token-fixture";
const ContainerProto = Object.getPrototypeOf(Sandbox.prototype) as {
  startAndWaitForPorts: (...args: unknown[]) => Promise<void>;
  start: (...args: unknown[]) => Promise<void>;
};

class Started extends Error {}

afterEach(() => {
  vi.restoreAllMocks();
});

async function studio(opts: {
  state?: StudioState;
  running?: boolean;
  destroyingSince?: string | null;
  operation?: { op: "provision" | "restart"; since: string } | null;
}) {
  const map = new Map<string, unknown>();
  if (opts.state) {
    map.set(STATUS_KEY, {
      id: ID, state: opts.state, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
      burn: null, spawnedBy: null, spawnTokenHash: await hashSpawnToken(TOKEN), repoSlug: null,
    } as StudioStatus);
  }
  map.set(SPAWN_TOKEN_KEY, TOKEN);
  if (opts.destroyingSince !== undefined) map.set(DESTROYING_KEY, opts.destroyingSince);
  if (opts.operation !== undefined) map.set(OPERATION_KEY, opts.operation);
  const storage = {
    get: async (k: string) => map.get(k),
    put: async (k: string, v: unknown) => {
      map.set(k, v);
    },
    delete: async (k: string) => map.delete(k),
  };
  const container = {
    running: opts.running ?? false,
    start: vi.fn(),
    monitor: vi.fn(() => new Promise(() => {})),
    getTcpPort: vi.fn(() => ({ fetch: async () => new Response("from container") })),
  };
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  const doObj = Object.create(StudioDO.prototype) as StudioDO;
  Object.assign(doObj, {
    ctx: { id: { name: ID }, storage, container, acceptWebSocket: noop, getWebSockets: () => [] },
    container,
    env: {},
    logger,
    containerTimeouts: { instanceGetTimeoutMS: 30_000, portReadyTimeoutMS: 90_000, waitIntervalMS: 300 },
    // Issue #152: replaces the old bare `startsAllowed: 0` counter — a real
    // StudioDO built via `new` gets this from its own class field
    // initializer, but `Object.create(StudioDO.prototype)` below never runs
    // the constructor, so every private field this class relies on (this one
    // included) has to be seeded by hand, exactly as `startsAllowed` was.
    activeOps: new Set<OpCtx>(),
    getState: async () => ({ status: container.running ? "healthy" : "stopped" }),
    state: { getState: async () => ({ status: "healthy" }) },
  });
  const baseStart = vi.spyOn(ContainerProto, "startAndWaitForPorts").mockRejectedValue(new Started("started"));
  const baseStartOnly = vi.spyOn(ContainerProto, "start").mockRejectedValue(new Started("started"));
  return { doObj, map, container, baseStart, baseStartOnly };
}

const FRESH = () => new Date(Date.now() - 1000).toISOString();
const STALE = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

function started(s: Awaited<ReturnType<typeof studio>>): boolean {
  return s.baseStart.mock.calls.length > 0 || s.baseStartOnly.mock.calls.length > 0 || s.container.start.mock.calls.length > 0;
}

async function exec(doObj: StudioDO): Promise<Response> {
  return doObj.containerFetch("http://localhost:3000/api/execute", { method: "POST", body: "{}" }, 3000);
}

describe("#123 start gate — exec path (containerFetch, the SDK HTTP transport's only door)", () => {
  it("stopped studio: exec answers 409, never starts a container", async () => {
    const s = await studio({ state: "stopped" });
    const res = await exec(s.doObj);
    expect(res.status).toBe(409);
    expect(started(s)).toBe(false);
  });

  it("refusal is typed JSON the SDK's handleErrorResponse parses, naming the way back", async () => {
    const s = await studio({ state: "stopped" });
    const body = (await (await exec(s.doObj)).json()) as { code: string; message: string; httpStatus: number };
    expect(body.code).toBe("STUDIO_STOPPED");
    expect(body.httpStatus).toBe(409);
    expect(body.message).toContain(`ff ${ID}`);
  });

  it("never-provisioned studio (no status row) is refused the same way", async () => {
    const s = await studio({});
    expect((await exec(s.doObj)).status).toBe(409);
    expect(started(s)).toBe(false);
  });

  it("destroying studio: the #110 late tick exec (row still running) never starts one", async () => {
    const s = await studio({ state: "running", destroyingSince: FRESH() });
    const res = await exec(s.doObj);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("destroy");
    expect(started(s)).toBe(false);
  });

  it("running studio whose container died still auto-restarts (today's heal path)", async () => {
    const s = await studio({ state: "running" });
    await exec(s.doObj).catch(() => {});
    expect(s.baseStart).toHaveBeenCalled();
  });

  it.each(["degraded", "provisioning"] as const)("%s studio still auto-starts", async (state) => {
    const s = await studio({ state });
    await exec(s.doObj).catch(() => {});
    expect(s.baseStart).toHaveBeenCalled();
  });

  it("stale DESTROYING marker (evicted destroy) does not block a running studio", async () => {
    const s = await studio({ state: "running", destroyingSince: STALE() });
    await exec(s.doObj).catch(() => {});
    expect(s.baseStart).toHaveBeenCalled();
  });

  // Fix round: OPERATION_KEY is written only inside allowingStart, so a live
  // op is already admitted. A lock seen WITHOUT the allowance is an orphan
  // (isolate reset mid-op) and must not boot a stopped studio for 15 min.
  it("stopped studio holding a FRESH but orphaned op lock is refused", async () => {
    const s = await studio({ state: "stopped", operation: { op: "provision", since: FRESH() } });
    expect((await exec(s.doObj)).status).toBe(409);
    expect(started(s)).toBe(false);
  });

  it("stopped + fresh DESTROYING + fresh op lock is refused", async () => {
    const s = await studio({ state: "stopped", destroyingSince: FRESH(), operation: { op: "restart", since: FRESH() } });
    expect((await exec(s.doObj)).status).toBe(409);
    expect(started(s)).toBe(false);
  });

  it("stopped studio with a STALE op lock is refused", async () => {
    const s = await studio({ state: "stopped", operation: { op: "restart", since: STALE() } });
    expect((await exec(s.doObj)).status).toBe(409);
    expect(started(s)).toBe(false);
  });

  it("released op lock (stored null, #103) is not a lock", async () => {
    const s = await studio({ state: "stopped", operation: null });
    expect((await exec(s.doObj)).status).toBe(409);
  });

  it("a container already running is never refused (the gate governs starts only)", async () => {
    const s = await studio({ state: "stopped", running: true });
    const res = await exec(s.doObj);
    expect(res.status).not.toBe(409);
  });
});

describe("#123 start gate — the start calls themselves (sbAwaitReady, RPC start, start())", () => {
  it("stopped studio: startAndWaitForPorts throws the refusal, base start never runs", async () => {
    const s = await studio({ state: "stopped" });
    await expect(s.doObj.startAndWaitForPorts()).rejects.toThrow(`ff ${ID}`);
    expect(started(s)).toBe(false);
  });

  it("the thrown refusal is typed (code STUDIO_STOPPED)", async () => {
    const s = await studio({ state: "stopped" });
    await expect(s.doObj.startAndWaitForPorts()).rejects.toMatchObject({ code: "STUDIO_STOPPED" });
    await expect(s.doObj.start()).rejects.toMatchObject({ code: "STUDIO_STOPPED" });
  });

  it("stopped studio: start() throws the refusal, base start never runs", async () => {
    const s = await studio({ state: "stopped" });
    await expect(s.doObj.start()).rejects.toThrow(`ff ${ID}`);
    expect(started(s)).toBe(false);
  });

  it("destroying studio: startAndWaitForPorts refused", async () => {
    const s = await studio({ state: "running", destroyingSince: FRESH() });
    await expect(s.doObj.startAndWaitForPorts()).rejects.toThrow(/destroy/);
    expect(started(s)).toBe(false);
  });
});

describe("#123 start gate — explicit operations still start a stopped studio", () => {
  // Each operation's FIRST container touch happens before provisionWithStorage
  // / restartWithStorage take OPERATION_KEY, so the op lock alone cannot
  // admit it. The Started sentinel aborts the operation at that first start.
  it("provision (provisionCore) starts a stopped studio's container", async () => {
    const s = await studio({ state: "stopped" });
    const core = (s.doObj as unknown as { provisionCore: (c: unknown) => Promise<unknown> }).provisionCore;
    await expect(core.call(s.doObj, { repo: "fleetflare", role: "web-studio" })).rejects.toBeInstanceOf(Started);
    expect(s.baseStart).toHaveBeenCalled();
  });

  it("restart (restartStudio — also the heal) starts a stopped studio's container", async () => {
    const s = await studio({ state: "stopped" });
    await expect(s.doObj.restartStudio()).rejects.toBeInstanceOf(Started);
    expect(s.baseStart).toHaveBeenCalled();
  });

  it("recycle starts the container it destroyed", async () => {
    const s = await studio({ state: "stopped" });
    const exec = async () => ({ code: 0, stdout: "", stderr: "" });
    Object.assign(s.doObj, {
      syncDeps: () => ({
        exec, r2Put: async () => {}, r2List: async () => [], r2Delete: async () => {}, now: () => new Date(),
        notify: async () => {}, burnAlertThresholdTokens: 0,
      }),
      memoryDeps: () => ({ resolveMemoryRepo: async () => null, commitFile: async () => {} }),
      destroy: vi.fn(async () => {}),
      lastSyncedAt: async () => new Date(),
      env: { DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) } },
    });
    await s.doObj.recycle({ repo: "fleetflare", role: "web-studio" } as never).catch(() => {});
    expect(s.baseStart).toHaveBeenCalled();
  });

  // #100 N1: provision / restart clear a DESTROYING marker a dead destroy
  // left behind — but only if their own start gets past it. The explicit-op
  // check must outrank the DESTROYING check, or recovery is locked out for
  // OPERATION_STALE_MS after any destroy that died mid-flight.
  it.each([
    ["provisionCore", (d: StudioDO) =>
      (d as unknown as { provisionCore: (c: unknown) => Promise<unknown> }).provisionCore.call(d, { repo: "fleetflare", role: "web-studio" })],
    ["restartStudio", (d: StudioDO) => d.restartStudio()],
  ] as const)("%s starts through a FRESH DESTROYING marker (dead destroy recovery)", async (_name, op) => {
    const s = await studio({ state: "stopped", destroyingSince: FRESH() });
    await expect(op(s.doObj)).rejects.toBeInstanceOf(Started);
    expect(s.baseStart).toHaveBeenCalled();
  });

  it("an operation's allowance ends with it: a late exec after it returns is refused", async () => {
    const s = await studio({ state: "stopped" });
    await s.doObj.restartStudio().catch(() => {});
    s.baseStart.mockClear();
    expect((await exec(s.doObj)).status).toBe(409);
    expect(s.baseStart).not.toHaveBeenCalled();
  });
});

describe("#123 start gate — terminal websocket", () => {
  const upgrade = () =>
    new Request(`https://studio${TERMINAL_PATH}`, { headers: { Upgrade: "websocket", Connection: "Upgrade" } });

  it("stopped studio: ws upgrade answers 409, never opens a pty or starts a container", async () => {
    const s = await studio({ state: "stopped" });
    const res = await s.doObj.fetch(upgrade());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain(`ff ${ID}`);
    expect(started(s)).toBe(false);
  });

  it("destroying studio: ws upgrade answers 409", async () => {
    const s = await studio({ state: "running", destroyingSince: FRESH() });
    expect((await s.doObj.fetch(upgrade())).status).toBe(409);
    expect(started(s)).toBe(false);
  });

  it("stopped studio: a plain GET (the CLI's refusal probe) also answers 409", async () => {
    const s = await studio({ state: "stopped" });
    expect((await s.doObj.fetch(new Request(`https://studio${TERMINAL_PATH}`))).status).toBe(409);
  });

  it("stopped studio with a provision in flight: terminal is not refused (allowance counts)", async () => {
    const s = await studio({ state: "stopped" });
    // Issue #152: a live op is "some ctx in activeOps whose own epoch still
    // matches the live one" — createOpCtx reads that live epoch (0, no
    // DESTROY_EPOCH_KEY seeded) off the SAME storage the gate itself reads.
    const doObjWithCtx = s.doObj as unknown as { ctx: { storage: Parameters<typeof createOpCtx>[0] } };
    const ctx = await createOpCtx(doObjWithCtx.ctx.storage);
    Object.assign(s.doObj, { activeOps: new Set<OpCtx>([ctx]) });
    expect((await s.doObj.fetch(new Request(`https://studio${TERMINAL_PATH}`))).status).toBe(426);
    expect(started(s)).toBe(false);
  });

  it("running studio: a plain GET still answers 426, opening nothing", async () => {
    const s = await studio({ state: "running", running: true });
    expect((await s.doObj.fetch(new Request(`https://studio${TERMINAL_PATH}`))).status).toBe(426);
    expect(started(s)).toBe(false);
  });
});

describe("#123 start gate — #95 container watch stays start-free", () => {
  it("watchContainer on a stopped studio reads ctx.container.running and starts nothing", async () => {
    const s = await studio({ state: "stopped", running: false });
    await s.doObj.watchContainer();
    expect(started(s)).toBe(false);
  });
});

// Fix round, verifier S1: the CLI's probe goes through the Worker ROUTE, not
// straight to the DO. The route used to answer 426 to any non-upgrade GET
// before the DO, so attachRefusal never saw the 409 and attach looped forever.
describe("#123 start gate — the CLI probe through the real Worker route", () => {
  async function route(s: Awaited<ReturnType<typeof studio>>) {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    const createSession = vi.fn(async () => {});
    Object.assign(s.doObj, { createSession });
    const testEnv = {
      ...env,
      STUDIO: {
        idFromName: (n: string) => n as unknown as DurableObjectId,
        get: () => ({ fetch: (r: Request) => s.doObj.fetch(r) }),
      },
    } as unknown as Env;
    const req = (h: Record<string, string> = {}) =>
      new Request(`https://x/studio/${ID}/ws/terminal`, { headers: { "Cf-Access-Jwt-Assertion": "jwt", ...h } });
    return { testEnv, req, createSession };
  }

  it("stopped studio: plain GET through the route answers 409 and attachRefusal returns its message", async () => {
    const s = await studio({ state: "stopped" });
    const { testEnv, req } = await route(s);
    expect((await handleStudio(req(), testEnv)).status).toBe(409);
    expect(await attachRefusal(() => handleStudio(req(), testEnv))).toContain(`ff ${ID}`);
    expect(started(s)).toBe(false);
  });

  it("running studio: plain GET through the route answers 426 and opens no pty", async () => {
    const s = await studio({ state: "running", running: true });
    const { testEnv, req, createSession } = await route(s);
    expect((await handleStudio(req(), testEnv)).status).toBe(426);
    expect(await attachRefusal(() => handleStudio(req(), testEnv))).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(started(s)).toBe(false);
  });
});
