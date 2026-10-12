# S14-F9 90s staleness twins — mechanical sync (board issue #513)

Ref #513 (magic-numbers sweep 14, S14-F9, refs #485). Two twins hardcode the
same 90s budget: `ACTIVITY_DO_STALE_SECONDS = 90` (cli/readiness-format.ts:271)
and `HOOK_STALE_BUDGET_MS = 90_000` (src/studio/activity.ts:430), documented
mirrors of each other with nothing mechanical keeping them in sync. Both
derive from `SHIP_TRANSCRIPT_SECONDS = 30` (src/studio/do.ts:248): 3 ship
ticks. Bump the tick, the doc comment drifts silently.

## Design

Layering blocks activity.ts importing do.ts (do.ts imports activity.ts —
cycle). So the tick const moves to a new leaf src/studio/ship-cadence.ts
(pure module, zero imports — sweep doc's own prescription); do.ts re-exports
it so test/studio.observation-tick.test.ts's existing import path keeps
working, zero test churn. Then:

- ship-cadence.ts: `export const SHIP_TRANSCRIPT_SECONDS = 30` (doc comment
  moves with it, updated to name the new home + importers).
- do.ts: `export { SHIP_TRANSCRIPT_SECONDS } from "./ship-cadence"` + prune
  the moved declaration.
- activity.ts: `import { SHIP_TRANSCRIPT_SECONDS } from "./ship-cadence"`;
  `HOOK_STALE_BUDGET_MS = 3 * SHIP_TRANSCRIPT_SECONDS * 1000`; its 20-line
  mirror doc trims to name the shared derivation, drops the "plain number
  rather than an import" rationale (no longer true).
- cli/readiness-format.ts: `import { SHIP_TRANSCRIPT_SECONDS } from
  "../src/studio/ship-cadence"`; `ACTIVITY_DO_STALE_SECONDS = 3 *
  SHIP_TRANSCRIPT_SECONDS`; the "3 × the ship tick" bullet now names the
  derivation, not just the number.

## Test (RED first)

New test in test/cli.fleet.test.ts (already imports BOTH readiness-format
and activity.ts): import SHIP_TRANSCRIPT_SECONDS from ship-cadence, assert
`ACTIVITY_DO_STALE_SECONDS === 3 * SHIP_TRANSCRIPT_SECONDS` and
`hookWinsAxis`'s budget equals the same product — but hookWinsAxis is
unexported, so assert via behavior: nextActivity with a hook exactly
`3 * SHIP_TRANSCRIPT_SECONDS` old loses to the pane, and one 1s fresher
wins. That pins the pair mechanically — bump the tick and the test fails
until both derivations follow.

## Verification

- `cd apps/fleet && ./node_modules/.bin/vitest run test/studio.activity.test.ts test/cli.fleet.test.ts` — pass (serial).
- RED run before green (mutated 90 → 91 assertion) — serial, one gate at a time.
- `cd apps/fleet && bun run check` — 5 projects clean.
- `cd apps/fleet && bun run english-check` — clean.
- `git diff origin/main --stat` — 5 files: ship-cadence.ts (new), do.ts, activity.ts, readiness-format.ts, cli.fleet.test.ts + this plan.

## Boundaries

Values unchanged (90s) — pure refactor. No behavior change. One heavy gate
at a time; check runs full tsc across 5 projects, run it alone. do.ts is a
ONE_WAY_GLOB — PR door is one-way. Sweep doc
docs/maintainability/2026-10-12-magic-numbers-sweep-14.md absent from
origin/main — do not invent it; the task body carries the finding.
