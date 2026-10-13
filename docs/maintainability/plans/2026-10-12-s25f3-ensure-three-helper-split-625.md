# S25-F3 plan — split `ensure` into three helpers in orca-workspace.ts

Task: https://github.com/rafrc21/fleetflare/issues/625 (parent sweep #589, finding S25-F3, GLM-OK tier).
Doc: `docs/maintainability/2026-10-12-oversized-functions-sweep-25.md` §S25-F3.

## Problem

`apps/fleet/cli/orca-workspace.ts:620` — module-private `ensure`, 155-line body
(620–774, 26 of those one comment block). Pure glue: lookup, worktree half,
title stamp, terminal list, duplicate reconcile, unhealthy-survivor close,
exists-shortcut, terminal create + rename. No >25-line code block inside —
purely a seam split. File already has the half-helpers separate; `ensure` is
the one function lacking decomposition.

## Change

Same module, three new module-private async helpers + shrunken `ensure`:

1. `ensureWorktreeHalf(id, deps)` → `{selector, created}` — board #39 lookup
   (`findStudioWorktree`, registry heal), existing-selector branch vs
   create branch (`parseStudioId`, `resolveRepoId`, `worktree create`,
   `registry.set`), plus the best-effort `--display-name` title stamp.
2. `reconcileAttachTerminals(id, selector, deps)` → `{kept, closedDuplicates}`
   — `terminal list` filtered by `isAttachTerminal`, board #42 duplicate
   reconcile (rank, close extras, collect handles), #124 M2 unhealthy-
   survivor close.
3. `createAttachTerminal(id, selector, deps)` — `terminal create --title id
   --command "fleet attach"`, `terminal rename` stamp, returns `{kind:
   "created"}` (caller merges `closedDuplicates`).
4. `ensure` shrinks to: worktree half → reconcile → exists-shortcut →
   create → return.

## Guardrails (from the task)

- Decision-record comment blocks (:675–693 terminal-half rationale, :732–757
  stray-terminal hypothesis) MOVE WITH their code — never delete. The 26-line
  :732–757 block documents the `created`-shortcut non-application, which
  stays in `ensure` (it guards the exists-shortcut vs create decision).
- Exists-shortcut needs `created` (half 1) AND `kept` (half 2) — thread both
  explicitly through the split; `ensure` owns that cross-half condition.
- `ensureStudioWorkspace` (:535) wrapper contract unchanged: `deps.lock` +
  throw → `{kind: "failed"}`.
- No behavior change, no signature change at exported surface.

## Net

- `test/bun/orca-workspace.test.ts` — 42 `ensureStudioWorkspace` + 3
  `openStudioRow` calls, all five file-header properties incl. concurrent-lock
  test (:448).
- `test/bun/orca-workspace.exit-code.ts`, `test/bun/orca-workspace.registry-writer.ts`.
- `test/cli.recycle-outcome.test.ts:431` — source-pin on `openStudioRow(`.
- GLM-OK lane.

## Steps

1. This plan doc (this commit).
2. Backend Developer: implement the split, one commit, push branch.
3. Verify: targeted orca-workspace bun tests exit 0; `bun run check` exit 0 —
   heavy gate, run ALONE, flock.
4. Fresh-context Code Reviewer, max 2 rounds.
5. QA + PR + envelope on issue.

## Verification

- Targeted bun tests above, exit 0, real tail.
- `cd apps/fleet && bun run check` (five tsc projects) exit 0 — heavy gate,
  one at a time, `flock /tmp/fleet-gate.lock`.
- No new exported symbols; diff is intra-file with comment blocks carried.
