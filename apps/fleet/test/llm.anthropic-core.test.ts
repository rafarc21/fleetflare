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
import { POOL, type PoolModel } from "../src/llm/models";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import { fakeCtx } from "./helpers/fake-ctx";
import { lockedUsageLogDb } from "./helpers/d1-locked";
import { getNoFinishReasonFailures } from "../src/llm/model-store";

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

/** Issue #1228: a smaller variant of `setup()` above — takes a caller-built
 *  `ai` stub directly (so a test can assert on its own `run` mock's call
 *  sequence) and forwards the pool/retryDeps test-injection seams
 *  `handleFleetAnthropicMessages`'s own 5th/6th params expose. Mirrors
 *  `llm.anthropic-stream.test.ts`'s own `callRoute` helper — needed here
 *  because the no_finish_reason retry/failover/non-retriable tests below are
 *  the first in THIS file to need a fixture pool or injected retryDeps. */
async function callRoute(opts: {
  ai: { run: ReturnType<typeof vi.fn> };
  envOverrides?: Partial<Env>;
  pool?: readonly PoolModel[];
  body?: unknown;
  retryDeps?: { sleep?: (ms: number) => Promise<void>; random?: () => number };
}) {
  const token = mintSpawnToken();
  const rows = async () => [row(ME, await hashSpawnToken(token))];
  const e = { ...env, FLEET_JUNIOR: "on", AI: opts.ai, ...FAST_RETRY, ...(opts.envOverrides ?? {}) } as unknown as Env;
  return handleFleetAnthropicMessages(req({ token, body: opts.body }), e, ctx, rows, opts.pool, opts.retryDeps);
}

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

// Issue #1228: the non-streaming path's own `consume` callback
// (`runModelPoolOverflow`, anthropic-route.ts) is where the real retry/
// failover/non-retriable logic lives — the streaming path can't retry once
// the Response has left, so it only fingerprints and counts. These tests
// exercise that callback end to end, through the real HTTP handler, the way
// `llm.anthropic-stream.test.ts` already covers the streaming half. The
// route always requests `stream: true` from the upstream internally (Issue
// #1099, finding 1), even for a client's non-streaming request, so every
// `env.AI.run` fixture here must resolve to a `ReadableStream<Uint8Array>` of
// raw OpenAI SSE bytes — a plain object resolves to `{ kind: "plain" }` in
// the consume callback and skips all no_finish_reason logic entirely.
describe("handleFleetAnthropicMessages — no_finish_reason retry/failover/non-retriable (#1228)", () => {
  // Same fixture shape as llm.anthropic-stream.test.ts's own `partial()`: a
  // chunk with content but no `usage` field, so `state.outputTokens` stays
  // 0 — the exact "out=0 no_finish_reason" condition the consume callback
  // retries/fails over on — and the stream ends without ever setting a
  // `finish_reason`. A fresh ReadableStream per call: a stream can only be
  // read once, and each test's `env.AI.run` mock is called more than once.
  const noFinishStream = () => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`));
      controller.close();
    },
  });
  // A normal, complete upstream stream: one chunk carrying both the text and
  // the `finish_reason`/`usage` the fixture above never sends.
  const goodStream = () => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      })}\n\n`));
      controller.close();
    },
  });
  const MARKER = "TOP-SECRET-PROMPT-TEXT-1228";

  it("an out=0 no_finish_reason retries the same model once, then succeeds", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let calls = 0;
      const run = vi.fn(async () => { calls++; return calls === 1 ? noFinishStream() : goodStream(); });
      const body = { ...good, messages: [{ role: "user", content: MARKER }] };
      const r = await callRoute({ ai: { run }, body });
      expect(r.status).toBe(200);
      expect(run).toHaveBeenCalledTimes(2);
      const replyBody = await r.json();
      expect(replyBody).toMatchObject({
        type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      });

      await ctx.drain();
      const rowsLogged = await usageRows();
      expect(rowsLogged).toHaveLength(1);
      // Issue #335's `attempts` accumulates every env.AI.run call this one
      // request cost — the initial try plus the one same-model retry.
      expect(rowsLogged[0]).toMatchObject({ ok: 1, error: null, inputTokens: 3, outputTokens: 2, attempts: 2 });

      // The intermediate failure (first attempt) still gets its own
      // fingerprint line, even though the retry recovered the turn — same
      // "every no_finish_reason, including one that recovers" discipline
      // the route's own doc comment on this call site describes.
      const lines = spy.mock.calls.map((c) => c.map(String).join(" "));
      const fingerprintLines = lines.filter((l) => l.includes("[glm-lead] no_finish_reason") && l.includes("fingerprint="));
      expect(fingerprintLines).toHaveLength(1);
      expect(fingerprintLines[0]).toContain("bodyBytes=");
      expect(fingerprintLines[0]).toContain("tools=");
      expect(fingerprintLines[0]).toContain("lastToolResult=");
      expect(fingerprintLines[0]).toContain("lastChunks=");
      expect(fingerprintLines[0]).toContain("usageIn=");
      expect(fingerprintLines[0]).toContain("usageOut=");
      // Never a bare "call failed" line either — the request ended ok=1.
      expect(lines.some((l) => l.includes("call failed"))).toBe(false);
      for (const l of lines) expect(l).not.toContain(MARKER);
    } finally {
      spy.mockRestore();
    }
  });

  it("same-model retry fails again, the pool fails over to the next model, which succeeds", async () => {
    const kimi: PoolModel = { ...POOL[1], smokePassed: true };
    const testPool: readonly PoolModel[] = [POOL[0], kimi];
    const seen: string[] = [];
    let calls = 0;
    // The first model tried gets BOTH its calls (initial + same-model retry)
    // answered with the no-finish fixture; the model it fails over to gets
    // the good stream on its own first call.
    const run = vi.fn(async (model: string) => {
      calls++;
      seen.push(model);
      return calls <= 2 ? noFinishStream() : goodStream();
    });
    const r = await callRoute({ ai: { run }, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(3);
    // Same model, retried once...
    expect(seen[0]).toBe(seen[1]);
    // ...then failed over to the OTHER pool model.
    expect(seen[2]).not.toBe(seen[0]);

    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    // Global Constraint (#717): logUsage records the model actually used —
    // the one that recovered the turn, never the one that exhausted its
    // own retry first.
    expect(rowsLogged[0]).toMatchObject({ ok: 1, model: seen[2] });
    expect(rowsLogged[0].model).not.toBe(seen[0]);
  });

  // Finding 1 (fresh-context review of #1228, PR #1235, BLOCKING): the
  // 3-strike cap used to increment ONCE per client request, at the very end
  // of the whole `runModelPoolOverflow` walk, while that walk itself burns
  // up to `order.length * 2` real `env.AI.run` calls per request (every
  // candidate's initial try plus its same-model retry). Every upstream out=0
  // no_finish_reason occurrence now counts toward the cap as it happens, so
  // with the default single-model pool here the SECOND client request
  // already trips the cap on its very first attempt (2 occurrences from
  // request 1, a 3rd occurrence 1 call into request 2) — never a third
  // identical ROUND TRIP, and the total env.AI.run calls across the whole
  // scenario stays at 3, not the pre-fix worst case.
  it("every pool model exhausts with out=0 no_finish_reason: first failure is retriable (529), second identical failure is non-retriable (400) — total upstream calls stay bounded", async () => {
    // Issue #1228 (3): the SAME identical-input body sent repeatedly —
    // computeRequestFingerprint hashes the raw pre-parse body string, so
    // repeated calls with the same JS object serialize to byte-identical raw
    // bodies, and all of them land under the same fingerprint/studio key.
    const body = { ...good, messages: [{ role: "user", content: "same poison body every single time" }] };
    const run = vi.fn(async () => noFinishStream());

    const first = await callRoute({ ai: { run }, body });
    expect(first.status).toBe(529);
    expect(await first.json()).toMatchObject({
      type: "error", error: { type: "overloaded_error", message: "upstream stream ended without a finish reason; retry the turn" },
    });
    // The single-model pool's initial try plus its one same-model retry —
    // 2 real upstream completions for this first request.
    expect(run.mock.calls.length).toBe(2);

    const second = await callRoute({ ai: { run }, body });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "upstream repeatedly failed to complete this request; compact context and retry" },
    });
    // The cap trips on the SECOND request's very first attempt (the 3rd
    // occurrence overall) — the walk stops dead right there, never spending
    // a same-model retry on a request already proven poisonous.
    expect(run.mock.calls.length).toBe(3);

    // Issue #1228: the entry gate at the top of the handler refuses a 3rd
    // identical request OUTRIGHT — the literal "client stops its 12x retry
    // loop" proof — before spending any more AI budget on a request already
    // proven to fail 3 times.
    const callsBeforeThird = run.mock.calls.length;
    const third = await callRoute({ ai: { run }, body });
    expect(third.status).toBe(400);
    expect(await third.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "upstream repeatedly failed to complete this request; compact context and retry" },
    });
    expect(run.mock.calls.length).toBe(callsBeforeThird);

    const fourth = await callRoute({ ai: { run }, body });
    expect(fourth.status).toBe(400);
    // Burn bound proof: 3 real upstream completions total for this entire
    // scenario (4 client requests), never the pre-fix worst case of up to
    // `order.length * 2` calls PER request before the cap was even checked.
    expect(run.mock.calls.length).toBe(3);
  });

  // Finding 1's own TDD proof, using a 3-model pool (the shape the bug
  // report itself used): every upstream occurrence counts toward the cap as
  // it happens, so the cap can trip MID-WALK, inside a single client
  // request, long before every candidate has even been tried.
  it("a 3-model pool trips the 3-strike cap mid-walk on a SINGLE request, not after 3 client round trips (burn bound)", async () => {
    const testPool: readonly PoolModel[] = POOL.map((m) => ({ ...m, smokePassed: true }));
    const run = vi.fn(async () => noFinishStream());
    const body = { ...good, messages: [{ role: "user", content: "same poison body, 3-model pool" }] };

    const first = await callRoute({ ai: { run }, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, body });
    // Model 0's initial try + its same-model retry + model 1's initial try
    // are 3 real occurrences, all within this ONE request — the cap trips
    // right there, and the walk stops instead of continuing on to model 1's
    // own retry or model 2 at all.
    expect(first.status).toBe(400);
    expect(run.mock.calls.length).toBe(3);

    // A second identical request is refused OUTRIGHT at the entry gate —
    // zero further env.AI.run calls. Total upstream completions for this
    // whole scenario: 3 — not the pre-fix worst case of up to
    // 3 models x 2 attempts x 3 round trips = 18.
    const second = await callRoute({ ai: { run }, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, body });
    expect(second.status).toBe(400);
    expect(run.mock.calls.length).toBe(3);
  });

  // Finding 1 (fresh-context review of #1228, PR #1235): the bottom
  // non-streaming failure branch used to key ONLY on `result.failure ===
  // "no_finish_reason"`, with no `outputTokens === 0` check — unlike the
  // retry walk's own gate a few lines up in runModelPoolOverflow, which
  // only treats an out=0 no_finish_reason as retriable/poison-countable.
  // The incident's own data says poison runs die after 0-1.6k out tokens,
  // not always 0, so a single-model pool whose no_finish_reason stream DID
  // carry output tokens used to be wrongly fingerprinted/counted toward the
  // SAME 3-strike poison streak meant only for the out=0 shape — risking a
  // false-positive permanent 400 on an unrelated flaky request.
  it("a no_finish_reason WITH output tokens is not poison-counted — falls through to the generic error path", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A chunk that carries real `usage.completion_tokens` (so
      // state.outputTokens > 0) but never a finish_reason — the "died with
      // SOME output" shape, as opposed to noFinishStream()'s out=0 shape.
      const noFinishWithOutputStream = () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
            choices: [{ delta: { content: "partial but priced" } }],
            usage: { prompt_tokens: 3, completion_tokens: 5 },
          })}\n\n`));
          controller.close();
        },
      });
      const run = vi.fn(async () => noFinishWithOutputStream());
      const body = { ...good, messages: [{ role: "user", content: "flaky but not poison" }] };
      const r = await callRoute({ ai: { run }, body });

      // NOT the poison-streak shapes (529 overloaded_error / 400
      // invalid_request_error) — it falls through to classifyAiError's own
      // generic mapping for the translator's own error-frame message.
      expect(r.status).not.toBe(529);
      expect(r.status).not.toBe(400);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({
        type: "error",
        error: { type: "api_error", message: "upstream stream ended without a finish reason" },
      });

      // Only ONE console.error fingerprint line for this single frame (the
      // overflow walk's own consume callback) — the bottom branch must not
      // log it a second time now that it falls through instead.
      const lines = spy.mock.calls.map((c) => c.map(String).join(" "));
      const fingerprintLines = lines.filter((l) => l.includes("[glm-lead] no_finish_reason") && l.includes("fingerprint="));
      expect(fingerprintLines).toHaveLength(1);

      // Never counted toward the 3-strike poison streak either.
      const raw = JSON.stringify(body);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
      const fingerprintHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      expect(await getNoFinishReasonFailures(env.DB, ME, fingerprintHash)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
