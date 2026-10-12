# Plan — #605: inspect.ts loses seven unused export keywords

Ref #588 sweep 24, finding S24-F6 (doc: docs/maintainability/2026-10-12-unused-exports-sweep-24.md).
Refactor, no behavior change. One src file: apps/fleet/src/studio/inspect.ts.

## Finding

Seven exported names have zero importers anywhere in apps/fleet (grep-verified:
src, cli, test, test-integration, container — only internal uses inside
inspect.ts itself): INSPECT_TARGET (:72), INCARNATION_SECTION (:116),
BRINGUP_LOG_SECTION (:117), INSPECT_BRINGUP_LOG_LINES (:121), InspectSnapshot
(:182), InspectExec (:252), InspectDeps (:254). observed.ts's LEAD_PANE_TARGET
(:811) is a deliberate comment-synced private copy, NOT an import — inspect.ts
imports INCARNATION_PATH from observed.ts, so an import back would be circular.
The sync mechanism between the two marker strings is the comment at
observed.ts:811; dropping the export keyword changes nothing there.

## Fix (TDD)

1. RED: add a module-shape test (test/bun/inspect-exports.test.ts) asserting the
   import surface of ../src/studio/inspect exactly equals the kept set
   (CHECKOUT_PRESENT, CHECKOUT_MISSING, TAIL_BEGIN, INSPECT_DEFAULT_TAIL_LINES,
   INSPECT_EXEC_MS, inspectCmd, parseInspectOutput, runInspect, InspectOutcome)
   — assert each of the seven names is NOT exportable and NOT present on the
   module object. Use bun's import of the module object; for the four consts
   also assert their VALUES survive internally (inspectCmd output still embeds
   "studio:claude" and the three sentinel tokens) via existing inspectCmd tests
   (test/bun/inspect-cmd.test.ts) staying green.
2. GREEN: remove the `export` keyword from the seven declarations in
   src/studio/inspect.ts. No other edits. Doc comments unchanged.
3. observed.ts untouched.

## Verification

- `cd apps/fleet && bun test test/bun/inspect-exports.test.ts test/bun/inspect-cmd.test.ts test/bun/tmux-socket.test.ts` green.
- `cd apps/fleet && ./node_modules/.bin/vitest run test/studio.inspect.test.ts test/studio.wake-gate.test.ts test/studio.exec-deadlines.test.ts test/cli.inspect-request.test.ts` green.
- `cd apps/fleet && ./node_modules/.bin/tsc --noEmit -p .` exit 0 (one heavy gate).
- `cd apps/fleet && bun run scripts/english-check.ts` exit 0.
- `cd apps/fleet && bun run scripts/test-lies-check.ts` exit 0.

## Boundaries

- One src file (inspect.ts) + one new test file. observed.ts, do.ts, cli
  untouched. No new deps.
- Heavy gates sequential, never parallel: single vitest lanes, then one tsc.
  Full suite belongs to CI/merge gate.
