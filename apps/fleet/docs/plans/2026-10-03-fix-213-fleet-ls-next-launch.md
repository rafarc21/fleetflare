# Fix `fleet ls`'s "next launch" column staleness (board issue #213)

## Problem statement

`fleet ls`'s "next launch" column (`StudioStatus.claudeAccountNext`) is
stamped by `withAccountDisplay` (`src/studio/registry.ts`), which called the
plain, limit-UNAWARE `launchAccount(env, repo, recorded)`. The REAL launch
gate (`launchAccountOrRefuse`, `src/studio/do.ts`, built in PR #211 for issue
#209) uses the smarter, limit-aware `launchAccountOrReroute`
(`src/studio/accounts.ts`), which reroutes around fleet-wide rate-limited
accounts via a three-tier cascade (own-chain wrap, unclaimed spare, borrow
another repo's reserved primary) before ever refusing.

So `fleet ls` could show a "next launch" account that is actually fleet-wide
limited and is NOT what a real launch lands on. This is display-only
staleness, not a safety bug — the real gate already does the right thing
regardless of what this column shows.

## The two options the issue offered

- **(A) Make the display reroute-aware too** — call the same
  `launchAccountOrReroute` the real gate uses, fed the same `limits`/
  `reserved` inputs, so the column can never disagree with where a launch
  would actually land.
- **(B) Accept the lag and document it** — leave `withAccountDisplay` calling
  the plain `launchAccount`, and add a doc note that "next launch" can be
  briefly stale relative to the real gate's rerouting.

## Why (A), not (B)

(A) turned out to be cheap to do correctly, which tipped the balance away
from just documenting the gap:

- `launchAccountOrReroute`'s only new inputs versus the plain `launchAccount`
  are `limits` (an `AccountLimits` map) and `reserved` (a `Set<string>`).
- `reserved` is **free** — `otherRepoPrimaries(env, repo)` (`accounts.ts`) is
  a synchronous, pure function of `env` alone. No I/O, no extra read.
- `limits` needs exactly **one shared D1 read per `fleet ls` call**, not one
  per row — `readFleetAccountLimits` (`src/studio/account-limits-store.ts`,
  already imported directly by `routes.ts` the same sandbox-free way) is
  called once in `listStudios`, before the per-row loop, and the same result
  is threaded through every row's `withAccountDisplay` call.
- The read is skipped entirely when `FLEET_AUTO_FAILOVER` is off:
  `launchAccountOrReroute`'s own early return
  (`if (!launch.ok || !autoFailoverOn(env)) return launch;`) means `limits`
  is never even looked at in that case, so there is no reason to pay for the
  D1 round trip then. `listStudios` mirrors that by only calling
  `readFleetAccountLimits` when `autoFailoverOn(env)` is true, falling back
  to `{}` (the "nothing is limited" fail-open value) otherwise — the exact
  same no-signal convention and warn-and-continue-on-D1-failure posture
  `do.ts`'s own `launchAccountOrRefuse` already uses at its own `limits`
  read (`do.ts` around its `let limits = {}; try { ... } catch { ... }`
  block).
- One deliberate simplification: `launchAccountOrReroute`'s `readBurn`
  parameter (used only for tier-3 borrow-account tie-breaking, to prefer the
  account with the lowest 5h burn) is left at its default
  (`async () => ({})`), so this display-only column falls back to picking a
  borrowed account in list order instead of by lowest burn. The real
  function that reads fleet-wide burn, `readFleetAccountBurn`, lives in
  `do.ts`, which imports `@cloudflare/sandbox` — exactly the import boundary
  issue #217's fix worked around for `routes.ts`. `registry.ts` has to stay
  sandbox-free the same way, so pulling in `readFleetAccountBurn` here was
  not worth it for a column that is advisory anyway; the real gate still
  makes the burn-aware pick at actual launch time.

Given all three new inputs are either free (`reserved`), already a single
shared read for the whole call (`limits`), or a documented, scoped
simplification (`readBurn`), making the display reroute-aware cost almost
nothing extra and removes a whole class of "the column lied" confusion — so
(A) was chosen over (B).

## The fix

### `withAccountDisplay` (`src/studio/registry.ts`)

Signature changed from

```ts
export function withAccountDisplay(env: Env, row: StudioStatus): StudioStatus
```

to

```ts
export async function withAccountDisplay(
  env: Env, row: StudioStatus, limits: AccountLimits, reserved: Set<string>, now: Date,
): Promise<StudioStatus>
```

Internally, the one call site that resolved "what launches next" was swapped
from `launchAccount(env, repo, recorded)` to
`await launchAccountOrReroute(env, repo, recorded, limits, reserved, now, row.borrowedAccount)`.
`launchAccountOrReroute` returns the identical `LaunchAccount` shape
(`{ok: true, name, token} | {ok: false, error}`) `launchAccount` already did,
so every other branch of `withAccountDisplay` (the `next.ok`/`next.name`
handling) needed no changes beyond this one call-site swap plus the new
`await`.

### `listStudios` (`src/studio/registry.ts`)

Reads `limits` **once**, before the per-row loop, gated on
`autoFailoverOn(env)` (fail-open to `{}` on a D1 read failure, logged via
`console.warn`, mirroring `do.ts`'s own pattern). For each row, computes
`reserved = otherRepoPrimaries(env, parseStudioId(row.id)?.repo ?? null)`
(per-row, since it depends on the row's own repo — this is synchronous, no
I/O) and calls `await withAccountDisplay(env, row, limits, reserved, now)` in
a plain sequential `for...of` loop (no `Promise.all` needed — after the one
shared `limits` read, every per-row call is CPU-only, nothing to
parallelize).

### Callers

`listStudios`'s own external signature (params/return type) is unchanged, so
its existing callers (`routes.ts`'s `/studio/` route and `renderStudioGrid`)
needed zero changes.

## Tests

`apps/fleet/test/studio.registry.test.ts` gained a new describe block,
`listStudios' claudeAccountNext reroutes around a fleet-wide limited account
(#213)`, reusing the existing #209 "mapped slot fleet-wide limited, another
slot free: reroutes to the free one" fixture (`writeFleetAccountLimit`) at
the `listStudios`/fleet-ls integration level:

- With `FLEET_AUTO_FAILOVER=on` and the mapped account fleet-wide limited,
  `claudeAccountNext` now shows the REROUTED account (the next free slot in
  the repo's own chain), never the limited mapped one. This is RED against
  the pre-fix `withAccountDisplay` (confirmed: fails with the limited mapped
  account instead of the rerouted one) and GREEN after the fix.
- With auto-failover off, the same fleet-wide-limited mapped account is still
  shown unchanged (no reroute) — pinning that the refactor did not disturb
  the pre-existing, documented off-semantics (nothing moves a studio off its
  mapped primary when failover is off).

Every existing direct call site of `withAccountDisplay`
(`test/studio.account-by-repo.test.ts`, `test/studio.account-launched.test.ts`
— found by grep) was updated to the new async 5-argument signature, passing
the "nothing is fleet-wide limited" no-op inputs (`{}` limits, an empty or
the test's already-computed `reserved` set, `new Date()`), since none of
those tests were exercising rerouting at that call site — all 143
pre-existing tests across the touched files kept passing unchanged, plus the
2 new `#213` tests above (145 total). A later review pass (finding 2) added
one more test closing a fail-open coverage gap in `listStudios`'s
`readFleetAccountLimits` try/catch, bringing the running total to 146.

## Scope

Touched only `src/studio/registry.ts` and the direct test call sites of
`withAccountDisplay`/`listStudios` found by grep
(`test/studio.registry.test.ts`, `test/studio.account-by-repo.test.ts`,
`test/studio.account-launched.test.ts`). `do.ts`, `failover.ts`, `accounts.ts`
and route files were not modified — only existing exports from `accounts.ts`
and `account-limits-store.ts` were imported.
