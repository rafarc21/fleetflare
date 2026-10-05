# Fleet accounts sync via claude-swap (board issue #232)

## Goal

Fleet learns account limit only reactively today: pane capture sees modal,
writes `account-limit:<slot>` row. Row goes stale — reinstated account stays
`dead:true`, blocks every launch (409 "every account limited") til
hand-deleted from D1. claude-swap (`cswap`, MIT, `uv tool install
claude-swap`) holds OAuth logins on operator Mac, `cswap list --json` reports
real per-account usage (`usageStatus`, `usage.fiveHour.{pct,resetsAt}`,
`usage.sevenDay.{pct,resetsAt,willLastToReset}`, `usage.scoped[]` per-model).
Fleet containers run inference-scope setup-tokens only — usage API
unreachable from container, so usage read happens on operator machine only,
pushed into D1 via a Worker route. Goal: `fleet accounts sync` joins real
usage to slots by label==email, writes/clears limit rows proactively —
stale `dead:true` row clears itself the moment operator's next sync sees a
fresh low-pct reading (that reading IS the "re-login proved it's alive"
signal, no separate dead-check needed).

## 3-step split (this doc covers step 1 only)

1. **(this dispatch)** Plan doc + pure join/decision logic module
   `src/studio/claude-swap.ts` + `clearFleetAccountLimit` helper on
   `account-limits-store.ts`. No wiring into Worker or CLI.
2. **(next dispatch)** Worker route `POST /studio/accounts/sync` — auth like
   other verbs, calls `decideAccountSync`/`joinAccountsToCswap` from this
   module, applies decisions via `writeFleetAccountLimit`/
   `clearFleetAccountLimit`.
3. **(final dispatch)** CLI verb `fleet accounts` (table, `--json`) / `fleet
   accounts sync` (runs `cswap list --json` locally, posts to the step-2
   route) / `--watch` (60s+ loop, diff-only output).

## API shapes (`src/studio/claude-swap.ts`)

```ts
export interface CswapWindow { pct: number; resetsAt: string | null; }
export interface CswapScopedWindow extends CswapWindow { model: string; }
export interface CswapAccount {
  email: string;
  usageStatus: string;
  usage: {
    fiveHour: CswapWindow;
    sevenDay: CswapWindow & { willLastToReset: boolean };
    scoped: CswapScopedWindow[];
  };
}

export interface FleetAccountSlot { name: string; label: string | null; }

export type SlotJoin =
  | { name: string; label: string; cswap: CswapAccount }
  | { name: string; label: string | null; cswap: null; reason: "no-label" | "cswap-missing" | "not-managed" };

export function joinAccountsToCswap(
  slots: FleetAccountSlot[], cswapAccounts: CswapAccount[], cswapAvailable: boolean,
): SlotJoin[];

export const DEFAULT_LIMIT_THRESHOLD_PCT = 95;

export type SyncDecision =
  | { name: string; action: "limit"; until: string | null; seenAt: string }
  | { name: string; action: "clear" }
  | { name: string; action: "unmanaged"; reason: "no-label" | "cswap-missing" | "not-managed" };

export function decideAccountSync(
  join: SlotJoin, now: Date, thresholdPct?: number,
): SyncDecision;

export interface HeadroomCandidate { name: string; cswap: CswapAccount; dataAgeMs: number; }
export function pickHeadroomAccount(
  candidates: HeadroomCandidate[], freshnessMs?: number,
): string | null;
```

Join: pure, label===email exact match, case-sensitive, no normalization.
`cswapAvailable: false` forces every slot to `"cswap-missing"` regardless of
label (binary missing/errored on operator machine) — never `"not-managed"`
(reserved for "cswap ran fine, this email just isn't one it manages").

Decision: pct >= thresholdPct (default 95) on EITHER `fiveHour.pct`,
`sevenDay.pct`, OR any `scoped[].pct` → `"limit"`, `until` = the SPECIFIC
window's own `resetsAt` that tripped it — never mixed across windows. All
three below threshold → `"clear"`, unconditionally (this is also the dead-row
clear path — a fresh low-pct reading alone is the "operator re-login proved
it's alive" signal, `decideAccountSync` itself knows nothing about `dead`,
that is the step-2 route's own concern of which D1 helper to call).
Unjoined slot (`join.cswap === null`) always passes its own `reason` through
as `"unmanaged"`, never defaults to limit/clear.

`pickHeadroomAccount`: item 5's pure comparator (`maxPct(a) =
max(fiveHour.pct, sevenDay.pct)`), lowest-maxPct wins among candidates with
`dataAgeMs < freshnessMs` (default 10 min); `null` when none fresh enough —
caller's cue to fall back to current (reactive) failover behaviour, this fn
never falls back itself.

## `clearFleetAccountLimit` (`account-limits-store.ts`)

New export, alongside existing `writeFleetAccountLimit`/
`readFleetAccountLimits`:

```ts
export async function clearFleetAccountLimit(db: D1Database, name: string): Promise<void> {
  await deleteFlag(db, accountLimitStateKey(name));
}
```

Deletes the row rather than writing `until: null` — a null-until WRITE would
trip the existing 24h `NULL_UNTIL_CEILING_MS` grace period in
`accountIsFree` (rate-limit.ts), wrong semantics for "clear now, proven
alive". A fully absent row reads free immediately via `accountIsFree`'s
`!(a.name in limits)` branch.

## Item 5 wiring: deferred, deliberately, this dispatch

`pickHeadroomAccount` is built and fully unit-tested here but NOT wired into
`src/studio/accounts.ts`, `src/studio/failover.ts`, or `src/studio/do.ts`.
Those three are in `apps/fleet/scripts/merge-danger.ts`'s `ONE_WAY_GLOBS`
(CI-enforced one-way door — irreversible-class changes to the live failover
cascade). Wiring the comparator into the live cascade is a follow-up board
issue; this dispatch only builds and proves the pure decision in isolation.
Reading `accounts.ts` for `accountLabel`/`resolveClaudeAccounts`/
`MAX_CLAUDE_ACCOUNTS`/`claudeAccountVarName` is fine — importing FROM a
one-way-door file doesn't make the importing file one-way; EDITING
accounts.ts/failover.ts/do.ts is what's forbidden here.

## Tests (acceptance criteria → `test/claude-swap.test.ts`)

- `joinAccountsToCswap`: exact label===email match; no-label slot →
  `"no-label"`; labelled slot with no matching cswap row → `"not-managed"`;
  `cswapAvailable: false` → every slot `"cswap-missing"` regardless of label.
- `decideAccountSync`: fiveHour >= 95 → limit w/ fiveHour's own resetsAt;
  sevenDay >= 95 → limit w/ sevenDay's own resetsAt; a scoped model >= 95
  (fiveHour/sevenDay both low) → limit w/ that scoped window's own resetsAt;
  all three below 95 → clear; exactly-at-threshold (95) → limit (`>=`, not
  `>`); an unmanaged join → `"unmanaged"` passthrough, never limit/clear;
  custom `thresholdPct` respected.
- `pickHeadroomAccount`: lowest maxPct among fresh candidates wins; a
  lower-pct but stale (`dataAgeMs >= freshnessMs`) candidate excluded; all
  stale → null; empty candidates → null; custom `freshnessMs` respected.
- `clearFleetAccountLimit` (real D1, `cloudflare:test`): after
  `writeFleetAccountLimit(db, name, null, seenAt, true)` (dead row) +
  `clearFleetAccountLimit(db, name)`, `readFleetAccountLimits` shows NO entry
  for that name — fully absent, not `dead: false`.

Fixture `test/fixtures/cswap-list.ts`: HAND-BUILT (cswap not installed in
this container, no real capture exists — never claimed verbatim), `@example
.com` emails only, 3+ accounts: one over threshold on `fiveHour`, one under
threshold everywhere, one over threshold only on a `scoped` model.

## Acceptance (from issue, restated)

No token, email, or org id printed in logs/PR/tests — fixtures use
`example.com`. Docs: operator setup (`cswap add` per account; never
`/logout` first — revokes refresh token) land with step 3 (the CLI verb),
not here.
