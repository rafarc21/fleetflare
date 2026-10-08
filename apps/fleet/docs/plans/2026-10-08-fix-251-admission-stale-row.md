# Fix admission refusing on a stale `account-limit` row after a 5h reset (board issue #251)

## The bug (reported by another maestro, 2026-10-06)

After a 5-hour window reset, `fleet provision` / `fleet recycle` answered
`409 every account limited; earliest reset <date>` while `fleet accounts`
showed the mapped slot free (14% of 5h). Admission read a stale
`account-limit:<slot>` row written before the reset. Workaround: `fleet
accounts sync`, then `fleet recycle <id> --account mapped`.

## What research found already works (not re-litigated here)

The issue's first fix bullet — "a limit row whose `until` has passed is
free — re-check before refusing" — is already correct code, already tested.
`accounts.ts`'s `accountIsFree` treats a passed `until` as free:

```ts
if (until !== null) return Date.parse(until) <= now.getTime();
```

and every caller in the admission cascade (`launchAccountOrReroute`, via
`selectFreeAccount` -> `nextClaudeAccount`/`firstFreeAccount` ->
`accountIsFree`) is handed a LIVE `now = new Date()` from `do.ts`'s
`launchAccountOrRefuse`, which reads `readFleetAccountLimits`/
`readFleetAccountUsage` fresh from D1 on every single admission call — no
caching, no TTL. This is already covered at the lower-level cascade
functions (`test/studio.account-failover.test.ts`, "an account whose
recorded reset has already passed counts as free again"). This fix adds a
CONFIRMING regression test at the exact admission entry point
(`launchAccountOrReroute`, in `test/studio.account-by-repo.test.ts`, where
every other test of that function already lives — not
`studio.account-failover.test.ts`, which tests the lower-level/live-failover
functions instead) to prove the existing check holds there too. It does.

## The real gap

`account-usage:<slot>` D1 data (`AccountUsageMap`, read via
`readFleetAccountUsage` and threaded into `launchAccountOrReroute` as
`usage`) is consulted ONLY for ordering among candidates `accountIsFree`
already says are free (`selectByHeadroom`, from `nextClaudeAccount`/
`firstFreeAccount`/`selectFreeAccount`). It is never consulted once every
candidate reads D1-limited and the function is one step from returning
the "every account limited" refusal. A fresh (<10 min,
`USAGE_ORDERING_FRESHNESS_MS`), genuinely-under-threshold usage reading for
a D1-limited account is simply thrown away at the refusal point — this is
the stale-row shape the bug actually reports: the fleet-wide limit row has
not yet been corrected by a sync, but a sync's own usage reading already
knows better.

## The fix

New `accounts.ts` export, `freshUnderThresholdAccount(accounts, limits,
usage, now, reserved)`: scans `accounts` for one that

- `accountIsFree(a, limits, now)` is **false** (only matters for accounts
  D1 currently calls limited — an already-free account's path already
  works, untouched);
- is not in `reserved` (same exclusion every other selection function here
  already respects);
- has a fresh usage entry (`usage[a.name].seenAt` within
  `USAGE_ORDERING_FRESHNESS_MS` of `now` — the exact same NaN-safe staleness
  check `selectByHeadroom` already performs, factored into a shared
  `isFreshUsage` helper so there is exactly one copy of that logic, not two
  that could drift);
- whose `usageMaxPct(usage[a.name])` (claude-swap.ts) is strictly below
  `DEFAULT_LIMIT_THRESHOLD_PCT` (claude-swap.ts, 95 — the same number the
  sync decision itself uses to call an account limited vs clear, imported
  rather than re-hardcoded).

Among qualifying candidates, the lowest `usageMaxPct` wins (ties: first in
list order), same tie-breaking spirit as `selectByHeadroom`. No qualifying
candidate -> `null`.

`launchAccountOrReroute` calls this AFTER tier 1 (`selectFreeAccount`) and
tier 3 (`nextBorrowedAccount`) have both already missed — immediately
before it would build the "every account limited" refusal — against the
full `accounts` list and the same `reserved` set every other tier already
respects. A hit admits onto that account for THIS decision only: nothing is
written back to D1. `fleet accounts sync` remains the thing that corrects
the stale row itself — this fix only makes admission stop trusting a row
sync's own last reading already disagrees with, automating the issue's own
documented workaround rather than replacing it.

The refusal message (unchanged shape otherwise) gains the limited
account's own name next to its `until`, and a suggestion to run `fleet
accounts sync` first — the two pieces an operator hitting this needs that
today's plain "earliest reset <date>" leaves out.

## Scope note: issue #253

#253 (reset-time display bugs reported against the same incident) is
**not** the same code path: it lives entirely in
`cli/accounts-format.ts` (CLI display formatting, no D1, no admission).
Research traced it as a related-but-distinct design gap in how that file
formats `until`/reset times for display, sharing only the same underlying
incident, not any function or module this fix touches. Per the maestro's
own framing ("fix in this PR if same code path else note it"), #253 is
fixed in a SEPARATE commit/dispatch on this same branch rather than folded
into this one.

## Files touched

- `apps/fleet/src/studio/accounts.ts` — `freshUnderThresholdAccount` (new),
  `isFreshUsage` (factored out of `selectByHeadroom`), the
  `launchAccountOrReroute` wiring, the refusal message.
- `apps/fleet/test/studio.account-by-repo.test.ts` — new tests on
  `launchAccountOrReroute`.

## Review

Small, bounded, TDD — per house convention for a scoped bugfix of this
size (see #246's own plan doc), light review (maestro verifies directly),
no separate code-review/QA round.
