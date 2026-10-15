# S43-F13 — fakeObserved(seed) into test/helpers/observed-session.ts (#889)

Ref #850 (sweep 43, F13). Census: docs/maintainability/2026-10-14-dup-fixtures-sweep-43.md.

## Problem

`apps/fleet/test/studio.survival-retry.test.ts:45` and
`apps/fleet/test/studio.survival-input.test.ts:45` carry a byte-identical
9-line `fakeObserved(seed)`: a single-key `Map`-backed `ObservedStorage`
plus a `stored()` accessor. They are the #697 split pair whose `session()`
builder already moved to `test/helpers/observed-session.ts` (#753). This
fixture is the pair's remaining hand-synced copy.

## Change

1. `test/helpers/observed-session.ts` gains an exported `fakeObserved(seed?)`
   — same body as the two local copies, same return shape
   `{ map, storage, stored }`. The helper imports `OBSERVED_KEY`,
   `emptyObserved`, `Observed` and `ObservedStorage` from
   `../../src/studio/observed`.
2. Both test files drop their local copy and import `fakeObserved` next to
   the existing `session` import from the same helper.
3. Imports that the removal leaves unused are dropped:
   - `studio.survival-retry.test.ts`: `emptyObserved`
   - `studio.survival-input.test.ts`: `type Observed`, `type ObservedStorage`
   Everything else each file imports from `src/studio/observed` is still
   used by other call sites and stays.

No production code changes. Net ~9 lines removed.

## Verify

- `bun x vitest run test/studio.survival-retry.test.ts test/studio.survival-input.test.ts` green before and after.
- `bun run check` (tsc across all five projects) clean — this is what proves the unused-import drops are exactly right.
- `bun run english-check`, `bun run test-lies-check` clean.

Heavy gates (`bun run check`, vitest) run ONE AT A TIME, never in parallel.
