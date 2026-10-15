---
# S47-F5 session-memory — LCG seed reset per test (refs #966, refs #944, refs #715)

`apps/fleet/test/bun/session-memory.test.ts:156` declares `let seed = 7` at
module scope. `rnd()` advances it; `line(i)` builds synthetic session
snapshots from it. `beforeEach` (`.ts:79`) resets `maxWrite` but never `seed`,
so fixture bytes depend on how many `rnd()` calls earlier tests made —
order-dependent. Today's `toBeGreaterThan(0)` assertions survive; any future
exact-size assertion becomes a reorder flake.

## Change
- One file: `apps/fleet/test/bun/session-memory.test.ts`. Add `seed = 7;` to
  the existing `beforeEach`, next to `maxWrite = 0;`. No other files. No
  src/, cli/, container/.

## Steps (TDD)
1. Plan doc commit + push.
2. RED: temporary `describe` at end of file runs `line(0)` in one test and
   asserts a later test's `line(0)` equals it — fails (seed advanced). Drop
   the probe.
3. GREEN: add `seed = 7;` to `beforeEach`; same probe passes.

## Verify (sequential, one gate at a time)
- `cd apps/fleet && bun test test/bun/session-memory.test.ts` — all pass.
- `cd apps/fleet && npx tsc --noEmit -p test` — exit 0.
- `cd apps/fleet && bun run english-check` — clean.

## Boundaries
- One test file only. No src/, cli/, container/. No closing keywords for
  #944/#715.
---