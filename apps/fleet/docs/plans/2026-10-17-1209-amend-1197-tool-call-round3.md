---
# Plan — task #1209: amend PR #1197 round 3, trailing unterminated tool_call

## Objective

Maestro review round 3 on PR #1197 (issue #1186). One gap remains: after the
tagged-call loop in `recoverThinkToolCalls`, a `<tool_call>` opener left
after the last complete `</tool_call>` is a truncated sibling and is
silently dropped. Also pin the two existing attempt branches with tests, and
add a wire-level kimi fixture.

## Change (translate.ts)

After the tagged-call loop (line ~781), when the text after the last
`</tool_call>` still matches `UNTERMINATED_TOOL_CALL` (`/<tool_call\b/`),
set `failedTagged = true` so the turn flags retryable instead of silently
dropping the truncated sibling.

## Tests (llm-translate-stream.test.ts, new #1209 block)

1. Unterminated opener with no `"name"` — retryable error (pins the
   `UNTERMINATED_TOOL_CALL` branch).
2. Brace-leading body without `"name"` — retryable error (pins the
   `startsWith("{")` clause).
3. Good call + truncated sibling — retryable error (pins the new tail check;
   RED before the fix).
4. Wire-level kimi stream (SSE data -> parseSseDataLine -> chunk) with a
   trailing truncated tool_call — retryable error. Recorded-shape replica:
   no live kimi recording exists in the repo (#1078).

Each of 1-4 must turn red under its own mutant (branch disabled / clause
dropped).

## Order

RED (2 fail, 69 pass) -> GREEN -> mutation-check each -> verify -> review -> QA.

## Boundaries

Touch only `apps/fleet/src/llm/translate.ts`,
`apps/fleet/test/bun/llm-translate-stream.test.ts`, this plan. Neutral names
only (acme). No `models.ts` thinkTags change.
---