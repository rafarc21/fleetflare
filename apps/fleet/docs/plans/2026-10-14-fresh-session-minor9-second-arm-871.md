# Plan — #871: MINOR 9 fresh-session test must exercise BOTH gate arms (S41-F3)

Task: https://github.com/rafarc21/fleetflare/issues/871

## Problem

apps/fleet/test/studio.fresh-session.test.ts:417 pins "a MISSING SessionMark is
always allowed, regardless of replacedAt/replacementDetected", but its body arms
only ONE of the two shapes that arm the refusal gate
(apps/fleet/src/studio/provision.ts:3743):
`obs.replacedAt !== null || obs.session?.replacementDetected === true`.
A missing-mark allowance that special-cased the replacedAt arm would still pass.

## Fix (test-only, no source change)

The MINOR 9 test loops BOTH arming shapes, each with NO SessionMark seeded:
1. replacedAt set, no mark (the existing arm, shape unchanged)
2. replacedAt null, frozen session.replacementDetected true, no mark (the
   MAJOR 2 / seedHealed shape already used later in the same file)

## TDD

- RED (mutation): make the gate's missing-mark fallback arm-dependent —
  `const lines = obs.replacedAt !== null ? (mark?.lines ?? 0) : 999999;` —
  variant 2 must fail the test. REVERT the mutation.
- GREEN: restore source unchanged; both variants pass.

## Verification (one heavy gate at a time, sequential)

- cd apps/fleet && bun x vitest run test/studio.fresh-session.test.ts (RED run, then GREEN run)
- bun run check (alone, nothing else running)
- bun run english-check
- bun run test-lies-check

