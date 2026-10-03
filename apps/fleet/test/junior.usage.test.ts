// apps/fleet/test/junior.usage.test.ts
//
// Issue #218: usage counting for /fleet/junior — one row per call (success
// and failure both), aggregated by studio for the GET /studio/junior/usage
// stats route. Same posture as junior.ratelimit.test.ts: real D1 via
// `cloudflare:test`'s `env.DB`, no mocking of the database.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { insertJuniorUsage, aggregateJuniorUsage, handleJuniorUsageStats } from "../src/junior/usage";
import { handleFleetJunior } from "../src/junior/route";
import { recordJuniorAuthorization } from "../src/junior/authz";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import type { BoardApi } from "../src/board/board";
import { studioLabel, type BoardTask } from "../src/board/types";

const REPO = "acme-org/websites";
const ME = "websites--web-studio";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  await env.DB.prepare("DELETE FROM junior_usage_log").run();
});

describe("insertJuniorUsage + aggregateJuniorUsage", () => {
  it("round-trips a single row", async () => {
    await insertJuniorUsage(env.DB, {
      id: "u1", ts: 100, studioId: ME, mode: "edit", model: "@cf/zai-org/glm-5.3",
      inputTokens: 10, outputTokens: 20, ok: true,
    });
    const agg = await aggregateJuniorUsage(env.DB, 0);
    expect(agg.rows).toEqual([{ studioId: ME, calls: 1, inputTokens: 10, outputTokens: 20 }]);
    expect(agg.totals).toEqual({ calls: 1, inputTokens: 10, outputTokens: 20 });
  });

  it("groups by studio id across multiple studios and multiple rows", async () => {
    const OTHER = "websites--release-studio";
    await insertJuniorUsage(env.DB, { id: "u1", ts: 100, studioId: ME, mode: "edit", model: "m", inputTokens: 10, outputTokens: 20, ok: true });
    await insertJuniorUsage(env.DB, { id: "u2", ts: 200, studioId: ME, mode: "text", model: "m", inputTokens: 5, outputTokens: 7, ok: false });
    await insertJuniorUsage(env.DB, { id: "u3", ts: 300, studioId: OTHER, mode: "edit", model: "m", inputTokens: 1, outputTokens: 2, ok: true });

    const agg = await aggregateJuniorUsage(env.DB, 0);
    expect(agg.rows).toEqual([
      { studioId: ME, calls: 2, inputTokens: 15, outputTokens: 27 },
      { studioId: OTHER, calls: 1, inputTokens: 1, outputTokens: 2 },
    ]);
    expect(agg.totals).toEqual({ calls: 3, inputTokens: 16, outputTokens: 29 });
  });

  it("`since` excludes rows older than the cutoff", async () => {
    await insertJuniorUsage(env.DB, { id: "u1", ts: 100, studioId: ME, mode: "edit", model: "m", inputTokens: 10, outputTokens: 20, ok: true });
    await insertJuniorUsage(env.DB, { id: "u2", ts: 5000, studioId: ME, mode: "edit", model: "m", inputTokens: 1, outputTokens: 1, ok: true });

    const agg = await aggregateJuniorUsage(env.DB, 1000);
    expect(agg.rows).toEqual([{ studioId: ME, calls: 1, inputTokens: 1, outputTokens: 1 }]);
    expect(agg.totals).toEqual({ calls: 1, inputTokens: 1, outputTokens: 1 });
  });
});

// handleFleetJunior route-level: a usage row lands after both a successful
// and a failed ai.run() call, carrying the right mode/model/ok/tokens.
const boardTask = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  number: 7, url: "https://github.com/acme-org/websites/issues/7", title: "t", body: "b",
  state: "working", labels: ["working", studioLabel(ME), "junior"], assignee: ME, milestone: null,
  open: true, updatedAt: "2026-09-28T00:00:00Z", ...overrides,
});
function board(tasks: BoardTask[] = [boardTask()]): BoardApi {
  const listIssues = vi.fn(async () => tasks);
  return { listIssues } as unknown as BoardApi;
}
function row(id: string, hash: string, repoSlug: string | null = REPO): StudioStatus {
  return { id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug };
}
async function setup(aiResult: unknown) {
  const token = mintSpawnToken();
  const rows = async () => [row(ME, await hashSpawnToken(token))];
  const run = vi.fn(async () => {
    if (aiResult instanceof Error) throw aiResult;
    return aiResult;
  });
  const e = { ...env, AGENT_REPO: REPO, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;
  await recordJuniorAuthorization(e.DB, REPO, 7, ME, Date.now());
  return { token, rows, run, e };
}
const good = { model: "@cf/zai-org/glm-5.3", messages: [{ role: "user", content: "hi" }], max_tokens: 100 };
const req = (token: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://w/fleet/junior", {
    method: "POST",
    headers: { [SPAWN_TOKEN_HEADER]: token, ...headers },
    body: JSON.stringify(body),
  });

describe("handleFleetJunior — usage recording (#218)", () => {
  it("records ok=1 with real token counts after a successful ai.run() call", async () => {
    const { token, rows, e } = await setup({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const r = await handleFleetJunior(req(token, good), e, board(), rows);
    await r.text(); // drain so the detached IIFE's insert has run

    const logged = await env.DB.prepare("SELECT * FROM junior_usage_log").all();
    expect(logged.results).toHaveLength(1);
    const logRow = logged.results[0] as Record<string, unknown>;
    expect(logRow.studio_id).toBe(ME);
    expect(logRow.ok).toBe(1);
    expect(logRow.input_tokens).toBe(3);
    expect(logRow.output_tokens).toBe(4);
    expect(logRow.model).toBe(good.model);
    expect(logRow.mode).toBe("edit"); // header omitted -> defaults to "edit"
  });

  it("records ok=0 with zero tokens after a failed ai.run() call", async () => {
    const { token, rows, e } = await setup(new Error("boom"));
    const r = await handleFleetJunior(req(token, good), e, board(), rows);
    await r.text();

    const logged = await env.DB.prepare("SELECT * FROM junior_usage_log").all();
    expect(logged.results).toHaveLength(1);
    const logRow = logged.results[0] as Record<string, unknown>;
    expect(logRow.ok).toBe(0);
    expect(logRow.input_tokens).toBe(0);
    expect(logRow.output_tokens).toBe(0);
  });

  it("records the X-Junior-Mode header value in the row's mode column", async () => {
    const { token, rows, e } = await setup({ response: "r" });
    const r = await handleFleetJunior(req(token, good, { "X-Junior-Mode": "text" }), e, board(), rows);
    await r.text();

    const logged = await env.DB.prepare("SELECT mode FROM junior_usage_log").all();
    expect((logged.results[0] as Record<string, unknown>).mode).toBe("text");
  });

  it("an invalid X-Junior-Mode header value falls back to the edit default", async () => {
    const { token, rows, e } = await setup({ response: "r" });
    const r = await handleFleetJunior(req(token, good, { "X-Junior-Mode": "bogus" }), e, board(), rows);
    await r.text();

    const logged = await env.DB.prepare("SELECT mode FROM junior_usage_log").all();
    expect((logged.results[0] as Record<string, unknown>).mode).toBe("edit");
  });
});

describe("handleJuniorUsageStats", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("401/403 when Access auth fails — same pattern as every other /studio/* route", async () => {
    const failure = new Response("forbidden", { status: 403 });
    const verifyAccessFn = vi.fn(async () => failure);
    const r = await handleJuniorUsageStats(new Request("https://w/studio/junior/usage"), env as unknown as Env, verifyAccessFn);
    expect(r.status).toBe(403);
    expect(verifyAccessFn).toHaveBeenCalled();
  });

  it("200 with {rows, totals} when authenticated, and ?since= filters correctly", async () => {
    await insertJuniorUsage(env.DB, { id: "u1", ts: 100, studioId: ME, mode: "edit", model: "m", inputTokens: 10, outputTokens: 20, ok: true });
    await insertJuniorUsage(env.DB, { id: "u2", ts: 5000, studioId: ME, mode: "edit", model: "m", inputTokens: 1, outputTokens: 1, ok: true });
    const verifyAccessFn = vi.fn(async () => null);

    const all = await handleJuniorUsageStats(new Request("https://w/studio/junior/usage"), env as unknown as Env, verifyAccessFn);
    expect(all.status).toBe(200);
    const allBody = await all.json<{ rows: unknown[]; totals: { calls: number } }>();
    expect(allBody.totals.calls).toBe(2);

    const since = await handleJuniorUsageStats(
      new Request("https://w/studio/junior/usage?since=1000"), env as unknown as Env, verifyAccessFn,
    );
    const sinceBody = await since.json<{ rows: unknown[]; totals: { calls: number } }>();
    expect(sinceBody.totals.calls).toBe(1);
  });

  it("verifyAccess is stubbed via the module spy too, matching the house pattern", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    const r = await handleJuniorUsageStats(new Request("https://w/studio/junior/usage"), env as unknown as Env);
    expect(r.status).toBe(200);
  });
});
