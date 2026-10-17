---
# Plan — amend #1197: tool-call attempt detection gaps (#1201)

Maestro review of PR #1197 (#1186) found four gaps in `hadToolCallAttempt`
(`apps/fleet/src/llm/translate.ts`, `recoverThinkToolCalls`). All four are
about when the unrecovered-tool-call error fires, never about what is
recovered.

## Gaps

1. Unterminated `<tool_call>` opener with no closer is not an attempt — the
   `TOOL_CALL_TAG` match requires both tags, so an interrupted call is
   silently dropped instead of retried.
2. Bare JSON after prose (`text` with `{` then `"name"`) is not an attempt —
   the current `startsWith("{")` gate misses it.
3. A tagged call that fails to parse is dropped silently when a sibling call
   recovered — `take` discards its own failure.
4. The bare-JSON gate `startsWith("{")` also flags a brace object with no
   `"name"` — over-broad, the false-positive side of gap 2.

## Fix (translate.ts only)

- `recoverThinkToolCalls` returns `{ calls, hadToolCallAttempt, failedTagged }`.
- `take(raw)` returns a boolean: true only when the block parsed AND produced
  a call. `failedTagged` is true when any tagged block's `take` returns false.
- Attempt gates, in order: one or more `TOOL_CALL_TAG` matches (attempt, plus
  `failedTagged`); else `/<tool_call\b/` matches (unterminated opener);
  else `/\{\s*"name"/` matches (bare JSON, including after prose).
- `finishThink` sets `unrecoverableToolCall` when `failedTagged || (calls.length === 0 && hadToolCallAttempt)`.

## RED tests (apps/fleet/test/bun/llm-translate-stream.test.ts)

Four cases, each `closed.ok` / error-frame asserted like the existing #1186
block:

- Unterminated `<tool_call>` opener (no closer) inside ` thinking` → retryable
  error, never end_turn.
- Bare JSON after prose inside ` thinking` → retryable error.
- Prose `"name":` mention with no `{` → NOT an attempt, `end_turn`, ok.
- One tagged call parses, its sibling fails → retryable error even though one
  call recovered.

The last two cases use `{...}`-shaped bytes captured from a live kimi/deepseek
stream, replicated here as a hand-written fixture with the exact byte shape
documented in the test comment — no recording is committed to the repo (see
the fixture note).

## Steps

1. Plan doc (this file).
2. RED: add the four tests; `bun test test/bun/llm-translate-stream.test.ts` red; commit.
3. GREEN: implement; stream + request suites green; commit.
4. Verify (one at a time): stream test, request test, `bun run check`.
5. Update PR #1197 body; set awaiting_merge; envelope + `.context/REPORT.md`.

## Boundaries

Only `apps/fleet/src/llm/translate.ts`, `apps/fleet/test/bun/llm-translate-stream.test.ts`,
and this plan doc. Do NOT touch `models.ts` thinkTags flags or
`anthropic-route.ts`. Keep `TOOL_CALL_MARKER` (runaway scan still uses it).

## Fixture note

No live kimi/deepseek stream recording exists in the repo (issue #1078 shipped
the same hand-written-shape caveat). The `{...}`-shape cases are replicas with
the byte shape stated in the test comment, not a committed recording; re-check
against a live smoke before re-promoting kimi.