# S48-F15 — orca-registry-rows fileLock contention yields: no action (recorded)

Issue: https://github.com/rafarc21/fleetflare/issues/984
Sweep: docs/maintainability/2026-10-15-slow-tests-sweep-48.md

## Problem
`apps/fleet/test/bun/orca-registry-rows.test.ts:390,394` yield 10ms and 50ms
around fileLock contention assertions — give the first fileLockAt call a
tick to win the exclusive-create race before the second starts, then let
the second sit waiting before the order assertion. Measured 3.4s per run,
sweep estimated ~60ms of that is these two yields. Negligible against the
real-fs file lock cost.

## Decision
No change. The 10ms is the smallest wait that lets the first call win the
exclusive-create race, and the 50ms is the window proving the second call
is still waiting. Sub-100ms combined, not on the gate's slowest-shard
path. Poll intervals in the same file (100ms) are already fine. Recorded
to close the lens.

## Verification
- `cd apps/fleet && bun test test/bun/orca-registry-rows.test.ts` — 87 passed, 0 fail.
- `cd apps/fleet && npx tsc --noEmit -p test` — exit 0.
- `cd apps/fleet && bun run english-check` — clean.