# Plan — #610: un-export three wake.ts detector exports (S24-F13)

Refs https://github.com/rafarc21/fleetflare/issues/610, sweep doc
docs/maintainability/2026-10-12-unused-exports-sweep-24.md (S24-F13), refs #588.

## Finding

LOOSE_LIMIT_PATTERNS, SURVEY_HEADER_PATTERN and surveyOverlayOnScreen
(src/studio/wake.ts:135, :204, :224) have zero importers. Their only
mentions outside wake.ts are prose: test/fixtures/survey-panes.ts:22 and
test/bun/wake-guard.test.ts:351,355 cite them in comments. wake.ts's real
importers (webhook.ts, assign-wake.ts, wake-gate.ts, failover.ts,
survival-delivery.ts, sweep.ts, do.ts, routes.ts) import WakeOutcome,
WakeExec, logWakeOutcome, runGatedWake, singleFlightWake — none of the
three. All three stay used in-file: LOOSE_LIMIT_PATTERNS feeds LOOSE_JS
(:149), SURVEY_HEADER_PATTERN feeds SURVEY_HEADER_ROW and the
container-side grep scan, surveyOverlayOnScreen is the survey detector.

## Change

Drop the `export` keyword from all three; each becomes module-private.
Also rewrite the now-stale doc comment above SURVEY_HEADER_PATTERN
("exported so `wakeCmd` can fold it...") to say the same thing without
the word "exported" — e.g. "POSIX ERE, C-locale safe — the same source
`wakeCmd` folds into the container-side `grep -E` scan" — keep rest of
comment (defense-in-depth reasoning, LOOSE_LIMIT_PATTERNS contrast)
unchanged.

- src/studio/wake.ts:135 `export const LOOSE_LIMIT_PATTERNS` → `const LOOSE_LIMIT_PATTERNS`
- src/studio/wake.ts:204 `export const SURVEY_HEADER_PATTERN` → `const SURVEY_HEADER_PATTERN`
- src/studio/wake.ts:224 `export function surveyOverlayOnScreen` → `function surveyOverlayOnScreen`

Runtime behavior unchanged: nothing outside wake.ts references any of
the three, so visibility narrowing cannot alter behavior. The wake.ts ↔
failover.ts module-init cycle is untouched — no imports are added or
removed, only the export keyword drops.

## Verification (sequential, one heavy gate at a time)

1. `cd apps/fleet && npx vitest run test/studio.wake.test.ts`
2. `cd apps/fleet && npx vitest run test/studio.wake-gate.test.ts test/studio.wake-race.test.ts test/studio.routes.test.ts`
3. `cd apps/fleet && bun test test/bun/wake-guard.test.ts test/bun/wake-cmd.test.ts test/bun/wake-submit-check.test.ts test/studio.files.test.ts`
4. `cd apps/fleet && npx tsc --noEmit`
5. `cd apps/fleet && npx tsc --noEmit -p test`
6. `cd apps/fleet && bun run scripts/english-check.ts`
7. `cd apps/fleet && bun run scripts/test-lies-check.ts`

Grep gate: `grep -rn "export const LOOSE_LIMIT_PATTERNS\|export const SURVEY_HEADER_PATTERN\|export function surveyOverlayOnScreen" apps/fleet` returns zero matches after the change.
