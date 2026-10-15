# #951 plan — sanitize non-Anthropic tool_use ids in model-pool translation

Refs #951, refs #911 (model-pool translation). One pure function + wiring it
into 4 id-passing sites in apps/fleet/src/llm/translate.ts. No behavior
change beyond id sanitization.

## Problem

apps/fleet/src/llm/translate.ts copies upstream OpenAI-chat-completions
tool-call ids VERBATIM into Anthropic `tool_use` content blocks. Kimi (and
other non-Anthropic pool models) generate ids containing `:` and `.` (e.g.
`call_abc:def.123`), which violate Anthropic's Messages API id pattern
`^[a-zA-Z0-9_-]+$`. When a lead studio resumes a session, its history
(containing those poisoned ids) is replayed; Anthropic validates and returns
400 `messages.1.content.0.tool_use.id: String should match pattern
'^[a-zA-Z0-9_-]+$'`, poisoning the whole session.

## Fix

Add ONE exported pure function to apps/fleet/src/llm/translate.ts:

```ts
export function sanitizeToolId(raw: unknown): string {
  ...
}
```

Requirements:

- Deterministic mapping: same input always yields the same output. This is
  the load-bearing property — it is what lets a `tool_result.tool_use_id` in
  a LATER inbound turn still pair with the `tool_use.id` this function emitted
  in an earlier outbound turn. Do not lose it.
- Output matches `^[a-zA-Z0-9_-]+$` ALWAYS.
- Idempotent: an already-valid id passes through unchanged (so an id already
  sanitized in history stays stable).
- Mapping is deterministic character substitution: every character NOT in
  `[A-Za-z0-9_-]` maps to `_` (`raw.replace(/[^A-Za-z0-9_-]/g, "_")` or
  equivalent); if the result is empty, treat as missing and generate via the
  existing `crypto.randomUUID()` fallback (`toolu_<uuid>`, matching
  `newToolUseId()`). A non-string or empty raw input is a missing id — same
  `newToolUseId()` behavior, preserved (not regressed).

Wire it in at ALL 4 sites that currently pass an upstream tool id to the
client:

1. `anthropicMessageToOpenAI` (inbound assistant `tool_use` -> OpenAI
   `tool_calls[].id`): `id: b.id` -> `id: sanitizeToolId(b.id)` — the
   "inbound history ids sanitized the same way" half.
2. `anthropicMessageToOpenAI` (inbound user `tool_result` -> OpenAI
   `{role:"tool"}.tool_call_id`): `tool_call_id: b.tool_use_id` ->
   `tool_call_id: sanitizeToolId(b.tool_use_id)` — the OTHER half of "inbound
   history ids sanitized the same way": a tool_result referencing a poisoned
   tool_use id must be sanitized identically so it still pairs.
3. `openAIResponseToAnthropic` (outbound OpenAI `tool_calls[].id` -> Anthropic
   `tool_use.id`): `id: toolUseId(tc.id)` -> `id: sanitizeToolId(tc.id)` — the
   "every tool_use id emitted to the client matches the pattern" half.
4. `applyOpenAIStreamChunk` (streaming `content_block_start` `tool_use.id`):
   `id: toolUseId(tc.id)` -> `id: sanitizeToolId(tc.id)`.

Make `toolUseId` (private, confirmed not imported anywhere else) delegate to
`sanitizeToolId` (or delete it and inline `sanitizeToolId`). Keep
`newToolUseId()` as-is.

## Mutation check

RED: write only the failing tests (no src change) — a kimi-style id
`"call_abc:def.123"` (contains `:` and `.`) must sanitize to
`"call_abc_def_123"` at all 4 sites, and the result must match
`^[a-zA-Z0-9_-]+$`. Run `cd apps/fleet && bun test
test/bun/llm-translate-request.test.ts test/bun/llm-translate-stream.test.ts`
— the new sanitization assertions FAIL against the current verbatim-copy src
(the verbatim id `call_abc:def.123` survives unchanged). This proves the tests
detect the bug, not just the fix.

## Verification

- GREEN run: same two-file `bun test` command — all pass (`N pass / 0 fail`).
- NO heavy gates: no full test suite, no repo-wide tsc/typecheck, no vite
  build, no e2e, no `bun run check` — those are the lead's gate.
- `git log origin/main..origin/fix-951-sanitize-tool-use-ids --oneline` shows
  3 commits (plan, RED, GREEN), pushed after each.