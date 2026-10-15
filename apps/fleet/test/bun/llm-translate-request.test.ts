// apps/fleet/test/bun/llm-translate-request.test.ts
// Pure translation functions for #249's GLM-led studio route — no env/fetch,
// so every direction (Anthropic request -> OpenAI, OpenAI response ->
// Anthropic) is tested with plain objects, bun:test, no mocking. The
// streaming + error-classification directions live in the sibling file
// llm-translate-stream.test.ts.
import { describe, expect, test } from "bun:test";
import {
  GLM_LEAD_MODEL,
  GLM_MIN_MAX_TOKENS,
  anthropicRequestToOpenAI,
  openAIResponseToAnthropic,
} from "../../src/llm/translate";

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

// Task 4 (spec 2026-10-13-model-pool-design, Components 3/4): the picked pool
// model now selects BOTH the outbound `model` id and the `max_tokens` floor —
// previously both were hardcoded to GLM_LEAD_MODEL/GLM_MIN_MAX_TOKENS.
describe("anthropicRequestToOpenAI — pool model override", () => {
  test("model override sets id and max_tokens floor", () => {
    const out = anthropicRequestToOpenAI({ messages: [{ role: "user", content: "hi" }], max_tokens: 10 }, { id: "@cf/b/kimi", minMaxTokens: 9000, maxMaxTokens: 32000 });
    expect(out.model).toBe("@cf/b/kimi");
    expect(out.max_tokens).toBe(9000);
  });
  test("no override keeps GLM defaults", () => {
    const out = anthropicRequestToOpenAI({ messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
    expect(out.model).toBe("@cf/zai-org/glm-5.3");
    expect(out.max_tokens).toBe(16000);
  });
});

// Incident #717: a live GLM-lead studio died mid-turn with "API Error:
// response exceeded the 64000 output token maximum" — a model's
// reasoning_content (visible chain-of-thought emitted alongside the final
// answer) can push TOTAL output past Claude Code's own hard 64k output-token
// limit even when the inbound Anthropic request's own `max_tokens` was far
// smaller than that. GLM_MIN_MAX_TOKENS above is a FLOOR only; this is the
// matching CEILING on the same computed value — never let the upstream
// request ask for more than `model.maxMaxTokens`, regardless of what the
// client (after the floor already raised it) or the floor itself asked for.
describe("anthropicRequestToOpenAI — maxMaxTokens ceiling", () => {
  test("a max_tokens above the ceiling is clamped down to maxMaxTokens, not passed through", () => {
    const out = anthropicRequestToOpenAI(
      { messages: [{ role: "user", content: "hi" }], max_tokens: 100000 },
      { id: "@cf/b/kimi", minMaxTokens: 16000, maxMaxTokens: 32000 },
    );
    expect(out.max_tokens).toBe(32000);
  });

  test("a max_tokens below the floor still floors to minMaxTokens — the ceiling doesn't break the existing floor behavior", () => {
    const out = anthropicRequestToOpenAI(
      { messages: [{ role: "user", content: "hi" }], max_tokens: 5000 },
      { id: "@cf/b/kimi", minMaxTokens: 16000, maxMaxTokens: 32000 },
    );
    expect(out.max_tokens).toBe(16000);
  });

  test("a max_tokens strictly between floor and ceiling passes through unchanged", () => {
    const out = anthropicRequestToOpenAI(
      { messages: [{ role: "user", content: "hi" }], max_tokens: 20000 },
      { id: "@cf/b/kimi", minMaxTokens: 16000, maxMaxTokens: 32000 },
    );
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

  // Board issue #951: Kimi (and other non-Anthropic pool models) generate
  // tool ids containing ":" and "." (e.g. call_abc:def.123), which violate
  // Anthropic's Messages API id pattern ^[a-zA-Z0-9_-]+$. A resumed session
  // replays history containing those poisoned ids, so every id this file
  // passes through must be sanitized to that pattern — deterministically,
  // so a later tool_result still pairs with the tool_use it references.
  test("an assistant tool_use id with ':' and '.' is sanitized to the ^[a-zA-Z0-9_-]+$ pattern", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{
        role: "assistant",
        content: [{ type: "tool_use", id: "call_abc:def.123", name: "get_weather", input: { city: "nyc" } }],
      }],
    });
    expect(out.messages[0].tool_calls[0].id).toBe("call_abc_def_123");
  });

  test("a user tool_result whose tool_use_id has ':' and '.' is sanitized identically, so it still pairs", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_abc:def.123", content: "ok" }] }],
    });
    expect(out.messages[0]).toEqual({ role: "tool", tool_call_id: "call_abc_def_123", content: "ok" });
  });

  test("an already-sanitized id passes through unchanged (idempotence, so a later tool_result still pairs)", () => {
    const out = anthropicRequestToOpenAI({
      model: "x", max_tokens: 10,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_abc_def_123", content: "ok" }] }],
    });
    expect(out.messages[0]).toEqual({ role: "tool", tool_call_id: "call_abc_def_123", content: "ok" });
  });
});

describe("openAIResponseToAnthropic — text", () => {
  test("plain text choice -> one text content block, mapped usage", () => {
    const out = openAIResponseToAnthropic({
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 4 },
    }, { model: "claude-opus-4-5", requestedMaxTokens: 1_000_000 });
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
    }, { model: "m", requestedMaxTokens: 1_000_000 });
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
    }, { model: "m", requestedMaxTokens: 1_000_000 });
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
    }, { model: "m", requestedMaxTokens: 1_000_000 });
    expect(out.usage).toEqual({ input_tokens: 500, output_tokens: 6861 });
  });
});

// Incident #717 part B: the floor/ceiling on the OUTBOUND max_tokens (above)
// bounds what the upstream request ASKS for, but reasoning_content can still
// inflate the upstream's SELF-REPORTED completion_tokens past what the
// ORIGINAL client request asked for — reporting that inflated number back as
// `usage.output_tokens` would make Claude Code's own token-accounting see a
// bigger number than it itself requested. `opts.requestedMaxTokens` is the
// inbound Anthropic request's own `max_tokens`, BEFORE any floor/ceiling
// clamping — a reporting-only clamp on the numeric usage field, never on the
// actual returned content.
describe("openAIResponseToAnthropic — output_tokens clamped to requestedMaxTokens", () => {
  test("a huge completion_tokens (reasoning_content inflation) is clamped to the original request's max_tokens", () => {
    const out = openAIResponseToAnthropic({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 70000 },
    }, { model: "m", requestedMaxTokens: 8000 });
    expect(out.usage).toEqual({ input_tokens: 50, output_tokens: 8000 });
  });

  test("a normal completion_tokens smaller than requestedMaxTokens passes through unchanged", () => {
    const out = openAIResponseToAnthropic({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 3000 },
    }, { model: "m", requestedMaxTokens: 8000 });
    expect(out.usage).toEqual({ input_tokens: 50, output_tokens: 3000 });
  });

  // Fresh-context review (#717 critical follow-up): `requestedMaxTokens` is
  // now a REQUIRED field, not optional — an optional field here is exactly
  // how the real non-streaming route call site shipped unclamped with no
  // compiler error, no failing test. There is no longer a "not provided"
  // shape to test; this pins the boundary instead (completion_tokens exactly
  // equal to requestedMaxTokens passes through unchanged, never clamped
  // below the real count).
  test("completion_tokens exactly equal to requestedMaxTokens is not clamped below itself", () => {
    const out = openAIResponseToAnthropic({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 8000 },
    }, { model: "m", requestedMaxTokens: 8000 });
    expect(out.usage).toEqual({ input_tokens: 50, output_tokens: 8000 });
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
    }, { model: "m", requestedMaxTokens: 1_000_000 });
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
    }, { model: "m", requestedMaxTokens: 1_000_000 });
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
    }, { model: "m", requestedMaxTokens: 1_000_000 });
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
    }, { model: "m", requestedMaxTokens: 1_000_000 });
    expect(out.content[0].id).toMatch(/^toolu_[0-9a-f]{32}$/);
  });

  test("a real tool_call id is kept as-is, never replaced", () => {
    const out = openAIResponseToAnthropic({
      choices: [{
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_abc123", type: "function", function: { name: "f", arguments: "{}" } }] },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, { model: "m", requestedMaxTokens: 1_000_000 });
    expect(out.content[0].id).toBe("call_abc123");
  });

  // Board issue #951: a Kimi-style id containing ":" and "." must be
  // sanitized on the way OUT to the Anthropic client too — same deterministic
  // mapping as the inbound direction, so the emitted tool_use.id always
  // matches ^[a-zA-Z0-9_-]+$ and a later tool_result can still pair with it.
  test("a tool_call id with ':' and '.' becomes a tool_use id matching ^[a-zA-Z0-9_-]+$", () => {
    const out = openAIResponseToAnthropic({
      choices: [{
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "call_abc:def.123", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "nyc" }) } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }, { model: "m", requestedMaxTokens: 1_000_000 });
    expect(out.content[0].id).toBe("call_abc_def_123");
    expect(out.content[0].id).toMatch(/^[a-zA-Z0-9_-]+$/);
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
    }, { model: "m", requestedMaxTokens: 1_000_000 });
    expect(out.stop_reason).toBe("tool_use");
  });
});
