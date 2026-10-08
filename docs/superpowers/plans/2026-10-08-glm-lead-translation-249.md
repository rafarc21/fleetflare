# GLM-led studio: Anthropic<->OpenAI translation route (#249)

**Issue:** https://github.com/rafarc21/fleetflare/issues/249

**Scope of this dispatch:** route + translation only. Admission-gate bypass,
container env wiring (studioEnvVars, launchAccountOrRefuse call sites,
`lead: glm` studio field) is a separate, later dispatch on this same branch.
Not touching do.ts/accounts.ts/types.ts here.

## Goal

New route `POST /fleet/llm/anthropic/v1/messages`. Claude Code binary points
`ANTHROPIC_BASE_URL` here instead of real Anthropic. Translates both ways:

- in: Anthropic Messages API request (text/tool_use/tool_result blocks,
  top-level `system`, `tools` with `input_schema`).
- out: Workers AI GLM (`env.AI.run("@cf/zai-org/glm-5.3", ...)`), OpenAI
  chat-completions shape (`messages` role/content, `tools` function/parameters,
  `tool_choice`, `stream`).
- back: Anthropic Messages API response (non-stream JSON) or Anthropic SSE
  event sequence (stream).

## Auth

Spawn-token auth, same shape as `/fleet/junior` (`isSpawnTokenShaped` +
`resolveSpawnParent`, both reused from `studio/spawn.ts`, no reimplementation).
Difference: token arrives as `Authorization: Bearer <token>` (maestro decision
1) OR `x-api-key: <token>` (maestro's follow-up comment: accept both, cheap,
robust to client variance) instead of junior's custom header.

Not done in this dispatch: capturing the real header Claude Code's own binary
sends (the issue asks for this as part of the wider PR's live-proof
requirement) — flagged in the final report, not blocking the translation
work itself.

## Files

- `apps/fleet/src/http/capped-body.ts` — `readCappedBody` extracted verbatim
  out of `junior/route.ts` (mechanical, same cap-then-stream logic) so both
  routes import one copy instead of carrying two.
- `apps/fleet/src/llm/translate.ts` — pure functions, no `env`/`fetch`:
  - `anthropicRequestToOpenAI` (Anthropic request -> OpenAI chat body)
  - `openAIResponseToAnthropic` (OpenAI response -> Anthropic response)
  - `classifyAiError` (thrown message -> Anthropic error type/status, same
    unscoped substring match `junior/route.ts`'s `aiErrorCode` uses, adapted
    rather than imported since the two map to different output shapes)
  - stream state machine: `createStreamState`, `streamPrelude`,
    `applyOpenAIStreamChunk`, `closeStream` — OpenAI SSE delta chunks in,
    Anthropic SSE event strings out.
  - `parseSseDataLine` — split one `data: ...` line into a parsed chunk, the
    `"[DONE]"` sentinel, or null.
- `apps/fleet/src/llm/anthropic-route.ts` — `handleFleetAnthropicMessages`,
  mirrors `junior/route.ts`'s own shape: method/path checks, Content-Length
  cap, spawn-token auth, capped body read, JSON parse, translate, call
  `env.AI.run`, translate back, stream or single JSON response.
- Tests: `apps/fleet/test/bun/llm-translate.test.ts` (pure, bun:test, every
  translation direction + edge case) and `apps/fleet/test/llm.anthropic-route.test.ts`
  (vitest + cloudflare:test, HTTP/auth/framing layer, same convention as
  `apps/fleet/test/junior.route.test.ts`).

## Shape mapping (concrete)

Text: Anthropic `{role, content: "hi"}` <-> OpenAI `{role, content: "hi"}`.
`system` (string or text-block array) becomes one leading OpenAI
`{role:"system", content}` message.

tool_use (assistant turn): Anthropic content block `{type:"tool_use", id,
name, input}` -> OpenAI `tool_calls: [{id, type:"function", function:{name,
arguments: JSON.stringify(input)}}]` on that assistant message.

tool_result (user turn): Anthropic content block `{type:"tool_result",
tool_use_id, content, is_error?}` -> OpenAI `{role:"tool", tool_call_id,
content: <flattened text>}`. `is_error` has no OpenAI tool-message field;
flagged uncertain, prefixed into content as `"[error] "` rather than dropped.

Response: OpenAI `choices[0].message.content` -> Anthropic `content: [{type:
"text", text}]`; `tool_calls` -> `{type:"tool_use", id, name, input:
JSON.parse(arguments)}` blocks. `finish_reason` -> `stop_reason`: stop/
function_call -> end_turn/tool_use, length -> max_tokens, tool_calls ->
tool_use, content_filter -> end_turn (flagged uncertain — Anthropic has no
content_filter equivalent). `usage.prompt_tokens`/`completion_tokens` ->
`input_tokens`/`output_tokens`.

Streaming: `message_start` once, `content_block_start`/`content_block_delta`
(text_delta or input_json_delta)/`content_block_stop` per block (text block
first if any content arrives before the first tool call, one block per
OpenAI `tool_calls[].index`), `message_delta` (stop_reason + usage) then
`message_stop` once at stream end.

Errors: `env.AI.run` throw -> Anthropic `{type:"error", error:{type,
message}}`, status+type from `classifyAiError` (timeout -> 504/
`api_error`... see code comment for the exact table — kept deliberately
loose, same "unscoped substring, not a contract" posture `aiErrorCode`
documents for itself).

## Explicitly out of scope here (flagged, not silently dropped)

- The spec's "optional Anthropic-compatible passthrough" backend (provider
  base URL + key from a Worker secret) — this dispatch wires the Workers AI
  GLM path only.
- Image content blocks — Claude Code rarely sends them from a studio
  terminal; dropped with a code comment rather than guessed at.
- Admission gate / container env / `lead: glm` field — next dispatch.

## Process

RED (bun:test for translate.ts) -> GREEN -> RED (vitest for the route) ->
GREEN. Caveman-compressed commit messages. Push after every commit.
