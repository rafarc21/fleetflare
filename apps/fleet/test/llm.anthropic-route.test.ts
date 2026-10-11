// apps/fleet/test/llm.anthropic-route.test.ts
// HTTP/auth/framing layer for #249's GLM-led studio route. Same
// cloudflare:test convention as test/junior.route.test.ts (spawn-token
// resolution needs a real registry row + a real StudioStatus shape) — every
// actual translation direction is covered without env/HTTP mocking in
// test/bun/llm-translate.test.ts; this file only proves the wiring:
// auth, path/method/size gates, and that env.AI.run is called with (and
// responds through) the translated shapes.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  handleFleetAnthropicMessages, ANTHROPIC_MESSAGES_PATH, ANTHROPIC_BODY_CAP,
  handleFleetAnthropicCountTokens, ANTHROPIC_COUNT_TOKENS_PATH,
} from "../src/llm/anthropic-route";
import { GLM_LEAD_MODEL, GLM_MIN_MAX_TOKENS } from "../src/llm/translate";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

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
function fakeCtx() {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => { tasks.push(p); p.catch(() => {}); }),
    passThroughOnException: () => {},
    drain: () => Promise.all(tasks),
  };
  return ctx as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn>; drain: () => Promise<unknown[]> };
}
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
  // JUNIOR_RATE_PER_MINUTE no longer has any effect here. Issue #298-1:
  // the 429 is Anthropic-shaped with a retry-after header, not bare text.
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
    expect(run).toHaveBeenCalledWith(GLM_LEAD_MODEL, { model: GLM_LEAD_MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: GLM_MIN_MAX_TOKENS });
    const body = await r.json();
    expect(body).toMatchObject({ type: "message", role: "assistant", model: good.model, content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } });
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
        { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"nyc"}' } }] },
        { role: "tool", tool_call_id: "toolu_1", content: "sunny" },
      ],
      max_tokens: GLM_MIN_MAX_TOKENS,
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

describe("handleFleetAnthropicMessages — streaming", () => {
  it("stream:true pipes OpenAI SSE chunks through to the Anthropic SSE event sequence", async () => {
    const chunks = [
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const run = vi.fn(async () => upstream);
    const token = mintSpawnToken();
    const rows = async () => [row(ME, await hashSpawnToken(token))];
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;

    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    const eventTypes = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(eventTypes).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
    ]);
    expect(text).toContain('"text":"hi"');
    expect(run).toHaveBeenCalledWith(GLM_LEAD_MODEL, expect.objectContaining({ stream: true, stream_options: { include_usage: true } }));
  });

  // Maestro review round 1, MAJOR 3: the exact bug — a mid-stream upstream
  // failure (after message_start AND a content block already reached the
  // client) used to be silently reported as a normal end_turn/message_stop.
  it("a mid-stream upstream failure emits event: error — never a faked end_turn/message_stop", async () => {
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`));
      },
      pull() {
        throw new Error("AiError: capacity exceeded mid-stream");
      },
    });
    const run = vi.fn(async () => upstream);
    const token = mintSpawnToken();
    const rows = async () => [row(ME, await hashSpawnToken(token))];
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;

    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    expect(r.status).toBe(200);
    const text = await r.text();
    const eventTypes = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(eventTypes).toEqual(["message_start", "content_block_start", "content_block_delta", "error"]);
    expect(eventTypes).not.toContain("message_stop");
    const errorFrame = text.split("\n\n").find((f) => f.includes("event: error"));
    expect(JSON.parse(errorFrame!.split("data: ")[1])).toEqual({
      type: "error", error: { type: "overloaded_error", message: "AiError: capacity exceeded mid-stream" },
    });

    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0].ok).toBe(0);
  });

  // Board issue #284 (a): the stream simply ends — reader hits EOF, no
  // finish_reason chunk ever arrived, no [DONE], no error chunk either.
  // Before this fix, this silently closed as a normal end_turn/message_stop
  // pair; now it must emit event: error instead.
  it("a stream that ends without ever sending a finish_reason chunk emits event: error, not a faked end_turn/message_stop (board issue #284a)", async () => {
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`));
        // The stream just ends here — no finish_reason chunk, no [DONE].
        controller.close();
      },
    });
    const run = vi.fn(async () => upstream);
    const token = mintSpawnToken();
    const rows = async () => [row(ME, await hashSpawnToken(token))];
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;

    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    expect(r.status).toBe(200);
    const text = await r.text();
    const eventTypes = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(eventTypes).toEqual(["message_start", "content_block_start", "content_block_delta", "error"]);
    expect(eventTypes).not.toContain("message_stop");
    const errorFrame = text.split("\n\n").find((f) => f.includes("event: error"));
    expect(JSON.parse(errorFrame!.split("data: ")[1])).toMatchObject({
      type: "error", error: { message: "upstream stream ended without a finish reason" },
    });

    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0].ok).toBe(0);
  });

  // Board issue #284 (b): an explicit upstream {"error":...} chunk arriving
  // mid-stream — the real failure reason is already right there in the
  // chunk, so it must flow straight into event: error, never be silently
  // swallowed by applyOpenAIStreamChunk's own "no choices[0]" no-op path.
  it("an explicit upstream {error:...} chunk mid-stream emits event: error with its own message, not a swallowed/silent continuation (board issue #284b)", async () => {
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: "upstream blew up mid-generation" } })}\n\n`));
        controller.close();
      },
    });
    const run = vi.fn(async () => upstream);
    const token = mintSpawnToken();
    const rows = async () => [row(ME, await hashSpawnToken(token))];
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;

    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    expect(r.status).toBe(200);
    const text = await r.text();
    const eventTypes = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(eventTypes).toEqual(["message_start", "content_block_start", "content_block_delta", "error"]);
    expect(eventTypes).not.toContain("message_stop");
    const errorFrame = text.split("\n\n").find((f) => f.includes("event: error"));
    expect(JSON.parse(errorFrame!.split("data: ")[1])).toEqual({
      type: "error", error: { type: "api_error", message: "upstream blew up mid-generation" },
    });

    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0].ok).toBe(0);
  });

  // #298-4: the overflow-shaped sibling of the test above — Claude Code's
  // client recognizes "prompt is too long" to trigger auto-compact mid-
  // session, so the raw upstream overflow text must not pass through.
  it("an overflow-shaped upstream {error:...} chunk mid-stream emits event: error carrying the fixed 'prompt is too long' message, not the raw upstream text (#298-4)", async () => {
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: "This model's maximum context length is 32768 tokens" } })}\n\n`));
        controller.close();
      },
    });
    const run = vi.fn(async () => upstream);
    const token = mintSpawnToken();
    const rows = async () => [row(ME, await hashSpawnToken(token))];
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;

    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    expect(r.status).toBe(200);
    const text = await r.text();
    const eventTypes = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(eventTypes).toEqual(["message_start", "content_block_start", "content_block_delta", "error"]);
    expect(eventTypes).not.toContain("message_stop");
    const errorFrame = text.split("\n\n").find((f) => f.includes("event: error"));
    expect(JSON.parse(errorFrame!.split("data: ")[1])).toEqual({
      type: "error", error: { type: "invalid_request_error", message: "prompt is too long" },
    });

    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0].ok).toBe(0);
  });

  // Board issue #284, MINOR 4(a): mirrors #218's own finding
  // (junior.usage.test.ts) applied to the stream-pump chain itself — the
  // Workers runtime is free to tear down this execution context the instant
  // the Response (already returned above, carrying `readable`) is
  // considered "done" from ITS own point of view, before a bare
  // `void`-prefixed promise chain has actually finished writing/closing the
  // stream. Checked BEFORE reading any byte of the body: ctx.waitUntil must
  // be called synchronously, the instant this function kicks the pump off —
  // not merely as an incidental side effect of the client eventually reading
  // the stream to completion (which the real runtime gives no such guarantee
  // about, timing-wise). The upstream stream here deliberately is never
  // read by this test before the assertion, so if the pump chain is only
  // reachable via a bare `void` (no ctx.waitUntil wrapping it directly),
  // backpressure on the unread TransformStream keeps it pending and
  // ctx.waitUntil never fires at all by this point.
  it("the stream-pump chain itself is handed to ctx.waitUntil, not a bare fire-and-forget (board issue #284 MINOR 4a)", async () => {
    const chunks = [
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const run = vi.fn(async () => upstream);
    const token = mintSpawnToken();
    const rows = async () => [row(ME, await hashSpawnToken(token))];
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;

    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    expect(r.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalled();
    await r.text();
    await ctx.drain();
  });

  it("a successful stream logs a usage row with the real tokens from the final usage-bearing chunk (MAJOR 4)", async () => {
    const enc = new TextEncoder();
    const chunks = [
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
    ];
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const run = vi.fn(async () => upstream);
    const token = mintSpawnToken();
    const rows = async () => [row(ME, await hashSpawnToken(token))];
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;

    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    expect(r.status).toBe(200);
    await r.text();
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ studioId: ME, inputTokens: 7, outputTokens: 2, ok: 1, error: null });
  });
});

// Issue #302: a live GLM-lead run hit an ~8-min upstream stall. The pump sat
// in `reader.read()` the whole time, Claude Code waited out its own 600s
// client timeout, and the two `ok: 0` rows it left carried no reason at all.
describe("handleFleetAnthropicMessages — stream idle timeout and failure reasons (issue #302)", () => {
  function streamSetup(upstream: ReadableStream<Uint8Array>, envOverrides: Partial<Env> = {}) {
    return (async () => {
      const run = vi.fn(async () => upstream);
      const token = mintSpawnToken();
      const rows = async () => [row(ME, await hashSpawnToken(token))];
      const e = { ...env, FLEET_JUNIOR: "on", AI: { run }, ...FAST_RETRY, ...envOverrides } as unknown as Env;
      return { token, rows, e, run };
    })();
  }
  const partial = () => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);

  it("an upstream that stalls past LEAD_STREAM_IDLE_MS emits event: error and cancels the upstream read", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(partial()); },
      pull() { return new Promise<void>(() => { /* stalls forever */ }); },
      cancel() { cancelled = true; },
    });
    const { token, rows, e } = await streamSetup(upstream, { LEAD_STREAM_IDLE_MS: "40" } as Partial<Env>);

    const started = Date.now();
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    const text = await r.text();
    expect(Date.now() - started).toBeLessThan(5_000);
    const eventTypes = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(eventTypes).toEqual(["message_start", "content_block_start", "content_block_delta", "error"]);
    const errorFrame = text.split("\n\n").find((f) => f.includes("event: error"));
    expect(JSON.parse(errorFrame!.split("data: ")[1])).toEqual({
      type: "error", error: { type: "api_error", message: "upstream stream idle timeout: no data for 40ms" },
    });

    await ctx.drain();
    expect(cancelled).toBe(true);
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ ok: 0, error: "idle_timeout after 40ms" });
  });

  it("a garbage LEAD_STREAM_IDLE_MS falls back to the default instead of disabling the timeout", async () => {
    const { LEAD_STREAM_IDLE_MS_DEFAULT, leadStreamIdleMs } = await import("../src/llm/anthropic-route");
    expect(LEAD_STREAM_IDLE_MS_DEFAULT).toBe(90_000);
    expect(leadStreamIdleMs({})).toBe(90_000);
    expect(leadStreamIdleMs({ LEAD_STREAM_IDLE_MS: "nope" })).toBe(90_000);
    expect(leadStreamIdleMs({ LEAD_STREAM_IDLE_MS: "0" })).toBe(90_000);
    expect(leadStreamIdleMs({ LEAD_STREAM_IDLE_MS: "120000" })).toBe(120_000);
  });

  it("a mid-stream read throw records upstream_read_error with the classified type", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(partial()); },
      pull() { throw new Error("AiError: capacity exceeded mid-stream"); },
    });
    const { token, rows, e } = await streamSetup(upstream);
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    await r.text();
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({
      ok: 0, error: "upstream_read_error overloaded_error: AiError: capacity exceeded mid-stream",
    });
  });

  it("an explicit upstream {error} chunk records upstream_error_chunk", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partial());
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: { message: "upstream blew up" } })}\n\n`));
        controller.close();
      },
    });
    const { token, rows, e } = await streamSetup(upstream);
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    await r.text();
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 0, error: "upstream_error_chunk api_error: upstream blew up" });
  });

  it("a stream that ends without a finish_reason records no_finish_reason", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(partial()); controller.close(); },
    });
    const { token, rows, e } = await streamSetup(upstream);
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    await r.text();
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 0, error: "no_finish_reason" });
  });

  it("the client dropping the stream records client_abort and cancels the upstream", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(partial()); },
      pull() { return new Promise<void>(() => {}); },
      cancel() { cancelled = true; },
    });
    const { token, rows, e } = await streamSetup(upstream, { LEAD_STREAM_IDLE_MS: "5000" } as Partial<Env>);
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel("client went away");
    await ctx.drain();
    expect(cancelled).toBe(true);
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ ok: 0, error: "client_abort" });
  });

  it("a non-streaming env.AI.run throw records ai_run_error with the status it mapped to", async () => {
    const { token, rows, e } = await setup();
    (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(async () => { throw new Error("AiError: capacity exceeded"); });
    await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 0, error: "ai_run_error 529 overloaded_error: AiError: capacity exceeded" });
  });

  it("a streaming env.AI.run throw records ai_run_error too", async () => {
    const { token, rows, e } = await setup();
    (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(async () => { throw new Error("upstream timeout"); });
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    expect(r.status).toBe(504);
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 0, error: "ai_run_error 504 api_error: upstream timeout" });
  });

  it("a failure writes exactly one console.error line naming studio + reason, never prompt content", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(partial()); controller.close(); },
      });
      const { token, rows, e } = await streamSetup(upstream);
      const body = { ...good, stream: true, messages: [{ role: "user", content: "TOP-SECRET-PROMPT-TEXT" }] };
      const r = await handleFleetAnthropicMessages(req({ token, body }), e, ctx, rows);
      await r.text();
      await ctx.drain();
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0].map(String).join(" ");
      expect(line).toBe(`[glm-lead] call failed studio=${ME} stream=true in=0 out=0 reason=no_finish_reason`);
      expect(line).not.toContain("TOP-SECRET-PROMPT-TEXT");
    } finally {
      spy.mockRestore();
    }
  });

  it("a successful call writes no console.error line and a null error column", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { token, rows, e } = await setup();
      await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
      await ctx.drain();
      expect(spy).not.toHaveBeenCalled();
      expect((await usageRows())[0]).toMatchObject({ ok: 1, error: null });
    } finally {
      spy.mockRestore();
    }
  });

  it("a very long upstream message is truncated in the stored reason", async () => {
    const { token, rows, e } = await setup();
    (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(async () => { throw new Error("x".repeat(5000)); });
    await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    await ctx.drain();
    const stored = (await usageRows())[0].error!;
    expect(stored.length).toBeLessThanOrEqual(300);
    expect(stored.startsWith("ai_run_error 500 api_error: xxx")).toBe(true);
  });
});

describe("handleFleetAnthropicMessages — pre-stream retry and call duration (issue #335)", () => {
  // The live shape: Workers AI throws this from inside env.AI.run, before any
  // stream exists.
  const TIMEOUT_504 = "AiError: 3046: Request timeout";
  const okReply = { choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
  function failThen(messages: string[], then: unknown) {
    let n = 0;
    return vi.fn(async () => {
      if (n < messages.length) throw new Error(messages[n++]);
      return then;
    });
  }

  it("a 504 (3046 Request timeout) is retried and the second attempt's reply is returned", async () => {
    const { token, rows, e } = await setup();
    const run = failThen([TIMEOUT_504], okReply);
    (e.AI as { run: unknown }).run = run;
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
    await ctx.drain();
    const logged = await usageRows();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ ok: 1, error: null, attempts: 2 });
  });

  it("a 529 overloaded (capacity) error is retried too", async () => {
    const { token, rows, e } = await setup();
    const run = failThen(["AiError: capacity exceeded"], okReply);
    (e.AI as { run: unknown }).run = run;
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gives up after 2 retries (3 attempts) and returns the last 504, recording attempts=3", async () => {
    const { token, rows, e } = await setup();
    const run = vi.fn(async () => { throw new Error(TIMEOUT_504); });
    (e.AI as { run: unknown }).run = run;
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(504);
    expect(run).toHaveBeenCalledTimes(3);
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 0, attempts: 3, error: `ai_run_error 504 api_error: ${TIMEOUT_504}` });
  });

  it("a 4xx-mapped error is never retried (context overflow 400, rate limit 429)", async () => {
    for (const message of ["This model's maximum context length is 32768 tokens", "AiError: rate limit reached"]) {
      const { token, rows, e } = await setup();
      const run = vi.fn(async () => { throw new Error(message); });
      (e.AI as { run: unknown }).run = run;
      const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
      expect(r.status).toBeLessThan(500);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("a generic 500 is not retried — only 504/529 are", async () => {
    const { token, rows, e } = await setup();
    const run = vi.fn(async () => { throw new Error("AiError: something else broke"); });
    (e.AI as { run: unknown }).run = run;
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(500);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("streaming: a pre-stream 504 is retried, then the stream is served normally", async () => {
    const chunk = (c: unknown) => `data: ${JSON.stringify(c)}\n\n`;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          chunk({ choices: [{ delta: { content: "hi" } }] }) +
          chunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) +
          "data: [DONE]\n\n",
        ));
        controller.close();
      },
    });
    const { token, rows, e } = await setup();
    const run = failThen([TIMEOUT_504], upstream);
    (e.AI as { run: unknown }).run = run;
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("event: message_stop");
    expect(run).toHaveBeenCalledTimes(2);
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 1, attempts: 2, inputTokens: 5, outputTokens: 1 });
  });

  it("streaming: a failure after the first byte is never retried", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`)); },
      pull() { throw new Error(TIMEOUT_504); },
    });
    const { token, rows, e } = await setup();
    const run = vi.fn(async () => upstream);
    (e.AI as { run: unknown }).run = run;
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    const text = await r.text();
    expect(text).toContain("event: error");
    expect(run).toHaveBeenCalledTimes(1);
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 0, attempts: 1 });
  });

  it("records call duration (ms) and attempts=1 on a first-try success, streaming and not", async () => {
    const { token, rows, e } = await setup();
    await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    await ctx.drain();
    const [row0] = await usageRows();
    expect(row0.attempts).toBe(1);
    expect(Number.isInteger(row0.durationMs)).toBe(true);
    expect(row0.durationMs!).toBeGreaterThanOrEqual(0);
  });

  it("duration covers the backoff between attempts", async () => {
    const { token, rows, e } = await setup(undefined, { LEAD_AI_RETRY_BASE_MS: "40" } as Partial<Env>);
    (e.AI as { run: unknown }).run = failThen([TIMEOUT_504], okReply);
    await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    await ctx.drain();
    // Jitter keeps the first delay within [base/2, base] = [20, 40] ms.
    expect((await usageRows())[0].durationMs!).toBeGreaterThanOrEqual(20);
  });
});

describe("runAiWithRetry / leadAiRetryBaseMs (issue #335)", () => {
  it("delays are jittered exponential backoff within [base*2^n/2, base*2^n]", async () => {
    const { runAiWithRetry } = await import("../src/llm/anthropic-route");
    const delays: number[] = [];
    const run = vi.fn(async () => { throw new Error("AiError: 3046: Request timeout"); });
    for (const random of [0, 0.999]) {
      delays.length = 0;
      await expect(runAiWithRetry(run, { baseMs: 100, random: () => random, sleep: async (ms) => { delays.push(ms); } }))
        .rejects.toMatchObject({ attempts: 3 });
      if (random === 0) expect(delays).toEqual([50, 100]);
      else expect(delays.map(Math.round)).toEqual([100, 200]);
    }
  });

  it("returns the value and attempt count on success", async () => {
    const { runAiWithRetry } = await import("../src/llm/anthropic-route");
    const result = await runAiWithRetry(async () => "ok", { baseMs: 1, sleep: async () => {} });
    expect(result).toEqual({ value: "ok", attempts: 1 });
  });

  it("a garbage LEAD_AI_RETRY_BASE_MS falls back to the default", async () => {
    const { leadAiRetryBaseMs, LEAD_AI_RETRY_BASE_MS_DEFAULT } = await import("../src/llm/anthropic-route");
    expect(LEAD_AI_RETRY_BASE_MS_DEFAULT).toBe(500);
    expect(leadAiRetryBaseMs({})).toBe(500);
    expect(leadAiRetryBaseMs({ LEAD_AI_RETRY_BASE_MS: "nope" })).toBe(500);
    expect(leadAiRetryBaseMs({ LEAD_AI_RETRY_BASE_MS: "250" })).toBe(250);
  });
});

// Board issue #284, MINOR 4(b): POST /v1/messages/count_tokens, the sibling
// Anthropic Messages API endpoint some SDK client configurations probe or
// call before a real request (Claude Code's own SDK may call it to decide
// whether to compact context first). Before this fix the route didn't exist
// at all — any request here fell through to the generic /fleet/ catch-all
// and 404'd, the same failure mode issue #249's own BLOCKER (route never
// mounted) looked like, except this gap is real: the endpoint genuinely
// isn't implemented. Same auth/feature-flag/leadType trust boundary as
// handleFleetAnthropicMessages above — none of those checks may be skipped
// just because this route never calls env.AI.run.
describe("handleFleetAnthropicCountTokens — board issue #284 MINOR 4(b)", () => {
  it("404 on the wrong path", async () => {
    const { token, rows, e } = await setup();
    const r = await handleFleetAnthropicCountTokens(
      req({ token, path: "/fleet/llm/anthropic/v1/other" }), e, ctx, rows,
    );
    expect(r.status).toBe(404);
  });

  it("404 when FLEET_JUNIOR is not 'on' — reuses the same feature flag as the messages route", async () => {
    const { token, rows, e } = await setup(undefined, { FLEET_JUNIOR: undefined });
    const r = await handleFleetAnthropicCountTokens(req({ token, path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows);
    expect(r.status).toBe(404);
  });

  it("401 with no token at all", async () => {
    const { rows, e } = await setup();
    const r = await handleFleetAnthropicCountTokens(req({ path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows);
    expect(r.status).toBe(401);
  });

  it("401 with a well-shaped but unknown token", async () => {
    const { rows, e } = await setup();
    const r = await handleFleetAnthropicCountTokens(
      req({ token: mintSpawnToken(), path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows,
    );
    expect(r.status).toBe(401);
  });

  it("403 when the calling studio's own leadType is not 'glm'", async () => {
    const { token, rows, e } = await setup(undefined, {}, "claude");
    const r = await handleFleetAnthropicCountTokens(req({ token, path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows);
    expect(r.status).toBe(403);
  });

  it("400 when messages is missing or empty", async () => {
    const { token, rows, e } = await setup();
    const r = await handleFleetAnthropicCountTokens(
      req({ token, path: ANTHROPIC_COUNT_TOKENS_PATH, body: { ...good, messages: [] } }), e, ctx, rows,
    );
    expect(r.status).toBe(400);
  });

  it("200: returns a plausible non-zero input_tokens ESTIMATE for non-trivial message content, without ever calling env.AI.run", async () => {
    const { token, rows, e, run } = await setup();
    const body = {
      model: "claude-opus-4-5",
      messages: [{ role: "user", content: "This is a reasonably long message, long enough that a rough 4-chars-per-token estimate should clearly exceed a handful of tokens." }],
    };
    const r = await handleFleetAnthropicCountTokens(req({ token, path: ANTHROPIC_COUNT_TOKENS_PATH, body }), e, ctx, rows);
    expect(r.status).toBe(200);
    expect(run).not.toHaveBeenCalled();
    const json = (await r.json()) as { input_tokens: number };
    expect(json.input_tokens).toBeGreaterThan(10);
  });

  // #298-3: the request's tools are real prompt material the backend
  // re-receives every call — an estimate that ignores them comes in low
  // and skews Claude Code's compact decisions the endpoint exists to feed.
  it("a body with a non-trivial tools array estimates HIGHER than the same body without tools (#298-3)", async () => {
    const { token, rows, e } = await setup();
    const tool = {
      name: "get_weather", description: "look up the current weather for a city",
      input_schema: { type: "object", properties: { city: { type: "string" }, units: { type: "string" } }, required: ["city"] },
    };
    const base = { model: "claude-opus-4-5", messages: [{ role: "user", content: "weather in nyc?" }] };
    const withTools = await handleFleetAnthropicCountTokens(
      req({ token, path: ANTHROPIC_COUNT_TOKENS_PATH, body: { ...base, tools: [tool] } }), e, ctx, rows,
    );
    const withoutTools = await handleFleetAnthropicCountTokens(
      req({ token, path: ANTHROPIC_COUNT_TOKENS_PATH, body: base }), e, ctx, rows,
    );
    const estimateWith = ((await withTools.json()) as { input_tokens: number }).input_tokens;
    const estimateWithout = ((await withoutTools.json()) as { input_tokens: number }).input_tokens;
    expect(estimateWith).toBeGreaterThan(estimateWithout);
  });

  it("array-content messages ({type:'text'} blocks) are counted, not skipped (#298-3)", async () => {
    const { token, rows, e } = await setup();
    const long = "a sentence of genuine content, ".repeat(20);
    const r = await handleFleetAnthropicCountTokens(
      req({
        token, path: ANTHROPIC_COUNT_TOKENS_PATH,
        body: { model: "claude-opus-4-5", messages: [{ role: "user", content: [{ type: "text", text: long }] }] },
      }), e, ctx, rows,
    );
    const json = (await r.json()) as { input_tokens: number };
    expect(json.input_tokens).toBeGreaterThan(10);
  });

  // Parity with the messages route: the endpoint spends no AI budget, but
  // an unthrottled endpoint is a free D1-hammering surface.
  it("429 once the LEAD per-minute limit is exceeded — same Anthropic rate_limit_error body + retry-after (#298-3)", async () => {
    const { token, rows, e } = await setup(undefined, { LEAD_RATE_PER_MINUTE: "1" });
    const first = await handleFleetAnthropicCountTokens(
      req({ token, path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows,
    );
    expect(first.status).toBe(200);
    const second = await handleFleetAnthropicCountTokens(
      req({ token, path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows,
    );
    expect(second.status).toBe(429);
    const retryAfter = second.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(await second.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "rate limit exceeded: too many glm-lead calls this minute" },
    });
  });
});
