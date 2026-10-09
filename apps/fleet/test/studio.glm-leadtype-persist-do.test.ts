// apps/fleet/test/studio.glm-leadtype-persist-do.test.ts
//
// Board issue #300 — END-TO-END proof. Before this fix, a glm-lead
// studio's FIRST-EVER provision launched the container with the correct
// GLM env vars (resolveLeadType's own cfg.leadType fallback), but never
// persisted `leadType` onto the row ensureSpawnToken writes — so the row
// `fleet ls`/the registry/the llm/anthropic-route.ts gate all read back
// disagreed with what the container actually booted as, and every real
// call to /fleet/llm/anthropic/v1/messages 403'd forever.
//
// Same real-DO-path technique as test/studio.account-gate-do.test.ts (used
// for board issue #284's own MINOR 3 fix): the REAL StudioDO prototype
// methods run against a fake `this` (fake in-memory storage Map, fake
// container), so this is NOT a hand-constructed StudioStatus fixture with
// leadType already set — the row is whatever the real provision path
// actually wrote. Two independent read-backs confirm it: the DO's own
// storage, and the REAL D1 registry row recordStudioFn wrote (via
// registry.ts's real listStudios, reading the real env.DB this DO's own
// env shares). Then the real, DO-minted spawn token is handed to the real
// handleFleetAnthropicMessages route, closing the loop the issue
// describes.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "../src/env";
import { StudioDO, SPAWN_TOKEN_KEY } from "../src/studio/do";
import { STATUS_KEY, type OpCtx } from "../src/studio/provision";
import { listStudios } from "../src/studio/registry";
import { handleFleetAnthropicMessages, ANTHROPIC_MESSAGES_PATH } from "../src/llm/anthropic-route";
import type { StudioStatus } from "../src/studio/types";

// A repo/role pair unique to this file, so its D1 registry row never
// collides with any other test file's own fixtures under the same key.
const REPO = "fleet300-glm-e2e";
const ROLE = "web-studio";
const ID = `${REPO}--${ROLE}`;

const FAKE_OAUTH = "sk-ant-oat01-" + "a".repeat(40);
const ContainerProto = Object.getPrototypeOf(Sandbox.prototype) as {
  startAndWaitForPorts: (...args: unknown[]) => Promise<void>;
  start: (...args: unknown[]) => Promise<void>;
};

/** Thrown by the pinned SDK's own Container start path, mocked below — its
 *  surfacing here is what proves this call reached the real container-start
 *  step rather than being refused by an earlier gate. */
class Started extends Error {}

// FLEET_JUNIOR on (required for a glm-lead studio to pass #284's own junior
// gate) and a fake AI binding (required for llm/anthropic-route.ts's own
// feature-flag check, and to let the full round trip actually run through
// to a 200 rather than 404).
const run = vi.fn(async () => ({
  choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
}));
const JUNIOR_ON = {
  ...env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH, FLEET_JUNIOR: "on", AI: { run },
} as unknown as Env;

function freshStudioFixture(doEnv: Env) {
  // Deliberately NOT seeded with a STATUS_KEY row — this studio has never
  // been provisioned before. `test/studio.account-gate-do.test.ts`'s own
  // `studio()` helper always pre-seeds one; this fixture is the genuinely
  // fresh-row case the issue says existing tests never exercised.
  const map = new Map<string, unknown>();
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
    env: doEnv,
    logger,
    containerTimeouts: { instanceGetTimeoutMS: 30_000, portReadyTimeoutMS: 90_000, waitIntervalMS: 300 },
    activeOps: new Set<OpCtx>(),
    destroyInFlightCount: 0,
    getState: async () => ({ status: "stopped" as const }),
    state: { getState: async () => ({ status: "healthy" }) },
  });
  return { doObj, map };
}

function fakeCtx(): ExecutionContext {
  const tasks: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => { tasks.push(p); p.catch(() => {}); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state WHERE key LIKE ?").bind(`%${ID}%`).run();
});

describe("#300 end-to-end: a brand-new glm-lead provision persists leadType and the route gate passes", () => {
  it("D1 row has leadType glm, and the studio's real spawn token passes the anthropic-route leadType gate", async () => {
    const { doObj, map } = freshStudioFixture(JUNIOR_ON);
    // Same technique as the #284 junior-gate tests: the pinned SDK's own
    // container start is mocked to reject, so a provision call that
    // reaches it (rather than being refused by an earlier gate) throws
    // `Started` — proof every gate above the container start was passed.
    vi.spyOn(ContainerProto, "startAndWaitForPorts").mockRejectedValue(new Started("started"));
    vi.spyOn(ContainerProto, "start").mockRejectedValue(new Started("started"));

    const err: unknown = await doObj.provision({ repo: REPO, role: ROLE, leadType: "glm" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Started);

    // Independent read-back #1: the DO's OWN storage row, as the real
    // provision path left it — not a hand-constructed StudioStatus.
    const storedRow = map.get(STATUS_KEY) as StudioStatus | undefined;
    expect(storedRow?.leadType).toBe("glm");

    // Independent read-back #2: the REAL D1 registry row recordStudioFn
    // wrote, read back through registry.ts's own real listStudios — not a
    // fixture asserting what SHOULD be there.
    const rows = await listStudios(env);
    const d1Row = rows.find((r) => r.id === ID);
    expect(d1Row?.leadType).toBe("glm");

    // Full end-to-end proof: the REAL spawn token this provision call
    // minted (ensureSpawnToken -> loadOrMintSpawnToken), presented to the
    // REAL route, passes the leadType gate and gets a real 200 — not a
    // 403.
    const token = map.get(SPAWN_TOKEN_KEY) as string;
    expect(typeof token).toBe("string");
    const req = new Request(`https://w${ANTHROPIC_MESSAGES_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await handleFleetAnthropicMessages(req, JUNIOR_ON, fakeCtx(), () => listStudios(env));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
  });
});
