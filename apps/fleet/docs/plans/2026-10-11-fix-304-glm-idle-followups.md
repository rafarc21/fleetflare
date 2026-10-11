# GLM idle-timeout follow-ups from #303 review (board issue #304)

Items 1 and 3 only (item 2 is maestro ops, skipped), from the #303 review of
issue #302's work in `src/llm/anthropic-route.ts`: the console line carries
raw upstream text that can echo request input and outlives the request in
`wrangler tail`; and tests cover only ONE overall deadline, never re-arming.

## Goal

- Item 3: the console.error line names the class/status only (new exported
  `failureClass`); the D1 `error` column keeps the full capped message.
- Item 1: prove a slow-but-steady stream (gaps under the limit, total
  over it) completes normally — the timer re-arms per chunk.

## Plan

1. Item 3 RED: a prompt-echoing upstream error must NOT reach the console
   line (but stays in the D1 column), plus a `failureClass` unit test
   covering every failure shape. Targeted vitest RED.
2. Item 3 GREEN: `failureClass` (strip from the first `:` onward; plain
   `idle_timeout`/`client_abort`/`no_finish_reason` pass through) feeds
   the console line's `reason=`.
3. Item 1: slow-steady-stream test (LEAD_STREAM_IDLE_MS 300, 60ms gaps,
   8 chunks, ~480ms total) — normal event sequence, no `error` event,
   `ok: 1` in the usage row.
4. Mutation check: one overall deadline in `readWithIdleTimeout` — run
   ONLY the new test (must FAIL), then revert.

## Boundaries

- Only `apps/fleet/src/llm/anthropic-route.ts`,
  `apps/fleet/test/llm.anthropic-route.test.ts`, and this plan doc.
- Targeted vitest only; D1 `error` column NOT changed; English only,
  conventional commits, fleet-studio identity.

## Verification

- Targeted vitest exit 0 (item-3 tests RED before GREEN); `bun run check`
  (tsc) exit 0; `bun run english-check` clean.
- Mutation check: single-deadline implementation FAILS the item-1 test.
