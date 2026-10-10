# Orca row lifecycle: `openStudioRow` / `closeStudioRow` (board issue #322)

Source: sweep-2 F7 (docs/maintainability/2026-10-10-deep-modules-sweep-2.md).
Refs #259, never closes. GLM-OK: behavior-preserving; characterization tests
at the interface first.

## Problem

Callers sequence shallow siblings that only ever appear in pairs:
`studioWorkspaceTitle`+`ensureStudioWorkspace` (4 sites),
`removeStudioWorkspace`+`describeWorkspaceRemoval` (2 sites).

## Solution

Two one-liners in `cli/orca-workspace.ts`: `openStudioRow(id, tasks, deps)` =
ensure with the derived title → `WorkspaceOutcome`; `closeStudioRow(id, deps)`
= remove+describe → the lines, so callers just print them.
`removeStudioWorkspace`'s optional `salvageDest` default flows through (no
caller passes one).

Six sites become one line each — fleet.ts :1089 (cmdSpawn), :1149
(cmdProvision), :1201 (cmdRecycle), ff.ts :394 (attachOrHandOff), :1251-1252
(cmdDestroy), :2136-2137 (reap destroy). Batch form (fleet.ts :850-853,
runTabs → reconcileStudioWorkspaces) stays byte-identical: reconcile takes a
`titleFor` resolver, not tasks, so the pair cannot thread through it. The
sweep's "7 call sites" = 6 rewire + 1 batch left as-is. Siblings stay exported
(reconcile + bun tests use them). Inside cmdProvision/cmdRecycle/cmdDestroy/
reapDeps ONLY the listed lines change; same Orca calls, same printed lines.

Pins counting old names update, never delete: recycle pin
(test/cli.recycle-outcome.test.ts :431-433) → `openStudioRow(`, count 1; destroy
pin (test/cli.destroy-outcome.test.ts :192-194) is the same class and needs the
same rename to `closeStudioRow(` — a forced deviation: this brief named only
the recycle pin.

## Tests-first order

RED: new describe blocks in test/bun/orca-workspace.test.ts via the existing
fake()/boardTask() harness — openStudioRow: working task → exact
`repo · #N <title>` stamped on `worktree set --display-name`, outcome created;
idle → `(idle)` title; `hasBinary: () => null` → skipped, zero calls.
closeStudioRow: removed → describeWorkspaceRemoval's lines; absent → the single
"no Orca worktree or attach terminal found — teardown complete" line; skipped
→ []; unverified → could-not-verify line. GREEN: implement, rewire, update the
two pins. Existing tests keep passing unmodified.

## Verification

`bun test test/bun/orca-workspace.test.ts` RED then GREEN; `bun run vitest run
test/cli.recycle-outcome.test.ts test/cli.destroy-outcome.test.ts` after the
rewire (destroy pin breaks with it); `flock /tmp/fleet-gate.lock bun run check`
ONCE, alone, at the end; `bun run english-check` (this doc is prose). Full
suite → CI, never run here.

## Files touched

- `docs/superpowers/plans/2026-10-10-orca-row-lifecycle-322.md` (this file)
- `apps/fleet/cli/orca-workspace.ts`, `cli/fleet.ts` (6 listed lines),
  `cli/ff.ts` (1 listed line)
- `apps/fleet/test/bun/orca-workspace.test.ts`
- `apps/fleet/test/cli.recycle-outcome.test.ts`, `cli.destroy-outcome.test.ts`
  (pin renames; the latter is the stated deviation)

## Out of scope

reconcileStudioWorkspaces + batch site, salvageDest param, any signature or
behavior change, full-suite runs.
