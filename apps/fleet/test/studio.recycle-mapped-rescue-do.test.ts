import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "../src/env";
import { StudioDO, SPAWN_TOKEN_KEY, RECYCLE_REFUSED_PREFIX } from "../src/studio/do";
import { RESCUE_FAILED_PREFIX } from "../src/studio/rescue";
import { STATUS_KEY, type OpCtx } from "../src/studio/provision";
import { hashSpawnToken } from "../src/studio/org";
import type { StudioState, StudioStatus } from "../src/studio/types";

/**
 * Issue #148 (follow-up from #135 review). `StudioDO.recycle()`'s own
 * `cfg.forceMappedAccount` handling (the `--account mapped` wiring, board
 * issue #131 ask 2) sits BEFORE the same `recycleWithSync(...)` call every
 * ordinary recycle falls through to — the rescue-push-before-destroy step
 * lives entirely inside that shared call, not in recycle()'s own wrapper.
 * test/studio.recycle-guard.test.ts already covers the rescue-first guarantee
 * thoroughly, but every one of its tests calls the EXPORTED `recycleWithSync`
 * directly, never `StudioDO.recycle()` itself — so a bug introduced
 * specifically in recycle()'s own ~14-line wrapper (e.g. a future edit that
 * folds `cfg.forceMappedAccount` into the `discardUnsynced` it forwards,
 * something like `recycleWithSync(..., discardUnsynced || cfg.forceMappedAccount)`)
 * would sail through every existing test green.
 *
 * This test goes through the REAL `StudioDO.recycle()` entry point — same
 * `Object.create(StudioDO.prototype)` fixture technique as
 * test/studio.account-gate-do.test.ts — with `cfg.forceMappedAccount: true`
 * (`fleet recycle <id> --account mapped`) and NO `--discard-unsynced`, against
 * a container whose rescue-push CONFIRMS a loss. It must refuse exactly like
 * an ordinary recycle would: `destroy()` never called, the error carries
 * RECYCLE_REFUSED_PREFIX and names the failed worktree.
 */
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

/** fleetflare mapped to its own slot 1 (CLAUDE_CODE_OAUTH_TOKEN), secret SET
 *  — a launchable mapped account, unlike account-gate-do.test.ts's own
 *  MAPPED_MISSING fixture (slot 2, secret unset). This is the "launchable,
 *  forced onto the mapped slot" case #131 ask 2 exists for. */
const MAPPED_LAUNCHABLE = {
  ...env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH, CLAUDE_ACCOUNT_BY_REPO: '{"fleetflare":1}',
  FLEET_RESCUE_REMOTE: undefined,
} as unknown as Env;

/** Strips sandbox-api.ts's own `withKillDeadline` wrapper
 *  (`timeout -k <grace> <secs> bash -c '<cmd>'`) back to the raw command, so
 *  fakes here can match against the same cmd strings
 *  test/studio.recycle-guard.test.ts's own `liveDeps` fixture already does —
 *  that file's fixtures feed `recycleWithSync` directly (no wrapper); this one
 *  goes through the real `sbExec` adapter (do.ts's `syncDeps("rescue")`),
 *  which wraps every command before it ever reaches `execWithSessionToken`. */
function unwrapKillDeadline(command: string): string {
  const m = /^timeout -k \d+ \d+ bash -c '([\s\S]*)'$/.exec(command);
  if (!m) return command;
  return m[1].replace(/'\\''/g, "'");
}

/** A LIVE container whose rescue-push CONFIRMS a loss — same shape as
 *  test/studio.recycle-guard.test.ts's own `liveDeps`, adapted to the real
 *  `execWithSessionToken` signature every "rescue"-class sbExec call lands on
 *  (see do.ts's `syncDeps("rescue")`: EXEC_CLASSES.rescue pins a sessionId). */
function rescueFailingExecWithSessionToken(execCalls: string[]) {
  return async (command: string, _sessionId: string) => {
    const cmd = unwrapKillDeadline(command);
    execCalls.push(cmd);
    if (cmd === "printf ok") return { success: true, exitCode: 0, stdout: "ok", stderr: "" };
    if (cmd.startsWith("mkdir -p")) return { success: true, exitCode: 0, stdout: "0\n1758067200", stderr: "" };
    if (cmd.includes("status --porcelain")) {
      return { success: true, exitCode: 0, stdout: `${RESCUE_FAILED_PREFIX} agent-a1 push`, stderr: "" };
    }
    return { success: true, exitCode: 0, stdout: "", stderr: "" };
  };
}

async function studio(state: StudioState, execWithSessionToken: ReturnType<typeof rescueFailingExecWithSessionToken>) {
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
    env: MAPPED_LAUNCHABLE,
    logger,
    containerTimeouts: { instanceGetTimeoutMS: 30_000, portReadyTimeoutMS: 90_000, waitIntervalMS: 300 },
    activeOps: new Set<OpCtx>(),
    destroyInFlightCount: 0,
    getState: async () => ({ status: "stopped" }),
    state: { getState: async () => ({ status: "healthy" }) },
    // The real `sbExec` adapter (sandbox-api.ts) calls these directly on
    // `this` (a real StudioDO IS a Sandbox) — faked here the same way
    // test/studio.account-gate-do.test.ts fakes `container` rather than the
    // SDK's own `Sandbox` methods.
    execWithSessionToken,
    exec: vi.fn(async () => { throw new Error("unexpected default-session exec — rescue-class calls must use execWithSessionToken"); }),
  });
  const baseStart = vi.spyOn(ContainerProto, "startAndWaitForPorts").mockRejectedValue(new Started("started"));
  const baseStartOnly = vi.spyOn(ContainerProto, "start").mockRejectedValue(new Started("started"));
  const started = () =>
    baseStart.mock.calls.length > 0 || baseStartOnly.mock.calls.length > 0 || container.start.mock.calls.length > 0;
  return { doObj, map, started };
}

describe("#148 recycle --account mapped keeps rescue-first through StudioDO.recycle() itself", () => {
  it("forceMappedAccount + a CONFIRMED rescue-push failure, no --discard-unsynced: refuses, destroy NEVER called", async () => {
    const execCalls: string[] = [];
    const s = await studio("running", rescueFailingExecWithSessionToken(execCalls));
    const destroy = vi.spyOn(s.doObj, "destroy").mockResolvedValue(undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const message = await s.doObj.recycle({ repo: "fleetflare", role: "web-studio", forceMappedAccount: true }, false)
        .then(() => "", (err: Error) => err.message);
      expect(message.startsWith(RECYCLE_REFUSED_PREFIX)).toBe(true);
      expect(message).toContain("agent-a1");
      expect(message).toContain(`fleet recycle ${ID} --discard-unsynced`);
      expect(destroy).not.toHaveBeenCalled();
      expect(s.started()).toBe(false);
      // The mapped-account clear still ran (cfg.forceMappedAccount's own
      // job) — this refusal is rescue's, not the mapped-account gate's.
      expect(execCalls).toContain("printf ok");
    } finally {
      errSpy.mockRestore();
    }
  });
});
