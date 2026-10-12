# Plan — S24-F12: task-state.ts TaskStateResult orphaned by its own consumers (refs #609, parent #588)

Sweep-24 finding F12 (docs/maintainability/2026-10-12-unused-exports-sweep-24.md, GLM-OK lane).
src/studio/task-state.ts:38 exports type TaskStateResult. Zero importers: grep across
apps/fleet finds the name only in-file — line 38's declaration and line 69,
runTaskStateTransition's return type. The module's two importers (cli/fleet.ts:37,
test/studio.task-state.test.ts:2) pull runTaskStateTransition + TaskStateFetchResult
(+ TaskStateDeps in the test) and let the return type flow from the function signature.

## Change

One file, apps/fleet/src/studio/task-state.ts: drop the `export` keyword from the
`TaskStateResult` declaration at line 38 (`export type TaskStateResult` →
`type TaskStateResult`). Symbol stays — still the return type at :69. Its doc comment
stays. Nothing else moves.

## Verification (one heavy gate at a time, flock /tmp/fleet-gate.lock)

1. Baseline before edit: `./node_modules/.bin/vitest run test/studio.task-state.test.ts`
   from apps/fleet — green; `grep -rn "TaskStateResult" apps/fleet` → only
   task-state.ts:38 and :69.
2. Apply the one-keyword edit.
3. GREEN: same vitest command — green, test file unchanged.
4. `flock /tmp/fleet-gate.lock bash -c 'cd apps/fleet && bun run check'` — exit 0.
   tsc over all five projects is the real zero-importer proof: a missed importer
   would fail to compile.
5. `flock /tmp/fleet-gate.lock bash -c 'cd apps/fleet && bun run english-check'` — exit 0.
6. `cd apps/fleet && bun run test-lies-check` — exit 0.

## Bounds

- One source file + this plan doc. Two-way door (re-add `export` trivially). Type-only,
  no runtime change.
- Heavy gates (`bun run check`, `english-check`) run alone under the gate lock, never
  parallel with anything else. Never run the full `bun run test` suite — targeted
  files only; CI owns the rest.
