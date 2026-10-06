# Wire `pickHeadroomAccount` into failover ordering (board issue #238)

## Goal

#232/#237 built `pickHeadroomAccount` (claude-swap.ts) + usage rows, never
wired. Issue: wire failover choice to prefer slot w/ most headroom when
usage data fresh (<10 min, `usageStatus === "ok"`) -- lowest max(5h, 7d,
scoped-model) pct. Stale/missing data -> current order unchanged. Never
chooses a slot carrying a live limit row. Existing failover mechanism
(operator decision #232: cswap is a read-only usage SOURCE, fleet never
calls `cswap switch`/`auto`) stays untouched -- this only reorders
candidates fleet already considers.

## Critical design finding: no persisted pct anywhere today

`account-limit:<slot>` D1 row (written by `POST /studio/accounts/sync`,
read by `account-limits-store.ts`) carries ONLY `{until, seenAt, dead?,
source?}` -- NO pct. Written only on sync decision "limit" (threshold
crossed), DELETED on "clear" (under threshold). So: no record anywhere the
Worker can read of an account's ACTUAL usage pct, only a binary
currently-limited-or-not.

Headroom ordering needs the pct, not the binary. Fix: NEW, separate
`account-usage:<slot>` D1 row, mirroring `account-burn:<slot>` exactly (same
`fleet_state` generic KV table, `src/state.ts` getFlag/setFlag, no
migration). Written by the sync route on BOTH "limit" AND "clear" decisions
-- a cleared/under-threshold account still has a real pct worth recording
for ordering; only "unmanaged"/"no-data" decisions carry no trustworthy pct,
write nothing here.

Do NOT widen `AccountLimitState` (rate-limit.ts) to also carry pct. Its own
doc comment states this codebase's convention: one type per concern.
`AccountLimitState` answers "is this account currently limited" (consumed by
`accountIsFree`) -- a different question from "how much headroom", with a
different staleness rule (limit rows have no hard ceiling except the
null-until 24h grace; headroom needs a hard 10-min freshness cutoff, same
number item 5 always specified). Two separate types/stores, never merged,
same "must never be read as interchangeable" reasoning `AccountLimitState`'s
own doc comment already gives for itself vs `AccountBurnState`.

## The scoped-pct gap in `pickHeadroomAccount` (not just a wiring task)

`pickHeadroomAccount`'s own internal `maxPct` (claude-swap.ts) currently
computes `Math.max(fiveHour.pct, sevenDay.pct)` ONLY -- never folds in
`scoped[].pct`. The issue's own acceptance criteria names "scoped window
dominating" as a required test case; today's code cannot pass it (a scoped
window at 99% with fiveHour/sevenDay both low would be invisible to the
comparator). Real bug, fixed in step 1, not deferred.

Fix: new pure helpers, `usageMaxPct(u: UsageHeadroom): number` =
`Math.max(fiveHourPct, sevenDayPct, scopedMaxPct ?? -Infinity)`, and
`toUsageHeadroom(cswap: CswapAccount): UsageHeadroom` extracting the three
numbers from an already-validated `CswapAccount` (scopedMaxPct = null when
`usage.scoped` is empty, else max of its pcts). `pickHeadroomAccount`'s
internal maxPct now calls these -- public signature (`HeadroomCandidate`,
`freshnessMs`) unchanged, this is an internal correctness fix.

## Scoping decision: tier-1/tier-2 only, tier-3 (borrow) explicitly OUT

`accounts.ts`'s failover cascade has 3 tiers: `nextClaudeAccount` (reactive,
pane-capture limit rows), `firstFreeAccount`/`selectFreeAccount` (plain free-
account scan, the normal launch/recycle path) -- these are tier-1/tier-2,
the plain cascade, and are the ONLY targets for headroom ordering here.
`nextBorrowedAccount` (tier-3, burn-based borrow, `account-burn:<slot>`) is
explicitly OUT OF SCOPE: its metric is API token OUTPUT BURN (how much this
studio has generated against a 5h window), not claude.ai usage-limit pct --
a different number for a different concern (how much HEADROOM a borrow
target has left before it burns out under active use, not how close an
account is to claude.ai's own usage cap). The issue never asks for tier-3 to
change; conflating the two metrics would silently change borrow's own
tie-break behaviour, which is not what #238 asks for.

## 3-step dispatch split

1. **(this dispatch)** Plan doc + pure storage/logic layer. New
   `account-usage:<slot>` store (`account-usage-store.ts`, mirrors
   `account-limits-store.ts`), `AccountUsageSnapshot` type + encode/decode
   (`rate-limit.ts`, mirrors `AccountLimitState`), `usageMaxPct`/
   `toUsageHeadroom` + the `pickHeadroomAccount` internal fix
   (`claude-swap.ts`). No wiring into Worker routes, DO, or CLI. Does NOT
   touch `accounts.ts`, `failover.ts`, `do.ts`, `routes.ts`, `cli/accounts.ts`.
2. **(next dispatch)** Sync route writes the new `account-usage:<slot>` row
   on "limit"/"clear" (never on "unmanaged"/"no-data"); CLI `fleet accounts
   sync` plumbing unchanged otherwise.
3. **(final dispatch)** One-way-door wiring: `accounts.ts`'s tier-1/tier-2
   cascade reads fresh `account-usage:<slot>` rows + current `account-limit`
   rows, calls `pickHeadroomAccount` (excluding any slot with a live limit
   row -- the issue's own "never chooses a slot with a live limit row"
   requirement) to pick among otherwise-free candidates when usage data is
   fresh; falls back to today's plain order when `pickHeadroomAccount`
   returns null (stale/missing). `failover.ts`/`do.ts` touched only as much
   as call-site plumbing requires. CI-enforced one-way-door files
   (`scripts/merge-danger.ts`'s `ONE_WAY_GLOBS`) -- member fresh-context
   review before PR, max 2 rounds, draft until green (maestro STATUS brief).

## Step 1 shapes

```ts
// rate-limit.ts
export function accountUsageStateKey(accountName: string): string {
  return `account-usage:${accountName}`;
}
export interface AccountUsageSnapshot {
  fiveHourPct: number;
  sevenDayPct: number;
  scopedMaxPct: number | null; // null: no scoped windows exist/reported
  seenAt: string; // ISO, same seenAt convention as AccountLimitState
}
export function encodeAccountUsageSnapshot(s: AccountUsageSnapshot): string;
export function decodeAccountUsageSnapshot(raw: string | null): AccountUsageSnapshot | null;
```

```ts
// account-usage-store.ts -- pure persistence, no do.ts, mirrors
// account-limits-store.ts's own header/boundary exactly
export async function readFleetAccountUsage(
  db: D1Database, accounts: ClaudeAccount[],
): Promise<Record<string, AccountUsageSnapshot>>;
export async function writeFleetAccountUsage(
  db: D1Database, name: string, snapshot: AccountUsageSnapshot,
): Promise<void>;
```

Absent row -> absent key in the returned record (same "absent means nothing
observed" convention `readFleetAccountLimits` already uses), never a
default/zero entry.

```ts
// claude-swap.ts
export interface UsageHeadroom { fiveHourPct: number; sevenDayPct: number; scopedMaxPct: number | null; }
export function usageMaxPct(u: UsageHeadroom): number;
export function toUsageHeadroom(cswap: CswapAccount): UsageHeadroom;
```

`toUsageHeadroom` assumes well-formed input (caller already validated, same
posture `decideAccountSync`'s own internal helpers take -- validation is the
caller's job, this fn just extracts).

## Tests (step 1)

- `rate-limit.ts`: `AccountUsageSnapshot` encode/decode round-trip incl.
  `scopedMaxPct: null`; malformed JSON -> null (same convention
  `decodeAccountLimitState` tests already use, same file).
- `account-usage-store.ts`: real D1 (`cloudflare:test`), write-then-read
  round trip; account w/ no row absent from returned record.
- `claude-swap.ts`: `usageMaxPct`/`toUsageHeadroom` -- a scoped window
  w/ HIGHER pct than both 5h/7d dominates (the issue's own "scoped window
  dominating" acceptance case); `scopedMaxPct: null` falls back to
  `max(fiveHourPct, sevenDayPct)`, no crash. `pickHeadroomAccount`: existing
  tests still pass + new test proving a candidate whose SCOPED window (not
  5h/7d) gives it the lowest maxPct is now correctly picked -- proves the
  fix changed real behaviour, not just added an unused helper. Tie (equal
  maxPct) -> first/current order preserved (existing test already covers
  this shape via array order; step-3 dispatch is what actually wires
  "current order" as the real cascade fallback).

## Addendum: deviations from spec, found while implementing

(left blank in the plan; filled in in the implementation commit/PR
description if anything in the dispatch brief didn't match the real code
once read.)

### Step 2 notes

No deviations from the step-2 dispatch brief. One clarification worth
recording for step 3: the sync route writes the new `account-usage:<slot>`
row regardless of whether the account-limit row itself ends up `applied` or
`skipped` (the "clear" branch's own "newer row exists" case) — the usage
snapshot is an independent store from account-limit's own skip logic, so a
`"clear"` decision whose account-limit write gets skipped still records its
`usage` pct. This wasn't explicitly spelled out in the dispatch brief's test
list but follows directly from "two independent stores, never merged" in
this doc's own "Critical design finding" section above.

`cli/accounts.ts` needed no code change: `doSync` already forwards each
row's own `decision` object (verbatim, `decideAccountSync`'s real return
value) into the POST body rather than reconstructing a subset of fields, so
the new `usage` field on "limit"/"clear" decisions rides along for free.
Confirmed via `bun test test/bun/accounts-cli.test.ts` (12 pass, unchanged).

### Maestro review round 2 (final round) — 5 findings fixed

- **MAJOR 1**: the persisted `account-usage:<slot>` row's `seenAt` was the
  decision's own wall-clock `seenAt` (= CLI-run-time `usageFetchedAt`), not
  that account's own data time. `usageAgeSeconds` (previously "clear"-only,
  finding 6's own fix) is now also on the "limit" `SyncDecision` variant;
  routes.ts computes `dataTime = usageFetchedAt − usageAgeSeconds*1000` for
  BOTH branches and stamps the account-usage row's `seenAt` with it.
- **MAJOR 2**: `failover.ts`'s `deps.accountUsage.read()` was unguarded —
  wrapped in the same fail-open-to-`{}` + `console.warn` pattern do.ts's own
  `launchAccountOrRefuse` already uses for `readFleetAccountUsage`.
- **MINOR 3**: `selectByHeadroom` (accounts.ts) now partitions candidates
  into a fresh set and a rest (no-data-or-stale) set; a fresh-but-nearly-
  spent (>80%) reading no longer gets promoted over a genuinely unknown
  candidate — see the function's own doc comment for the full rule.
- **MINOR 4**: the sync route's usage-pct validation is tightened to a real
  `[0, 100]` range (was "finite number" only); the account-usage write now
  builds its object field-by-field rather than `{...rawUsage, seenAt}`
  (which could have persisted an arbitrary client-controlled key to D1); and
  `usageFetchedAt` more than 2 minutes in the future now 400s the whole
  request.
- **MINOR 5**: `selectByHeadroom`'s staleness check now treats a non-finite
  age (an unparseable `seenAt`, `Date.parse` -> `NaN`) as stale — `NaN >=
  freshnessMs` was `false` in JS, so a malformed row previously survived the
  filter as if it were the freshest reading.
