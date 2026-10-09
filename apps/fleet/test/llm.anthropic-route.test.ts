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
import { handleFleetAnthropicMessages, ANTHROPIC_MESSAGES_PATH, ANTHROPIC_BODY_CAP } from "../src/llm/anthropic-route";
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
    "SELECT studio_id AS studioId, mode, model, input_tokens AS inputTokens, output_tokens AS outputTokens, ok FROM junior_usage_log ORDER BY ts ASC",
  ).all<{ studioId: string; mode: string; model: string; inputTokens: number; outputTokens: number; ok: number }>();
  return res.results ?? [];
}

async function setup(
  aiResult: unknown = { choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  envOverrides: Partial<Env> = {},
  leadType: "claude" | "glm" | undefined = "glm",
) {
  const token = mintSpawnToken();
  const rows = async () => [row(ME, await hashSpawnToken(token), leadType)];
  const run = vi.fn(async () => aiResult);
  const e = { ...env, FLEET_JUNIOR: "on", AI: { run }, ...envOverrides } as unknown as Env;
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
  // JUNIOR_RATE_PER_MINUTE no longer has any effect here.
  it("429 once the per-minute rate limit is exceeded — uses its OWN LEAD_RATE_PER_MINUTE, not junior's", async () => {
    const { token, rows, e } = await setup(undefined, { LEAD_RATE_PER_MINUTE: "1" });
    const first = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(first.status).toBe(200);
    const second = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(second.status).toBe(429);
    expect(await second.text()).toContain("too many glm-lead calls this minute");
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
    expect(rowsLogged[0]).toMatchObject({ studioId: ME, inputTokens: 7, outputTokens: 2, ok: 1 });
  });
});
