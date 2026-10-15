# S48-F10 llm.anthropic-stream idle gaps — 60ms→40ms, LEAD_STREAM_IDLE_MS 300→200 (refs #979, refs #945, refs #715)

`apps/fleet/test/llm.anthropic-stream.test.ts:515-554`, "slow-but-steady stream" test: 8 SSE frames, real `sleep(60)` before each (~480ms) to prove per-chunk timer re-arming against `LEAD_STREAM_IDLE_MS=300`.

Real timers stay — the route arms a real setTimeout in the worker, so fake timers are awkward (finding's own note). Smallest fix per finding F10: 40ms gaps + `LEAD_STREAM_IDLE_MS=200`, ratio preserved (~160ms saved). Recorded minor.

## Change
- `:534` `await sleep(60)` → `await sleep(40)`
- `:540` `LEAD_STREAM_IDLE_MS: "300"` → `LEAD_STREAM_IDLE_MS: "200"`
- Comment `:529-531` "60ms gap" / "8 pulls x 60ms ~ 480ms total" → "40ms gap" / "8 pulls x 40ms ~ 320ms total"

## Verify (sequential, one gate at a time)
- `cd apps/fleet && npx vitest run test/llm.anthropic-stream.test.ts` (67 pass, ~5.5s)
- `cd apps/fleet && npx tsc --noEmit -p test`
- `cd apps/fleet && bun run english-check`

## Boundaries
- One file, three token edits. No container/, src/, cli/.
- No closing keywords for #945/#715.
- Heavy gates: this one test file only; `tsc -p test` only. No full suite, no vite build.