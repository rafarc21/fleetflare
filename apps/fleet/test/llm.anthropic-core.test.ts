// apps/fleet/test/llm.anthropic-core.test.ts
// HTTP/auth/framing layer for #249's GLM-led studio route — the non-streaming
// half (auth/path/method/size gates, spend controls, non-streaming round
// trip), split out of test/llm.anthropic-route.test.ts per sweep-45 F6
// (#919). Same cloudflare:test convention as test/junior.route.test.ts
// (spawn-token resolution needs a real registry row + a real StudioStatus
// shape) — every actual translation direction is covered without env/HTTP
// mocking in test/bun/llm-translate-request.test.ts and
// test/bun/llm-translate-stream.test.ts; this file only proves the wiring:
// auth, path/method/size gates, and that env.AI.run is called with (and
// responds through) the translated shapes.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  handleFleetAnthropicMessages, ANTHROPIC_MESSAGES_PATH, ANTHROPIC_BODY_CAP,
} from "../src/llm/anthropic-route";
import { GLM_LEAD_MODEL, GLM_MIN_MAX_TOKENS } from "../src/llm/translate";
import { OSS_LEAD_CONTINUE_RULE } from "../src/llm/lead-rule";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import { fakeCtx } from "./helpers/fake-ctx";
import { lockedUsageLogDb } from "./helpers/d1-locked";

const ME = "acme-org--web-studio";
// Maestro review round 1, MAJOR 2: every row here carries `leadType: "glm"`
// by default — the route now refuses any studio whose own registry row
// isn't glm-led, so a fixture that omitted this would 403 before reaching
// whatever the test actually means to exercise. Tests that specifically
// cover the leadType gate build their OWN row with a different value.
function row(id: string, hash: string, leadType: "claude" | "glm" | undefined = "glm"): StudioStatus {
  return { id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug: "acme-org/websites",
    ...(leadType === undefined ? {} : { leadType }) };
}
// fakeCtx: shared queue-drain fake — helpers/fake-ctx.ts (sweep 33 F2, #746)
let ctx: ReturnType<typeof fakeCtx>;

async function usageRows() {
  const res = await env.DB.prepare(
    "SELECT studio_id AS studioId, mode, model, input_tokens AS inputTokens, output_tokens AS outputTokens, ok, error, duration_ms AS durationMs, attempts FROM junior_usage_log ORDER BY ts ASC",
  ).all<{ studioId: string; mode: string; model: string; inputTokens: number; outputTokens: number; ok: number; error: string | null; durationMs: number | null; attempts: number | null }>();
  return res.results ?? [];
}

// Issue #335: every fixture env retries with a 1ms backoff base, so a test
// whose env.AI.run always throws a retryable error stays fast.
const FAST_RETRY = { LEAD_AI_RETRY_BASE_MS: "1" } as Partial<Env>;

async function setup(
  aiResult: unknown = { choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  envOverrides: Partial<Env> = {},
  leadType: "claude" | "glm" | undefined = "glm",
) {
  const token = mintSpawnToken();
  const rows = async () => [row(ME, await hashSpawnToken(token), leadType)];
  const run = vi.fn(async () => aiResult);
  const e = { ...env, FLEET_JUNIOR: "on", AI: { run }, ...FAST_RETRY, ...envOverrides } as unknown as Env;
  return { token, rows, run, e };
}

const good = { model: "claude-opus-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

function req(opts: { token?: string | null; apiKey?: string; body?: unknown; path?: string; method?: string }) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  const method = opts.method ?? "POST";
  return new Request(`https://w${opts.path ?? ANTHROPIC_MESSAGES_PATH}`, {
    method, headers,
    body: method === "POST" ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? good)) : undefined,
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  await env.DB.prepare("DELETE FROM junior_usage_log").run();
  ctx = fakeCtx();
});

describe("handleFleetAnthropicMessages — gates", () => {
  it("404 on the wrong path", async () => {
    const { token, rows, e } = await setup();
    expect((await handleFleetAnthropicMessages(req({ token, path: "/fleet/llm/anthropic/v1/other" }), e, ctx, rows)).status).toBe(404);
  });
  it("404 when the AI binding is missing", async () => {
    const { token, rows, e } = await setup();
    const withoutAi = { ...e, AI: undefined } as unknown as Env;
    expect((await handleFleetAnthropicMessages(req({ token }), withoutAi, ctx, rows)).status).toBe(404);
  });
  it("405 on GET", async () => {
    const { token, rows, e } = await setup();
    expect((await handleFleetAnthropicMessages(req({ token, method: "GET" }), e, ctx, rows)).status).toBe(405);
  });
  it("401 with no token at all", async () => {
    const { rows, e } = await setup();
    expect((await handleFleetAnthropicMessages(req({}), e, ctx, rows)).status).toBe(401);
  });
  it("401 with a well-shaped but unknown token", async () => {
    const { rows, e } = await setup();
    expect((await handleFleetAnthropicMessages(req({ token: mintSpawnToken() }), e, ctx, rows)).status).toBe(401);
  });
  it("401 with a malformed Authorization header (not 'Bearer <token>')", async () => {
    const { rows, e } = await setup();
    const r = new Request(`https://w${ANTHROPIC_MESSAGES_PATH}`, {
      method: "POST", headers: { authorization: "token abc123" }, body: JSON.stringify(good),
    });
    expect((await handleFleetAnthropicMessages(r, e, ctx, rows)).status).toBe(401);
  });
  it("a valid token via x-api-key authenticates exactly like Authorization: Bearer", async () => {
    const { token, rows, e, run } = await setup();
    const r = await handleFleetAnthropicMessages(req({ apiKey: token }), e, ctx, rows);
    expect(r.status).toBe(200);
    expect(run).toHaveBeenCalled();
  });
  it("413 when Content-Length already declares over the cap — no token check, no AI call", async () => {
    const { e, run } = await setup();
    const rows = vi.fn(async () => []);
    const r = new Request(`https://w${ANTHROPIC_MESSAGES_PATH}`, {
      method: "POST", headers: { "content-length": String(ANTHROPIC_BODY_CAP + 1) }, body: JSON.stringify(good),
    });
    expect((await handleFleetAnthropicMessages(r, e, ctx, rows)).status).toBe(413);
    expect(rows).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it("400 on bad JSON", async () => {
    const { token, rows, e } = await setup();
    expect((await handleFleetAnthropicMessages(req({ token, body: "{nope" }), e, ctx, rows)).status).toBe(400);
  });
  it("400 when messages is missing or empty", async () => {
    const { token, rows, e } = await setup();
    expect((await handleFleetAnthropicMessages(req({ token, body: { ...good, messages: [] } }), e, ctx, rows)).status).toBe(400);
    expect((await handleFleetAnthropicMessages(req({ token, body: { model: good.model, max_tokens: 10 } }), e, ctx, rows)).status).toBe(400);
  });
  it("400 when max_tokens is missing or not a positive number", async () => {
    const { token, rows, e } = await setup();
    const { max_tokens: _omit, ...withoutMaxTokens } = good;
    expect((await handleFleetAnthropicMessages(req({ token, body: withoutMaxTokens }), e, ctx, rows)).status).toBe(400);
    expect((await handleFleetAnthropicMessages(req({ token, body: { ...good, max_tokens: 0 } }), e, ctx, rows)).status).toBe(400);
  });
});

// Maestro review round 1, MAJOR 2: spend controls. Before this fix, spawn-
// token validity alone was the whole gate — any studio, any leadType, could
// reach env.AI.run with no flag, no rate limit, no usage row.
describe("handleFleetAnthropicMessages — spend controls (MAJOR 2)", () => {
  it("404 when FLEET_JUNIOR is not 'on' — reuses junior's own feature flag", async () => {
    const { token, rows, e, run } = await setup(undefined, { FLEET_JUNIOR: undefined });
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("403 when the calling studio's own leadType is not 'glm' — a claude-led studio may not spend here", async () => {
    const { token, rows, e, run } = await setup(undefined, {}, "claude");
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("403 when the calling studio's row has no leadType at all (pre-#249 row, defaults to claude)", async () => {
    // Built directly, bypassing setup()'s own default param (passing
    // `undefined` explicitly for leadType there would re-trigger its "glm"
    // default, same JS semantics row()'s own default has) — this row
    // genuinely has no `leadType` key at all, the real pre-#249 shape.
    const token = mintSpawnToken();
    const hash = await hashSpawnToken(token);
    const noLeadTypeRow: StudioStatus = {
      id: ME, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug: "acme-org/websites",
    };
    const rows = async () => [noLeadTypeRow];
    const run = vi.fn(async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" } ], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  // Board issue #284, MAJOR 1: this route has its OWN rate limit now
  // (LEAD_RATE_PER_MINUTE, src/llm/ratelimit.ts) — junior's own
  // JUNIOR_RATE_PER_MINUTE no longer has any effect here. The 429 is now
  // Anthropic-shaped with a retry-after header, not bare text.
  it("429 once the per-minute rate limit is exceeded — uses its OWN LEAD_RATE_PER_MINUTE, not junior's", async () => {
    const { token, rows, e } = await setup(undefined, { LEAD_RATE_PER_MINUTE: "1" });
    const first = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(first.status).toBe(200);
    const second = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(second.status).toBe(429);
    const retryAfter = second.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(await second.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "rate limit exceeded: too many glm-lead calls this minute" },
    });
  });

  it("429 past the daily cap — same Anthropic rate_limit_error body + retry-after (#298-1)", async () => {
    const { token, rows, e } = await setup(undefined, { LEAD_DAILY_CAP: "1" });
    const first = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(first.status).toBe(200);
    const second = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(second.status).toBe(429);
    const retryAfter = second.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(await second.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "rate limit exceeded: daily glm-lead cap reached" },
    });
  });

  it("junior's own JUNIOR_RATE_PER_MINUTE has no effect on this route — the two limits are separate", async () => {
    const { token, rows, e } = await setup(undefined, { JUNIOR_RATE_PER_MINUTE: "1" });
    const first = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(first.status).toBe(200);
    const second = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(second.status).toBe(200);
  });

  it("a burst of 10 rapid calls succeeds under the default LEAD_RATE_PER_MINUTE (60) — would 429 at junior's old default of 5", async () => {
    const { token, rows, e } = await setup();
    for (let i = 0; i < 10; i++) {
      const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
      expect(r.status).toBe(200);
    }
  });

  it("a successful non-streaming call logs a junior_usage_log row with the REAL input/output tokens (MAJOR 4)", async () => {
    const { token, rows, e } = await setup({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 4 },
    });
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(200);
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ studioId: ME, model: GLM_LEAD_MODEL, inputTokens: 11, outputTokens: 4, ok: 1 });
  });

  // Issue #519 (sweep 13): logUsage's insertJuniorUsage .catch(() => {})
  // used to drop a failed usage insert with no trace, so a whole day's
  // missing usage rows read identically to "nobody called". The swallow
  // stays (a logging failure must never touch the response already
  // returned) but one console.error naming "usage insert failed" must
  // fire. The locked-D1 fake itself now lives in helpers/d1-locked.ts
  // (sweep 43 F6, #883) — the same idiom as junior.usage.test.ts's own
  // missing-column db, forwarded to the real env.DB for every OTHER
  // statement (the rate limiter's fleet_state reads still need to work
  // for the call to reach the insert at all).
  it("a failed usage-row insert leaves the response intact and logs one console.error naming the insert failure (#519)", async () => {
    const realDb = env.DB;
    const db = lockedUsageLogDb(realDb);
    const { token, rows, e } = await setup();
    (e as { DB: unknown }).DB = db;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ type: "message", role: "assistant" });
      await ctx.drain();
      const failures = errors.mock.calls.filter((c) => c.join(" ").includes("usage insert failed"));
      expect(failures).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("a failed non-streaming call (env.AI.run throws) still logs a usage row, ok: false", async () => {
    const { token, rows, e } = await setup();
    (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(async () => { throw new Error("AiError: capacity exceeded"); });
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(529);
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ studioId: ME, ok: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("a context-overflow-shaped upstream error maps to 400 invalid_request_error, not a 500 the client would just retry (MAJOR 4)", async () => {
    const { token, rows, e } = await setup();
    (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(async () => {
      throw new Error("This model's maximum context length is 32768 tokens");
    });
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } });
  });
});

describe("handleFleetAnthropicMessages — non-streaming translation round trip", () => {
  it("200: translates the request to OpenAI shape, calls env.AI.run with the fixed GLM model, translates the reply back", async () => {
    const { token, rows, e, run } = await setup();
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(200);
    // Incident fix (#717): no LEAD_AI_GATEWAY_ID set in this fixture env, so
    // env.AI.run is called with exactly the pre-model-pool 2-arg shape — no
    // gateway option attached.
    // Issue #1112 layer 1: a lead call gets the continue-until-todos-done rule as its system message.
    // Issue #1099 (review, finding 1): the upstream call is always a stream, so the
    // runaway scan covers the non-streaming path too; the body carries the stream flag.
    expect(run).toHaveBeenCalledWith(GLM_LEAD_MODEL, {
      model: GLM_LEAD_MODEL, messages: [{ role: "system", content: OSS_LEAD_CONTINUE_RULE }, { role: "user", content: "hi" }], max_tokens: GLM_MIN_MAX_TOKENS,
      stream: true, stream_options: { include_usage: true },
    });
    const body = await r.json();
    expect(body).toMatchObject({ type: "message", role: "assistant", model: good.model, content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } });
  });

  // Fresh-context review, #717 critical follow-up: the REAL non-streaming
  // path (handleFleetAnthropicMessages's own call to
  // openAIResponseToAnthropic, not the `stream: true`-but-upstream-ignored-it
  // defensive fallback branch) used to omit `requestedMaxTokens` entirely —
  // an inflated upstream completion_tokens (reasoning_content spend) reached
  // the client verbatim. This exercises the REAL route handler end to end,
  // not the pure translate.ts function in isolation.
  it("a huge upstream completion_tokens (reasoning_content inflation) is clamped to the request's own max_tokens, not reported verbatim", async () => {
    const { token, rows, e } = await setup({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 70000 },
    });
    const body = { model: "claude-opus-4-5", max_tokens: 8000, messages: [{ role: "user", content: "hi" }] };
    const r = await handleFleetAnthropicMessages(req({ token, body }), e, ctx, rows);
    expect(r.status).toBe(200);
    const replyBody = (await r.json()) as { usage: { output_tokens: number } };
    expect(replyBody.usage.output_tokens).toBe(8000);
  });

  it("a tool_use round trip: request tool_result -> OpenAI tool message, response tool_calls -> Anthropic tool_use block", async () => {
    const { token, rows, e, run } = await setup({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"nyc"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const body = {
      model: "claude-opus-4-5", max_tokens: 100,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "nyc" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }] },
      ],
    };
    const r = await handleFleetAnthropicMessages(req({ token, body }), e, ctx, rows);
    expect(r.status).toBe(200);
    expect(run).toHaveBeenCalledWith(GLM_LEAD_MODEL, {
      model: GLM_LEAD_MODEL,
      messages: [
        { role: "system", content: OSS_LEAD_CONTINUE_RULE },
        { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"nyc"}' } }] },
        { role: "tool", tool_call_id: "toolu_1", content: "sunny" },
      ],
      max_tokens: GLM_MIN_MAX_TOKENS,
      stream: true, stream_options: { include_usage: true },
    });
    const replyBody = (await r.json()) as { content: unknown };
    expect(replyBody.content).toEqual([{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "nyc" } }]);
  });

  it("env.AI.run throwing a capacity error becomes a 529 overloaded_error body", async () => {
    const { token, rows, e } = await setup();
    (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(async () => { throw new Error("AiError: capacity exceeded"); });
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(529);
    expect(await r.json()).toEqual({ type: "error", error: { type: "overloaded_error", message: "AiError: capacity exceeded" } });
  });
});
