// apps/fleet/src/llm/translate.ts
//
// Pure translation between Anthropic's Messages API shape (what Claude Code
// sends/expects, board issue #249's whole premise — `ANTHROPIC_BASE_URL`
// pointed at this fleet's Worker instead of the real Anthropic API) and
// Workers AI's OpenAI-chat-completions shape (`env.AI.run("@cf/zai-org/
// glm-5.3", {...})`). Nothing here touches `env`, `fetch`, or a binding —
// same "pure over ports" discipline as studio/spawn.ts (see that file's own
// header) — so every direction is unit-testable with plain objects. The
// HTTP shell (auth, body-size cap, SSE byte framing) lives in
// anthropic-route.ts; this file only ever converts one in-memory shape into
// another.
//
// Anthropic's Messages API has no vendored TypeScript types in this repo
// (confirmed before this file was written) — every shape below is
// hand-specified from the public API's own documented contract. Anywhere
// genuinely uncertain about an exact field name/shape, say so in a comment
// instead of guessing silently (see the stop_reason table and the
// message_delta usage shape below for the two places that applies).

// deno-lint-ignore no-explicit-any
type Json = any;

/** The v1 backend model (maestro decision, #249 STATUS comment
 *  2026-10-08T02:28Z) — fixed, not the client-requested `model` field. The
 *  Anthropic request's own `model` is only ever echoed back into the
 *  response's `model` field, for display; it never selects the backend. */
export const GLM_LEAD_MODEL = "@cf/zai-org/glm-5.3";

// ---------------------------------------------------------------------------
// Anthropic request -> OpenAI chat-completions request
// ---------------------------------------------------------------------------

/** Anthropic's `tool_result.content` and `system` can each be a plain string
 *  or an array of `{type:"text", text}` blocks — flattened to one string by
 *  joining non-empty parts with a blank line, the same join this file uses
 *  for a text-block-array message body (anthropicContentToText below). */
function flattenTextLike(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Json) => b && b.type === "text" && typeof b.text === "string")
      .map((b: Json) => b.text)
      .join("\n\n");
  }
  return "";
}

/** Anthropic `tool_choice` -> OpenAI `tool_choice`. `"any"` (Anthropic: force
 *  SOME tool call) is OpenAI's `"required"` — the two APIs use different
 *  words for the same forced-call-no-specific-tool concept. An unrecognized
 *  shape falls back to `"auto"` rather than throwing — a client sending a
 *  tool_choice variant this route doesn't know about should still get a
 *  response, not a 400 over a field it can't itself control at generation
 *  time. */
function mapToolChoice(tc: Json): Json {
  if (tc && tc.type === "auto") return "auto";
  if (tc && tc.type === "any") return "required";
  if (tc && tc.type === "none") return "none";
  if (tc && tc.type === "tool" && typeof tc.name === "string") {
    return { type: "function", function: { name: tc.name } };
  }
  return "auto";
}

/** One Anthropic `messages[]` entry -> zero or more OpenAI messages. An
 *  assistant turn (text + tool_use blocks) is always exactly one OpenAI
 *  message; a user turn can be several (Anthropic allows leading/trailing
 *  plain text around one or more `tool_result` blocks in the SAME turn —
 *  OpenAI has no equivalent of a mixed turn, so each `tool_result` becomes
 *  its own `{role:"tool"}` message and any text around it is flushed as its
 *  own `{role:"user"}` message, in the original order). */
function anthropicMessageToOpenAI(m: Json): Json[] {
  if (typeof m.content === "string") return [{ role: m.role, content: m.content }];
  const blocks: Json[] = Array.isArray(m.content) ? m.content : [];

  if (m.role === "assistant") {
    const textParts: string[] = [];
    const toolCalls: Json[] = [];
    for (const b of blocks) {
      if (b.type === "text") textParts.push(b.text);
      else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id, type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      }
      // Anything else (e.g. an image block) is dropped here, deliberately —
      // Claude Code rarely if ever sends one from a studio terminal, and
      // OpenAI-chat-completions assistant turns have no image-content
      // equivalent to carry it to anyway.
    }
    const out: Json = { role: "assistant", content: textParts.length > 0 ? textParts.join("\n\n") : null };
    if (toolCalls.length > 0) out.tool_calls = toolCalls;
    return [out];
  }

  // role === "user"
  const out: Json[] = [];
  let textBuffer: string[] = [];
  const flush = () => {
    if (textBuffer.length > 0) { out.push({ role: "user", content: textBuffer.join("\n\n") }); textBuffer = []; }
  };
  for (const b of blocks) {
    if (b.type === "text") {
      textBuffer.push(b.text);
    } else if (b.type === "tool_result") {
      flush();
      const content = flattenTextLike(b.content);
      out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `[error] ${content}` : content });
    }
    // Images in a user turn: same drop-and-comment rule as the assistant
    // branch above.
  }
  flush();
  return out;
}

/**
 * Anthropic Messages API request body -> Workers AI OpenAI-chat-completions
 * request body. `model` is always `GLM_LEAD_MODEL` — see that constant's own
 * doc comment.
 */
export function anthropicRequestToOpenAI(body: Json): Json {
  const messages: Json[] = [];
  if (body.system !== undefined && body.system !== null) {
    const text = flattenTextLike(body.system);
    if (text.length > 0) messages.push({ role: "system", content: text });
  }
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    messages.push(...anthropicMessageToOpenAI(m));
  }

  const out: Json = { model: GLM_LEAD_MODEL, messages, max_tokens: body.max_tokens };
  if (body.stream === true) out.stream = true;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t: Json) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  if (body.tool_choice !== undefined) out.tool_choice = mapToolChoice(body.tool_choice);
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI chat-completions response -> Anthropic response
// ---------------------------------------------------------------------------

/**
 * OpenAI `finish_reason` -> Anthropic `stop_reason`. The four Anthropic
 * values documented for a non-tool/non-stop-sequence turn are `end_turn`,
 * `max_tokens`, `tool_use`, `stop_sequence` — this route never sets
 * `stop_sequence` (it would require echoing back WHICH configured stop
 * string matched, which this translation does not track). `content_filter`
 * has no documented Anthropic equivalent at all; mapped to `end_turn` as the
 * least-wrong default rather than inventing a stop_reason value Claude Code
 * has never seen. Flagged here, not guessed at silently.
 */
function mapFinishReason(reason: unknown): string {
  switch (reason) {
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    case "function_call": return "tool_use";
    case "stop":
    case "content_filter":
    default:
      return "end_turn";
  }
}

/** `msg_<32 hex>` — Anthropic's own ids look like `msg_01XFDUDY...`
 *  (base62-ish, vendor-internal format). The exact alphabet is not part of
 *  the documented contract Claude Code depends on (it treats the id as an
 *  opaque string), so this format is a reasonable stand-in, not a guess at
 *  something load-bearing. */
function newMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Workers AI's OpenAI-chat-completions response -> one Anthropic Messages
 * API response (non-streaming shape: `{id, type:"message", role:"assistant",
 * content:[...], stop_reason, usage:{input_tokens,output_tokens}}`).
 */
export function openAIResponseToAnthropic(resp: Json, opts: { model: string; id?: string }): Json {
  const choice = resp?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: Json[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    let input: Json = {};
    try { input = JSON.parse(tc.function?.arguments ?? "{}"); }
    catch { /* malformed model output — an empty input beats throwing on a tool the caller DID ask for */ }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }

  return {
    id: opts.id ?? newMessageId(),
    type: "message",
    role: "assistant",
    model: opts.model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp?.usage?.prompt_tokens ?? 0,
      output_tokens: resp?.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Error classification — env.AI.run throws a bare Error with free-text,
// same shape junior/route.ts's aiErrorCode already classifies (see that
// function's own doc comment on why unscoped substring matching is the best
// signal available: env.AI.run is a direct binding call, not an HTTP
// response with its own status line). Adapted rather than imported — this
// route's callers need an Anthropic error TYPE + HTTP status, not junior's
// own numeric code, so reusing the symbol directly would mean mapping its
// output a second time anyway.
// ---------------------------------------------------------------------------

/**
 * Anthropic's documented error types and the HTTP status each one pairs
 * with: `invalid_request_error`(400), `authentication_error`(401),
 * `permission_error`(403), `not_found_error`(404),
 * `request_too_large`(413), `rate_limit_error`(429), `api_error`(500),
 * `overloaded_error`(529). Only the three this backend can actually produce
 * are classified; everything else is `api_error`/500 — the generic bucket a
 * caller already has to handle for an unrecognized failure.
 */
export function classifyAiError(message: string): { status: number; type: string } {
  if (/timeout/i.test(message)) return { status: 504, type: "api_error" };
  if (/capacity/i.test(message)) return { status: 529, type: "overloaded_error" };
  if (/rate limit|too many/i.test(message)) return { status: 429, type: "rate_limit_error" };
  return { status: 500, type: "api_error" };
}

// ---------------------------------------------------------------------------
// Streaming: OpenAI SSE delta chunks -> Anthropic SSE event sequence
// ---------------------------------------------------------------------------

/** `event: <type>\ndata: <json>\n\n` — Anthropic's own SSE frame shape. */
function sseEvent(type: string, data: Json): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** One line of an upstream OpenAI-compatible SSE body -> the parsed chunk
 *  object, the literal string `"DONE"` for the `data: [DONE]` sentinel, or
 *  `null` for anything that is not a `data:` line (blank lines, `event:`
 *  lines this backend doesn't send, SSE comment lines starting `:`). */
export function parseSseDataLine(line: string): Json | "DONE" | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return "DONE";
  try { return JSON.parse(payload); } catch { return null; }
}

export interface StreamState {
  /** Index of the next NEW content block this stream will open. */
  nextIndex: number;
  /** Anthropic content-block index currently holding the running text block,
   *  or null if no text delta has arrived yet. */
  textIndex: number | null;
  /** OpenAI `tool_calls[].index` -> the Anthropic content-block index opened
   *  for it. A GLM tool call can stream its name/id on the first delta and
   *  its arguments across many more; this is what lets every later delta for
   *  the same call find its already-open block. */
  toolIndexByOpenAiIndex: Map<number, number>;
  /** Every content-block index opened so far, in open order — closeStream
   *  emits `content_block_stop` in this same order (text and tool blocks
   *  interleave however the model actually opened them). */
  openedInOrder: number[];
  finishReason: unknown;
  outputTokens: number;
}

export function createStreamState(): StreamState {
  return { nextIndex: 0, textIndex: null, toolIndexByOpenAiIndex: new Map(), openedInOrder: [], finishReason: null, outputTokens: 0 };
}

/** The one-time `message_start` event. Always first, before any chunk is
 *  applied — Claude Code treats this as the frame that establishes the
 *  message id/model/role, with a zeroed usage it expects `message_delta` to
 *  update. */
export function streamPrelude(id: string, model: string): string[] {
  return [sseEvent("message_start", {
    type: "message_start",
    message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  })];
}

/** Applies one parsed OpenAI streaming chunk to `state` (mutated in place —
 *  one state per in-flight request, never shared) and returns the Anthropic
 *  SSE frames it produces. A chunk with no `choices[0]` (some providers send
 *  a trailing usage-only chunk) produces no frames and never throws. */
export function applyOpenAIStreamChunk(state: StreamState, chunk: Json): string[] {
  const choice = chunk?.choices?.[0];
  if (chunk?.usage?.completion_tokens !== undefined) state.outputTokens = chunk.usage.completion_tokens;
  if (!choice) return [];
  const events: string[] = [];
  const delta = choice.delta ?? {};
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) state.finishReason = choice.finish_reason;

  if (typeof delta.content === "string" && delta.content.length > 0) {
    if (state.textIndex === null) {
      state.textIndex = state.nextIndex++;
      state.openedInOrder.push(state.textIndex);
      events.push(sseEvent("content_block_start", { type: "content_block_start", index: state.textIndex, content_block: { type: "text", text: "" } }));
    }
    events.push(sseEvent("content_block_delta", { type: "content_block_delta", index: state.textIndex, delta: { type: "text_delta", text: delta.content } }));
  }

  for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    const openAiIndex = tc.index ?? 0;
    let anthropicIndex = state.toolIndexByOpenAiIndex.get(openAiIndex);
    if (anthropicIndex === undefined) {
      anthropicIndex = state.nextIndex++;
      state.toolIndexByOpenAiIndex.set(openAiIndex, anthropicIndex);
      state.openedInOrder.push(anthropicIndex);
      events.push(sseEvent("content_block_start", {
        type: "content_block_start", index: anthropicIndex,
        content_block: { type: "tool_use", id: tc.id, name: tc.function?.name, input: {} },
      }));
    }
    const argsDelta = tc.function?.arguments;
    if (typeof argsDelta === "string" && argsDelta.length > 0) {
      events.push(sseEvent("content_block_delta", { type: "content_block_delta", index: anthropicIndex, delta: { type: "input_json_delta", partial_json: argsDelta } }));
    }
  }

  return events;
}

/** Closes every open content block (in the order they were opened), then
 *  emits `message_delta` (stop_reason + usage) and `message_stop` once.
 *  Anthropic's documented `message_delta.usage` shape carries only
 *  `output_tokens` (input doesn't change mid-stream) — not fully certain
 *  this backend's own wire format matches that exactly, so this is the one
 *  field in this file flagged as "best effort against the documented
 *  contract", same spirit as mapFinishReason's content_filter case above. */
export function closeStream(state: StreamState): string[] {
  const events: string[] = [];
  for (const index of state.openedInOrder) {
    events.push(sseEvent("content_block_stop", { type: "content_block_stop", index }));
  }
  events.push(sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: mapFinishReason(state.finishReason), stop_sequence: null },
    usage: { output_tokens: state.outputTokens },
  }));
  events.push(sseEvent("message_stop", { type: "message_stop" }));
  return events;
}
