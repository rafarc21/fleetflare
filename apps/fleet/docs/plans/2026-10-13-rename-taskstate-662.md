# 662 — S29-F2 rename TaskState ×2 (refs #647)

Sweep 29 (apps/fleet/docs/maintainability/2026-10-13-duplicate-types-sweep-29.md,
F2): same exported name for two disjoint closed unions — board/types.ts:37
(7 A2A board states, exported) and tasks/types.ts:11 ("idle"|"running"|"done"|
"failed", file-local since #602). Pure renames, no shape change:
`TaskState` -> `BoardTaskState` (board) and -> `WorkerTaskState` (tasks).
Both names collide with nothing (verified by grep). Out of scope:
container/server.ts's local mirror, TaskStateDeps/TaskStateFetchResult/
TaskStateResult, doc comments.

## Plan

1. RED pin: test/bun/fleet-reap.test.ts imports `BoardTaskState` (renamed
   board type) -> `tsc --noEmit -p test` fails while board/types.ts still
   exports `TaskState`. Commit 1 carries the pin.
2. GREEN: rename in all sites — src/board/types.ts (decl :37 + in-file uses
   :40,:46,:48,:77,:164,:201 + :74 comment mention), src/board/board.ts
   (import :27 + 10 use sites), src/board/comment-wake.ts (:30 import, :137
   param), src/github/webhook.ts (:28 import, :267 annot), src/studio/
   task-reap.ts (:25 import, :41 field), src/studio/cli-args.ts (:21 import,
   :193 member), cli/fleet.ts (:77 import, :1876 param), test/bun/
   fleet-reap.test.ts (:18 import, :70 param). tasks/types.ts `TaskState` ->
   `WorkerTaskState` (:11 decl, :25 field). Commit 2.
3. Verify: `bun run check` (5 tsc projects), targeted vitest, test-lies-check,
   english-check. Update sweep doc F2 row -> `(fixed by #662)` marker.
   Commit 3 + done record + PR.

## Verification

- tsc x5 clean; RED pin flipped back green.
- Targeted tests only — full suite is CI/merge-gate territory (memory ceiling).
