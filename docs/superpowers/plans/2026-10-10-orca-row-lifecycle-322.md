# Orca row lifecycle: `openStudioRow` / `closeStudioRow` (board issue #322)

Source: deep-modules sweep 2 F7 (docs/maintainability/2026-10-10-deep-modules-sweep-2.md). Refs
#259, never closes. Tier GLM-OK: behavior-preserving, characterization tests at
the interface first, one module per PR.

## Problem

Callers must sequence shallow siblings that only ever appear in pairs:
`studioWorkspaceTitle` + `ensureStudioWorkspace` (4 single-studio sites), and
`removeStudioWorkspace` + `describeWorkspaceRemoval` (2 sites). The outcome
value each pair shares is invisible at the call site.

## Solution

Two functions in `cli/orca-workspace.ts`, one line each:
`openStudioRow(id, tasks, deps)` = ensure with the derived title; returns the
`WorkspaceOutcome`. `closeStudioRow(id, deps)` = remove + describe; returns the
lines so the caller just prints them. `removeStudioWorkspace`'s optional
`salvageDest` default flows through unchanged (no caller passes one).

Six call sites become one line each — fleet.ts :1089 (cmdSpawn), :1149
(cmdProvision), :1201 (cmdRecycle), ff.ts :394 (attachOrHandOff), :1251-1252
(cmdDestroy, one line), :2136-2137 (reap destroy, one line). The batch form
(fleet.ts :850-853, runTabs → `reconcileStudioWorkspaces`) stays byte-identical:
reconcile takes a `titleFor` resolver, not tasks, so the pair cannot be threaded
through it. The sweep's "7 call sites" is 6 rewire + 1 batch left as-is.

Keep `studioWorkspaceTitle` / `ensureStudioWorkspace` / `removeStudioWorkspace`
/ `describeWorkspaceRemoval` exported (reconcile + the bun tests use them
directly). Same Orca calls, same printed lines, same exit codes; inside
cmdProvision / cmdRecycle / cmdDestroy / reapDeps ONLY the listed lines change.

Source-text pins counting the old names update, never delete: recycle pin
(test/cli.recycle-outcome.test.ts :431-433) — `openStudioRow(`, count 1; the
destroy pin (test/cli.destroy-outcome.test.ts :192-194) is the same class and
also needs the rename to `closeStudioRow(` (count 1) — a forced deviation from
this brief, which named only the recycle pin.

## Tests-first order

RED: new describe blocks in test/bun/orca-workspace.test.ts through the two new
functions, existing `fake()` / `boardTask()` harness — openStudioRow: working
task → exact title `repo · #N <title>` stamped (`worktree set --display-name`)
and outcome `created`; idle → `(idle)` title; not-under-Orca (`hasBinary: () =>
null`) → `skipped`, zero calls. closeStudioRow: removed → same lines as
describeWorkspaceRemoval; absent → the single "no Orca worktree or attach
terminal found — teardown complete" line; skipped → `[]`; unverified → the
could-not-verify line. GREEN: implement, rewire, update the two pins. Existing
tests keep passing unmodified (they drive the still-exported siblings).

## Verification

`bun test test/bun/orca-workspace.test.ts` (bun lane) RED then GREEN; `bun run
vitest run test/cli.recycle-outcome.test.ts` (and cli.destroy-outcome.test.ts —
its pin breaks with the rewire) after the rewire. `flock /tmp/fleet-gate.lock
bun run check` ONCE at the end, alone. `bun run english-check` (this doc is
prose). Full suite → CI, never run here.

## Files touched

- `docs/superpowers/plans/2026-10-10-orca-row-lifecycle-322.md` (this file)
- `apps/fleet/cli/orca-workspace.ts`
- `apps/fleet/cli/fleet.ts` (6 listed lines only)
- `apps/fleet/cli/ff.ts` (1 listed line)
- `apps/fleet/test/bun/orca-workspace.test.ts`
- `apps/fleet/test/cli.recycle-outcome.test.ts` (pin rename)
- `apps/fleet/test/cli.destroy-outcome.test.ts` (pin rename — deviation above)

## Out of scope

reconcileStudioWorkspaces / batch call site, the salvageDest param, any
signature change, any behavior change, full-suite runs.
