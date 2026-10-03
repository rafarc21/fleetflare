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
