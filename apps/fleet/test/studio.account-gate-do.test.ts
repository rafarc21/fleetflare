import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "../src/env";
import { StudioDO, SPAWN_TOKEN_KEY, LaunchRefusedError } from "../src/studio/do";
import { STATUS_KEY, type OpCtx } from "../src/studio/provision";
import { hashSpawnToken } from "../src/studio/org";
import type { StudioState, StudioStatus } from "../src/studio/types";

// ---------------------------------------------------------------------------
// Issue #271, PR #273 review round 2: the launch gate's WIRING. A repo mapped
// (CLAUDE_ACCOUNT_BY_REPO) to an account whose secret is not set must never
// launch — through provision, restart, recycle, or an alarm-woken exec.
//
// Same technique as test/studio.start-gate.test.ts: the REAL StudioDO
// prototype methods run against a fake `this`, and "a container was
// started" is an observed call into the pinned SDK's Container start path.
// Fake token only; no secret anywhere.
// ---------------------------------------------------------------------------

const ID = "fleetflare--web-studio";
const TOKEN = "spawn-token-fixture";
const FAKE_OAUTH = "sk-ant-oat01-" + "a".repeat(40);
const ContainerProto = Object.getPrototypeOf(Sandbox.prototype) as {
  startAndWaitForPorts: (...args: unknown[]) => Promise<void>;
  start: (...args: unknown[]) => Promise<void>;
};

class Started extends Error {}

afterEach(() => {
  vi.restoreAllMocks();
});

/** fleetflare mapped to slot 2, and CLAUDE_CODE_OAUTH_TOKEN_2 not set. */
const MAPPED_MISSING = {
  ...env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH, CLAUDE_ACCOUNT_BY_REPO: '{"fleetflare":2}',
} as unknown as Env;

async function studio(state: StudioState) {
  const map = new Map<string, unknown>();
  map.set(STATUS_KEY, {
    id: ID, state, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: await hashSpawnToken(TOKEN), repoSlug: null,
  } as StudioStatus);
  map.set(SPAWN_TOKEN_KEY, TOKEN);
  const storage = {
    get: async (k: string) => map.get(k),
    put: async (k: string, v: unknown) => { map.set(k, v); },
    delete: async (k: string) => map.delete(k),
  };
  const container = {
    running: false,
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
    env: MAPPED_MISSING,
    logger,
    containerTimeouts: { instanceGetTimeoutMS: 30_000, portReadyTimeoutMS: 90_000, waitIntervalMS: 300 },
    activeOps: new Set<OpCtx>(),
    destroyInFlightCount: 0,
    getState: async () => ({ status: "stopped" }),
    state: { getState: async () => ({ status: "healthy" }) },
  });
  const baseStart = vi.spyOn(ContainerProto, "startAndWaitForPorts").mockRejectedValue(new Started("started"));
  const baseStartOnly = vi.spyOn(ContainerProto, "start").mockRejectedValue(new Started("started"));
  const started = () =>
    baseStart.mock.calls.length > 0 || baseStartOnly.mock.calls.length > 0 || container.start.mock.calls.length > 0;
  return { doObj, map, started };
}

function rowError(map: Map<string, unknown>): string | null {
  return (map.get(STATUS_KEY) as StudioStatus | undefined)?.error ?? null;
}

describe("#271 launch gate — mapped account with no secret refuses, through the real DO paths", () => {
  it("provision: refused, row says why, no container started", async () => {
    const s = await studio("provisioning");
    await expect(s.doObj.provision({ repo: "fleetflare", role: "web-studio" })).rejects.toBeInstanceOf(LaunchRefusedError);
    expect(rowError(s.map)).toContain("mapped to CLAUDE_CODE_OAUTH_TOKEN_2");
    expect((s.map.get(STATUS_KEY) as StudioStatus).state).toBe("degraded");
    expect(s.started()).toBe(false);
  });

  it("restart: refused, row says why, no container started", async () => {
    const s = await studio("running");
    await expect(s.doObj.restartStudio()).rejects.toBeInstanceOf(LaunchRefusedError);
    expect(rowError(s.map)).toContain("mapped to CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(s.started()).toBe(false);
  });

  it("recycle: refused BEFORE its destroy — the running container is not killed", async () => {
    const s = await studio("running");
    const destroy = vi.spyOn(s.doObj, "destroy").mockResolvedValue(undefined);
    await expect(s.doObj.recycle({ repo: "fleetflare", role: "web-studio" })).rejects.toBeInstanceOf(LaunchRefusedError);
    expect(destroy).not.toHaveBeenCalled();
    expect(rowError(s.map)).toContain("mapped to CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(s.started()).toBe(false);
  });

  it("alarm-woken exec (no explicit op): refused with 409, never boots a container with no credentials", async () => {
    const s = await studio("running");
    const res = await s.doObj.containerFetch("http://localhost:3000/api/execute", { method: "POST", body: "{}" }, 3000);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("mapped to CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(s.started()).toBe(false);
  });

  it("attach (the pty door) is refused the same way", async () => {
    const s = await studio("running");
    const res = await s.doObj.fetch(new Request("http://x/ws/terminal"));
    expect(res.status).toBe(409);
    expect(s.started()).toBe(false);
  });
});
