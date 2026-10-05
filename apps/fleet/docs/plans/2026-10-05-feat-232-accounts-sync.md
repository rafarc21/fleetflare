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

## Addendum 2026-10-05: rework after external review

First pass (15 commits, `8f24f9e`..`d146252`, PR #237) shipped per above.
Maestro review round 1 of 2 on PR #237: REQUEST CHANGES, 2 blocker + 4 major.
Plus scope-add from issue #232 STATUS comments (2026-10-05T09:48:22Z,
2026-10-05T10:17:38Z). 3-dispatch rework (`ad9807f`..`c5897ea`) addressed
all of it. This section records what changed and why; original sections
above are history, not edited.

**1. Review findings + scope-add.**

Blocker 1: stale/failed cswap data cleared real limits. `usageStatus`/
`usageAgeSeconds` never read by decide logic. Probe: 86400s-old 1% reading →
`clear` → deletes `dead:true` row → launch into disabled account.

Blocker 2: limit w/ no `resetsAt` → `until: undefined` → row decodes
null → slot reads FREE. Probe confirmed at 99%.

Scope-add (STATUS 09:48:22Z): only 2 of 6 real fleet slots carry a
`CLAUDE_ACCOUNT_<n>_LABEL` — label-only join near-useless in practice.
Required reset-time join as fallback.

STATUS 10:17:38Z: claude-swap = usage-number SOURCE only, operator decision.
Fleet never calls `cswap switch`/`auto`. No new switching path — unchanged
from original plan, just confirmed explicitly.

**2. `CswapAccount` corrected shape.**

`usageStatus === "ok"` = healthy (real cswap value; original plan's `"active"`
was invented, never verified against real cswap). Any other value (seen:
`relogin_required`, `unavailable`) = failure, `usage: null`. New field
`usageAgeSeconds: number` (seconds old, self-reported by cswap) — can be old
even when `usageStatus` is `"ok"`. `usage` now `{ fiveHour, sevenDay, scoped }
| null`. New const `MAX_USAGE_AGE_SECONDS = 600` — the general staleness
gate for ANY decision, not just item-5 headroom ordering.

**3. New `SyncDecision` action `"no-data"`.**

Distinct from `"unmanaged"`. `"unmanaged"`: join found no cswap match at all
(label miss + no reset-time candidate, or cswap itself unavailable).
`"no-data"`: join DID find a cswap account, but reading untrustworthy —
`usageStatus !== "ok"`, `usage === null`, `usageAgeSeconds >=
MAX_USAGE_AGE_SECONDS`, or malformed usage shape (non-numeric pct, non-array
scoped, etc). Both → no D1 write, same as before, but reason now visible.
`decideAccountSync` never throws by construction — a single malformed entry
degrades to `"no-data"` for that slot only, isolated.

**4. Two-pass join algorithm.**

`FleetAccountSlot` gained `until: string | null` (slot's own currently-D1-
recorded reset, for reset-time matching). `SlotJoin` gained `matchSource:
"label" | "inferred" | "unmapped" | "cswap-missing"`, replacing the old
per-branch `reason` field.

Pass 0: any email appearing >1x in `cswapAccounts` excluded from the
matching pool entirely (minor review fix — duplicate must never silently
first-win).

Pass 1 (label): exact `label === email`, same as original plan. Match
removes account from pool.

Pass 2 (reset-time, only for slots unresolved by pass 1): slot's own
`until` vs each remaining pool account's `fiveHour.resetsAt` /
`sevenDay.resetsAt`, within `RESET_MATCH_WINDOW_MS` = ±5 min. Exactly one
candidate → tentative `"inferred"` match. Zero or >1 → stays unmapped,
never guesses.

Cross-slot collision: if ≥2 slots tentatively resolve to the SAME pool
account, collision invalidates ALL of them back to `"unmapped"` — a cswap
account can't back two real fleet slots. Account stays unconsumed.

Fixture case required: two slots with identical reset time → both unmapped
(not a 50/50 guess).

**5. `--write-labels` CLI flag.**

`fleet accounts --write-labels` (and `--json` combo → `labelSuggestions`
key in JSON output) prints one pasteable `CLAUDE_ACCOUNT_<n>_LABEL=<email>`
line per `"inferred"` match. Never writes any config file itself — operator
pastes into ops config by hand. Bare `fleet accounts` stays read-only
(never calls the sync write route).

**6. Route (`POST /studio/accounts/sync`) changes.**

Request body gained top-level `usageFetchedAt` (ISO timestamp of the whole
cswap snapshot) — the ONE whole-request validation (missing/unparseable →
400 for the entire request; every `"clear"` in the batch is meaningless
without it, no partial-success story for a garbage snapshot time).

Response gained `skipped: { name, reason }[]`, distinct from `applied`/
`rejected` — a `"clear"` that lost to a fresher existing row (row's own
`seenAt` >= `usageFetchedAt`) reports here as a correct no-op, not an error.

A `"limit"` write now reads the row's current state first
(`readOneAccountLimit`, new export on `account-limits-store.ts`) and
preserves an existing `dead: true` flag instead of dropping it — a usage
threshold sighting is orthogonal to "account is dead" (failover.ts's own
pane-capture concern).

Every sync-route `"limit"`/`"clear"` write now tags `source: "usage"` on
the row — `AccountLimitState` (`rate-limit.ts`) gained optional `source`
field so a row's origin (usage sync vs pane-capture) is visible after the
fact. `writeFleetAccountLimit` signature gained a 6th optional `source?:
"usage"` param.

Per-entry validation tightened: `"limit"` requires `until` PRESENT (string
or explicit `null`, never absent/undefined) and `seenAt` parseable;
`"clear"` requires `seenAt` parseable too (clear now carries `seenAt`).
Malformed entry (null, non-object, non-string `name`, garbage `action`) →
rejected, never a 500. Duplicate names in one batch still all-reject, same
as before.

**7. Item 5 (headroom ordering) — officially out of scope, not deferred.**

Maestro's own round-1 review split it to issue #238 explicitly ("Remove
from this PR's claims"). `pickHeadroomAccount` ships built+tested in
`claude-swap.ts`, still unwired into `accounts.ts`/`failover.ts`/`do.ts`
(CI-enforced one-way-door files) — same non-wiring as original plan, but
now tracked under its own issue rather than an open-ended "follow-up" note
on this PR.

**8. Review status on reworked code.**

Both code-reviewer rounds on the reworked code: spec APPROVE, standards
APPROVE, nothing blocking. Current state — the 2-blocker/4-major external
maestro review (point 1 above) is what triggered this whole rework/
addendum, fully resolved by points 2-7 above.
