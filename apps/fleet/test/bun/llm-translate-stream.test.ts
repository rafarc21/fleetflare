// apps/fleet/test/bun/llm-translate-stream.test.ts
// Streaming half of the pure translation tests for #249's GLM-led studio
// route — the non-streaming request/response directions live in the sibling
// file llm-translate-request.test.ts. No env/fetch, so every direction
// (streaming chunk -> Anthropic SSE event, error classification) is tested
// with plain objects, bun:test, no mocking.
import { describe, expect, test } from "bun:test";
import {
  classifyAiError,
  createStreamState,
  streamPrelude,
  applyOpenAIStreamChunk,
  closeStream,
  closeStreamOrError,
  parseSseDataLine,
  parseStreamErrorChunk,
  streamErrorFrame,
  runawayErrorFrame,
} from "../../src/llm/translate";

/** Splits a raw `event: X\ndata: Y\n\n` frame back into its two halves, for
 *  assertions — the inverse of translate.ts's own sseEvent(). */
function parseFrame(frame: string): { event: string; data: unknown } {
  const m = /^event: (.+)\ndata: (.+)\n\n$/.exec(frame);
  if (!m) throw new Error(`not a well-formed SSE frame: ${JSON.stringify(frame)}`);
  return { event: m[1], data: JSON.parse(m[2]) };
}

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
    frames.push(...closeStream(state, 1_000_000));

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
    frames.push(...closeStream(state, 1_000_000));

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

  // Board issue #951: the streaming path emits the SAME tool_use.id to the
  // client as the non-streaming path, so a Kimi-style id containing ":" and
  // "." must be sanitized here too — otherwise a resumed session replays a
  // poisoned id and Anthropic returns 400 on the ^[a-zA-Z0-9_-]+$ pattern.
  test("a streamed tool call with a kimi-style id ':' '.' sanitizes to ^[a-zA-Z0-9_-]+$ on content_block_start", () => {
    const state = createStreamState();
    const frames = applyOpenAIStreamChunk(state, {
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc:def.123", function: { name: "get_weather", arguments: "" } }] } }],
    });
    const [start] = frames.map(parseFrame);
    const block = (start.data as { content_block: { id: string } }).content_block;
    expect(block.id).toBe("call_abc_def_123");
    expect(block.id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  test("usage from the final OpenAI chunk reaches message_delta's output_tokens", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "hi" } }] });
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 9 } });
    const [delta] = closeStream(state, 1_000_000).filter((f) => f.includes("message_delta")).map(parseFrame);
    expect((delta.data as { usage: { output_tokens: number } }).usage.output_tokens).toBe(9);
  });

  // Fresh-context review (#717 critical follow-up): the streaming-side
  // equivalent of the non-streaming "output_tokens clamped to
  // requestedMaxTokens" describe block above — GLM's self-reported
  // `completion_tokens` (inflated by `reasoning_content`) can far exceed
  // the ORIGINAL client request's own `max_tokens`; `closeStream`'s emitted
  // `message_delta.usage.output_tokens` must never report more than that,
  // same reporting-only clamp `openAIResponseToAnthropic` already applies
  // on the non-streaming path.
  test("a huge state.outputTokens (reasoning_content inflation) is clamped to requestedMaxTokens in the emitted message_delta", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "hi" } }] });
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 70000 } });
    const [delta] = closeStream(state, 8000).filter((f) => f.includes("message_delta")).map(parseFrame);
    expect((delta.data as { usage: { output_tokens: number } }).usage.output_tokens).toBe(8000);
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
    const [delta] = closeStream(state, 1_000_000).filter((f) => f.includes("message_delta")).map(parseFrame);
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
    const [delta] = closeStream(state, 1_000_000).filter((f) => f.includes("message_delta")).map(parseFrame);
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
    const [delta] = closeStream(state, 1_000_000).filter((f) => f.includes("message_delta")).map(parseFrame);
    expect((delta.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("max_tokens");
  });

  test("closeStream reports stop_reason: max_tokens when applyOpenAIStreamChunk was never even called", () => {
    const state = createStreamState();
    const [delta] = closeStream(state, 1_000_000).filter((f) => f.includes("message_delta")).map(parseFrame);
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
    const result = closeStreamOrError(state, 1_000_000);
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
    const result = closeStreamOrError(state, 1_000_000);
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
    const result = closeStreamOrError(state, 1_000_000);
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
    const result = closeStreamOrError(state, 1_000_000);
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

// ---------------------------------------------------------------------------
// Issue #1073: kimi writes tool calls INSIDE its <think> block and then idles.
// Shapes below are the assumed upstream form (`<think>` tags streamed in
// `delta.content`, tool call as `<tool_call>{json}</tool_call>` or a bare
// JSON object) — hand-written, not yet confirmed against a live kimi
// recording. Re-check against a live smoke before re-promoting kimi.
// ---------------------------------------------------------------------------

/** Feeds content deltas (one per chunk) then a finish_reason chunk through
 *  the stream translator and returns the parsed SSE frames it produced. */
function runThinkStream(contentChunks: string[], finishReason: string | null) {
  const state = createStreamState({ thinkTags: true });
  const frames: string[] = [];
  for (const c of contentChunks) {
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: { content: c }, finish_reason: null }] }));
  }
  if (finishReason !== null) {
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: finishReason }] }));
  }
  return { state, frames, closed: closeStreamOrError(state, 64000) };
}

describe("think-block tool calls (issue #1073)", () => {
  test("a tagged tool call inside <think> becomes a real tool_use block; reasoning is not leaked as text", () => {
    const { frames, closed } = runThinkStream([
      "<think>I should read the README first.\n<tool_call>{\"name\":\"Read\",\"arguments\":{\"file_path\":\"/workspace/acme/README.md\"}}</tool_call></think>",
    ], "stop");
    const parsed = frames.map(parseFrame);
    const start = parsed.find((f) => f.event === "content_block_start");
    expect(start?.data).toMatchObject({ content_block: { type: "tool_use", name: "Read" } });
    const inputJson = parsed.filter((f) => f.event === "content_block_delta").map((f) => (f.data as { delta: { partial_json?: string } }).delta.partial_json ?? "").join("");
    expect(JSON.parse(inputJson)).toEqual({ file_path: "/workspace/acme/README.md" });
    expect(parsed.some((f) => f.event === "content_block_delta" && (f.data as { delta: { type: string } }).delta.type === "text_delta")).toBe(false);
    const messageDelta = closed.frames.map(parseFrame).find((f) => f.event === "message_delta");
    expect((messageDelta?.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("tool_use");
    expect(closed.ok).toBe(true);
  });

  test("a bare JSON tool call as the whole <think> body is recovered (input key form)", () => {
    const { frames, closed } = runThinkStream([
      "<think>{\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}</think>",
    ], "stop");
    const start = frames.map(parseFrame).find((f) => f.event === "content_block_start");
    expect(start?.data).toMatchObject({ content_block: { type: "tool_use", name: "Bash" } });
    expect(closed.ok).toBe(true);
    expect(closed.frames.map(parseFrame).find((f) => f.event === "message_delta")?.data)
      .toMatchObject({ delta: { stop_reason: "tool_use" } });
  });

  test("tags split across chunk boundaries are still recognized", () => {
    const { frames, closed } = runThinkStream([
      "<thi", "nk>plan\n<tool_c", "all>{\"name\":\"Read\",\"arguments\":{\"file_path\":\"a\"}}</tool", "_call></th", "ink>",
    ], "stop");
    expect(frames.map(parseFrame).find((f) => f.event === "content_block_start")?.data)
      .toMatchObject({ content_block: { type: "tool_use", name: "Read" } });
    expect(closed.ok).toBe(true);
  });

  test("reasoning with no tool call is dropped; visible text after </think> still streams", () => {
    const { frames, closed } = runThinkStream([
      "<think>plan the work</think>Here is the answer.",
    ], "stop");
    const parsed = frames.map(parseFrame);
    const texts = parsed.filter((f) => f.event === "content_block_delta").map((f) => (f.data as { delta: { text?: string } }).delta.text ?? "");
    expect(texts.join("")).toBe("Here is the answer.");
    expect(parsed.some((f) => f.event === "content_block_start" && (f.data as { content_block: { type: string } }).content_block.type === "tool_use")).toBe(false);
    expect(closed.frames.map(parseFrame).find((f) => f.event === "message_delta")?.data)
      .toMatchObject({ delta: { stop_reason: "end_turn" } });
  });

  test("an unterminated <think> at end of stream still recovers a complete tool call", () => {
    const { closed } = runThinkStream([
      "<think><tool_call>{\"name\":\"Read\",\"arguments\":{\"file_path\":\"b\"}}</tool_call>",
    ], "length");
    expect(closed.frames.map(parseFrame).find((f) => f.event === "content_block_start")?.data)
      .toMatchObject({ content_block: { type: "tool_use", name: "Read" } });
    expect(closed.ok).toBe(true);
  });

  test("an unrecoverable tool call inside <think>, with no visible output, ends with a retryable error frame — never a silent idle", () => {
    const { closed } = runThinkStream([
      "<think><tool_call>{not valid json</tool_call></think>",
    ], "length");
    expect(closed.ok).toBe(false);
    const errorFrame = closed.frames.map(parseFrame).find((f) => f.event === "error");
    expect(errorFrame).toBeDefined();
    expect((errorFrame?.data as { error: { message: string } }).error.message).toMatch(/retry/i);
    expect(closed.frames.some((f) => f.includes("message_stop"))).toBe(false);
  });
});

describe("think tags are off for every model except kimi (issue #1073 review)", () => {
  test("GLM/DeepSeek stream (thinkTags off) passes literal <think> and tool_call text through byte-identical", () => {
    const state = createStreamState();
    const frames: string[] = [];
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "<think>plan" }, finish_reason: null }] }));
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "</think><tool_call>{\"name\":\"Read\"}</tool_call>" }, finish_reason: null }] }));
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }] }));
    const closed = closeStreamOrError(state, 64000);
    expect(frames).toEqual([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<think>plan"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"</think><tool_call>{\\"name\\":\\"Read\\"}</tool_call>"}}\n\n',
    ]);
    expect(closed.ok).toBe(true);
    expect(closed.frames.map(parseFrame).find((f) => f.event === "message_delta")?.data)
      .toMatchObject({ delta: { stop_reason: "end_turn" } });
  });

  test("with thinkTags off, a <think> tag split across chunks is never held back", () => {
    const state = createStreamState();
    const frames = applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "<thi" }, finish_reason: null }] });
    expect(frames.map(parseFrame).map((f) => (f.data as { delta?: { text?: string } }).delta?.text)).toEqual([undefined, "<thi"]);
  });
});

describe("stray closer and narrate-then-unrecoverable tool call (issue #1186)", () => {
  const OPEN = "<think>";
  const CLOSE = "</think>";

  test("a stray CLOSE with no OPEN is dropped, not emitted as visible text", () => {
    const { frames, closed } = runThinkStream(["answer text" + CLOSE], "stop");
    const texts = frames.map(parseFrame).filter((f) => f.event === "content_block_delta")
      .map((f) => (f.data as { delta: { text?: string } }).delta.text ?? "");
    expect(texts.join("")).toBe("answer text");
    expect(closed.ok).toBe(true);
    expect(closed.frames.map(parseFrame).some((f) => f.event === "error")).toBe(false);
    expect(closed.frames.map(parseFrame).find((f) => f.event === "message_delta")?.data)
      .toMatchObject({ delta: { stop_reason: "end_turn" } });
  });

  test("a stray closer split across deltas is dropped, not emitted", () => {
    const splitAt = Math.floor(CLOSE.length / 2);
    const { frames, closed } = runThinkStream(["answer" + CLOSE.slice(0, splitAt), CLOSE.slice(splitAt)], "stop");
    const texts = frames.map(parseFrame).filter((f) => f.event === "content_block_delta")
      .map((f) => (f.data as { delta: { text?: string } }).delta.text ?? "");
    expect(texts.join("")).toBe("answer");
    expect(closed.ok).toBe(true);
  });

  test("narrate then an unrecoverable tagged tool call inside OPEN..CLOSE ends with a retryable error, not end_turn", () => {
    const { frames, closed } = runThinkStream(["I will look now" + OPEN + "<tool_call>{not valid json</tool_call>" + CLOSE], "stop");
    expect(closed.ok).toBe(false);
    const err = closed.frames.map(parseFrame).find((f) => f.event === "error");
    expect(err).toBeDefined();
    expect((err?.data as { error: { message: string } }).error.message).toMatch(/retry/i);
    expect(closed.frames.some((f) => f.includes("message_stop"))).toBe(false);
  });

  test("narrate then a bare-JSON tool-call attempt inside OPEN..CLOSE that fails to parse ends with a retryable error", () => {
    const { frames, closed } = runThinkStream(["I will look now" + OPEN + "{\"name\":\"Read\",\"arguments\":{oops" + CLOSE], "stop");
    expect(closed.ok).toBe(false);
    const err = closed.frames.map(parseFrame).find((f) => f.event === "error");
    expect(err).toBeDefined();
    expect((err?.data as { error: { message: string } }).error.message).toMatch(/retry/i);
    expect(closed.frames.some((f) => f.includes("message_stop"))).toBe(false);
  });

  test("a prose mention of a name in reasoning after narration is NOT treated as a tool call", () => {
    const { frames, closed } = runThinkStream(["Done" + OPEN + "the field \"name\": \"x\" matters here" + CLOSE], "stop");
    expect(closed.ok).toBe(true);
    expect(closed.frames.map(parseFrame).some((f) => f.event === "error")).toBe(false);
    expect(closed.frames.map(parseFrame).find((f) => f.event === "message_delta")?.data)
      .toMatchObject({ delta: { stop_reason: "end_turn" } });
    expect(frames.map(parseFrame).some((f) => f.event === "content_block_start"
      && (f.data as { content_block: { type: string } }).content_block.type === "tool_use")).toBe(false);
  });
});

describe("tool-call attempt detection gaps (issue #1201)", () => {
  const OPEN = "<think>";
  const CLOSE = "</think>";

  test("an unterminated <tool_call> opener with no closer is an attempt — retryable error, not end_turn", () => {
    const { closed } = runThinkStream(["I will look now" + OPEN + "<tool_call>{\"name\":\"Read\",\"arguments\":{", "oops" + CLOSE], "stop");
    expect(closed.ok).toBe(false);
    const err = closed.frames.map(parseFrame).find((f) => f.event === "error");
    expect(err).toBeDefined();
    expect((err?.data as { error: { message: string } }).error.message).toMatch(/retry/i);
    expect(closed.frames.some((f) => f.includes("message_stop"))).toBe(false);
  });

  test("bare JSON after prose inside  thinking is an attempt — retryable error", () => {
    const { closed } = runThinkStream(["I will look now" + OPEN + "let me check.\n{\"name\":\"Read\",\"arguments\":{\"file_path\":\"a\"}}" + CLOSE], "stop");
    expect(closed.ok).toBe(false);
    const err = closed.frames.map(parseFrame).find((f) => f.event === "error");
    expect(err).toBeDefined();
    expect((err?.data as { error: { message: string } }).error.message).toMatch(/retry/i);
    expect(closed.frames.some((f) => f.includes("message_stop"))).toBe(false);
  });

  test("prose mentioning \"name\": with no brace is NOT an attempt — end_turn, ok", () => {
    const { frames, closed } = runThinkStream(["Done" + OPEN + "the field \"name\": \"x\" matters here" + CLOSE], "stop");
    expect(closed.ok).toBe(true);
    expect(closed.frames.map(parseFrame).some((f) => f.event === "error")).toBe(false);
    expect(closed.frames.map(parseFrame).find((f) => f.event === "message_delta")?.data)
      .toMatchObject({ delta: { stop_reason: "end_turn" } });
    expect(frames.map(parseFrame).some((f) => f.event === "content_block_start"
      && (f.data as { content_block: { type: string } }).content_block.type === "tool_use")).toBe(false);
  });

  test("one tagged call parses, its sibling fails — retryable error even though one recovered", () => {
    const { closed } = runThinkStream([
      "I will look now" + OPEN
      + "<tool_call>{\"name\":\"Read\",\"arguments\":{\"file_path\":\"a\"}}</tool_call>"
      + "<tool_call>{not valid json</tool_call>" + CLOSE,
    ], "stop");
    expect(closed.ok).toBe(false);
    const err = closed.frames.map(parseFrame).find((f) => f.event === "error");
    expect(err).toBeDefined();
    expect((err?.data as { error: { message: string } }).error.message).toMatch(/retry/i);
    expect(closed.frames.some((f) => f.includes("message_stop"))).toBe(false);
  });
});

// Issue #1209 (maestro review round 3): a truncated sibling after the last
// complete </tool_call> must still flag the turn — the tagged loop used to
// return early and drop it silently. Test 4 feeds the same shape through the
// real wire path (SSE data line -> parseSseDataLine -> chunk).
describe("tool-call attempt detection round 3 (issue #1209)", () => {
  const OPEN = "<think>";
  const CLOSE = "</think>";

  test("an unterminated <tool_call> opener with no name is an attempt — retryable error", () => {
    const { closed } = runThinkStream(["I will look now" + OPEN + '<tool_call>{', "still no name" + CLOSE], "stop");
    expect(closed.ok).toBe(false);
    const err = closed.frames.map(parseFrame).find((f) => f.event === "error");
    expect(err).toBeDefined();
    expect((err?.data as { error: { message: string } }).error.message).toMatch(/retry/i);
    expect(closed.frames.some((f) => f.includes("message_stop"))).toBe(false);
  });

  test('a brace-leading body without "name" is an attempt — retryable error', () => {
    const { closed } = runThinkStream(["I will look now" + OPEN + '{"arguments":{"file_path":"a"}}', "oops" + CLOSE], "stop");
    expect(closed.ok).toBe(false);
    const err = closed.frames.map(parseFrame).find((f) => f.event === "error");
    expect(err).toBeDefined();
    expect((err?.data as { error: { message: string } }).error.message).toMatch(/retry/i);
    expect(closed.frames.some((f) => f.includes("message_stop"))).toBe(false);
  });

  test("a good call followed by a truncated sibling is an attempt — retryable error", () => {
    const { closed } = runThinkStream([
      "I will look now" + OPEN
      + '<tool_call>{"name":"Read","arguments":{"file_path":"a"}}</tool_call>'
      + '<tool_call>{"name":"Bash","arguments":{"command":"ls' + CLOSE,
    ], "stop");
    expect(closed.ok).toBe(false);
    const err = closed.frames.map(parseFrame).find((f) => f.event === "error");
    expect(err).toBeDefined();
    expect((err?.data as { error: { message: string } }).error.message).toMatch(/retry/i);
    expect(closed.frames.some((f) => f.includes("message_stop"))).toBe(false);
  });

  test("wire-level kimi stream: a trailing truncated tool_call is a retryable error", () => {
    const state = createStreamState({ thinkTags: true });
    const frames: string[] = [];
    const sse = (content: string) => "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n";
    const feed = (line: string) => {
      const chunk = parseSseDataLine(line);
      frames.push(...applyOpenAIStreamChunk(state, chunk));
    };
    feed(sse('<think>I need two calls'));
    feed(sse('<tool_call>{"name":"Read","arguments":{"file_path":"/workspace/acme/a.txt"}}</tool_call>'));
    feed(sse('<tool_call>{"name":"Bash","arguments":{"command":"ls -la"'));
    feed(sse('</think>'));
    frames.push(...applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }] }));
    const closed = closeStreamOrError(state, 64000);
    expect(closed.ok).toBe(false);
    expect(closed.reason).toBe("think_tool_call_unrecovered");
    expect(closed.frames.some((f) => f.includes("message_stop"))).toBe(false);
  });
});

// Issue #1099: a degenerate upstream stream is aborted with a retriable
// overloaded_error, not run to the 64k output cap. Round 3 (maestro review)
// dropped the per-model soft cap: repetition thresholds are conservative, and a
// `finish_reason: "length"` with no tool_use started is the backstop.
describe("runaway output detection (issue #1099)", () => {
  const delta = (d: Record<string, unknown>) => ({ choices: [{ delta: d }] });

  test("a line of 40+ chars repeated 50 times in a row sets reason repeat_line", () => {
    const state = createStreamState();
    for (let i = 0; i < 60; i++) applyOpenAIStreamChunk(state, delta({ content: "the same looping sentence, again and again\n" }));
    expect(state.runaway).toBe("repeat_line");
  });

  test("a paragraph of 200+ chars repeated 8 times in a row sets reason repeat_paragraph", () => {
    const state = createStreamState();
    const paragraph = `${"alpha line of prose that goes on for a while, ".repeat(5)}\nalpha second line of the same paragraph\n\n`;
    for (let i = 0; i < 10; i++) applyOpenAIStreamChunk(state, delta({ content: paragraph }));
    expect(state.runaway).toBe("repeat_paragraph");
  });

  test("repeated reasoning_content trips the same repeat check", () => {
    const state = createStreamState();
    for (let i = 0; i < 60; i++) applyOpenAIStreamChunk(state, delta({ reasoning_content: "loop loop loop loop loop loop loop loop loop loop\n" }));
    expect(state.runaway).toBe("repeat_line");
  });

  test("a line under 40 chars repeated many times does not trip (`}` and `---` style lines)", () => {
    const state = createStreamState();
    for (let i = 0; i < 200; i++) applyOpenAIStreamChunk(state, delta({ content: "  {\"a\": 1},\n" }));
    expect(state.runaway).toBeNull();
  });

  // Review case: CJK loop. CJK runs ~1.5 chars/token, so it is caught by the
  // repeated-line check when it has line breaks, and by the length rule otherwise.
  test("a CJK loop with line breaks is caught by the repeat check", () => {
    const state = createStreamState();
    const line = "这是一个重复的句子，没有任何新的内容。".repeat(3) + "\n";
    for (let i = 0; i < 60; i++) applyOpenAIStreamChunk(state, delta({ content: line }));
    expect(state.runaway).toBe("repeat_line");
  });

  test("a CJK loop without line breaks is caught by the length rule at the output cap", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, delta({ content: "推".repeat(40000) }));
    expect(state.runaway).toBeNull();
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "length" }] });
    const close = closeStreamOrError(state, 32000);
    expect(close.ok).toBe(false);
    expect(close.reason).toBe("runaway:length");
    expect(parseFrame(close.frames[0]).event).toBe("error");
  });

  // Review case: a 62k-char English answer with no repetition is a legit answer.
  test("a 62k-char English answer with no repetition passes", () => {
    const state = createStreamState();
    let text = "";
    for (let i = 0; text.length < 62000; i++) text += `token${i} ${i % 20 === 19 ? "\n" : ""}`;
    applyOpenAIStreamChunk(state, delta({ content: text }));
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }] });
    expect(state.runaway).toBeNull();
    expect(closeStreamOrError(state, 32000).ok).toBe(true);
  });

  // Review case: a 60-element JSON array of identical short objects is legit.
  test("a JSON array of 60 identical short objects passes", () => {
    const state = createStreamState();
    const lines = ["[", ...Array.from({ length: 60 }, () => '  {"a": 1},'), "]"].join("\n") + "\n";
    applyOpenAIStreamChunk(state, delta({ content: lines }));
    expect(state.runaway).toBeNull();
  });

  test("once a tool_use has started, a long repetitive tool argument stream passes", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Write", arguments: "" } }] } }] });
    const line = '  "row": "identical row of file content, repeated",\\n';
    for (let i = 0; i < 200; i++) {
      applyOpenAIStreamChunk(state, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: line } }] } }] });
    }
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    expect(state.runaway).toBeNull();
  });

  test("a normal short turn is untouched: no runaway, frames identical to a plain state", () => {
    const guarded = createStreamState();
    const plain = createStreamState();
    const chunks = [{ choices: [{ delta: { content: "hello " } }] }, { choices: [{ delta: { content: "world" }, finish_reason: "stop" }] }];
    const a = chunks.flatMap((c) => applyOpenAIStreamChunk(guarded, c));
    const b = chunks.flatMap((c) => applyOpenAIStreamChunk(plain, c));
    expect(a).toEqual(b);
    expect(guarded.runaway).toBeNull();
  });

  test("runawayErrorFrame is a retriable overloaded_error SSE error frame naming the reason", () => {
    const frame = parseFrame(runawayErrorFrame("repeat_line"));
    expect(frame.event).toBe("error");
    expect(frame.data).toMatchObject({ type: "error", error: { type: "overloaded_error" } });
    expect(JSON.stringify(frame.data)).toContain("repeat_line");
  });
});

const delta = (d: Record<string, unknown>) => ({ choices: [{ delta: d }] });

// Review case: kimi writes a tool call inside <think>; the tool marker can be
// split across 3-char deltas, so the payload must be recognised per tail of the
// text, not per delta. A payload is tool arguments, never reasoning.
describe("kimi in-think tool payload is never scanned as reasoning (issue #1099 review)", () => {
  test("an in-think Write split into 3-char deltas, with repeated lines, is not a runaway", () => {
    const state = createStreamState({ thinkTags: true });
    const body = `${"const row = 'identical line of generated code here';\n".repeat(1500)}`;
    const payload = `<tool_call>{"name":"Write","arguments":{"file_path":"a.ts","content":"${body}"}}</tool_call>`;
    const pieces = [`<think>Plan the file.\n`, ...Array.from({ length: Math.ceil(payload.length / 3) }, (_, i) => payload.slice(i * 3, i * 3 + 3)), "</think>"];
    for (const p of pieces) applyOpenAIStreamChunk(state, delta({ content: p }));
    expect(state.runaway).toBeNull();
  });

  test("reasoning in a think region with no tool call and a repeated line still trips", () => {
    const state = createStreamState({ thinkTags: true });
    applyOpenAIStreamChunk(state, delta({ content: `<think>${"z reasoning loop line, repeated many times over\n".repeat(60)}` }));
    expect(state.runaway).toBe("repeat_line");
  });
});

// Issue #1099 (review round 3): a non-streaming reply is built from the stream
// translator's own frames, and closeStreamOrError owns the no-finish and length
// checks, so the non-streaming path needs no second reassembly.
describe("closeStreamOrError runaway and finish rules (issue #1099 review)", () => {
  test("a length finish with no tool_use started is a retriable runaway, not max_tokens", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: { content: "partial" } }] });
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "length" }] });
    const close = closeStreamOrError(state, 32000);
    expect(close.ok).toBe(false);
    expect(close.reason).toBe("runaway:length");
  });

  test("a length finish after a tool_use started is a normal tool turn", () => {
    const state = createStreamState();
    applyOpenAIStreamChunk(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "{}" } }] } }] });
    applyOpenAIStreamChunk(state, { choices: [{ delta: {}, finish_reason: "length" }] });
    expect(closeStreamOrError(state, 32000).ok).toBe(true);
  });
});
