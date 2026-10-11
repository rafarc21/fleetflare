# formatColumns — one column-table builder behind 4 CLI tables (refs #399)

Sweep-5 F1 (parent sweep #394). Tier GLM-OK. Behavior-preserving fold, two-way door.

## Problem
The same column-table dance is hand-rolled 4x and has already drifted:
- cli/fleet.ts formatTable — widths from longest cell, padEnd, join("  "), last column never padded (#205: trailing blanks turned one long ERROR into 87 KB of output)
- cli/accounts-format.ts formatAccountsTable — same, `last = headers.length - 1` guard
- cli/task-format.ts formatTaskTable — same, `i === cols.length - 1` variant
- cli/junior.ts formatJuniorStats — same width computation but pads EVERY column then `.trimEnd()` on the joined line: the #205 rule lives in trimEnd, not in the table

A width/spacing bug must be fixed four times; junior's copy already drifted.

## Change
1. RED first — characterization tests that pin the exact bytes of all four tables for a fixed input BEFORE the fold:
   - apps/fleet/test/cli.columns.test.ts (new, vitest lane): imports formatColumns and byte-pins formatTaskTable + formatAccountsTable outputs
   - apps/fleet/test/bun/junior-stats-unit.test.ts (append): byte-pin formatJuniorStats output, including the proof that no line ends in whitespace (trimEnd on an already-unpadded last column is a no-op)
   - formatTable byte-pin: test/bun/fleet-ls-denominator.test.ts already pins no-trailing-pad + capped ERROR (#205); add one exact-bytes pin of a full formatTable row there
   Run the new tests, watch formatColumns's own tests fail on the missing module, commit + push.
2. GREEN — new module apps/fleet/cli/columns.ts: `formatColumns(headers: string[], rows: string[][], opts?: { padLast?: boolean }): string`, pure, imports NOTHING (root-pool importable, same discipline cli/readiness-format.ts's header documents). Last column NEVER padded by default (#205 contract); padLast: true opts in for a caller wanting the old shape. All four call sites become 2-liners; each caller keeps its exact empty-table string and legend lines. junior's formatJuniorStats drops the per-line trimEnd. All characterization tests green, byte-identical. Commit + push.
3. Gates, sequential, one at a time: cd apps/fleet && bun run check; bun run english-check; bun run test-lies-check; then targeted suites (vitest: cli.columns.test.ts cli.task-format.test.ts cli.accounts-format.test.ts; bun lane: test/bun/fleet-ls-*.test.ts test/bun/junior-stats-unit.test.ts test/bun/junior-stats-cli.test.ts). Full suite belongs to CI.

## Files
- New: apps/fleet/cli/columns.ts, apps/fleet/test/cli.columns.test.ts
- Modify: apps/fleet/cli/fleet.ts, apps/fleet/cli/accounts-format.ts, apps/fleet/cli/task-format.ts, apps/fleet/cli/junior.ts
- Test: apps/fleet/test/bun/junior-stats-unit.test.ts, apps/fleet/test/bun/fleet-ls-denominator.test.ts

## Boundaries
- ~60 changed lines. No behavior change: all four tables' bytes identical before/after.
- Heavy gates: `bun run check` once, at the end, under flock /tmp/fleet-gate.lock. Targeted test runs only during the loop.
- No UI, no browser lane: QA is suites + tsc.

## Check
`bun run check`, `bun run english-check`, `bun run test-lies-check` exit 0; targeted vitest + bun lanes green; `git diff origin/main...HEAD` shows the four call sites folded to 2-liners.
