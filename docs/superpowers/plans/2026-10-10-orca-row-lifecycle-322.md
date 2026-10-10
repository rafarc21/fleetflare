# Orca row lifecycle: `openStudioRow` / `closeStudioRow` (#322)

Source: sweep-2 F7; refs #259, never closes. GLM-OK: behavior-preserving,
characterization tests at the interface first.

## Problem
Callers sequence sibling pairs that only ever appear together: title+ensure
(4 sites), remove+describe (2 sites).

## Solution
Two one-liners in `cli/orca-workspace.ts`. `openStudioRow(id, tasks, deps)` =
ensure with the derived title → `WorkspaceOutcome`; `closeStudioRow(id, deps)`
= remove+describe → the lines to print; salvageDest default flows through.

Six sites become one line each — fleet.ts :1089 (spawn), :1149 (provision),
:1201 (recycle), ff.ts :394, :1251-1252 (destroy), :2136-2137 (reap).
Batch (fleet.ts :850-853) stays byte-identical: reconcile takes a titleFor
resolver, not tasks — sweep's "7 sites" = 6 rewire + 1 batch left as-is.
Siblings stay exported. Inside the four protected verbs ONLY the listed
lines change; same Orca calls, same printed lines. Pins rename, never delete:
recycle pin (cli.recycle-outcome.test.ts :431-433) → `openStudioRow(`, count
1; destroy pin (cli.destroy-outcome.test.ts :192-194) needs the same rename —
a deviation: the brief named only the recycle pin.

## Tests first
Bun lane, existing fake()/boardTask(): openStudioRow working-task → exact
`repo · #N <title>` on `worktree set`, outcome created; idle → `(idle)` title;
hasBinary null → skipped, zero calls. closeStudioRow removed/absent/skipped/
unverified → the exact describeWorkspaceRemoval lines. Existing tests keep
passing unmodified.

## Verification
`bun test test/bun/orca-workspace.test.ts` RED then GREEN; `bun run vitest
run test/cli.recycle-outcome.test.ts test/cli.destroy-outcome.test.ts` after
the rewire; flock /tmp/fleet-gate.lock bun run check ONCE; bun run
english-check. Full suite → CI.

## Files touched — orca-workspace.ts, cli/fleet.ts (6 lines), cli/ff.ts (1
line), bun test file, both vitest pin files, this doc.
Out of scope: reconcile + batch site, salvageDest, signature/behavior changes.
