# Fix flaky test: batch the 1005-row setup in pruneWorkerExceptions (#1123)

`test/exceptions.test.ts` › `pruneWorkerExceptions` › `caps the table at keep
rows` inserts 1005 rows via a per-row `await ...prepare(...).run()` loop.
1005 sequential D1 round-trips is what blows past vitest's 5 s default under
gate CPU contention — 2026-10-16 gate vitest-1 red 2/2 on an unrelated
CLI-only PR; locally the whole file runs <1 s.

## Fix
Replace the loop with ONE `WITH RECURSIVE` INSERT generating the identical
1005 rows (id `exc-{i}`, ts `i`, route `/x`, name `Error`, message `boom`,
stack_head NULL) for i in 0..1004. Assertions unchanged — they already pin
count=1000 and ts 5..1004, so a wrong batch fails the test.

## Why batch, not a 30 s timeout
Root cause is the 1005 round-trips, not the prune. One statement removes the
contention multiplier; a longer timeout would only hide it.

## Verification
- `cd apps/fleet && bun run test test/exceptions.test.ts` — the touched test
  only; full suite is CI's job.
No RED possible locally: the flake is contention-only, so the test already
passes before the change. GREEN = the unchanged assertions still pass against
the batched setup (proves identical rows).
