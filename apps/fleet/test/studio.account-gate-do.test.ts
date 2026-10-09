import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "../src/env";
import { StudioDO, SPAWN_TOKEN_KEY, LaunchRefusedError, LAUNCH_REFUSED_PREFIX } from "../src/studio/do";
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

/**
 * Issue #284: the same real-DO-path technique, for the OTHER pre-container
 * gate a glm-lead studio must pass — FLEET_JUNIOR. `env` here deliberately
 * carries no CLAUDE_ACCOUNT_BY_REPO at all: irrelevant to a glm lead (it
 * never reads a Claude account — see do.ts's launchFields "glm" branch), and
 * its presence would risk this test accidentally exercising the #271 gate
 * instead of the one under test here.
 */
const JUNIOR_OFF = { ...env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH } as unknown as Env;
const JUNIOR_ON = { ...env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH, FLEET_JUNIOR: "on" } as unknown as Env;

async function studio(
  state: StudioState, opts: { env?: Env; leadType?: "claude" | "glm" } = {},
) {
  const map = new Map<string, unknown>();
  map.set(STATUS_KEY, {
    id: ID, state, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: await hashSpawnToken(TOKEN), repoSlug: null,
    ...(opts.leadType ? { leadType: opts.leadType } : {}),
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
    env: opts.env ?? MAPPED_MISSING,
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
    const err: unknown = await s.doObj.provision({ repo: "fleetflare", role: "web-studio" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchRefusedError);
    // Issue #217 review: pinned directly at the source, independent of the
    // route layer — routes.ts's launchOrStartRefusalResponse recognises this
    // refusal ACROSS the RPC boundary purely by this message prefix (a class
    // never survives Workers RPC, only `.message` does), so the prefix must
    // genuinely be on the message the real DO method throws, not just
    // asserted by a test fixture that types it in independently.
    expect((err as Error).message.startsWith(LAUNCH_REFUSED_PREFIX)).toBe(true);
    expect(rowError(s.map)).toContain("mapped to CLAUDE_CODE_OAUTH_TOKEN_2");
    expect((s.map.get(STATUS_KEY) as StudioStatus).state).toBe("degraded");
    expect(s.started()).toBe(false);
  });

  it("restart: refused, row says why, no container started", async () => {
    const s = await studio("running");
    const err: unknown = await s.doObj.restartStudio().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchRefusedError);
    expect((err as Error).message.startsWith(LAUNCH_REFUSED_PREFIX)).toBe(true);
    expect(rowError(s.map)).toContain("mapped to CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(s.started()).toBe(false);
  });

  it("recycle: refused BEFORE its destroy — the running container is not killed", async () => {
    const s = await studio("running");
    const destroy = vi.spyOn(s.doObj, "destroy").mockResolvedValue(undefined);
    const err: unknown = await s.doObj.recycle({ repo: "fleetflare", role: "web-studio" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchRefusedError);
    expect((err as Error).message.startsWith(LAUNCH_REFUSED_PREFIX)).toBe(true);
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

// ---------------------------------------------------------------------------
// Issue #284: a glm-lead studio boots with ANTHROPIC_BASE_URL pointed at
// llm/anthropic-route.ts's handleFleetAnthropicMessages, which 404s on every
// call while FLEET_JUNIOR is off for this repo (or narrowed out via
// JUNIOR_REPOS) — the same gate.ts juniorEnabled() the /fleet/junior route
// itself reads. Before this fix, provisionUngated/restartUngated/recycle's
// `leadType === "glm"` branches skipped the Claude-account gate entirely (by
// design — #249) but ran no OTHER gate in its place, so a glm-lead studio
// came up looking healthy with a lead that cannot make a single model call.
// Refused here instead, before any container touch, same shape as #271's own
// gate right above: the row goes `degraded` with the reason, then throws —
// reusing LaunchRefusedError/LAUNCH_REFUSED_PREFIX (do.ts), the one refusal
// shape that survives the Worker->DO RPC boundary (see that class's own doc
// comment), so routes.ts/spawn.ts's existing launchOrStartRefusalResponse
// recognises this refusal exactly like any other, with no new wiring.
// ---------------------------------------------------------------------------
describe("#284 junior gate — a glm-lead studio refuses while FLEET_JUNIOR is off, through the real DO paths", () => {
  it("provision: refused, row says why, no container started", async () => {
    const s = await studio("provisioning", { env: JUNIOR_OFF, leadType: "glm" });
    const err: unknown = await s.doObj.provision({ repo: "fleetflare", role: "web-studio" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchRefusedError);
    expect((err as Error).message.startsWith(LAUNCH_REFUSED_PREFIX)).toBe(true);
    expect(rowError(s.map)).toContain("FLEET_JUNIOR");
    expect((s.map.get(STATUS_KEY) as StudioStatus).state).toBe("degraded");
    expect(s.started()).toBe(false);
  });

  it("restart: refused, row says why, no container started", async () => {
    const s = await studio("running", { env: JUNIOR_OFF, leadType: "glm" });
    const err: unknown = await s.doObj.restartStudio().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchRefusedError);
    expect((err as Error).message.startsWith(LAUNCH_REFUSED_PREFIX)).toBe(true);
    expect(rowError(s.map)).toContain("FLEET_JUNIOR");
    expect(s.started()).toBe(false);
  });

  it("recycle: refused BEFORE its destroy — the running container is not killed", async () => {
    const s = await studio("running", { env: JUNIOR_OFF, leadType: "glm" });
    const destroy = vi.spyOn(s.doObj, "destroy").mockResolvedValue(undefined);
    const err: unknown = await s.doObj.recycle({ repo: "fleetflare", role: "web-studio" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchRefusedError);
    expect((err as Error).message.startsWith(LAUNCH_REFUSED_PREFIX)).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
    expect(rowError(s.map)).toContain("FLEET_JUNIOR");
    expect(s.started()).toBe(false);
  });

  it("a claude-lead studio under the same FLEET_JUNIOR-off env is unaffected — the gate is glm-only (regression)", async () => {
    const s = await studio("provisioning", { env: JUNIOR_OFF });
    const err: unknown = await s.doObj.provision({ repo: "fleetflare", role: "web-studio" }).catch((e: unknown) => e);
    // No Claude-account gate to refuse on here either (JUNIOR_OFF carries a
    // real, set CLAUDE_CODE_OAUTH_TOKEN and no CLAUDE_ACCOUNT_BY_REPO), so
    // this reaches the real container start, which the fixture's own mocked
    // SDK rejects with `Started` — proof neither gate fired.
    expect(err).toBeInstanceOf(Started);
    expect(s.started()).toBe(true);
  });

  it("glm-lead studio, FLEET_JUNIOR on: not refused — reaches the real container start (#249 bypass regression)", async () => {
    const s = await studio("provisioning", { env: JUNIOR_ON, leadType: "glm" });
    const err: unknown = await s.doObj.provision({ repo: "fleetflare", role: "web-studio" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Started);
    expect(s.started()).toBe(true);
  });
});
