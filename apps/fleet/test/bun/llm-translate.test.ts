// apps/fleet/test/bun/llm-translate.test.ts
// Pure translation functions for #249's GLM-led studio route — no env/fetch,
// so every direction (Anthropic request -> OpenAI, OpenAI response ->
// Anthropic, streaming chunk -> Anthropic SSE event, error classification)
// is tested with plain objects, bun:test, no mocking.
import { describe, expect, test } from "bun:test";
import {
  GLM_LEAD_MODEL,
  GLM_MIN_MAX_TOKENS,
  anthropicRequestToOpenAI,
  openAIResponseToAnthropic,
  classifyAiError,
  createStreamState,
  streamPrelude,
  applyOpenAIStreamChunk,
  closeStream,
  closeStreamOrError,
  parseSseDataLine,
  parseStreamErrorChunk,
  streamErrorFrame,
} from "../../src/llm/translate";

/** Splits a raw `event: X\ndata: Y\n\n` frame back into its two halves, for
 *  assertions — the inverse of translate.ts's own sseEvent(). */
function parseFrame(frame: string): { event: string; data: unknown } {
  const m = /^event: (.+)\ndata: (.+)\n\n$/.exec(frame);
  if (!m) throw new Error(`not a well-formed SSE frame: ${JSON.stringify(frame)}`);
  return { event: m[1], data: JSON.parse(m[2]) };
}

describe("anthropicRequestToOpenAI — text", () => {
  test("plain string content round-trips as-is, model pinned to GLM", () => {
    const out = anthropicRequestToOpenAI({
      model: "claude-opus-4-5", max_tokens: 1024,
      messages: [{ role: "user", content: "hi there" }],
    });
    expect(out.model).toBe(GLM_LEAD_MODEL);
    expect(out.messages).toEqual([{ role: "user", content: "hi there" }]);
    // 1024 is below GLM_MIN_MAX_TOKENS — see the dedicated floor describe
    // block below for the behavior this assertion now reflects.
    expect(out.max_tokens).toBe(GLM_MIN_MAX_TOKENS);
  });

  test("top-level system string becomes a leading system message", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10, system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("top-level system as text-block array is joined", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.messages[0]).toEqual({ role: "system", content: "a\n\nb" });
  });

  test("a text content-block array collapses to a plain string", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{ role: "user", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] }],
    });
    expect(out.messages[0]).toEqual({ role: "user", content: "part one\n\npart two" });
  });

  test("stream flag passes through", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10, stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.stream).toBe(true);
  });

  // MAJOR 4 (maestro review round 1): without this, no chunk the upstream
  // sends (including the final one) ever carries a `usage` field, and every
  // streamed reply reports 0/0 regardless of the real call.
  test("stream:true also requests usage on the final chunk (stream_options.include_usage)", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10, stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  test("stream_options is absent on a non-streaming request", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.stream_options).toBeUndefined();
  });
});

// STATUS comment on PR #255, measured live 2026-10-08T08:40:12Z (Workers AI,
// @cf/zai-org/glm-5.3, chat completions): GLM spends most of max_tokens on
// reasoning_content before producing any visible content. At max_tokens 3000
// -> content "" (all 3000 went to reasoning). At 12000 -> 6861 completion
// tokens, good content. Claude Code's own requested max_tokens is sized for
// Claude, not for a backend that burns budget on reasoning first.
describe("anthropicRequestToOpenAI — GLM_MIN_MAX_TOKENS floor", () => {
  test("a Claude-sized max_tokens below the floor is raised to GLM_MIN_MAX_TOKENS (16000)", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 3000,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.max_tokens).toBe(GLM_MIN_MAX_TOKENS);
  });

  test("a max_tokens already above the floor passes through unchanged — this is a floor, not a cap", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 20000,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.max_tokens).toBe(20000);
  });
});

describe("anthropicRequestToOpenAI — tools", () => {
  test("input_schema becomes OpenAI function/parameters", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
    });
    expect(out.tools).toEqual([{
      type: "function",
      function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
    }]);
  });

  test.each([
    [{ type: "auto" }, "auto"],
    [{ type: "any" }, "required"],
    [{ type: "none" }, "none"],
  ])("tool_choice %j -> %j", (anthropicChoice, expected) => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10, tool_choice: anthropicChoice as never,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.tool_choice).toBe(expected);
  });

  test("tool_choice {type:'tool', name} -> forced function choice", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10, tool_choice: { type: "tool", name: "get_weather" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });
});

describe("anthropicRequestToOpenAI — tool_use / tool_result round trip", () => {
  test("assistant tool_use block becomes an OpenAI tool_calls entry", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "nyc" } },
        ],
      }],
    });
    expect(out.messages[0]).toEqual({
      role: "assistant", content: "let me check",
      tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "nyc" }) } }],
    });
  });

  test("assistant turn with ONLY a tool_use block has null content, no stray text block", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] }],
    });
    expect(out.messages[0].content).toBeNull();
    expect(out.messages[0].tool_calls).toHaveLength(1);
  });

  test("user tool_result (string content) becomes a tool-role message", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny, 72F" }] }],
    });
    expect(out.messages[0]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "sunny, 72F" });
  });

  test("user tool_result (text-block array content) is flattened", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] }],
    });
    expect(out.messages[0]).toEqual({ role: "tool", tool_call_id: "t1", content: "a\n\nb" });
  });

  test("tool_result is_error prefixes content so the model sees the failure", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] }],
    });
    expect(out.messages[0].content).toBe("[error] boom");
  });

  test("a user turn mixing leading text and a trailing tool_result emits two messages, in order", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "also, " }, { type: "tool_result", tool_use_id: "t1", content: "ok" }],
      }],
    });
    expect(out.messages).toEqual([
      { role: "user", content: "also, " },
      { role: "tool", tool_call_id: "t1", content: "ok" },
    ]);
  });
});

describe("openAIResponseToAnthropic — text", () => {
  test("plain text choice -> one text content block, mapped usage", () => {
    const out = openAIResponseToAnthropic({
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 4 },
    }, { model: "claude-opus-4-5" });
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.model).toBe("claude-opus-4-5");
    expect(out.content).toEqual([{ type: "text", text: "hello" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage).toEqual({ input_tokens: 11, output_tokens: 4 });
    expect(typeof out.id).toBe("string");
    expect(out.id.length).toBeGreaterThan(0);
  });

  test.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["content_filter", "end_turn"],
    [null, "end_turn"],
  ])("finish_reason %j -> stop_reason %j", (finish, expected) => {
    const out = openAIResponseToAnthropic({
      choices: [{ message: { role: "assistant", content: "x" }, finish_reason: finish }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, { model: "m" });
    expect(out.stop_reason).toBe(expected);
  });

  // STATUS comment on PR #255, measured live 2026-10-08T08:40:12Z: the exact
  // measured failure shape — GLM spent the whole max_tokens budget on
  // reasoning_content, content comes back "", and this backend reported it
  // under finish_reason: "stop", NOT "length". finish_reason alone would
  // have told Claude Code this was a normal completed turn with nothing to
  // say; forcing max_tokens here instead tells it to retry/compact.
  test("empty content + no tool_calls forces stop_reason max_tokens, even when finish_reason says 'stop'", () => {
    const out = openAIResponseToAnthropic({
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 3000 },
    }, { model: "m" });
    expect(out.content).toEqual([]);
    expect(out.stop_reason).toBe("max_tokens");
  });

  // STATUS comment on PR #255, measured live 2026-10-08T08:40:12Z: GLM's
  // usage object may report completion_tokens_details.reasoning_tokens as a
  // breakdown of completion_tokens (OpenAI's own documented convention for
  // reasoning models, e.g. o1/o3) rather than a figure additional to it. The
  // maestro's own measured numbers ("6861 completion tokens, ~24k chars
  // reasoning") confirm this: ~24k chars of reasoning at ~4 chars/token is
  // ~6000 tokens, almost exactly the reported completion_tokens — if the two
  // were additive, completion_tokens would need to be far larger. So
  // reasoning_tokens is ignored; completion_tokens alone is the full count.
  test("completion_tokens_details.reasoning_tokens is ignored, not added to output_tokens", () => {
    const out = openAIResponseToAnthropic({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 500, completion_tokens: 6861, completion_tokens_details: { reasoning_tokens: 9000 } },
    }, { model: "m" });
    expect(out.usage).toEqual({ input_tokens: 500, output_tokens: 6861 });
  });
});

describe("openAIResponseToAnthropic — tool_calls", () => {
  test("a tool_calls response becomes a tool_use content block with parsed input", () => {
    const out = openAIResponseToAnthropic({
      choices: [{
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "nyc" }) } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }, { model: "m" });
    expect(out.content).toEqual([{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "nyc" } }]);
    expect(out.stop_reason).toBe("tool_use");
  });

  test("text AND a tool call both produce content blocks, text first", () => {
    const out = openAIResponseToAnthropic({
      choices: [{
        message: {
          role: "assistant", content: "checking now",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, { model: "m" });
    expect(out.content).toEqual([
      { type: "text", text: "checking now" },
      { type: "tool_use", id: "call_1", name: "f", input: {} },
    ]);
  });

  test("malformed tool_call arguments JSON falls back to an empty object input rather than throwing", () => {
    const out = openAIResponseToAnthropic({
      choices: [{
        message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{not json" } }] },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, { model: "m" });
    expect(out.content[0]).toEqual({ type: "tool_use", id: "c1", name: "f", input: {} });
  });

  // Minor fix (maestro review round 1): a toolu_-prefixed id is generated
  // when GLM's own tool-call response omits one, rather than leaving an
  // empty/undefined id on a block Claude Code expects to reference later
  // (e.g. in its own next-turn tool_result).
  test.each([[undefined], [null], [""]])("a missing/empty tool_call id (%j) gets a generated toolu_ id", (missing) => {
    const out = openAIResponseToAnthropic({
      choices: [{
        message: { role: "assistant", content: null, tool_calls: [{ id: missing, type: "function", function: { name: "f", arguments: "{}" } }] },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, { model: "m" });
    expect(out.content[0].id).toMatch(/^toolu_[0-9a-f]{32}$/);
  });

  test("a real tool_call id is kept as-is, never replaced", () => {
    const out = openAIResponseToAnthropic({
      choices: [{
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_abc123", type: "function", function: { name: "f", arguments: "{}" } }] },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, { model: "m" });
    expect(out.content[0].id).toBe("call_abc123");
  });

  // Minor fix (maestro review round 1): stop_reason derived from whether any
  // tool_use block was actually produced, not only from the upstream's own
  // finish_reason — this backend is not reliably observed to always set
  // finish_reason to the tool-calling value even when it DID emit a tool
  // call.
  test("stop_reason is tool_use whenever a tool_use block was emitted, even if finish_reason says 'stop'", () => {
    const out = openAIResponseToAnthropic({
      choices: [{
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, { model: "m" });
    expect(out.stop_reason).toBe("tool_use");
  });
});

describe("classifyAiError", () => {
  test.each([
    ["Request timeout after 30s", 504, "api_error"],
    ["AiError: capacity exceeded for model", 529, "overloaded_error"],
    ["rate limit exceeded, too many requests", 429, "rate_limit_error"],
    ["something else entirely", 500, "api_error"],
  ])("%j -> status %j, type %j", (message, status, type) => {
    expect(classifyAiError(message)).toEqual({ status, type });
  });

  // MAJOR 4 (maestro review round 1): a context-overflow failure maps to
  // 400/invalid_request_error with a FIXED message, so Claude Code's own
  // client treats it as "compact your context", not "retry the same
  // request" (what a 500/504/529 all read as). Flagged uncertainty — see
  // classifyAiError's own doc comment on the exact wording not being
  // confirmed against a real observed error string from this binding.
  test.each([
    "This model's maximum context length is 32768 tokens, however you requested 40000 tokens",
    "context_length_exceeded",
    "prompt exceeds the context window for this model",
  ])("a context-overflow-shaped message (%j) -> 400 invalid_request_error, fixed message", (message) => {
    expect(classifyAiError(message)).toEqual({
      status: 400, type: "invalid_request_error", message: "prompt is too long",
    });
  });
});

describe("streamErrorFrame", () => {
  test("builds a genuine Anthropic event: error SSE frame, classified the same way as the non-streaming path", () => {
    const frame = streamErrorFrame("AiError: capacity exceeded");
    const { event, data } = parseFrame(frame);
    expect(event).toBe("error");
    expect(data).toEqual({ type: "error", error: { type: "overloaded_error", message: "AiError: capacity exceeded" } });
  });

  // Claude Code recognizes "prompt is too long" to trigger auto-compact
  // mid-stream too, which matters for long GLM sessions — the raw upstream
  // overflow text passes that signal by.
  test("a context-overflow-shaped message surfaces the classifyAiError override, not the raw upstream text (#298-4)", () => {
    const frame = streamErrorFrame("This model's maximum context length is 32768 tokens");
    const { event, data } = parseFrame(frame);
    expect(event).toBe("error");
    expect(data).toEqual({
      type: "error", error: { type: "invalid_request_error", message: "prompt is too long" },
    });
  });

  test("a capacity-shaped message keeps the raw upstream text — no override exists there", () => {
    const frame = streamErrorFrame("AiError: capacity exceeded mid-generation");
    const { data } = parseFrame(frame);
    expect((data as { error: { message: string } }).error.message).toBe("AiError: capacity exceeded mid-generation");
  });
});

describe("parseSseDataLine", () => {
  test("a data line with JSON parses to the object", () => {
    expect(parseSseDataLine('data: {"a":1}')).toEqual({ a: 1 });
  });
  test("the [DONE] sentinel returns the literal string \"DONE\"", () => {
    expect(parseSseDataLine("data: [DONE]")).toBe("DONE");
  });
  test("a non-data line (blank, comment, event: line) returns null", () => {
    expect(parseSseDataLine("")).toBeNull();
    expect(parseSseDataLine("event: foo")).toBeNull();
    expect(parseSseDataLine(": comment")).toBeNull();
  });
});

describe("streaming: prelude + chunk application + close", () => {
  test("text-only stream: message_start, one text block, one message_delta/stop", () => {
    const state = createStreamState();
    const frames: string[] = [];
    frames.push(...streamPrelude("msg_1", "claude-opus-4-5"));
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "Hel" } }] }));
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "lo" } }] }));
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }] }));
    frames.push(...closeStream(state));

    const events = frames.map(parseFrame);
    expect(events.map((e) => e.event)).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_delta",
      "content_block_stop", "message_delta", "message_stop",
    ]);
    expect(events[0].data).toMatchObject({ type: "message_start", message: { id: "msg_1", model: "claude-opus-4-5", role: "assistant" } });
    expect(events[1].data).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    expect(events[2].data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } });
    expect(events[3].data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } });
    expect(events[4].data).toEqual({ type: "content_block_stop", index: 0 });
    expect(events[5].data).toMatchObject({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    expect(events[6].data).toEqual({ type: "message_stop" });
  });

  // Anthropic's real Messages API SSE contract closes each content block
  // (`content_block_stop`) BEFORE the next one's `content_block_start` ever
  // fires — never two blocks open at once. This pins that: the text block
  // (index 0) is closed the moment the first tool_calls delta arrives,
  // strictly before the tool_use block (index 1) opens — not deferred to
  // the end of the whole stream (see closeOpenBlock's own doc comment in
  // translate.ts).
  test("a streamed tool call opens its own content block, separate index from text, each closed before the next opens", () => {
    const state = createStreamState();
    const frames: string[] = [];
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "ok, " } }] }));
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } }] } }] }));
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] }));
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"nyc"}' } }] } }] }));
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
    frames.push(...closeStream(state));

    const events = frames.map(parseFrame);
    expect(events.map((e) => e.event)).toEqual([
      "content_block_start", "content_block_delta", // text (index 0) opens and streams
      "content_block_stop", // text (index 0) closes — BEFORE the tool block ever opens
      "content_block_start", // tool_use (index 1) opens
      "content_block_delta", "content_block_delta", // arg deltas
      "content_block_stop", // tool_use (index 1) closes, at stream end
      "message_delta", "message_stop",
    ]);
    expect(events[0].data).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    expect(events[1].data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok, " } });
    expect(events[2].data).toEqual({ type: "content_block_stop", index: 0 });
    expect(events[3].data).toEqual({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} } });
    expect(events[4].data).toEqual({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } });
    expect(events[5].data).toEqual({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"nyc"}' } });
    expect(events[6].data).toEqual({ type: "content_block_stop", index: 1 });
    expect(events[7].data).toMatchObject({ type: "message_delta", delta: { stop_reason: "tool_use" } });
  });

  test("usage from the final OpenAI chunk reaches message_delta's output_tokens", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "hi" } }] });
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 9 } });
    const [delta] = closeStream(state).filter((f) => f.includes("message_delta")).map(parseFrame);
    expect((delta.data as { usage: { output_tokens: number } }).usage.output_tokens).toBe(9);
  });

  // Fresh-context review finding 1: the prior fix (MAJOR 4 above) only got
  // state.inputTokens right internally (the D1 usage-log row) — it never
  // reached any outbound SSE frame Claude Code itself reads. message_delta
  // is the real Anthropic wire event Claude Code reads a turn's FINAL usage
  // off of, so the real input_tokens has to land there too, not stay
  // client-visible-0 forever. (message_start legitimately stays 0 — see
  // streamPrelude's own doc comment: this backend only learns the real
  // prompt_tokens count off the LAST chunk, long after message_start has
  // already been written to the wire.)
  test("message_delta's usage ALSO carries the real input_tokens — not just output_tokens — so Claude Code itself stops seeing input_tokens: 0 on every streamed turn", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "hi" } }] });
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 9 } });
    const [delta] = closeStream(state).filter((f) => f.includes("message_delta")).map(parseFrame);
    expect((delta.data as { usage: { input_tokens: number; output_tokens: number } }).usage).toEqual({
      input_tokens: 5, output_tokens: 9,
    });
  });

  // MAJOR 4 (maestro review round 1): the same final usage-bearing chunk
  // also carries the real prompt_tokens — tracked on the state for the
  // ROUTE to read back after the stream ends (for the usage-log row), AND
  // (fresh-context review finding 1, test above) for closeStream's own
  // message_delta frame to carry to the client.
  test("usage from the final OpenAI chunk also reaches state.inputTokens", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "hi" } }] });
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 9 } });
    expect(state.inputTokens).toBe(5);
  });

  test("a chunk with no choices (e.g. a usage-only trailing chunk) produces no frames and does not throw", () => {
    const state = createStreamState();
    expect(applyOpenAIStreamChunk(state, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })).toEqual([]);
  });

  // Minor fix (maestro review round 1): a toolu_-prefixed id is generated
  // for a streamed tool_use block's content_block_start when GLM's own
  // delta omits one, same fix as the non-streaming path above.
  test("a streamed tool call with no id gets a generated toolu_ id on content_block_start", () => {
    const state = createStreamState();
    const frames = applyOpenAIStreamChunk(state, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "f", arguments: "" } }] } }],
    });
    const [start] = frames.map(parseFrame);
    const block = (start.data as { content_block: { id: string } }).content_block;
    expect(block.id).toMatch(/^toolu_[0-9a-f]{32}$/);
  });

  // Minor fix (maestro review round 1): closeStream's own stop_reason is
  // derived from whether any tool_use block was actually OPENED during this
  // stream, not only from the upstream's self-reported finish_reason — this
  // backend is not reliably observed to always set finish_reason to the
  // tool-calling value even when a tool call streamed through.
  test("closeStream reports stop_reason: tool_use whenever a tool block opened, even if finish_reason never said so", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, {
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "f", arguments: "{}" } }] } }],
    });
    // No finish_reason chunk at all this time — e.g. the upstream closed the
    // stream without ever sending one.
    const [delta] = closeStream(state).filter((f) => f.includes("message_delta")).map(parseFrame);
    expect((delta.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("tool_use");
  });

  // STATUS comment on PR #255, measured live 2026-10-08T08:40:12Z: the
  // streaming equivalent of the empty-content failure — this stream never
  // opened ANY content block at all (the measured failure mode: the whole
  // max_tokens budget went to reasoning, nothing visible ever streamed).
  // `state.nextIndex === 0` is the "never opened a block" signal (it only
  // increments when a block opens) — forced to max_tokens regardless of
  // finish_reason, same reasoning as the non-streaming guard above.
  test("closeStream reports stop_reason: max_tokens when no content block was ever opened, even if finish_reason said 'stop'", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }] });
    const [delta] = closeStream(state).filter((f) => f.includes("message_delta")).map(parseFrame);
    expect((delta.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("max_tokens");
  });

  test("closeStream reports stop_reason: max_tokens when applyOpenAIStreamChunk was never even called", () => {
    const state = createStreamState();
    const [delta] = closeStream(state).filter((f) => f.includes("message_delta")).map(parseFrame);
    expect((delta.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("max_tokens");
  });

  // STATUS comment on PR #255, measured live 2026-10-08T08:40:12Z: same
  // reasoning-tokens handling as the non-streaming path above, applied to
  // the usage-bearing chunk's completion_tokens_details field — ignored,
  // not added, since completion_tokens already includes reasoning tokens.
  test("completion_tokens_details.reasoning_tokens on the usage chunk is ignored, not added to state.outputTokens", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "hi" } }] });
    applyOpenAIStreamChunk(state, {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 500, completion_tokens: 6861, completion_tokens_details: { reasoning_tokens: 9000 } },
    });
    expect(state.outputTokens).toBe(6861);
  });
});

// Board issue #284 (a): a stream that ends WITHOUT ever setting a
// finish_reason (reader hits natural EOF, [DONE] with no preceding
// finish_reason chunk, a dropped connection — anything that never carries a
// chunk with `choice.finish_reason` set) used to fall through to
// `closeStream`'s own unconditional `message_delta`/`message_stop` pair,
// with `mapFinishReason(null)` silently mapping to `"end_turn"` — a client
// sees a normal successful turn when the upstream connection never actually
// confirmed it finished at all. `closeStreamOrError` is the new, narrower
// check layered ON TOP of `closeStream` (not folded into it — see that
// function's own doc comment in translate.ts for why `closeStream`'s own
// unit tests above, several of which deliberately call it directly with
// `state.finishReason === null`, must keep passing unchanged).
describe("closeStreamOrError — board issue #284 (a): stream ends without ever confirming finish_reason", () => {
  test("finishReason still null at stream end -> event: error, not a faked end_turn message_delta/message_stop", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "partial, then the connection just stopped" } }] });
    // No finish_reason chunk ever arrives — the upstream stream simply ends.
    const result = closeStreamOrError(state);
    expect(result.ok).toBe(false);
    expect(result.frames).toHaveLength(1);
    const { event, data } = parseFrame(result.frames[0]);
    expect(event).toBe("error");
    expect(data).toMatchObject({ type: "error", error: { message: "upstream stream ended without a finish reason" } });
  });

  test("finishReason set (even to a mapped-to-end_turn value like 'stop') -> normal closeStream frames, ok: true", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "hi" } }] });
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }] });
    const result = closeStreamOrError(state);
    expect(result.ok).toBe(true);
    const events = result.frames.map(parseFrame);
    expect(events.map((e) => e.event)).toEqual(["content_block_stop", "message_delta", "message_stop"]);
    expect(events[1].data).toMatchObject({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  });

  // Must NOT regress the PR #255 empty-content/max_tokens-floor guard: that
  // failure shape's finish_reason IS present (often "stop", never null) —
  // only a genuinely null finishReason should ever trigger the new error
  // path, never this different, already-handled shape.
  test("the max_tokens-floor empty-content guard (finish_reason present, no content opened) still closes normally, not as an error", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }] });
    const result = closeStreamOrError(state);
    expect(result.ok).toBe(true);
    const [delta] = result.frames.filter((f) => f.includes("message_delta")).map(parseFrame);
    expect((delta.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("max_tokens");
  });

  // Must NOT regress the tool_use case either — finish_reason is non-null
  // there too (even when the upstream's own self-reported value disagrees,
  // see anyToolUseBlocks' own doc comment above).
  test("a completed tool_use stream (finish_reason set) still closes normally, not as an error", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, {
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "f", arguments: "{}" } }] } }],
    });
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    const result = closeStreamOrError(state);
    expect(result.ok).toBe(true);
    const [delta] = result.frames.filter((f) => f.includes("message_delta")).map(parseFrame);
    expect((delta.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("tool_use");
  });
});

// Board issue #284 (b): some OpenAI-compatible backends emit a chunk shaped
// `{"error": {...}}` instead of (or interleaved with) the normal
// `{choices: [...]}` shape when something goes wrong server-side
// mid-generation. Before this fix, `applyOpenAIStreamChunk`'s own
// `chunk?.choices?.[0]` would be `undefined` for a chunk like this, and the
// function would silently return `[]` — no frames, no signal, the one chunk
// that actually explained the failure discarded.
describe("parseStreamErrorChunk — board issue #284 (b): an explicit upstream {error:...} chunk", () => {
  test("a chunk shaped {error: {message}} returns the message", () => {
    expect(parseStreamErrorChunk({ error: { message: "backend exploded mid-generation" } })).toBe("backend exploded mid-generation");
  });

  test("a chunk shaped {error: 'plain string'} returns the string", () => {
    expect(parseStreamErrorChunk({ error: "backend exploded mid-generation" })).toBe("backend exploded mid-generation");
  });

  test("a normal {choices:...} chunk returns null", () => {
    expect(parseStreamErrorChunk({ choices: [{ delta: { content: "hi" } }] })).toBeNull();
  });

  test("a usage-only trailing chunk (no error, no choices) returns null", () => {
    expect(parseStreamErrorChunk({ usage: { prompt_tokens: 1, completion_tokens: 1 } })).toBeNull();
  });

  test("an empty object returns null", () => {
    expect(parseStreamErrorChunk({})).toBeNull();
  });
});
