import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as authModule from "../src/studio/auth";
import worker from "../src/index";
import { getFlag } from "../src/state";
import { recordStudio } from "../src/studio/registry";
import { alertedKey, rearmKey, clearRearm } from "../src/tasks/watchdog";
import type { TaskRecord } from "../src/tasks/loop";
import type { Env } from "../src/env";

// scheduled()'s own doc comment calls it untested — "a scheduled export can
// no more be constructed under vitest-pool-workers than AgentDO can" — but
// scheduled() is a plain async function on the default export, not a DO: the
// same hand-built-binding technique test/telegram.webhook.test.ts already
// uses for env.AGENT works here too, unblocking real coverage of Carve-out
// C's dedupe wiring (the alertedKey read/set actually lives in this file,
// not in tasks/watchdog.ts's pure shouldAlert).

let realFetch: typeof globalThis.fetch;
let alerts: string[] = [];

function staleTask(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task_stale_1", agentId: "cto", project: "websites",
    thread: null, chatId: "100000001", liveMessageId: null,
    startedTs: 0, lastHeartbeat: 0, failedPolls: 0, shownMilestones: 0,
    ...over,
  };
}

function fakeAgentReturning(task: TaskRecord | null): Env["AGENT"] {
  return {
    idFromName: (n: string) => n,
    get: () => ({ fetch: async () => Response.json({ task }) }),
  } as unknown as Env["AGENT"];
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  alerts = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init: any) => {
    const body = JSON.parse(init.body as string);
    if (typeof body.text === "string" && /WATCHDOG/.test(body.text)) alerts.push(body.text);
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

describe("scheduled() watchdog (Carve-out C: alert dedupe)", () => {
  it("does not alert on the first stale minute, only the second", async () => {
    const fakeEnv = { ...env, AGENT: fakeAgentReturning(staleTask()) };

    await worker.scheduled({} as any, fakeEnv, {} as any);
    expect(alerts).toHaveLength(0);

    await worker.scheduled({} as any, fakeEnv, {} as any);
    expect(alerts).toHaveLength(1);
    expect(await getFlag(env.DB, alertedKey("task_stale_1"))).toBe("1");
  });

  it("does not re-alert on a third and fourth consecutive stale minute for the same task", async () => {
    // The exact bug: no backoff, no dedupe, re-sending forever.
    const fakeEnv = { ...env, AGENT: fakeAgentReturning(staleTask()) };

    await worker.scheduled({} as any, fakeEnv, {} as any); // attempts 1
    await worker.scheduled({} as any, fakeEnv, {} as any); // attempts 2 -> alerts
    await worker.scheduled({} as any, fakeEnv, {} as any); // attempts 3 -> would have alerted again
    await worker.scheduled({} as any, fakeEnv, {} as any); // attempts 4 -> would have alerted again

    expect(alerts).toHaveLength(1);
    // The re-arm counter itself is a separate concern (Carve-out C only
    // dedupes the alert) and keeps climbing every stale minute regardless.
    expect(await getFlag(env.DB, rearmKey("task_stale_1"))).toBe("4");
  });

  it("alerts again for a different taskId — not a global mute", async () => {
    const first = { ...env, AGENT: fakeAgentReturning(staleTask({ taskId: "task_a" })) };
    await worker.scheduled({} as any, first, {} as any);
    await worker.scheduled({} as any, first, {} as any);
    expect(alerts).toHaveLength(1);

    const second = { ...env, AGENT: fakeAgentReturning(staleTask({ taskId: "task_b" })) };
    await worker.scheduled({} as any, second, {} as any);
    await worker.scheduled({} as any, second, {} as any);
    expect(alerts).toHaveLength(2);
  });

  it("alerts again for the SAME taskId after it recovers and goes stale a second time", async () => {
    // Final-review residual: alertedKey used to be set, never cleared, so a
    // taskId that ever crossed the alert threshold once stayed muted for
    // every later episode too, even across a full recovery. clearRearm is
    // the real re-arm's recovery signal (src/agents/do.ts's
    // pollAndClearRearm calls it on every completed poll) — called directly
    // here since this harness's AGENT stub is fake and never polls for real.
    const fakeEnv = { ...env, AGENT: fakeAgentReturning(staleTask()) };

    // Episode 1: goes stale, alerts once.
    await worker.scheduled({} as any, fakeEnv, {} as any); // attempts 1
    await worker.scheduled({} as any, fakeEnv, {} as any); // attempts 2 -> alerts
    expect(alerts).toHaveLength(1);

    // Recovers.
    await clearRearm(env.DB, "task_stale_1", Date.now());

    // Episode 2: goes stale again. Must alert a second time, not stay muted.
    await worker.scheduled({} as any, fakeEnv, {} as any); // attempts 1 (fresh)
    await worker.scheduled({} as any, fakeEnv, {} as any); // attempts 2 -> alerts again
    expect(alerts).toHaveLength(2);
  });
});

// P4 §5's board mount. The board lives at `/studio/board/*` because the
// Cloudflare Access app is scoped to the `/studio` path (src/board/routes.ts's
// header) — which means its prefix sits INSIDE handleStudio's, and the order
// of the two branches in src/index.ts is what keeps them apart. Pinned here:
// a reordering would silently send every board request to handleStudio, which
// answers 404 for those paths.
describe("board mount", () => {
  it("routes /studio/board/* to the board handler, not the studio one", async () => {
    const spy = vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    try {
      const res = await worker.fetch(
        new Request("https://x/studio/board/tasks", { headers: { "Cf-Access-Jwt-Assertion": "t" } }),
        env as unknown as Env,
        {} as any,
      );
      // handleStudio would 404 this path (ROUTE_RE has no `tasks` action).
      // The board handler gets as far as minting an installation token, which
      // this test env has no key for — its own 502 shape, which is the proof
      // the request reached it.
      expect(res.status).toBe(502);
      expect(await res.text()).toContain("board upstream failed");
    } finally {
      spy.mockRestore();
    }
  });

  it("still gates the board on Access", async () => {
    const res = await worker.fetch(new Request("https://x/studio/board/tasks"), env as unknown as Env, {} as any);
    expect(res.status).toBe(401);
  });
});

// P4a-2's studio surface. `/fleet/tasks*` and `/fleet/spawn` share the
// Access-less `/fleet/` prefix, so index.ts's branch order is what keeps them
// apart — handleFleetSpawn 404s every path but its own, and would swallow the
// board verbs if it ran first. Pinned here for the same reason the board mount
// above is.
describe("fleet board mount", () => {
  it("routes /fleet/tasks* to the board's studio handler, not to the spawn handler", async () => {
    const res = await worker.fetch(new Request("https://x/fleet/tasks"), env as unknown as Env, {} as any);
    // handleFleetSpawn would 405 a GET (its own method check runs first); the
    // fleet board handler 401s an unauthenticated GET instead. That difference
    // IS the proof of which one received the request.
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });

  it("carries no Access gate at all — the spawn token is the whole credential", async () => {
    // An Access JWT is neither required nor sufficient here: the same request
    // with one still 401s, because the token header is what this route reads.
    const spy = vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    try {
      const res = await worker.fetch(
        new Request("https://x/fleet/tasks", { headers: { "Cf-Access-Jwt-Assertion": "t" } }),
        env as unknown as Env,
        {} as any,
      );
      expect(res.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves /fleet/spawn reaching the spawn handler unchanged", async () => {
    const res = await worker.fetch(new Request("https://x/fleet/spawn"), env as unknown as Env, {} as any);
    expect(res.status).toBe(405); // spawn checks method first
  });
});

// Issue #95: the minute cron also fans the stopped-but-running detector out,
// every 5th minute, to each STOPPED studio's own DO — `watchContainer` reads
// the runtime's container flag, never an exec.
describe("scheduled() stopped-container watch (issue #95)", () => {
  function fakeStudio(calls: string[]): Env["STUDIO"] {
    return {
      idFromName: (n: string) => n,
      get: (id: string) => ({ watchContainer: async () => { calls.push(id); } }),
    } as unknown as Env["STUDIO"];
  }
  const row = (id: string, state: string) => ({
    id, state, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
  });

  beforeEach(async () => {
    await recordStudio(env, row("acme-os--maestro", "stopped") as any);
    await recordStudio(env, row("acme-os--web-studio", "running") as any);
  });

  it("asks each stopped studio's DO on a watch minute, and only the stopped ones", async () => {
    const calls: string[] = [];
    const fakeEnv = { ...env, AGENT: fakeAgentReturning(null), STUDIO: fakeStudio(calls) };
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 24, 12, 40) } as any, fakeEnv, {} as any);
    expect(calls).toEqual(["acme-os--maestro"]);
  });

  it("asks nobody off a watch minute", async () => {
    const calls: string[] = [];
    const fakeEnv = { ...env, AGENT: fakeAgentReturning(null), STUDIO: fakeStudio(calls) };
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 24, 12, 41) } as any, fakeEnv, {} as any);
    expect(calls).toEqual([]);
  });
});

describe("scheduled() order (PR #109 review)", () => {
  it("runs the stale-task watchdog BEFORE the container watch, so a hung DO call cannot delay a re-arm", async () => {
    const order: string[] = [];
    const agent = {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (url: string) => {
          if (url.endsWith("/rearm")) { order.push("rearm"); return new Response("ok"); }
          return Response.json({ task: staleTask() });
        },
      }),
    } as unknown as Env["AGENT"];
    const studio = {
      idFromName: (n: string) => n,
      get: () => ({ watchContainer: async () => { order.push("watch"); } }),
    } as unknown as Env["STUDIO"];
    await recordStudio(env, {
      id: "acme-os--maestro", state: "stopped", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    });
    await worker.scheduled(
      { scheduledTime: Date.UTC(2026, 8, 24, 12, 40) } as any, { ...env, AGENT: agent, STUDIO: studio }, {} as any,
    );
    expect(order).toEqual(["rearm", "watch"]);
  });
});
