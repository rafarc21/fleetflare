import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "../src/env";
import { StudioDO, SPAWN_TOKEN_KEY, constructorLaunch } from "../src/studio/do";
import { STATUS_KEY, type OpCtx } from "../src/studio/provision";
import { hashSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";

/**
 * Issue #306: `fleet recycle <id> --account mapped` on a studio whose repo was
 * remapped to a NEW slot relaunched on the OLD one. The constructor pins the
 * DO's in-memory start config (`envVars`/`envAccount`) to the row's last
 * `launchedAccount` (constructorLaunch, #292 r2); recycle() reassigned it only
 * inside recycleWithSync's post-destroy awaitReady closure, AFTER that
 * closure's own launchAccountOrRefuse awaits. A start landing in the
 * destroy -> assign window — an open `fleet attach` socket reconnecting — is
 * admitted by startRefusal (recycle holds the explicit allowance) and boots
 * the stale token; onStart then records the old account again.
 *
 * Same `Object.create(StudioDO.prototype)` fixture as
 * test/studio.recycle-mapped-rescue-do.test.ts, through the REAL
 * `StudioDO.recycle()` entry point.
 */
const ID = "fleetflare--web-studio";
const TOKEN = "spawn-token-fixture";
const OLD_OAUTH = "sk-ant-oat01-" + "o".repeat(40);
const NEW_OAUTH = "sk-ant-oat01-" + "n".repeat(40);
const OLD = "CLAUDE_CODE_OAUTH_TOKEN";
const NEW = "CLAUDE_CODE_OAUTH_TOKEN_2";
const ContainerProto = Object.getPrototypeOf(Sandbox.prototype) as {
  startAndWaitForPorts: (...args: unknown[]) => Promise<void>;
  start: (...args: unknown[]) => Promise<void>;
};

class Started extends Error {}

afterEach(() => {
  vi.restoreAllMocks();
});

/** fleetflare remapped to slot 2 (NEW); the studio last launched on slot 1 (OLD). */
const REMAPPED = {
  ...env, CLAUDE_CODE_OAUTH_TOKEN: OLD_OAUTH, CLAUDE_CODE_OAUTH_TOKEN_2: NEW_OAUTH,
  CLAUDE_ACCOUNT_BY_REPO: '{"fleetflare":2}', FLEET_RESCUE_REMOTE: undefined,
} as unknown as Env;

/** A live container whose every probe/rescue/harvest step succeeds. */
function healthyExec(command: string) {
  const m = /^timeout -k \d+ \d+ bash -c '([\s\S]*)'$/.exec(command);
  const cmd = m ? m[1].replace(/'\\''/g, "'") : command;
  if (cmd === "printf ok") return { success: true, exitCode: 0, stdout: "ok", stderr: "" };
  if (cmd.startsWith("mkdir -p")) return { success: true, exitCode: 0, stdout: "0\n1758067200", stderr: "" };
  return { success: true, exitCode: 0, stdout: "", stderr: "" };
}

async function studio() {
  const map = new Map<string, unknown>();
  const row = {
    id: ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: await hashSpawnToken(TOKEN), repoSlug: null,
    launchedAccount: OLD,
  } as StudioStatus;
  map.set(STATUS_KEY, row);
  map.set(SPAWN_TOKEN_KEY, TOKEN);
  const storage = {
    get: async (k: string) => map.get(k),
    put: async (k: string, v: unknown) => { map.set(k, v); },
    delete: async (k: string) => map.delete(k),
  };
  const container = {
    running: true,
    start: vi.fn(),
    monitor: vi.fn(() => new Promise(() => {})),
    getTcpPort: vi.fn(() => ({ fetch: async () => new Response("from container") })),
  };
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  const doObj = Object.create(StudioDO.prototype) as StudioDO;
  // What the constructor leaves in memory: the OLD launch, read back from the row.
  const launched = constructorLaunch(REMAPPED, ID, TOKEN, row);
  Object.assign(doObj, {
    ctx: { id: { name: ID }, storage, container, acceptWebSocket: noop, getWebSockets: () => [] },
    container,
    env: REMAPPED,
    logger,
    envVars: launched.envVars,
    envAccount: launched.envAccount,
    containerTimeouts: { instanceGetTimeoutMS: 30_000, portReadyTimeoutMS: 90_000, waitIntervalMS: 300 },
    activeOps: new Set<OpCtx>(),
    destroyInFlightCount: 0,
    getState: async () => ({ status: "healthy" }),
    state: { getState: async () => ({ status: "healthy" }) },
    execWithSessionToken: async (command: string) => healthyExec(command),
    exec: async (command: string) => healthyExec(command),
  });
  // Every container start the SDK would make: record what it boots with.
  const boots: { token: string | undefined; account: string | undefined }[] = [];
  const self = doObj as unknown as { envVars: Record<string, string>; envAccount: string | undefined };
  const capture = function () {
    boots.push({ token: self.envVars.CLAUDE_CODE_OAUTH_TOKEN, account: self.envAccount });
    return Promise.reject(new Started("started"));
  };
  vi.spyOn(ContainerProto, "startAndWaitForPorts").mockImplementation(capture);
  vi.spyOn(ContainerProto, "start").mockImplementation(capture);
  return { doObj, container, boots, launched };
}

describe("#306 recycle --account mapped vs a start racing the destroy -> assign window", () => {
  it("fixture: the constructor pinned the OLD slot", async () => {
    const s = await studio();
    expect(s.launched.envAccount).toBe(OLD);
    expect(s.launched.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe(OLD_OAUTH);
  });

  it("a start landing right after destroy() boots the NEW mapped slot, never the stale one", async () => {
    const s = await studio();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // destroy() kills the container; an open `fleet attach` socket reconnects
    // inside the same window and its pty open starts a fresh container.
    vi.spyOn(s.doObj, "destroy").mockImplementation(async () => {
      s.container.running = false;
      await s.doObj.startAndWaitForPorts().catch((err: unknown) => {
        if (!(err instanceof Started)) throw err;
      });
    });
    try {
      // `true` (--discard-unsynced): rescue is not what this test is about.
      await s.doObj.recycle({ repo: "fleetflare", role: "web-studio", forceMappedAccount: true }, true)
        .catch(() => undefined);
      // The racing start is the FIRST boot; recycle's own sbAwaitReady follows.
      expect(s.boots.length).toBeGreaterThanOrEqual(1);
      for (const boot of s.boots) {
        expect(boot.token).toBe(NEW_OAUTH);
        expect(boot.account).toBe(NEW);
      }
    } finally {
      errSpy.mockRestore();
    }
  });
});
