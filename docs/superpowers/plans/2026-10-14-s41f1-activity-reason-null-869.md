# S41-F1 activity reason-null — loop every non-unknown state (refs #869, refs #845)

Sweep 41 finding F1 (docs/maintainability/2026-10-14-overclaiming-titles-sweep-41.md
— that sweep doc lives on the sweep's own branch, not in this repo; this plan is
self-contained). Sibling precedent: sweep-22 weak-test batch (commit 2f4a77e6).

## Problem

`apps/fleet/test/studio.activity.test.ts:553` —

    it("reason is null whenever state is not unknown", () => {
      const result = nextActivity(null, { kind: "working" }, null, null, T0);
      expect(result.reason).toBeNull();
    });

Title says "whenever" — the whole non-unknown set (waiting-question,
waiting-members, working, idle, limit). Body drives ONE kind (working).
`apps/fleet/src/studio/activity.ts:616` does null it for all:

    const reason = state === "unknown" && verdict.kind === "unknown" ? verdict.reason : null;

but a regression leaking reason onto any other state passes this test
untouched.

## Fix

Replace the single-kind body with a loop (the file's own for-of shape, e.g.
studio.activity.test.ts:461) generating one `it` per non-unknown case, asserting
`nextActivity(...).reason` is null for each. Stay inside the same describe
block. Cases:

1. Frame-verdict kinds — `nextActivity(null, <verdict>, null, null, T0)`:
   - working
   - idle
   - waiting-question
   - waiting-members via "subagents"
   - waiting-members via "background-shell" (distinct FrameVerdict value)
2. limit — reached NOT via `verdict.kind` but by a live limit observation
   outranking the frame (the "not via verdict.kind" non-unknown path). Own
   `it`: assert state "limit" AND reason null, reusing the sibling limit
   fixture shape (until: "2026-09-25T13:30:00.000Z", seenAt: T0).

No unknown case in the loop: the sibling test "an unknown verdict never
inherits the previous state's word" already asserts reason PRESENT on unknown.

Verdict table typed `as const` so each literal stays assignable to
`FrameVerdict` without widening — no import change.

## Mutation check (RED/GREEN)

After GREEN: temporarily mutate activity.ts:616 to

    const reason = verdict.kind === "idle" ? "leak" : null;

RED expected: the idle `it` fails (the old single-kind working test would NOT
have caught this leak — that is the point). The unknown sibling tests also
fail (they expect their reason preserved) — expected RED breadth. Restore,
GREEN again. Runs `vitest run test/studio.activity.test.ts` twice — one
file, cheap, but serial (one gate at a time, never alongside another gate).

## Verification (serial, one gate at a time)

1. `cd apps/fleet && bun x vitest run test/studio.activity.test.ts` — all
   pass; old 1 `it` replaced by 6.
2. Mutation RED/GREEN as above, restored.
3. `bun x tsc --noEmit -p test` under `flock /tmp/fleet-gate.lock` (heavy,
   alone).
4. `bun run scripts/english-check.ts` — clean.
5. `bun run scripts/test-lies-check.ts` — clean.
6. Never run the full vitest suite; only this one file.

## Scope guard

Test-only change to apps/fleet/test/studio.activity.test.ts. No src change
survives the branch (mutation is temporary). If the surrounding code shows a
real bug, stop and report instead. Rest of sweep 41 out of scope.

Provenance note: plan written by the lead directly under the overnight
auto-nudge override (member dispatch denied twice, no member running) —
disclosed on the board issue, not hidden.
