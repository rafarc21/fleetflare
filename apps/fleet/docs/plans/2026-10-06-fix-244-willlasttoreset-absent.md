# Fix `willLastToReset` absent-key rejection + scoped `name` same bug class (board issue #244)

## The bug

Real `cswap list --json` output can OMIT `usage.sevenDay.willLastToReset`
entirely for some accounts (observed live, 2026-10-06, on a fresh account —
that account's `sevenDay` object had only `pct`/`resetsAt`/`countdown`/
`clock`, no `willLastToReset` key at all). `isValidUsage`
(`src/studio/claude-swap.ts`) required `willLastToReset` to be either a
`boolean` or an explicit `null` — an absent key reads as `undefined` off a
plain object, which is neither, so the validator rejected the account,
`decideAccountSync` returned `"no-data"` for it (dropped as malformed), and
upstream the slot shows `unmapped` and never syncs.

Nothing in this module ever reads `willLastToReset`'s VALUE for any
decision — confirmed by `CswapAccount`'s own doc comment ("nothing in this
module reads this field for any decision") and by grep: no reader anywhere
in `cli/accounts.ts` or `cli/accounts-format.ts` either.

## Second instance, same bug class

`isValidScopedWindow` required `name` to be a string on every scoped
window. `decideAccountSync`'s only read of `scoped[]`
(`scoped.find((w) => w.pct >= thresholdPct)` then `trippedScoped.resetsAt`)
never touches `.name` — confirmed by `CswapScopedWindow`'s own doc comment
("Nothing in this module reads `name` for any DECISION") and by grep: no
reader of `.scoped[].name` anywhere in `cli/accounts.ts` or
`cli/accounts-format.ts` either. Exactly as dead as `willLastToReset` was.

## Audit for a third instance

Cross-referenced every field each validator checks
(`isValidWindow`: `pct`, `resetsAt`; `isValidScopedWindow`: + `name`;
`isValidUsage`: `fiveHour`, `sevenDay`, `willLastToReset`, `scoped[]`;
`isValidCswapAccountForJoin`: `email`, `usage`) against every field actually
read by `decideAccountSync`, `resetsAtCandidates`, `withinResetWindow`, and
the `joinAccountsToCswap` loop (`pct`, `resetsAt`, `email`, `usage`,
`usageStatus`, `usageAgeSeconds`). Every remaining required field on the
task's own keep-list (`pct`, `resetsAt`, `email`, `usageStatus`,
`usageAgeSeconds`) IS read for a real decision. No third instance found —
only the two above.

`routes.ts`'s own `usageFetchedAt` request-body check is unrelated (lives in
a different file, already required because it IS read for the dataTime
computation) — confirmed out of scope, left untouched.

## The fix

1. `CswapAccount["usage"]["sevenDay"]`'s `willLastToReset` becomes
   `willLastToReset?: boolean | null` (optional) — doc comment reworded to
   say the KEY itself may be absent in real output, mirroring
   `CswapWindow.resetsAt`'s own doc-comment structure for the identical
   "key absent OR null, same valid shape" situation.
2. `isValidUsage` drops the `willLastToReset` check entirely — no key-exists
   check either, just shape-validates `fiveHour`/`sevenDay` (via
   `isValidWindow`) and `scoped` array shape.
3. `isValidScopedWindow` is deleted; every call site uses `isValidWindow`
   directly on scoped-window entries (nothing beyond `pct`/`resetsAt` is
   ever read off a scoped window, so a separate function added no value
   once `name` is no longer checked). `CswapScopedWindow.name` keeps its
   type (still useful for callers/display, not a decision concern) but is
   marked `name?: string` since the real shape doesn't guarantee it either
   and nothing requires it anymore.

## Tests (TDD)

`test/fixtures/cswap-list.ts` gains `ABSENT_WILL_LAST_TO_RESET` — a fixture
whose `sevenDay` object has only `pct`/`resetsAt`/`countdown`/`clock` (no
`willLastToReset` key at all), matching the live 2026-10-06 probe exactly,
documented in the fixture's own provenance header as issue #244's
correction round.

`test/claude-swap.test.ts`:
- `decideAccountSync` with `willLastToReset` entirely absent -> valid,
  correct action (not `"no-data"`).
- Same fixture through the full join path
  (`joinAccountsToCswap`/`isValidCswapAccountForJoin`) -> label match
  succeeds, account is not dropped as malformed.
- A scoped window missing `name` entirely -> still valid (second fix).
- Regression: a window with `pct` missing/non-numeric still fails; `email`
  empty/missing still fails; malformed `usageStatus`/`usageAgeSeconds`
  still degrade to `"no-data"` -- confirms the fix is surgical.

## Review

Board issue #244, same pattern as #240's real-probe correction rounds —
small, bounded, TDD, one PR.
