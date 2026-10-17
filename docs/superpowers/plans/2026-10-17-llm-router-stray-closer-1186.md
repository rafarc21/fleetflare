# Plan — LLM router: drop stray `</think>`, error on unrecovered in-think tool call (#1186)

Two candidate causes of the live OSS lead stalls (#1112), both in `apps/fleet/src/llm/translate.ts`, both found in the #1183 review and identical on `main`.

## Defects

1. `routeContent` (translate.ts:712): while not inside `<think>`, the scanner only looks for `THINK_OPEN` (`<think>`). A stray `THINK_CLOSE` (`</think>`) with no preceding open is never matched, so `pushSegment` emits it as visible text. The lead's screen shows a literal `</think>`.

2. `closeStreamOrError` (translate.ts:1014): the unrecovered-in-think-tool-call guard requires `state.nextIndex === 0`. When the lead narrates first (visible text opens block index 0), then emits an unrecoverable tool call inside `<think>`, `nextIndex > 0`, the guard is skipped, and `closeStream` closes with `stop_reason: end_turn` and no `tool_use`. The client sees a turn that ended without the tool call — the narrate-and-stop stall. The recovery needs `nextIndex === 0`, so any prior narration defeats it.

## Fix

1. In `routeContent`, while not thinking: if `THINK_CLOSE` appears before the next `THINK_OPEN` (or no open exists), drop it and continue scanning — a closer with no opener is noise, never visible text.

2. Narrow `unrecoverableToolCall` to a genuine tool-call attempt, then error regardless of narration:
   - `recoverThinkToolCalls` returns `{ calls, hadToolCallAttempt }` instead of the bare array. `hadToolCallAttempt` is true when the think body had at least one `<tool_call>` tag, or when it is a bare `{...}` object (the two recognized payload shapes). A bare `"name": "..."` mention in reasoning prose is NOT an attempt (today it false-positives into the error path only because no output is present).
   - `finishThink` sets `unrecoverableToolCall` when `calls.length === 0 && hadToolCallAttempt`.
   - `closeStreamOrError` errors on `state.unrecoverableToolCall` with no `nextIndex` condition.

## RED tests (apps/fleet/test/bun/llm-translate-stream.test.ts)

- Stray closer: content `answer text</think>` (no open) → visible text is `answer text`, no `</think>` delta; `end_turn`, `ok`.
- Narrate then unrecoverable tagged tool call: `I will look now<think><tool_call>{not valid json</tool_call></think>` → retryable error frame, no `message_stop`, `ok: false`.
- Narrate then bare-JSON attempt: `I will look now<think>{"name":"Read","arguments":{oops</think>` → retryable error, `ok: false`.
- No false positive: prose mention of a name in reasoning after narration (`...<think>the field "name": "x" matters</think>`) → `ok: true`, no error frame, `end_turn`.

## Steps

1. Plan doc (this file).
2. RED: add the four tests; run `bun test test/bun/llm-translate-stream.test.ts` (expect the new ones fail); commit.
3. GREEN: implement the two fixes; same file green; commit.
4. Verify (one at a time): `bun test test/bun/llm-translate-stream.test.ts`, then `bun test test/bun/llm-translate-request.test.ts`, then `bun run check`.
5. Push after first commit; PR refs #1186 (no closing keyword); envelope.

## Boundaries

Touch only `apps/fleet/src/llm/translate.ts`, `apps/fleet/test/bun/llm-translate-stream.test.ts`, this plan doc. Do NOT change `models.ts` thinkTags flags (DeepSeek/GLM byte-identical passthrough is a separate, tested contract — #1073 review). Do NOT touch `anthropic-route.ts` or the `runaway` scan. Keep `TOOL_CALL_MARKER` (still used by the runaway scan at translate.ts:590).