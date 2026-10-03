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
