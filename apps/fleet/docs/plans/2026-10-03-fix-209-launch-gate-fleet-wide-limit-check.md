# Fix the launch gate's missing fleet-wide limit check (board issue #209)

## Problem statement

With `FLEET_AUTO_FAILOVER=on` and a repo mapped to a slot (issue #271's
`CLAUDE_ACCOUNT_BY_REPO`), a fresh provision/restart/recycle could still
launch a container straight onto that slot even though D1 already recorded
it, fleet-wide, as limited (issue #102's `AccountLimits`/`accountIsFree`,
`src/studio/account-limits-store.ts`'s `readFleetAccountLimits`) — landing
the studio directly in the weekly-limit modal instead of on a free account.

Root cause: `launchAccount` (`src/studio/accounts.ts:480`) resolves the
mapped slot (or the recorded account, with failover on) **unconditionally**
— it never consults `AccountLimits` at all. The gate every container touch
runs through first, `launchAccountOrRefuse` (`src/studio/do.ts:3648`), calls
`launchAccount` and also never consults limits. The fleet-wide limit map
exists (issue #102 built it specifically so one exhausted account's state is
visible to every studio's own next decision) but this one entry point never
read it.

## The fix

### New pure function: `launchAccountOrReroute` (`src/studio/accounts.ts`)

```ts
export function launchAccountOrReroute(
  env: ClaudeAccountEnv, repo: string | null, recorded: string | null | undefined,
  limits: AccountLimits, reserved: Set<string>, now: Date = new Date(),
): LaunchAccount
```

Calls `launchAccount` first (completely unchanged — no edit to that
function's signature or behavior; its own existing tests, including the
"(#53, unchanged)" one, keep passing untouched). If the resolved account
reads free (`accountIsFree`), returns that answer as-is. If it reads
limited, reroutes via `nextClaudeAccount(accounts, <resolved name>, limits,
now, reserved)` — the exact same forward-wrap/`reserved`-skip rule every
other failover path in this file already uses. If `nextClaudeAccount` also
returns null (every account limited or reserved), refuses with
`{ ok: false, error }` naming the earliest reset
(`earliestAccountReset(accounts, limits, now)`), or `"unknown"` when that is
itself null (every limited account's `until` is unreadable) — never the
literal string `"null"`.

Gated on `autoFailoverOn(env)` *inside* the function itself, as a second,
redundant guard on top of the caller's own gating below — matching every
other reroute/switch mechanism in this codebase (accounts.ts's own doc
comments: with failover off nothing ever moves a studio, and a restart is
how an operator's map edit reaches it; deliberate, untouched).

Does **not** invoke `nextBorrowedAccount` — that tier is the *reactive*
failover's own last-resort pass (`failover.ts`), out of scope here.
`nextClaudeAccount`'s own `reserved` param is the "same reserved rule" this
fix needs, and no further.

### Wiring: `launchAccountOrRefuse` (`src/studio/do.ts:3648`)

The only caller that reads D1, and only when `autoFailoverOn(env)` is true
(skip the round trip otherwise — matches an existing comment in do.ts about
not paying for an already-rare path):

```ts
const limits = autoFailoverOn(env) ? await readFleetAccountLimits(env.DB, resolveClaudeAccounts(env)) : {};
const reserved = otherRepoPrimaries(env, repo);
const launch = launchAccountOrReroute(env, repo, existing?.claudeAccount ?? null, limits, reserved);
```

`reserved` is built with `otherRepoPrimaries(env, repo)` — the identical
call shape `StudioDO.failoverDeps()` already uses
(`otherRepoPrimaries(this.env, parseStudioId(this.selfId())?.repo ?? null)`,
do.ts:5988), just with `repo` already resolved earlier in the same function.

Every other caller of the reroute/refusal machinery
(`provisionUngated`/`restartUngated`/`StudioDO.recycle()`) reaches it
exclusively through `launchAccountOrRefuse`, so the fix is live everywhere
that gate already runs — no other call site needed a change.

## Scope boundaries (deliberately not touched)

- **`refuseUnlessMappedAccountLaunchable`** (do.ts:3589) — the explicit
  operator override verb (`fleet recycle --account mapped`), deliberately
  bypassing recorded/limit state. Untouched.
- **`withAccountDisplay`** (`src/studio/registry.ts:274`, `fleet ls`'s
  display-only "next launch" column) — synchronous/no-I/O by design.
  **Known residual**: `fleet ls`'s "next launch" column may still show the
  mapped slot even though the real launch will reroute around it — it's
  display-only, not a safety issue, and fixing it needs an async rewrite of
  a function every other caller depends on staying sync. Left as-is.
- **`nextBorrowedAccount`** — not invoked by this fix (see above).
- **`launchAccount`'s own signature/behavior** — untouched; the new function
  wraps it rather than editing it, so its own existing test coverage
  (`describe("launchAccount"...)` in
  `test/studio.account-by-repo.test.ts`) still exercises the exact same
  contract.

## Test ripple

Grepped `FLEET_AUTO_FAILOVER.*on` across `apps/fleet/test/`:

- `studio.account-by-repo.test.ts` — reaches `launchAccountOrRefuse` with a
  bare `envWith` (`vars as unknown as Env`, no `DB`). **Fixed**: `envWith`
  now merges the real (migrated, empty-by-default) `cloudflare:test` D1:
  `{ ...testEnv, ...vars } as unknown as Env`.
- `studio.account-launched.test.ts` — same pattern, several tests reach
  `launchAccountOrRefuse` directly with `FLEET_AUTO_FAILOVER: "on"`. Already
  imported `env as testEnv` from `cloudflare:test` for an unrelated reason
  (`TEST_STUDIO_DO_SRC`); `envWith` now merges it in the same way.
- `studio.account-failover.test.ts` — its one `FLEET_AUTO_FAILOVER: "on"`
  env is used only with `launchFields`/`launchAccountName` (pure, untouched
  functions), never `launchAccountOrRefuse`. No change needed.
- `studio.refresh.test.ts` — its one `FLEET_AUTO_FAILOVER: "on"` env is used
  only with `studioEnvVars` directly (pure, untouched). No change needed.
- `studio.auto-continue.test.ts` — only a comment mentions
  `FLEET_AUTO_FAILOVER`; no call reaches the new code at all. No change
  needed.

An empty `fleet_state` table (the real D1's default state) reads back as
"no limits recorded" — every account free — which is exactly today's
behavior for every test that isn't specifically about this new reroute, so
merging the real D1 in is a no-op for all of them.

## Tests added (`test/studio.account-by-repo.test.ts`)

`describe("launchAccountOrReroute — issue #209...")` — pure-function
coverage, no D1:

1. Mapped slot limited (`until` in the future) + another free slot exists +
   auto-failover on → reroutes to the free one, never the limited mapped
   slot.
2. Mapped slot limited, every other account also limited or reserved →
   refuses, error contains `every account limited; earliest reset <ts>`
   with the real ISO timestamp.
3. Mapped slot limited, every other account limited too, none has a
   readable reset (`until: null`) → refuses, error says `unknown`, never
   the literal string `null`.
4. Mapped slot free → unchanged (regression guard).
5. Auto-failover off, mapped slot limited → still launches on the mapped
   slot unchanged (today's documented off-semantics).
6. The reroute never lands on another repo's reserved primary even when
   `AccountLimits` shows it free.

`describe("launchAccountOrRefuse — fleet-wide limit reroute, real D1
(#209)")` — end-to-end wiring, real D1 via `writeFleetAccountLimit`:

7. Auto-failover on, mapped slot fleet-wide limited (real D1 row), another
   slot free → reroutes away from the mapped slot.
8. Auto-failover off, same fleet-wide-limited D1 row → still launches on
   the mapped slot (the D1 round trip is gated off entirely).
9. Auto-failover on, every configured account fleet-wide limited (real D1
   rows) → refuses, naming the earliest reset.

## Verification

Full suite (`bun run test`), repo-wide typecheck (`bun run check`), the
bun-native lane (`bun run bun-test` — `accounts.ts` stays importable from
it, per its own header), and `bun run english-check`, run one at a time
under the shared gate lock. See the PR/completion record for the actual
command output.

## Fix-first review round (2026-10-03) — tiers 2/3 were missing, and a D1
## hiccup could strand a studio

A fresh-context review of PR #211 (before merge) found two real gaps in the
fix above, both now closed on the same branch/PR.

### Finding A+B — the reroute only ever ran tier 1 of failover's own cascade

`launchAccountOrReroute`'s *original* version (described above) called
`nextClaudeAccount` over the **full, unscoped** account list and refused the
moment that returned null. `runAccountFailover` (`failover.ts`), the
reactive failover path for an already-running studio, runs a genuine
**three**-tier cascade when picking a replacement: (1) this repo's own
scoped chain, forward wrap; (2) an unclaimed spare positioned before this
repo's own primary; (3) borrowing another repo's own reserved primary
(lowest 5h burn). The launch gate's own copy implemented only tier 1 — a
repo whose own scoped chain was fully limited refused the WHOLE launch
(`every account limited`) even when an unclaimed spare, or another repo's
reserved-but-currently-free primary, genuinely existed. That message is
literally false in that case: an account exists and is free, just reserved
or out of this repo's own scope.

Fix:

- **`accounts.ts`**: new exported `selectFreeAccount(accounts, anchor,
  current, currentOutOfScope, reserved, limits, now)` — tiers 1+2 of the
  cascade, factored out of failover.ts's own inline `candidate`/
  `outOfScopeSpare` locals, so there is exactly one implementation of "where
  does this repo's own chain send it, falling back to an unclaimed spare".
- **`failover.ts`**: `runAccountFailover`'s own `outOfScopeSpare` now
  delegates to `selectFreeAccount` instead of its own inline
  `firstFreeAccount` call. `candidate` (tier 1 alone) stays its own direct,
  separate call — it is still needed standalone for the auto-failover-OFF
  "parked" messaging and the `isBorrow` computation, which must never be
  influenced by a tier-2 spare that an auto-failover-off tick never acts on.
  `anchor`/`scopedAccounts`/`currentOutOfScope`/`start`/tier 3
  (`nextBorrowedAccount`) are untouched — this is a one-way-door file (see
  its own doc comments, #102/#103/#109/#131/#158/#170/#214) and the only
  change is that one delegation.
- **`accounts.ts`**: `launchAccountOrReroute` rewritten to run all three
  tiers: `selectFreeAccount` first (tiers 1+2, scoped to this repo's own
  mapped-primary anchor), then — only on a miss — `nextBorrowedAccount`
  (already its own shared export) fed fleet-wide burn via a new `readBurn`
  callback parameter, read lazily only on this now-rare path, exactly like
  `FailoverDeps.accountBurn.read()` already is. The function is now
  `async` for that one reason; it stays pure (no I/O of its own — `readBurn`
  is the caller's own injected callback). Refuses only once ALL THREE tiers
  miss.
- **Residual, stated rather than assumed**: the launch gate always treats
  the resolved account as in-scope (`currentOutOfScope: false`). The one
  case that is not is a studio restarting while actively borrowing an
  account positioned before its own primary, whose borrowed account has
  ALSO since gone limited — a narrow edge needing `existing.borrowedAccount`
  threaded through, which this function is not handed. Every other studio
  is unaffected; tiers 1/2/3 themselves are not weakened by this.
- **`do.ts`**: `readFleetAccountBurn` (previously module-private) exported,
  mirroring `readFleetAccountLimits`'s own export, so `launchAccountOrRefuse`
  can wire it in as `launchAccountOrReroute`'s `readBurn` callback.
- **`do.ts`**: a genuine reroute (this call's own `launch.name` differs from
  what plain `launchAccount` — no limit-awareness at all — would have
  resolved for the same `recorded`) now also writes `borrowedAccount`/
  `borrowedFromRepo` onto the row, mirroring `failover.ts`'s own write
  condition on a completed switch exactly (new `borrowFields` helper,
  alongside `accountClears`). Gated on genuine rerouting specifically — the
  plain #289 "recorded account carries forward, still free" case stays
  silent, since that switch already set the field back when it actually
  happened; re-deriving it here would otherwise spuriously write on every
  ordinary relaunch. Without this write, a studio launched via reroute/
  borrow would never carry the field the EXISTING hand-back mechanism reads
  to bring it home once its own primary frees up.

### Finding C — a D1 hiccup must fail open, never strand a studio

`launchAccountOrRefuse`'s `readFleetAccountLimits` call (and the new burn
read) could throw on a transient D1 error. That throw propagated
**uncaught** through `launchAccountOrRefuse`, which recycle's own flow calls
AFTER `destroy()` has already landed — stranding the studio destroyed with
nothing relaunched, a worse failure than before #209 ever read D1 at this
point. Both reads are now wrapped in try/catch, falling back to `{}` (no
limit/burn known — the exact behaviour this gate had before #209 shipped)
and logging `console.warn` with the error, never throwing.

### Tests added (`test/studio.account-by-repo.test.ts`)

`describe("launchAccountOrReroute — issue #209...")`, all now `async`:

- tier 3 — own chain exhausted, no unclaimed spare, another repo's reserved
  primary free → borrows it (replaces the old test that incorrectly
  expected a refusal in this exact shape).
- genuine exhaustion — own chain AND the reserved borrow candidate all
  limited → refuses, naming the earliest reset (the only case that still
  refuses).
- tier 2 — own chain limited, an unclaimed spare before the primary free →
  reroutes there.
- a `dead: true` entry is never picked by any tier.
- a `null`-until entry older than `NULL_UNTIL_CEILING_MS` (24h) counts as
  free again, picked over a genuinely limited one.

New `describe("launchAccountOrRefuse — borrow tier 3 and D1 failure
handling, real D1 (#209 review)")`:

- borrow via the real D1 wiring: launch succeeds on another repo's reserved
  primary, and the row's `borrowedAccount`/`borrowedFromRepo` land
  correctly.
- `env.DB.prepare` throws → the limits read is caught, the launch still
  succeeds with `limits = {}` (fail open), and `console.warn` fires — never
  an uncaught throw out of `launchAccountOrRefuse`.

Ran `test/studio.account-by-repo.test.ts`, `test/studio.account-launched.test.ts`,
`test/studio.account-failover.test.ts` together (243 tests, all green) after
every change; no regression in the existing tier-2/tier-3/hand-back coverage
`studio.account-failover.test.ts` already had for `runAccountFailover`
itself.

## Fix-first review round 2 (2026-10-03) — a regression in the review-round-1
## fix, a zero-coverage fail-open path, and a duplicated formula

A second fresh-context review of PR #211 found two blocking Spec findings in
the review-round-1 work above, plus one Standards nit. All three closed on
the same branch/PR.

### Finding 1 — `currentOutOfScope` hardcoded `false` disabled tier 1 for an
### out-of-scope, actively-borrowed `current`

Review round 1's own "Residual" note (above) stated this gap but left it
unfixed: `launchAccountOrReroute` always called `selectFreeAccount(accounts,
anchor, launch.name, false, ...)`. For a studio recorded on, and actively
borrowing, an account positioned BEFORE its own mapped primary (whose
borrowed account has ALSO since gone limited), that hardcoded `false` made
tier 1 a **guaranteed no-op**: `scopedAccounts` never contains the
out-of-scope `current`, so `nextClaudeAccount`'s own `idx < 0` branch
(accounts.ts) returns null immediately — not merely "misses", but never even
scans the repo's own in-scope chain for a free account. Tier 2
(`accounts.slice(0, anchor)`) never covers that chain either (it is the
slice BEFORE the anchor), so a genuinely free in-scope account was skipped
entirely in favour of an unnecessary tier-3 borrow, or an outright refusal.
The ORIGINAL pre-round-1 code (`nextClaudeAccount` over the full, unscoped
list) did not have this specific bug — this was a regression review round 1
introduced while fixing Finding A+B above.

Fix: `launchAccountOrReroute` gained a new `borrowedAccount: string | null |
undefined` parameter (threaded from the caller's own
`existing.borrowedAccount`) and now derives `currentOutOfScope` the same way
`failover.ts`'s own `runAccountFailover` already does —
`borrowedAccount != null && currentIdx >= 0 && currentIdx < anchor`. The
function's doc comment's "Residual" claim ("tiers 1/2/3 themselves are not
weakened by it") was also corrected: tier 1 WAS a guaranteed no-op in this
exact case, not merely a narrow residual. `do.ts`'s `launchAccountOrRefuse`
(the one caller) now passes `existing?.borrowedAccount ?? null`.

New regression test (`test/studio.account-by-repo.test.ts`): a studio
recorded on, and actively borrowing, an account before its own mapped
primary, where that account AND the primary are both now limited but a
later account in the repo's own scoped chain is free — proves tier 1 picks
the in-scope free account rather than an unnecessary tier-3 borrow of
another repo's reserved primary.

### Finding 2 — the burn-read fail-open path had zero test coverage

`do.ts`'s try/catch around `readFleetAccountBurn` (added in review round 1,
Finding C) was never actually exercised by a test: the existing
"`env.DB.prepare` throws" test only ever breaks the LIMITS read, in a
scenario where tier 1 already resolves — the burn callback is never
invoked there.

New test: the same tiers-1+2-miss fixture as the existing tier-3/borrow
test, with a D1 stub that poisons ONLY the `account-burn:`-prefixed key
(leaving the limits read hitting the real D1), asserting the launch still
succeeds (burn treated as empty) and `console.warn` fires naming
`readFleetAccountBurn`. Mutation-verified by temporarily removing the
try/catch: the new test fails with an uncaught "D1 burn read unavailable"
without it, and passes with it restored — confirming it is a genuine
regression pin, not a tautology.

### Finding 3 — duplicated `primaryIsMapped` formula (Standards)

`do.ts`'s `borrowFields` carried a hand-copy of
`StudioDO.primaryIsMapped()`'s own formula
(`repo !== null && parseAccountMap(env.CLAUDE_ACCOUNT_BY_REPO)[repo] !==
undefined`). Extracted into `accounts.ts` as an exported
`primaryIsMapped(env, repo)` (alongside `parseAccountMap`, which it already
wraps); `StudioDO.primaryIsMapped()` is now a one-line wrapper calling it
with `this.env`/`parseStudioId(this.selfId())?.repo ?? null`. Pure
extraction, identical behaviour — added direct unit coverage for the new
export.

### Verification

Ran `test/studio.account-by-repo.test.ts`, `test/studio.account-launched.test.ts`,
`test/studio.account-failover.test.ts` together (249 tests, all green) after
every change, then the full `bun run test` and repo-wide `bun run check`
(gate-locked, one at a time) before reporting done.

## Fix-first review round 3 (2026-10-03) — borrow-field write dead in
## production, and a stale pre-primary anchor false-refusing a free primary

A third fresh-context review of PR #211 found two more blocking findings,
both confirmed by reading the code directly (not inferred).

### Finding 1 — `borrowFields`'s row write was DEAD CODE in production;
### hand-back never fired

`launchAccountOrRefuse`'s own inline `commitOkClears` branch was the ONLY
caller of `borrowFields` (the write that sets `borrowedAccount`/
`borrowedFromRepo` so the existing hand-back mechanism, failover.ts, can
later bring a rerouted/borrowing studio home once its own primary frees
up) — but all FOUR real production call sites (`provisionUngated`,
`restartUngated`, recycle's entry call, recycle's post-destroy closure)
pass `commitOkClears: false` and commit only through
`decideAccountClears`/`applyAccountClears`, which called `accountClears`
without ever touching the borrow fields at all. Net effect: in real
production, a studio that reroutes onto a spare or borrows another repo's
reserved primary never got `borrowedAccount` written, and the hand-back
mechanism — gated on exactly that field — never fired. The existing borrow
test (`test/studio.account-by-repo.test.ts`) only ever exercised the
DEFAULT `commitOkClears: true` path, which no real caller uses, so it never
caught this.

Fix: `accountClears` now takes `repo`/`reserved` and folds `borrowFields`'s
own computation (plus the pre-existing "genuine reroute" gate that keeps
the plain #289 carry-forward case silent) directly into its own return —
the ONE computation both the inline `commitOkClears: true` branch and
`decideAccountClears` (every real production caller's own path) now share.
`decideAccountClears` gained the same two parameters, threaded through from
each of its three call sites in do.ts, derived the identical way
`launchAccountOrRefuse` itself already does: `parseStudioId(id)?.repo ??
null` and `otherRepoPrimaries(env, repo)`.

New test (`test/studio.account-by-repo.test.ts`): the same tiers-1+2-miss,
tier-3-borrow fixture as the existing (now explicitly-labelled "default
path") test, but driven through the REAL `commitOkClears: false` →
`decideAccountClears` → (simulated success continuation) → `applyAccountClears`
sequence every real caller actually uses — asserting `borrowedAccount`/
`borrowedFromRepo` land correctly. RED against the pre-fix code (`clears`
resolved null, so nothing was ever written); GREEN after.

### Finding 2 — `launchAccountOrReroute`'s anchor never widened backward for
### a stale non-borrowing recorded account (#273 r2 case), false-refusing a
### free primary

`accounts.ts`'s `launchAccountOrReroute` computed `anchor` as ALWAYS just
the mapped primary's own index — unlike `failover.ts`'s own
`runAccountFailover` derivation, which widens `anchor` backward to the
recorded `current`'s own position whenever the studio is NOT actively
borrowing and `current` sits before the primary (the "#273 r2" shape: a
repo whose `CLAUDE_ACCOUNT_BY_REPO` map assigns it a primary while a studio
is still recorded on an earlier account from before that map existed).
Without the widening, `scopedAccounts` (sliced from the unwidened anchor)
never even contained the recorded account, so `nextClaudeAccount`'s own
`idx < 0` branch returned null immediately — tier 1 never even tried the
primary itself (which sits INSIDE the correctly-widened scope), tier 2 only
covers strictly-before-anchor, and tier 3 has nothing to borrow when no
other repo's primary is reserved. Concrete repro: three accounts, a repo
mapped to slot 2, a studio recorded on slot 1 (not borrowing), slot 1
fleet-wide limited, slot 2 (the repo's own primary) completely free —
refused "every account limited" instead of rerouting to slot 2.

Fix: factored the anchor/`currentOutOfScope` derivation into a new shared
pure helper, `accounts.ts`'s `deriveSearchAnchor(accounts, start, current,
borrowedActive)`, implementing failover.ts's own exact formula (`anchor =
borrowedActive ? start : (currentIdx < 0 ? start : Math.min(start,
currentIdx))`, `currentOutOfScope = borrowedActive && currentIdx >= 0 &&
currentIdx < anchor`). `failover.ts`'s own inline computation now calls it
(semantics unchanged — a pure lift, not a behaviour change there);
`launchAccountOrReroute` calls it too, instead of its own simplified (and
wrong) copy, so the two formulas cannot drift a third time.

New test (`test/studio.account-by-repo.test.ts`): the exact repro scenario
above — a stale recorded account before a later-mapped primary, not
borrowing, primary free — asserts the launch gate reroutes to the primary
rather than refusing. RED against the pre-fix code (refused "every account
limited" even with the primary free); GREEN after.

### Finding 3 (test improvement) — the genuine-exhaustion refusal test now
### also checks the row

The existing "every configured account fleet-wide limited" test
(`test/studio.account-by-repo.test.ts`) only ever asserted the REJECTED
promise's message. Strengthened to also assert the row itself went
`state: "degraded"` with `error` naming the earliest reset — what `fleet
ls` actually reads, not just what the call throws.

### Verification

Each finding's test confirmed RED against the pre-fix code, then GREEN
after its own fix, committed separately and pushed immediately. Ran
`test/studio.account-by-repo.test.ts`, `test/studio.account-launched.test.ts`,
`test/studio.account-failover.test.ts` together (all green) after every
change, repo-wide `tsc --noEmit` clean, then the full `bun run test` and
`bun run check` (gate-locked, one at a time, never concurrently) before
reporting done.
