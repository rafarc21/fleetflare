# S38-F4 plan — assign reassignment test pins BoardApi's missing delete verb, issue #778

Sweep: 38 (test names vs assertions, issue #741), finding S38-F4. Spec: issue #778.
Baseline measured 2026-10-13: board.assign.test.ts green on origin/main (380e97df).

## Problem

board.assign.test.ts:541 "never deletes a comment — the dead studio's
envelopes are the history" asserts `Object.keys(api)` lacks a
deleteComment key — a statement about the FAKE's shape (helpers/board-api.ts),
not about the port. The title promises the code under test refuses a
deletion; nothing in the body proves that.

## Steps

1. Retitle to "the BoardApi port has no delete verb — history cannot be
   removed by this path" — the type-level fact actually proven.
2. Replace the Object.keys assertion with the house type-pin pattern
   (studio.exports-pin-608.test.ts): a `@ts-expect-error TS2339` directive
   on `api.deleteComment`. TS2339 fires today because the port has no such
   verb; add one and the directive goes unused (TS2578), failing
   `bun run check`'s `tsc --noEmit -p test` pass. vitest keeps the runtime
   half: createComment called exactly once on reassignment.
3. Verify sequentially, one gate at a time (heavy-gate rule): vitest on
   the one file; mutation RED/GREEN — add a deleteComment verb to BoardApi,
   expect `tsc --noEmit -p test` to fail TS2578, revert, expect green
   (this runs the tsc gate TWICE, never alongside another gate);
   english-check; test-lies-check.
4. Push branch, completion record.

## Risk

Test-only, no src/ change. The pin is compile-time: invisible to vitest,
fires only under `tsc -p test` / `bun run check` — the test comment says
so. Door: two-way.
