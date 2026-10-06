# Fix the `account-usage:<slot>` row race on overlapping sync batches (board issue #246)

## The bug

`routes.ts`'s `POST /studio/accounts/sync` handler writes the
`account-usage:<slot>` row (via `writeFleetAccountUsage`) unconditionally in
both the `"limit"` and `"clear"` branches — there is no freshness check on
the usage write itself. The `"clear"` branch's own "newer row exists" skip
(`current && Date.parse(current.seenAt) >= dataTimeMs`) only guards the
SEPARATE `account-limit:<slot>` row's own clear; it runs AFTER the usage
write already landed, so it does nothing to protect the usage store.

Two overlapping `fleet accounts sync` runs (e.g. a `--watch` loop racing a
manual run) can land out of order: a newer batch's usage reading gets
persisted, then an older, later-arriving batch's usage write unconditionally
overwrites it with stale data — even though that same older batch's
account-limit clear was correctly skipped as stale.

## The fix (both branches, not just "clear")

The issue names the `"clear"` branch, but the usage STORE's race is a
property of the store itself, independent of which decision produced the
write. The `"limit"` branch writes `account-usage:<slot>` unconditionally
too (it doesn't even have a limit-row skip concept, since a limit write is
never skipped) — an older `"limit"` batch landing late overwrites a newer
usage reading exactly the same way. Fixing only the named branch would just
relocate the same bug to the other one, so both are fixed in this pass.

- New `readOneAccountUsage(db, name)` in `account-usage-store.ts`, mirroring
  `account-limits-store.ts`'s own `readOneAccountLimit` (same per-account,
  single-row read shape).
- In both the `"limit"` and `"clear"` branches, immediately before each
  `writeFleetAccountUsage` call: read the account's current usage row and
  only write if there's no current row, or the current row's `seenAt` is
  strictly OLDER than this entry's own `dataTimeMs`/`usageDataTimeIso` (the
  same data-time value each branch already computes for its own
  account-limit freshness check — reused, not recomputed). If the current
  usage row is the same age or newer, the write is silently skipped — no new
  `skipped` entry, no response-shape change. The existing `skipped` array's
  semantics stay exactly what they were (the account-limit row's own clear
  being skipped); this is a pure D1-level guard on the separate usage store,
  and the account-limit row's own applied/rejected/skipped logic is
  completely unaffected either way.

## Review

Per the maestro's own dispatch on issue #246: small, bounded, TDD, one PR —
light review (maestro verifies directly), no separate code-review/QA round.
