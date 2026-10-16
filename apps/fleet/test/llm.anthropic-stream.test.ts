// apps/fleet/test/llm.anthropic-stream.test.ts
// HTTP/auth/framing layer for #249's GLM-led studio route — the streaming
// half (SSE streaming, stream idle timeout/failure reasons, pre-stream retry
// + call duration, count_tokens, model pool + gateway, #767 same-model
// backoff), split out of test/llm.anthropic-route.test.ts per sweep-45 F6
// (#919). Same cloudflare:test convention as test/junior.route.test.ts
// (spawn-token resolution needs a real registry row + a real StudioStatus
// shape) — every actual translation direction is covered without env/HTTP
// mocking in test/bun/llm-translate-request.test.ts and
// test/bun/llm-translate-stream.test.ts; this file only proves the wiring:
// streaming event shaping, stream-failure classification, retries, pool
// overflow, and that env.AI.run is called with the translated shapes.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  handleFleetAnthropicMessages, ANTHROPIC_MESSAGES_PATH,
  handleFleetAnthropicCountTokens, ANTHROPIC_COUNT_TOKENS_PATH,
  leadStreamPingMs, pumpAnthropicStream,
} from "../src/llm/anthropic-route";
import { aggregateLeadUsage } from "../src/junior/usage";
import { GLM_LEAD_MODEL } from "../src/llm/translate";
import { POOL, type PoolModel } from "../src/llm/models";
import { setAssignedModel } from "../src/llm/model-store";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import { fakeCtx } from "./helpers/fake-ctx";

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

/** Task 4 (spec 2026-10-13-model-pool-design) — a smaller variant of
 *  `setup()` above, for the gateway/pool-overflow tests: takes a caller-built
 *  `ai` stub directly (so a test can assert on its own `run` mock's call
 *  args/sequence) instead of `setup()`'s own wrapped `vi.fn(async () =>
 *  aiResult)`. Builds the same authorized POST (`good` body, a freshly
 *  minted spawn token, a glm-led registry row) every other happy-path test
 *  in this file already does. `pool` (code review, Standards axis, #717):
 *  `handleFleetAnthropicMessages`'s own test-injection seam for the model
 *  pool pickModels walks — the same `rows`-style override already used for
 *  DB injection, now extended so a test can hand it a fixture pool instead
 *  of mutating the real, shared `models.ts` POOL export. */
async function callRoute(opts: {
  ai: { run: ReturnType<typeof vi.fn> };
  envOverrides?: Partial<Env>;
  pool?: readonly PoolModel[];
  /** Issue #1099: a streaming request body (`stream: true`) for the runaway tests. */
  body?: unknown;
  /** #767: fake sleep/random threaded through the handler's own 6th
   *  param, so a route-level test can pin the backoff schedule exactly
   *  without ever waiting a real 3s. */
  retryDeps?: { sleep?: (ms: number) => Promise<void>; random?: () => number };
}) {
  const token = mintSpawnToken();
  const rows = async () => [row(ME, await hashSpawnToken(token))];
  const e = { ...env, FLEET_JUNIOR: "on", AI: opts.ai, ...FAST_RETRY, ...(opts.envOverrides ?? {}) } as unknown as Env;
  return handleFleetAnthropicMessages(req({ token, body: opts.body }), e, ctx, rows, opts.pool, opts.retryDeps);
}

function req(opts: { token?: string | null; apiKey?: string; body?: unknown; path?: string; method?: string; signal?: AbortSignal }) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  const method = opts.method ?? "POST";
  return new Request(`https://w${opts.path ?? ANTHROPIC_MESSAGES_PATH}`, {
    method, headers, signal: opts.signal,
    body: method === "POST" ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? good)) : undefined,
  });
}
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  await env.DB.prepare("DELETE FROM junior_usage_log").run();
  ctx = fakeCtx();
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

  // The overflow-shaped sibling of the test above — Claude Code's client
  // recognizes "prompt is too long" to trigger auto-compact mid-session,
  // so the raw upstream overflow text must not pass through.
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

  // Fresh-context review, #717 critical follow-up: this is the critical gap
  // — Claude Code streams by default, so THIS path (pumpAnthropicStream ->
  // applyOpenAIStreamChunk/closeStreamOrError) is the one that actually
  // broke live GLM-lead studios mid-turn. Exercises the REAL route handler
  // end to end (a real SSE ReadableStream upstream, parsed back out of the
  // Response body), not the pure translate.ts functions in isolation.
  it("streaming: a huge upstream completion_tokens (reasoning_content inflation) is clamped to the request's own max_tokens in the final message_delta, not reported verbatim", async () => {
    const enc = new TextEncoder();
    const chunks = [
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 70000 } },
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
    const body = { model: "claude-opus-4-5", max_tokens: 8000, stream: true, messages: [{ role: "user", content: "hi" }] };

    const r = await handleFleetAnthropicMessages(req({ token, body }), e, ctx, rows);
    expect(r.status).toBe(200);
    const text = await r.text();
    const deltaLine = text.split("\n\n").find((frame) => frame.includes("message_delta"));
    const deltaData = JSON.parse(deltaLine!.slice(deltaLine!.indexOf("data:") + 5).trim()) as { usage: { output_tokens: number } };
    expect(deltaData.usage.output_tokens).toBe(8000);

    // The D1 usage-log row (what `handleFleetAnthropicMessages` bills
    // against) stays consistent with what the client was actually told,
    // rather than the raw, unclamped upstream figure.
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ studioId: ME, outputTokens: 8000, ok: 1 });
  });

  // Issue #519 (sweep 13): the `.finally(() => { writer.close().catch(() => {}) })`
  // after pumpAnthropicStream used to drop a failed close with no trace. The
  // pump itself already finished OK here -- the client consumed every frame
  // through message_stop, then went away before the close round-trip, which
  // is exactly the window where close() rejects (cancelling the readable
  // errors the writable side). The close failure must not disturb the
  // already-returned response or the usage row; it must log one
  // console.error. The fake DB below gates ONLY the usage insert on a
  // manual deferred (still forwarded to the real env.DB) so the cancel
  // deterministically lands between the pump's own return and the
  // `.finally`'s close() -- and so the row is released INSIDE this test's
  // own lifetime, never leaking into the next test's usageRows() read.
  it("a writer.close() rejection after the pump finished logs one console.error, and the ok usage row still lands (#519)", async () => {
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
    const realDb = env.DB;
    let releaseInsert: () => void = () => {};
    const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    let insertRun: Promise<unknown> | null = null;
    const gatedUsageDb = {
      prepare: (sql: string) => {
        if (!sql.includes("INSERT INTO junior_usage_log")) return realDb.prepare(sql);
        const stmt = realDb.prepare(sql);
        return {
          bind: (...args: unknown[]) => ({
            run: () => {
              insertRun = (async () => {
                await insertGate;
                return (stmt as unknown as { bind: (...a: unknown[]) => { run: () => Promise<unknown> } }).bind(...args).run();
              })();
              return insertRun;
            },
          }),
        };
      },
    } as unknown as D1Database;
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run }, DB: gatedUsageDb } as unknown as Env;

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
      expect(r.status).toBe(200);

      // Consume every frame the pump wrote -- through message_stop, the
      // last one -- so the pump's own writes have all resolved and it
      // returns ok. Then the client drops (cancel) while the insert is
      // still gated, before the `.finally`'s writer.close() runs.
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        if (text.includes("message_stop")) break;
      }
      expect(text).toContain("message_stop");
      await reader.cancel("client closed the tab before the close round-trip");
      await ctx.drain();

      const closeFailures = errors.mock.calls.filter((c) => c.join(" ").includes("writer close failed"));
      expect(closeFailures).toHaveLength(1);
      // The pump had already finished OK -- release the insert and let the
      // usage row land, ok:1.
      releaseInsert();
      await insertRun;
      const rowsLogged = await usageRows();
      expect(rowsLogged).toHaveLength(1);
      expect(rowsLogged[0]).toMatchObject({ studioId: ME, inputTokens: 7, outputTokens: 2, ok: 1, error: null });
    } finally {
      errors.mockRestore();
    }
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

  it("a slow-but-steady stream (gaps under LEAD_STREAM_IDLE_MS, total time over it) completes normally — the idle timer re-arms on every chunk", async () => {
    // Issue #304, item 1: the stall test above proves a PERMANENT stall trips
    // the timer, but a stream with gaps under the limit and total time over
    // it would pass even with one single overall deadline armed before the
    // loop. This pins the actual contract: every chunk re-arms the timer, so
    // a live stream that keeps making progress never trips it.
    const enc = new TextEncoder();
    const chunks = [
      ...Array.from({ length: 7 }, (_, i) => ({ choices: [{ delta: { content: `c${i}` } }] })),
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ];
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    let enqueued = 0;
    const upstream = new ReadableStream<Uint8Array>({
      // One SSE frame per pull, with a 40ms gap before each: every gap is
      // under the 200ms idle limit, but 8 pulls x 40ms ~ 320ms total is over
      // it — only per-chunk re-arming lets this stream through.
      async pull(controller) {
        if (enqueued >= chunks.length) { controller.close(); return; }
        await sleep(40);
        if (enqueued < chunks.length - 1) controller.enqueue(enc.encode(`data: ${JSON.stringify(chunks[enqueued])}\n\n`));
        else controller.enqueue(enc.encode(`data: ${JSON.stringify(chunks[enqueued])}\n\ndata: [DONE]\n\n`));
        enqueued++;
      },
    });
    const { token, rows, e } = await streamSetup(upstream, { LEAD_STREAM_IDLE_MS: "200" } as Partial<Env>);

    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    expect(r.status).toBe(200);
    const text = await r.text();
    const eventTypes = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(eventTypes).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_delta",
      "content_block_delta", "content_block_delta", "content_block_delta", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect(eventTypes).not.toContain("error");
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 1, error: null });
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
      // Issue #304: the reason is now failureClass()'s own output — class/
      // status only. `no_finish_reason` carries no upstream text, so its
      // redacted form is the string itself, unchanged.
      expect(line).toBe(`[glm-lead] call failed studio=${ME} stream=true in=0 out=0 reason=no_finish_reason`);
      expect(line).not.toContain("TOP-SECRET-PROMPT-TEXT");
    } finally {
      spy.mockRestore();
    }
  });

  // Board issue #304, item 3: the upstream's OWN error message can echo
  // request input — a context-overflow error quoting the prompt is the
  // exact shape that motivated this. `wrangler tail` output outlives the
  // request, so the console line must carry the failure CLASS only. The D1
  // `error` column is NOT redacted: the full message stays there for
  // diagnosis (issue #302's truncation cap still applies).
  it("a prompt-echoing upstream error never reaches the console line, but the full message stays in the D1 error column (issue #304)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { token, rows, e } = await setup();
      (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(async () => {
        throw new Error("bad input near: TOP-SECRET-PROMPT-TEXT");
      });
      const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
      expect(r.status).toBe(500);
      await ctx.drain();
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0].map(String).join(" ");
      expect(line).not.toContain("TOP-SECRET-PROMPT-TEXT");
      expect(line).toContain("reason=ai_run_error 500 api_error");
      expect((await usageRows())[0].error).toBe("ai_run_error 500 api_error: bad input near: TOP-SECRET-PROMPT-TEXT");
    } finally {
      spy.mockRestore();
    }
  });

  it("failureClass keeps the class/status and drops everything from the first ':' onward (issue #304)", async () => {
    const { failureClass } = await import("../src/llm/anthropic-route");
    // Plain reasons never carry upstream text — they pass through unchanged.
    expect(failureClass("idle_timeout after 40ms")).toBe("idle_timeout after 40ms");
    expect(failureClass("client_abort")).toBe("client_abort");
    expect(failureClass("no_finish_reason")).toBe("no_finish_reason");
    // Every failureReason shape: everything from the FIRST ':' onward is
    // the upstream message — dropped, even when the message itself carries
    // more colons.
    expect(failureClass("upstream_read_error overloaded_error: AiError: capacity exceeded mid-stream"))
      .toBe("upstream_read_error overloaded_error");
    expect(failureClass("upstream_error_chunk api_error: upstream blew up")).toBe("upstream_error_chunk api_error");
    expect(failureClass("ai_run_error 504 api_error: upstream timeout")).toBe("ai_run_error 504 api_error");
    expect(failureClass("pump_error: something broke inside the pump")).toBe("pump_error");
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

  it("a 4xx-mapped error is never retried (context overflow 400); a rate limit 429 gets only #767 backoff, not a #335 retry", async () => {
    // Context overflow: classifyAiError maps it to a 400 — runAiWithRetry
    // does not retry it, and it is not a rate limit, so #767's backoff
    // does not fire either: exactly one call, fail fast.
    {
      const { token, rows, e } = await setup();
      const run = vi.fn(async () => { throw new Error("This model's maximum context length is 32768 tokens"); });
      (e.AI as { run: unknown }).run = run;
      const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
      expect(r.status).toBeLessThan(500);
      expect(run).toHaveBeenCalledTimes(1);
    }
    // Rate limit: still not a #335 retryable status (runAiWithRetry only
    // retries 504/529), but #767's backoff now fires — pool off means the
    // single model has nowhere else to go, so it reruns up to 4 extra
    // rounds on the backoff schedule before reporting the 429.
    {
      const sleeps: number[] = [];
      const { token, rows, e } = await setup();
      const run = vi.fn(async () => { throw new Error("AiError: rate limit reached"); });
      (e.AI as { run: unknown }).run = run;
      const r = await handleFleetAnthropicMessages(
        req({ token }), e, ctx, rows,
        undefined,
        { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 },
      );
      expect(r.status).toBe(429);
      expect(run).toHaveBeenCalledTimes(5);
      expect(sleeps).toEqual([2100, 4200, 8400, 14000]);
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

  // The request's tools are real prompt material the backend re-receives
  // every call — an estimate that ignores them comes in low and skews
  // Claude Code's compact decisions the endpoint exists to feed.
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

  // Still throttled — the endpoint spends no AI budget, but an unthrottled
  // endpoint is a free D1-hammering surface — now from its OWN per-minute
  // budget, never the messages route's.
  it("429 once its OWN per-minute limit is exceeded — same Anthropic rate_limit_error body + retry-after (#298-3)", async () => {
    const { token, rows, e } = await setup(undefined, { LEAD_COUNT_TOKENS_RATE_PER_MINUTE: "1" });
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
      error: { type: "rate_limit_error", message: "rate limit exceeded: too many count_tokens calls this minute" },
    });
  });

  // A count_tokens call must spend NOTHING from the messages budget: the
  // busiest GLM studio ran ~1800 count_tokens calls a day, and drawing them
  // from the shared per-minute/daily counters locked studios out.
  it("count_tokens and /messages have separate per-minute budgets — a count_tokens call spends none of /messages'", async () => {
    const { token, rows, e } = await setup(undefined, { LEAD_RATE_PER_MINUTE: "1", LEAD_COUNT_TOKENS_RATE_PER_MINUTE: "1" });
    const count = await handleFleetAnthropicCountTokens(req({ token, path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows);
    expect(count.status).toBe(200);
    // /messages still answers 200 — the count_tokens call above spent none
    // of its per-minute budget.
    const msg = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(msg.status).toBe(200);
    // The SECOND count_tokens call is what trips count_tokens' own budget.
    const counted = await handleFleetAnthropicCountTokens(req({ token, path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows);
    expect(counted.status).toBe(429);
    const retryAfter = counted.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(await counted.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "rate limit exceeded: too many count_tokens calls this minute" },
    });
  });

  // count_tokens spends no AI budget, so no daily cap applies to it — and
  // /messages' own daily cap must never gate it either.
  it("count_tokens has no daily cap — /messages' LEAD_DAILY_CAP does not gate it", async () => {
    const { token, rows, e } = await setup(undefined, { LEAD_DAILY_CAP: "1" });
    const msg = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(msg.status).toBe(200);
    const count = await handleFleetAnthropicCountTokens(req({ token, path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows);
    expect(count.status).toBe(200);
  });
});

// Task 4 (spec 2026-10-13-model-pool-design, Components 3/4): every
// env.AI.run call now carries the AI Gateway option (unified billing/logs),
// and LEAD_MODEL_POOL=on walks router.ts's pickModels order on a 429/3021,
// instead of hardcoding GLM.
// Lead-model routing (#1070): calls that hit the output cap (GLM_MAX_MAX_TOKENS,
// translate.ts) must end as a clean `max_tokens` turn, never an error or a
// hang. These pin the route-level path end to end; the translation units
// live in test/bun/llm-translate-*.test.ts.
describe("handleFleetAnthropicMessages — output cap ends cleanly (#1070)", () => {
  it("a non-streaming reply cut at the cap with no tool_use (finish_reason length) is a retriable 529, never a 200 max_tokens", async () => {
    // The route always streams upstream (review round 3), so the mock is a stream.
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "partial answer" } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 40, completion_tokens: 32000 } })}\n\n` +
          "data: [DONE]\n\n",
        ));
        controller.close();
      },
    });
    const { token, rows, e, run } = await setup();
    (run as unknown as { mockImplementation: (fn: () => Promise<unknown>) => void }).mockImplementation(async () => upstream);
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, max_tokens: 4000 } }), e, ctx, rows);
    expect(r.status).toBe(529);
    expect(await r.json()).toMatchObject({ type: "error", error: { type: "overloaded_error" } });
  });

  it("a streaming reply cut at the cap with no tool_use ends with event: error overloaded_error, never max_tokens", async () => {
    const chunk = (c: unknown) => `data: ${JSON.stringify(c)}\n\n`;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          chunk({ choices: [{ delta: { content: "partial" } }] }) +
          chunk({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 40, completion_tokens: 32000 } }) +
          "data: [DONE]\n\n",
        ));
        controller.close();
      },
    });
    const { token, rows, e, run } = await setup();
    (run as unknown as { mockImplementation: (fn: () => Promise<unknown>) => void }).mockImplementation(async () => upstream);
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true, max_tokens: 4000 } }), e, ctx, rows);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("event: error");
    expect(text).toContain('"type":"overloaded_error"');
    expect(text).not.toContain('"stop_reason":"max_tokens"');
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 0, error: "runaway:length" });
  });

  it("a client max_tokens above the model ceiling is sent upstream clamped to GLM_MAX_MAX_TOKENS (32000), never passed through", async () => {
    const { token, rows, e, run } = await setup();
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, max_tokens: 64000 } }), e, ctx, rows);
    expect(r.status).toBe(200);
    const sent = (run.mock.calls[0] as unknown[])[1] as { max_tokens: number };
    expect(sent.max_tokens).toBe(32000);
  });
});

describe("model pool + gateway (spec 2026-10-13)", () => {
  // Incident fix (#717): a production account's "default" AI Gateway isn't
  // provisioned for unified billing — `ai.run(model, body, { gateway: { id:
  // "default" } })` came back "2021: Insufficient unified billing credits"
  // for EVERY GLM lead call the instant this got deployed. The gateway
  // option is now OFF unless `LEAD_AI_GATEWAY_ID` is actually set to a
  // non-empty string — unset means the exact pre-model-pool call shape:
  // `ai.run(model, body)`, no third argument at all (not `undefined`, not
  // `{}` — a genuinely 2-length args array, since a provider could branch on
  // `arguments.length`).
  it("LEAD_AI_GATEWAY_ID unset: ai.run is called with no gateway option at all (2 args)", async () => {
    const calls: unknown[][] = [];
    const ai = { run: vi.fn(async (...a: unknown[]) => { calls.push(a); return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; }) };
    const res = await callRoute({ ai, envOverrides: {} });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("@cf/zai-org/glm-5.3");
    expect(calls[0].length).toBe(2);
  });

  it("LEAD_AI_GATEWAY_ID set to empty string: same as unset — no gateway option, 2 args", async () => {
    const calls: unknown[][] = [];
    const ai = { run: vi.fn(async (...a: unknown[]) => { calls.push(a); return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_AI_GATEWAY_ID: "" } });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].length).toBe(2);
  });

  it("pool on: 3021 on first model moves to next model, no backoff", async () => {
    // The real pool has exactly ONE smoke-passed model today (GLM —
    // models.ts's own POOL, kimi/deepseek not yet smoke-tested) — pickModels
    // never offers a smoke-UNtested model as an overflow candidate (the
    // pool's own entry rule, enforced in router.ts, not something this
    // route may bypass), so there is genuinely no SECOND model to move to
    // without a fixture pool where kimi has smoke-passed. Built as a plain
    // copy of the real POOL (code review, Standards axis, #717) and handed
    // to `callRoute`'s own `pool` override — `handleFleetAnthropicMessages`'s
    // test-injection seam — rather than mutating the real, shared `models.ts`
    // POOL export, which no sibling test could be sure stayed unmutated.
    const kimi = { ...POOL[1], smokePassed: true };
    const testPool: readonly PoolModel[] = [POOL[0], kimi, POOL[2]];
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      if (seen.length === 1) throw new Error("3021: rate limiting: Account rate limit exceeded");
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
    // Global Constraint: logUsage must record the model actually used
    // (`usedModel`) — the SECOND model tried, never a hardcoded constant
    // (code review, Spec axis, #717).
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0].model).toBe(seen[1]);
  });

  it("pool on: every model 429s → 429 rate_limit_error with retry-after", async () => {
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => { seen.push(model); throw new Error("3021: Account rate limit exceeded"); }) };
    const res = await callRoute({
      ai, envOverrides: { LEAD_MODEL_POOL: "on" },
      retryDeps: { sleep: async () => {}, random: () => 0 },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect((await res.json() as any).error.type).toBe("rate_limit_error");
    // #767: the LAST candidate has no untried model left to move to (every
    // other candidate already 3021'd this walk), so it reruns through the
    // same-model backoff — 1 first turn + 4 backoff rounds. 3 candidates
    // in the pool → 1 + 1 + 5 = 7 ai.run calls.
    expect(ai.run).toHaveBeenCalledTimes(7);
    // Global Constraint: the logged usage row's model must be the LAST
    // model actually tried, never a hardcoded constant (code review,
    // Spec axis, #717).
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0].model).toBe(seen[seen.length - 1]);
  });

  // Review Focus item 3: a genuine multi-model exhaustion — the real POOL
  // has only one smoke-passed model today, so the test above cannot
  // distinguish "last model tried" from "first model tried" (code review,
  // Spec axis, #717). Built the same way as the "moves to next model"
  // fixture pool above: a plain copy of the real POOL with every entry
  // forced to `smokePassed: true`, handed to `callRoute`'s own `pool`
  // injection seam rather than mutating the shared `models.ts` POOL export.
  it("pool on: 3021 on every model (genuine multi-model exhaustion) → 429, first models once, LAST model retried via #767 backoff, usage row logs the LAST model tried", async () => {
    const testPool: readonly PoolModel[] = POOL.map((m) => ({ ...m, smokePassed: true }));
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      throw new Error("3021: rate limiting: Account rate limit exceeded");
    }) };
    const res = await callRoute({
      ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool,
      retryDeps: { sleep: async () => {}, random: () => 0 },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect((await res.json() as any).error.type).toBe("rate_limit_error");
    // router.ts's own round-robin hash of the studio id picks WHICH pool
    // model goes first — not necessarily the pool's declaration order — so
    // this asserts against `seen` (the actual try order), not a hardcoded
    // sequence. #767: the FIRST candidates are fresh on their own turn, so
    // each is tried once; the LAST candidate has no untried model to move
    // to (every other candidate already 3021'd this walk), so it reruns
    // through the same-model backoff — 1 first turn + 4 backoff rounds.
    expect(ai.run).toHaveBeenCalledTimes(testPool.length + 4);
    expect(seen).toHaveLength(testPool.length + 4);
    expect(new Set(seen)).toEqual(new Set(testPool.map((m) => m.id)));
    expect(seen.filter((m) => m === seen[seen.length - 1])).toHaveLength(5);
    expect(seen[seen.length - 1]).not.toBe(seen[0]);
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    // The logged model is the LAST one actually tried — not the first, and
    // not a hardcoded GLM constant.
    expect(rowsLogged[0].model).toBe(seen[seen.length - 1]);
    expect(rowsLogged[0].model).not.toBe(seen[0]);
    expect(rowsLogged[0].model).not.toBe(GLM_LEAD_MODEL);
  });

  // Incident fix (#717 continued, production 2026-10-13): kimi/deepseek/GLM
  // all measured upstream 500s the overflow loop used to treat as terminal —
  // `4002: could not route request to AI model` and `8005: Internal server
  // error` — breaking the loop and failing the turn instead of moving to the
  // next pool candidate. Same fixture shape as "3021 on first model moves to
  // next model" above: a kimi copy forced to `smokePassed: true` so there is
  // a genuine second candidate to move to.
  it("pool on: upstream 4002 (could not route) on first model moves to next model, no backoff", async () => {
    const kimi = { ...POOL[1], smokePassed: true };
    const testPool: readonly PoolModel[] = [POOL[0], kimi, POOL[2]];
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      if (seen.length === 1) throw new Error("500 api_error: 4002: could not route request to AI model");
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool });
    expect(res.status).toBe(200);
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
    // No same-model retry on this error shape — the first model was tried
    // exactly once before the loop moved on, unlike 504/529's own
    // runAiWithRetry same-model retry.
    expect(seen.filter((m) => m === seen[0])).toHaveLength(1);
  });

  it("pool on: upstream 8005 (Internal server error) on first model moves to next model, no backoff", async () => {
    const kimi = { ...POOL[1], smokePassed: true };
    const testPool: readonly PoolModel[] = [POOL[0], kimi, POOL[2]];
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      if (seen.length === 1) throw new Error("8005: Internal server error");
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool });
    expect(res.status).toBe(200);
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.filter((m) => m === seen[0])).toHaveLength(1);
  });

  // Lead-model routing (#1070): a 504/529 used to spend LEAD_AI_MAX_RETRIES
  // same-model retries (~235 s each on a 3046 timeout) before the overflow
  // loop ever moved on. With another candidate left in the order, the first
  // failure now moves straight to it; the same-model retry only runs on the
  // LAST candidate, where no other model is left to move to.
  it("pool on: a 504 (3046 timeout) on the first model moves to the next model after one attempt — no same-model retry (#1070)", async () => {
    const kimi = { ...POOL[1], smokePassed: true };
    const testPool: readonly PoolModel[] = [POOL[0], kimi, POOL[2]];
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      if (seen.length === 1) throw new Error("AiError: 3046: Request timeout");
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool });
    expect(res.status).toBe(200);
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.filter((m) => m === seen[0])).toHaveLength(1);
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 1, attempts: 2, model: seen[1] });
  });

  it("pool on: a 529 (capacity) on the first model moves to the next model after one attempt — no same-model retry (#1070)", async () => {
    const kimi = { ...POOL[1], smokePassed: true };
    const testPool: readonly PoolModel[] = [POOL[0], kimi, POOL[2]];
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      if (seen.length === 1) throw new Error("AiError: capacity exceeded");
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool });
    expect(res.status).toBe(200);
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(seen.filter((m) => m === seen[0])).toHaveLength(1);
  });

  it("pool on: a 504 on every model — each earlier candidate is tried once, only the LAST candidate gets the same-model retry (#1070)", async () => {
    const testPool: readonly PoolModel[] = POOL.map((m) => ({ ...m, smokePassed: true }));
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      throw new Error("AiError: 3046: Request timeout");
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool });
    expect(res.status).toBe(504);
    // 1 try on each non-last candidate, then the last candidate's own
    // runAiWithRetry: 3 attempts (1 + LEAD_AI_MAX_RETRIES).
    expect(ai.run).toHaveBeenCalledTimes(testPool.length - 1 + 3);
    const last = seen[seen.length - 1];
    expect(seen.filter((m) => m === last)).toHaveLength(3);
    for (const m of new Set(seen.slice(0, -3))) expect(seen.filter((x) => x === m)).toHaveLength(1);
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 0, attempts: testPool.length - 1 + 3, model: last });
  });

  it("pool on with only one candidate: a 504 still gets the full same-model retry — nothing else to move to", async () => {
    const testPool: readonly PoolModel[] = [POOL[0]];
    const ai = { run: vi.fn(async () => { throw new Error("AiError: 3046: Request timeout"); }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool });
    expect(res.status).toBe(504);
    expect(ai.run).toHaveBeenCalledTimes(3);
  });

  // LEAD_MODEL_OVERFLOW=off (#768): each model has its own 20 rpm budget, so
  // keeping a studio on its ONE assigned model spreads capacity across the
  // pool. Same fixture pool shape as the overflow tests above — a kimi copy
  // forced to `smokePassed: true` — plus a real D1 assigned-model row, so
  // the route reads a genuine assignment, never a hardcoded constant.
  it("LEAD_MODEL_OVERFLOW=off: assigned kimi is the only model tried — no overflow candidates", async () => {
    const kimi = { ...POOL[1], smokePassed: true };
    const testPool: readonly PoolModel[] = [POOL[0], kimi, POOL[2]];
    await setAssignedModel(env.DB, ME, POOL[1].id);
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on", LEAD_MODEL_OVERFLOW: "off" }, pool: testPool });
    expect(res.status).toBe(200);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([POOL[1].id]);
  });

  it("LEAD_MODEL_OVERFLOW=off: 3021 on the assigned model → same-model #767 backoff, then 429, no second-model call", async () => {
    const kimi = { ...POOL[1], smokePassed: true };
    const testPool: readonly PoolModel[] = [POOL[0], kimi, POOL[2]];
    await setAssignedModel(env.DB, ME, POOL[1].id);
    const seen: string[] = [];
    const sleeps: number[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      throw new Error("3021: Account rate limit exceeded");
    }) };
    const res = await callRoute({
      ai, envOverrides: { LEAD_MODEL_POOL: "on", LEAD_MODEL_OVERFLOW: "off" }, pool: testPool,
      retryDeps: { sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0 },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect((await res.json() as any).error.type).toBe("rate_limit_error");
    // #767: overflow off means ONE candidate, so the same-model backoff
    // fires — the assigned model reruns 1 first turn + 4 backoff rounds
    // (fake sleep, jitter 0) before the 429. Still no second-model call.
    expect(ai.run).toHaveBeenCalledTimes(5);
    expect(seen).toEqual(Array.from({ length: 5 }, () => POOL[1].id));
    expect(sleeps.map(Math.round)).toEqual([2100, 4200, 8400, 14000]);
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0].model).toBe(POOL[1].id);
  });

  it("LEAD_MODEL_OVERFLOW unset (default on): 3021 on first model still moves to next — overflow behavior unchanged", async () => {
    const kimi = { ...POOL[1], smokePassed: true };
    const testPool: readonly PoolModel[] = [POOL[0], kimi, POOL[2]];
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      if (seen.length === 1) throw new Error("3021: Account rate limit exceeded");
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  // Code review (Spec axis, #717): the whole point of `isOverflowRoutingError`
  // being its OWN predicate rather than folded into `isRateLimited` is that
  // an all-models-exhausted 4002/8005 run reports `classifyAiError`'s own
  // default (500 `api_error`), NOT the 429 `rate_limit_error` the
  // all-exhausted call site reports when `isRateLimited` triggered the
  // exhaustion (see the "3021 on every model" test above). Same fixture
  // shape as that test — every POOL entry forced to `smokePassed: true` —
  // but throwing the 4002 incident string instead of a 3021.
  it("pool on: 4002 on every model (genuine multi-model exhaustion) → 500 api_error, NOT 429 rate_limit_error", async () => {
    const testPool: readonly PoolModel[] = POOL.map((m) => ({ ...m, smokePassed: true }));
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      throw new Error("500 api_error: 4002: could not route request to AI model");
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool });
    expect(res.status).toBe(500);
    expect((await res.json() as any).error.type).toBe("api_error");
    expect(ai.run).toHaveBeenCalledTimes(testPool.length);
    expect(seen).toHaveLength(testPool.length);
  });

  it("custom gateway id via LEAD_AI_GATEWAY_ID", async () => {
    const calls: unknown[][] = [];
    const ai = { run: vi.fn(async (...a: unknown[]) => { calls.push(a); return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; }) };
    await callRoute({ ai, envOverrides: { LEAD_AI_GATEWAY_ID: "fleet" } });
    expect(calls[0][2]).toEqual({ gateway: { id: "fleet" } });
  });
});

// #767: GLM's account is capped at 20 rpm, so ~60% of lead calls throw
// `3021: rate limiting` from env.AI.run. The overflow walk's
// move-to-next-model rule cannot help when there is no next model (pool
// off, or every other candidate already 3021'd this walk), and a bare 429
// makes Claude Code burn its own retry budget and end the turn. The fix
// this block pins: rerun the SAME model on a jittered backoff schedule
// [3s,6s,12s,20s] (±30%, cumulative sleep capped 45s) before giving up.
describe("#767 — 3021 same-model backoff", () => {
  // The measured production string — classifyAiError maps it to a 429,
  // which runAiWithRetry does NOT retry (only 504/529), so each backoff
  // round is exactly one ai.run call.
  const R3021 = "3021: rate limiting: inference request per min rate reached";
  const okReply = { choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } };

  /** A run stub that throws the 3021 for its first `n` calls, then replies. */
  function rateThen(n: number, then: unknown = okReply) {
    let calls = 0;
    return vi.fn(async () => {
      if (calls < n) { calls++; throw new Error(R3021); }
      return then;
    });
  }

  function fakeSleep() {
    const sleeps: number[] = [];
    return { sleeps, deps: { sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0 } };
  }

  // Schedule pins use random=0 (the 70% jitter floor) unless a test
  // specifically exercises the jitter itself.

  it("direct runAiWithRateLimitBackoff: 3021,3021,ok resolves with attempts 3, sleeping 2100 then 4200 (random=0)", async () => {
    const { runAiWithRateLimitBackoff } = await import("../src/llm/anthropic-route");
    const { sleeps, deps } = fakeSleep();
    const run = rateThen(2);
    const r = await runAiWithRateLimitBackoff(run, { baseMs: 1, ...deps });
    expect(r).toEqual({ value: okReply, attempts: 3 });
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2100, 4200]);
  });

  it("direct: 5x3021 rejects as AiRunError with attempts 5, sleeping [2100,4200,8400,14000] (random=0)", async () => {
    const { runAiWithRateLimitBackoff } = await import("../src/llm/anthropic-route");
    const { sleeps, deps } = fakeSleep();
    const run = rateThen(5);
    await expect(runAiWithRateLimitBackoff(run, { baseMs: 1, ...deps })).rejects.toMatchObject({
      message: R3021, attempts: 5,
    });
    expect(run).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([2100, 4200, 8400, 14000]);
  });

  it("direct: a non-rate-limited 500 rejects immediately, zero sleeps", async () => {
    const { runAiWithRateLimitBackoff } = await import("../src/llm/anthropic-route");
    const { sleeps, deps } = fakeSleep();
    const run = vi.fn(async () => { throw new Error("AiError: something else broke"); });
    await expect(runAiWithRateLimitBackoff(run, { baseMs: 1, ...deps })).rejects.toMatchObject({
      message: "AiError: something else broke", attempts: 1,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("direct: random=1 sleeps [3900,7800,15600,17700] — the 45s cap clamps the 4th round", async () => {
    const { runAiWithRateLimitBackoff, RATE_LIMIT_BACKOFF_CAP_MS } = await import("../src/llm/anthropic-route");
    expect(RATE_LIMIT_BACKOFF_CAP_MS).toBe(45_000);
    const sleeps: number[] = [];
    const run = rateThen(5);
    const deps = { sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 1 };
    await expect(runAiWithRateLimitBackoff(run, { baseMs: 1, ...deps })).rejects.toMatchObject({ attempts: 5 });
    // 130% of [3000,6000,12000] then the cap clamps 20000*1.3 to the
    // remaining 45000 - (3900+7800+15600) = 17700. Rounded: 3000*1.3 is
    // 3899.999... in float math, so compare rounded values, not exact.
    expect(sleeps.map(Math.round)).toEqual([3900, 7800, 15600, 17700]);
    expect(Math.round(sleeps.reduce((a, b) => a + b, 0))).toBe(45_000);
  });

  it("route-level pool-off (order=[glm]): 3021,3021,ok → 200, usage row attempts 3", async () => {
    const { sleeps, deps } = fakeSleep();
    const ai = { run: rateThen(2) };
    const res = await callRoute({ ai, retryDeps: deps });
    expect(res.status).toBe(200);
    expect(ai.run).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2100, 4200]);
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ ok: 1, attempts: 3, model: GLM_LEAD_MODEL });
  });

  it("route-level pool-off: 5x3021 → 429 rate_limit_error + retry-after 30, usage row attempts 5", async () => {
    const { sleeps, deps } = fakeSleep();
    const ai = { run: rateThen(5) };
    const res = await callRoute({ ai, retryDeps: deps });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect((await res.json() as any).error.type).toBe("rate_limit_error");
    expect(sleeps).toEqual([2100, 4200, 8400, 14000]);
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ ok: 0, attempts: 5, model: GLM_LEAD_MODEL });
  });

  it("route-level pool-on, 3-model fixture pool: 3021 on the first model moves to the next — sleep never called", async () => {
    // Same fixture-pool shape as the #717 tests above: a plain copy of the
    // real POOL, every entry smoke-passed, handed to callRoute's own `pool`
    // injection seam — never a mutation of the shared models.ts export.
    const testPool: readonly PoolModel[] = POOL.map((m) => ({ ...m, smokePassed: true }));
    const { sleeps, deps } = fakeSleep();
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      if (seen.length === 1) throw new Error(R3021);
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, retryDeps: deps });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    // Today's move-to-next-model-first rule is pinned: no same-model
    // backoff fires while another untried candidate remains.
    expect(sleeps).toEqual([]);
  });

  it("route-level pool-on: first model 3021, second model 3021 → backoff fires on the second round (every other candidate seen)", async () => {
    const testPool: readonly PoolModel[] = POOL.map((m) => ({ ...m, smokePassed: true }));
    const { sleeps, deps } = fakeSleep();
    const perModel: Record<string, number> = {};
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      perModel[model] = (perModel[model] ?? 0) + 1;
      seen.push(model);
      // Round 1: every candidate 3021s once, in walk order. Round 2: the
      // LAST candidate's rerun finally succeeds.
      if (perModel[model] === 1) throw new Error(R3021);
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, retryDeps: deps });
    expect(res.status).toBe(200);
    // First walk: all 3 candidates, once each, no backoff. Second walk
    // reruns the last one (every OTHER candidate already seen) with a
    // backoff sleep before its rerun.
    expect(seen).toHaveLength(4);
    expect(sleeps).toEqual([2100]);
    const last = seen[2];
    expect(seen[3]).toBe(last);
  });
});

// Issue #1073: `<think>` parsing and think-block tool-call recovery run ONLY
// for the kimi stream. A GLM stream with the same literal `<think>` text must
// reach the client unchanged.
describe("handleFleetAnthropicMessages — think-block parsing is kimi-only (issue #1073)", () => {
  const THINK_TOOL_CALL = '<think><tool_call>{"name":"Read","arguments":{"file_path":"/workspace/acme/README.md"}}</tool_call></think>';

  function sseStream(content: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  /** Drives the real handler with a stream:true request, pool pinned to one model. */
  async function streamVia(pool: readonly PoolModel[], content: string) {
    const token = mintSpawnToken();
    const rows = async () => [row(ME, await hashSpawnToken(token))];
    const run = vi.fn(async () => sseStream(content));
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run }, ...FAST_RETRY } as unknown as Env;
    return handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows, pool);
  }

  function parseEvents(text: string) {
    return text.split("\n\n").filter(Boolean).map((f) => {
      const [eventLine, dataLine] = f.split("\n");
      return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) as Record<string, any> };
    });
  }

  it("a kimi stream recovers the think-block tool call as a tool_use block", async () => {
    const kimiOnly: readonly PoolModel[] = [{ ...POOL[1], smokePassed: true }];
    const r = await streamVia(kimiOnly, THINK_TOOL_CALL);
    expect(r.status).toBe(200);
    const events = parseEvents(await r.text());
    expect(events.find((e) => e.event === "content_block_start")?.data.content_block).toMatchObject({ type: "tool_use", name: "Read" });
    expect(events.some((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")).toBe(false);
  });

  it("a GLM stream with the same literal <think> text passes it through as visible text, no tool_use", async () => {
    const glmOnly: readonly PoolModel[] = [{ ...POOL[0], smokePassed: true }];
    const r = await streamVia(glmOnly, THINK_TOOL_CALL);
    expect(r.status).toBe(200);
    const events = parseEvents(await r.text());
    expect(events.some((e) => e.event === "content_block_start" && e.data.content_block.type === "tool_use")).toBe(false);
    const visible = events.filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta").map((e) => e.data.delta.text).join("");
    expect(visible).toBe(THINK_TOOL_CALL);
  });
});

// Issue #1099: a degenerate stream is aborted mid-turn with a retriable
// overloaded_error, logged as runaway:<reason>, and the studio's next call
// moves to another pool model (LEAD_MODEL_OVERFLOW on).
describe("handleFleetAnthropicMessages — runaway output abort (issue #1099)", () => {
  function sseOf(contents: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const content of contents) controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  const looping = Array.from({ length: 60 }, () => "the same looping sentence here, again and again\n");
  const testPool: readonly PoolModel[] = POOL.map((m) => ({ ...m, smokePassed: true }));

  it("a runaway stream ends with a retriable overloaded_error, never a normal end_turn", async () => {
    const run = vi.fn(async () => sseOf(looping));
    const r = await callRoute({ ai: { run }, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, body: { ...good, stream: true } });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("event: error");
    expect(text).toContain('"type":"overloaded_error"');
    expect(text).not.toContain('"stop_reason":"end_turn"');
    expect(text).not.toContain("event: message_stop");
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged.at(-1)).toMatchObject({ ok: 0, error: "runaway:repeat_line" });
  });

  it("after a runaway abort the studio's next call goes to a different model", async () => {
    const seen: string[] = [];
    const run = vi.fn(async (model: string) => {
      seen.push(model);
      return seen.length === 1 ? sseOf(looping) : sseOf(["fine answer"]);
    });
    const first = await callRoute({ ai: { run }, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, body: { ...good, stream: true } });
    await first.text();
    await ctx.drain();
    const second = await callRoute({ ai: { run }, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, body: { ...good, stream: true } });
    expect(second.status).toBe(200);
    await second.text();
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it("with LEAD_MODEL_OVERFLOW=off the retry stays on the same model", async () => {
    const seen: string[] = [];
    const run = vi.fn(async (model: string) => {
      seen.push(model);
      return seen.length === 1 ? sseOf(looping) : sseOf(["fine answer"]);
    });
    const envOverrides = { LEAD_MODEL_POOL: "on", LEAD_MODEL_OVERFLOW: "off" } as Partial<Env>;
    const first = await callRoute({ ai: { run }, envOverrides, pool: testPool, body: { ...good, stream: true } });
    await first.text();
    await ctx.drain();
    const second = await callRoute({ ai: { run }, envOverrides, pool: testPool, body: { ...good, stream: true } });
    await second.text();
    expect(seen[1]).toBe(seen[0]);
  });
});

// Maestro review (#1099 follow-up): findings 1 (non-streaming path had no
// scan — a 32k-token loop went out as a 200), 5 (cancelUpstream untested;
// runaway usage row logged 0/0).
describe("handleFleetAnthropicMessages — runaway review follow-ups (issue #1099)", () => {
  const looping = Array.from({ length: 60 }, () => "the same looping sentence here, again and again\n");
  const testPool: readonly PoolModel[] = POOL.map((m) => ({ ...m, smokePassed: true }));

  function trackedStream(contents: string[], onCancel: () => void, finish = false): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const content of contents) controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        // A runaway is left open on purpose: a real upstream is still generating,
        // and a closed stream never fires its cancel callback. A clean reply closes.
        if (finish) controller.close();
      },
      cancel() { onCancel(); },
    });
  }

  it("a streamed runaway cancels the upstream read (no tokens paid after the trip)", async () => {
    let cancelled = false;
    const run = vi.fn(async () => trackedStream(looping, () => { cancelled = true; }));
    const r = await callRoute({ ai: { run }, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, body: { ...good, stream: true } });
    await r.text();
    await ctx.drain();
    expect(cancelled).toBe(true);
  });

  it("a non-streaming runaway returns 529 overloaded_error before any byte, and cancels upstream", async () => {
    let cancelled = false;
    const run = vi.fn(async () => trackedStream(looping, () => { cancelled = true; }));
    const r = await callRoute({ ai: { run }, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, body: good });
    expect(r.status).toBe(529);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await r.json()).toMatchObject({ type: "error", error: { type: "overloaded_error" } });
    expect(cancelled).toBe(true);
    await ctx.drain();
    expect((await usageRows()).at(-1)).toMatchObject({ ok: 0, error: "runaway:repeat_line" });
  });

  it("a runaway usage row records non-zero input and output counts", async () => {
    const run = vi.fn(async () => trackedStream(looping, () => {}));
    const r = await callRoute({ ai: { run }, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, body: { ...good, stream: true } });
    await r.text();
    await ctx.drain();
    const row = (await usageRows()).at(-1)!;
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.outputTokens).toBeGreaterThan(0);
  });

  it("a non-streaming reply with no finish_reason is an error, never a 200 end_turn", async () => {
    const enc = new TextEncoder();
    const run = vi.fn(async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "cut off mid" } }] })}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }));
    const r = await callRoute({ ai: { run }, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, body: good });
    expect(r.status).not.toBe(200);
    expect(await r.json()).toMatchObject({ type: "error" });
  });

  it("a non-streaming tool_use reply is rebuilt from the translator frames (text + tool block, stop_reason tool_use)", async () => {
    const enc = new TextEncoder();
    const run = vi.fn(async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "reading" } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "Read", arguments: "{\"file_path\":\"a.ts\"}" } }] } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }));
    const r = await callRoute({ ai: { run }, envOverrides: { LEAD_MODEL_POOL: "on" }, pool: testPool, body: good });
    expect(r.status).toBe(200);
    const reply = (await r.json()) as { stop_reason: string; content: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
    expect(reply.stop_reason).toBe("tool_use");
    expect(reply.content[0]).toMatchObject({ type: "text", text: "reading" });
    expect(reply.content[1]).toMatchObject({ type: "tool_use", name: "Read", input: { file_path: "a.ts" } });
  });

  it("two runaways in a row avoid both models (the avoid set grows)", async () => {
    const seen: string[] = [];
    const run = vi.fn(async (model: string) => {
      seen.push(model);
      return seen.length <= 2 ? trackedStream(looping, () => {}) : trackedStream(["fine answer"], () => {}, true);
    });
    const envOverrides = { LEAD_MODEL_POOL: "on" } as Partial<Env>;
    for (let i = 0; i < 2; i++) {
      const r = await callRoute({ ai: { run }, envOverrides, pool: testPool, body: { ...good, stream: true } });
      await r.text();
      await ctx.drain();
    }
    const third = await callRoute({ ai: { run }, envOverrides, pool: testPool, body: { ...good, stream: true } });
    await third.text();
    expect(seen).toHaveLength(3);
    expect(seen[2]).not.toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[1]);
  });
});

// Issue #1147: a long generation sits silent upstream (prefill of a ~120k-token
// prompt, then a long output), and the client gets no bytes. Two defects:
// the streaming path emits no keepalive, and a client that hangs up is only
// noticed on the NEXT write, so a silent drop logs ok=1 (non-streaming) or
// lingers until the idle timer (streaming). Fixtures use small ms values so
// the suite stays on real timers, same as the #302 block above.
describe("handleFleetAnthropicMessages — keepalive and client-drop accounting (issue #1147)", () => {
  const frame = (c: unknown) => `data: ${JSON.stringify(c)}\n\n`;
  const textChunk = frame({ choices: [{ delta: { content: "partial" } }] });
  const finishChunk = frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
  /** One upstream part per pull: wait `gapMs` (Infinity = never), then emit `data`. */
  function gappedUpstream(parts: Array<{ gapMs: number; data?: string }>, onCancel?: () => void) {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i >= parts.length) { controller.close(); return; }
        const part = parts[i++];
        if (part.gapMs === Infinity) await new Promise<void>(() => {});
        else if (part.gapMs > 0) await new Promise<void>((r) => setTimeout(r, part.gapMs));
        if (part.data !== undefined) controller.enqueue(new TextEncoder().encode(part.data));
      },
      cancel() { onCancel?.(); },
    });
  }
  async function setupWith(upstream: ReadableStream<Uint8Array>, envOverrides: Partial<Env> = {}) {
    const run = vi.fn(async () => upstream);
    const token = mintSpawnToken();
    const rows = async () => [row(ME, await hashSpawnToken(token))];
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run }, ...FAST_RETRY, ...envOverrides } as unknown as Env;
    return { token, rows, e };
  }
  /** Drains the response body in the background, like the Workers runtime does
   *  for a connected client. Without this the pump blocks on backpressure. */
  function consume(r: Response): Promise<string> {
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    return (async () => {
      let text = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
      return text;
    })();
  }

  it("the streaming path emits event: ping while the upstream is silent between chunks", async () => {
    const upstream = gappedUpstream([{ gapMs: 0, data: textChunk }, { gapMs: 120, data: finishChunk }, { gapMs: 0, data: "data: [DONE]\n\n" }]);
    const { token, rows, e } = await setupWith(upstream, { LEAD_STREAM_PING_MS: "20", LEAD_STREAM_IDLE_MS: "5000" } as Partial<Env>);
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    const text = await consume(r);
    const pings = text.split("event: ping\ndata: {\"type\":\"ping\"}\n\n").length - 1;
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(text).toContain("event: message_stop");
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 1, error: null });
  });

  it("a fast stream carries no ping at all (the default interval never fires on a normal turn)", async () => {
    const upstream = gappedUpstream([{ gapMs: 0, data: textChunk }, { gapMs: 0, data: finishChunk }, { gapMs: 0, data: "data: [DONE]\n\n" }]);
    const { token, rows, e } = await setupWith(upstream);
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    const text = await consume(r);
    expect(text).not.toContain("event: ping");
    expect(text).toContain("event: message_stop");
  });

  it("pings do not reset the idle clock: a permanent stall still times out at LEAD_STREAM_IDLE_MS", async () => {
    const upstream = gappedUpstream([{ gapMs: 0, data: textChunk }, { gapMs: Infinity }]);
    const { token, rows, e } = await setupWith(upstream, { LEAD_STREAM_PING_MS: "10", LEAD_STREAM_IDLE_MS: "80" } as Partial<Env>);
    const started = Date.now();
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    const text = await consume(r);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(text.split("event: ping").length - 1).toBeGreaterThanOrEqual(2);
    expect(text).toContain("upstream stream idle timeout: no data for 80ms");
    await ctx.drain();
    expect((await usageRows())[0]).toMatchObject({ ok: 0, error: "idle_timeout after 80ms" });
  });

  it("a client that hangs up during a silent upstream is recorded as client_abort at once, not at the idle timeout", async () => {
    let cancelled = false;
    const upstream = gappedUpstream([{ gapMs: 0, data: textChunk }, { gapMs: Infinity }], () => { cancelled = true; });
    const { token, rows, e } = await setupWith(upstream, { LEAD_STREAM_IDLE_MS: "5000", LEAD_STREAM_PING_MS: "60000" } as Partial<Env>);
    const ac = new AbortController();
    const started = Date.now();
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true }, signal: ac.signal }), e, ctx, rows);
    const consumed = consume(r);
    setTimeout(() => ac.abort(), 30);
    await ctx.drain();
    await consumed;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancelled).toBe(true);
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ ok: 0, error: "client_abort" });
  });

  it("a non-streaming client that hangs up is logged ok: 0 client_abort, not ok: 1 for a reply nobody reads", async () => {
    const upstream = gappedUpstream([{ gapMs: 0, data: textChunk }, { gapMs: 100, data: finishChunk }, { gapMs: 0, data: "data: [DONE]\n\n" }]);
    const { token, rows, e } = await setupWith(upstream);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const r = await handleFleetAnthropicMessages(req({ token, signal: ac.signal }), e, ctx, rows);
    expect(r.status).toBe(499);
    await ctx.drain();
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ ok: 0, error: "client_abort" });
    // INFER/READY read SUM(ok) over these rows (junior/usage.ts aggregateLeadUsage),
    // so a dropped call is a counted failure there too.
    const agg = await aggregateLeadUsage(env.DB, 0);
    expect(agg.rows.find((x) => x.studioId === ME)).toMatchObject({ calls: 1, ok: 0 });
  });

  it("the ping interval parses like the other lead timers: garbage and zero fall back to the 15s default", () => {
    expect(leadStreamPingMs({})).toBe(15_000);
    expect(leadStreamPingMs({ LEAD_STREAM_PING_MS: "nope" })).toBe(15_000);
    expect(leadStreamPingMs({ LEAD_STREAM_PING_MS: "0" })).toBe(15_000);
    expect(leadStreamPingMs({ LEAD_STREAM_PING_MS: "2500" })).toBe(2_500);
  });

  // Review round 2 (maestro, #1147): the ping clock must follow CLIENT silence,
  // not upstream silence; a client abort must win over a write stuck on
  // backpressure; a stuck ping write must not hang the pump. The pump-level
  // cases use a fake writer so the stuck write is deterministic. Each test
  // races the pump against a short timer, so a hang fails fast, not at 5s.
  const reasoningChunk = frame({ choices: [{ delta: { reasoning_content: "thinking" } }] });
  /** A writer whose N-th write (0-based) and any write `stall` picks never settles. */
  function fakeWriter(stall: (frame: string, index: number) => boolean) {
    const frames: string[] = [];
    const writer = {
      write(chunk: Uint8Array) {
        const f = new TextDecoder().decode(chunk);
        const index = frames.push(f) - 1;
        return stall(f, index) ? new Promise<void>(() => {}) : Promise.resolve();
      },
      close: () => Promise.resolve(),
    } as unknown as WritableStreamDefaultWriter<Uint8Array>;
    return { writer, frames };
  }
  const within = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);

  it("pings keep coming while the upstream is busy with reasoning the client never sees (ping clock = client silence)", async () => {
    const parts = [
      ...Array.from({ length: 30 }, () => ({ gapMs: 10, data: reasoningChunk })),
      { gapMs: 0, data: finishChunk },
      { gapMs: 0, data: "data: [DONE]\n\n" },
    ];
    const { token, rows, e } = await setupWith(gappedUpstream(parts), { LEAD_STREAM_PING_MS: "40", LEAD_STREAM_IDLE_MS: "5000" } as Partial<Env>);
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    const text = await consume(r);
    // ~300ms of upstream silence toward the client at a 40ms ping: about 7 pings.
    expect(text.split("event: ping").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("pings cover the prefill wait before the first upstream byte (guard: already true before the fix)", async () => {
    const upstream = gappedUpstream([{ gapMs: 150, data: textChunk }, { gapMs: 0, data: finishChunk }, { gapMs: 0, data: "data: [DONE]\n\n" }]);
    const { token, rows, e } = await setupWith(upstream, { LEAD_STREAM_PING_MS: "20", LEAD_STREAM_IDLE_MS: "5000" } as Partial<Env>);
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    const text = await consume(r);
    expect(text.split("event: ping").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("a client abort wakes the pump even while a data write is stuck on backpressure", async () => {
    let cancelled = false;
    const upstream = gappedUpstream(Array.from({ length: 1000 }, () => ({ gapMs: 5, data: textChunk })), () => { cancelled = true; });
    const { writer } = fakeWriter((_f, i) => i >= 1);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const result = await within(
      pumpAnthropicStream(upstream, writer, "msg_test", "glm-5.3", 1000, 5_000, undefined, { pingMs: 0, signal: ac.signal }),
      1_000,
    );
    expect(result).not.toBe("hung");
    expect(result).toMatchObject({ ok: false, failure: "client_abort" });
    expect(cancelled).toBe(true);
  });

  it("a ping write that never settles is bounded by the ping interval and ends as client_abort, not a hang", async () => {
    let cancelled = false;
    const upstream = gappedUpstream([{ gapMs: 0, data: textChunk }, { gapMs: Infinity }], () => { cancelled = true; });
    const { writer } = fakeWriter((f) => f.startsWith("event: ping"));
    const result = await within(
      pumpAnthropicStream(upstream, writer, "msg_test", "glm-5.3", 1000, 5_000, undefined, { pingMs: 20 }),
      1_000,
    );
    expect(result).not.toBe("hung");
    expect(result).toMatchObject({ ok: false, failure: "client_abort" });
    expect(cancelled).toBe(true);
  });
});

// Issue #1147 review (maestro, 2026-10-16): the keepalive clock must follow what
// the CLIENT last received, not the upstream. Reasoning-only upstream chunks emit
// no client bytes, and a client that stops reading must not hold a call forever.
describe("handleFleetAnthropicMessages — keepalive follows the client (issue #1147 review)", () => {
  const frame = (c: unknown) => `data: ${JSON.stringify(c)}\n\n`;
  const finishChunk = frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
  function gappedUpstream(parts: Array<{ gapMs: number; data?: string }>, onCancel?: () => void) {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i >= parts.length) { controller.close(); return; }
        const part = parts[i++];
        if (part.gapMs === Infinity) await new Promise<void>(() => {});
        else if (part.gapMs > 0) await new Promise<void>((r) => setTimeout(r, part.gapMs));
        if (part.data !== undefined) controller.enqueue(new TextEncoder().encode(part.data));
      },
      cancel() { onCancel?.(); },
    });
  }
  async function setupWith(upstream: ReadableStream<Uint8Array>, envOverrides: Partial<Env> = {}) {
    const run = vi.fn(async () => upstream);
    const token = mintSpawnToken();
    const rows = async () => [row(ME, await hashSpawnToken(token))];
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run }, ...FAST_RETRY, ...envOverrides } as unknown as Env;
    return { token, rows, e };
  }
  function consume(r: Response): Promise<string> {
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    return (async () => {
      let text = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
      return text;
    })();
  }

  it("reasoning-only upstream chunks still get keepalive pings: the clock tracks client silence, not upstream bytes", async () => {
    const reasoning = (i: number) => frame({ choices: [{ delta: { reasoning_content: `r${i}` } }] });
    const parts = [
      ...Array.from({ length: 15 }, (_, i) => ({ gapMs: 10, data: reasoning(i) })),
      { gapMs: 0, data: finishChunk },
      { gapMs: 0, data: "data: [DONE]\n\n" },
    ];
    const { token, rows, e } = await setupWith(gappedUpstream(parts), { LEAD_STREAM_PING_MS: "40", LEAD_STREAM_IDLE_MS: "5000" } as Partial<Env>);
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    const text = await consume(r);
    expect(text.split("event: ping").length - 1).toBeGreaterThanOrEqual(2);
    expect(text).toContain("event: message_stop");
  });

  it("a client that stops reading and then hangs up unblocks the pump at once (writes race the client's abort)", async () => {
    let cancelled = false;
    const upstream = gappedUpstream([{ gapMs: 0, data: frame({ choices: [{ delta: { content: "partial" } }] }) }, { gapMs: Infinity }], () => { cancelled = true; });
    const { token, rows, e } = await setupWith(upstream, { LEAD_STREAM_IDLE_MS: "5000", LEAD_STREAM_PING_MS: "60000" } as Partial<Env>);
    const ac = new AbortController();
    const started = Date.now();
    await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true }, signal: ac.signal }), e, ctx, rows);
    // The client never reads the body. It hangs up.
    setTimeout(() => ac.abort(), 30);
    await ctx.drain();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancelled).toBe(true);
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ ok: 0, error: "client_abort" });
  });

  it("a client that stops reading during keepalive is treated as gone after one ping interval, not held to the idle deadline", async () => {
    let cancelled = false;
    const { token, rows, e } = await setupWith(gappedUpstream([{ gapMs: Infinity }], () => { cancelled = true; }), { LEAD_STREAM_PING_MS: "40", LEAD_STREAM_IDLE_MS: "300" } as Partial<Env>);
    const started = Date.now();
    const r = await handleFleetAnthropicMessages(req({ token, body: { ...good, stream: true } }), e, ctx, rows);
    // Take message_start, then never read again: every later ping write stalls.
    await r.body!.getReader().read();
    await ctx.drain();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(cancelled).toBe(true);
    const rowsLogged = await usageRows();
    expect(rowsLogged).toHaveLength(1);
    expect(rowsLogged[0]).toMatchObject({ ok: 0, error: "client_abort" });
  });
});
