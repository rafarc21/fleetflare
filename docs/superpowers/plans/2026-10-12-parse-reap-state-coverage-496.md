# Plan — S11-F8 parseReapState direct branch coverage (task #496)

Parent: https://github.com/rafarc21/fleetflare/issues/496. Sweep: apps/fleet/docs/maintainability/2026-10-12-cli-coverage-sweep-11.md (S11-F8).
Branch `test-496-parse-reap-state` off origin/main 24282c2. Tests only — no src change lands.

## What changed since the sweep

The sweep proposed importing `parseReapState` directly — it was exported when
the sweep was written. d41495f (refs #470, PR #503) dropped the export, and
task #496 forbids src changes, so the export stays off. Harness instead:
`reapDeps(...).loadState()` (apps/fleet/cli/fleet.ts:2475-2488), the exported
seam that calls `parseReapState` (:2385) and turns a null into the kept-aside
rename + throw. The kept-aside integration half
(test/bun/fleet-reap-wiring.test.ts:146-158) stays untouched — this file adds
the direct per-branch half the sweep asked for.

## Test design — new apps/fleet/test/bun/fleet-reap-state.test.ts

bun:test (vitest cannot import cli/fleet). No Bun.serve needed: loadState only
reads the state file. Imports `reapDeps` + `emptyReapState` from ../../cli/fleet;
hermetic OrcaDeps stub (same shape as fleet-reap-wiring.test.ts's
NOT_UNDER_ORCA, defined locally — not exported); dummy creds pointing at an
unroutable port — loadState never fetches.

Table-driven, fresh temp dir + state file per case.

Kept-aside cases (parseReapState → null → loadState throws):
- scalars `42`, `"str"`, `true`, `null` (:2392 non-object)
- array `[1,2]` (:2392 Array.isArray)
- one bad field each: `{"backoffUntil":5}` (:2395), `{"stallAlarmAt":{"a":1}}`
  (:2396), `{"boardRows":{"x":"y"}}` (:2397), `{"refusals":{"x":-1}}` and
  `{"refusals":{"x":1.5}}` (:2398 isCountMap integer >= 0)
Assert: rejects /corrupt or wrong shape/, exactly one `reap-state.json.corrupt-*`
aside file in the dir holding the exact original bytes, statePath itself gone.

Parsed cases (state returned, nothing renamed):
- `{}` → emptyReapState()
- `{"backoffUntil":{"acmeclient--pilot":"2026-10-13T00:00:00.000Z"}}` → that
  map + the other three empty (the sweep's valid-partial case)
- `{"boardRows":{"example-org/acmeclient":3},"refusals":{"acmeclient--pilot":2}}`
  → both kept + two empty
- `{"unknown":1}` → emptyReapState() (unknown keys silently dropped)
Assert: resolves, no `reap-state.json.corrupt-*` file created, state file bytes
unchanged.

## TDD — coverage of existing behavior, so RED is a mutation proof

The behavior under test is already correct (the kept-aside wiring tests prove
the shared path), so the honest RED is mutation testing, not a first-green:

1. Commit: plan doc + test file; run `bun test test/bun/fleet-reap-state.test.ts`
   — expected GREEN against current code.
2. Mutation RED proof (reverted immediately, NEVER committed or pushed):
   a. cli/fleet.ts :2392 — drop `|| Array.isArray(parsed)` → the `[1,2]` case
      must FAIL.
   b. cli/fleet.ts :2398 — remove the refusals `isCountMap` guard → the
      `{"x":-1}` case must FAIL.
   Each: run the new test file, capture the failing case name, revert. After
   both: `git diff --stat apps/fleet/cli/` must be EMPTY.
3. Push discipline: `LEFTHOOK=0 git push -u origin test-496-parse-reap-state`
   right after the first commit, after every commit after.

## Verify (one heavy gate at a time)

- `bun test test/bun/fleet-reap-state.test.ts test/bun/fleet-reap-wiring.test.ts`
  (new + neighbor; mutation runs are the same single file, light)
- `flock /tmp/fleet-gate.lock bun run check` — heavy, alone, nothing parallel
- `bun run scripts/english-check.ts` and `bun run scripts/test-lies-check.ts`

## Boundaries

- NO src/cli change in the final diff — mutation edits reverted, never committed.
- New file only: apps/fleet/test/bun/fleet-reap-state.test.ts. No edit to any
  existing test.
- No Bun.serve, no network, no new dependency. Comments 1-2 lines WHY, English.
