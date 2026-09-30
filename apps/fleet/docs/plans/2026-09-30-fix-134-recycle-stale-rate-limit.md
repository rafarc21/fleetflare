# Clear stale `rateLimited` when a launch resolves to a different account (board issue #134)

## Root cause

`launchAccountOrRefuse()` (`src/studio/do.ts`) already resolves recycle's
account correctly: with `FLEET_AUTO_FAILOVER` off it ignores the studio's
previously-recorded account entirely and resolves straight to the repo's
`CLAUDE_ACCOUNT_BY_REPO`-mapped slot (confirmed by the existing #328
"end-state sanity check" test at the bottom of
`test/studio.account-launched.test.ts`). Account selection is not the bug.

`StudioStatus.rateLimited` is a per-row field whose *content* (`{until,
seenAt}`) is an observation that was necessarily made while the studio was
running on the account it was launched on at the time — not a property of
the studio row in general. `recycle()`'s own `StudioStatus` writes spread
`...existing` forward (see `recycle()`'s doc comment), so a stale
`rateLimited` observation made on account A rides along untouched after a
recycle that resolves and launches happily on account B. The only code
paths that ever clear `rateLimited` are `runAccountFailover`'s live-pane
recovery detection (`failover.ts`, ~300s cadence) and the degraded-recovery
path (`do.ts`, ~30s cadence, `recovery.shouldHeal`) — both require fresh
screen evidence and neither runs as part of `launchAccountOrRefuse`'s own
account-resolution step. Neither is a refusal gate: there is no code
anywhere in the recycle/provision/restart path that reads `.rateLimited` to
decide whether to launch.

The practical effect: `fleet ls` / `fleet recycle`'s own table
(`formatTable`, `formatRateLimited`) keeps printing "rate-limited until
`<time>`" for a studio that is, in fact, running fine on the newly-mapped
account — because the row's `rateLimited` field was never invalidated by
the account change. This reads exactly like "recycle refused", even though
the container was destroyed and relaunched correctly. It is a stale-display
bug, not a refusal bug — but skills/fleet-cockpit/SKILL.md correctly
instructs operators/agents to treat "rate-limited until `<time>`" as "do
not recycle", so the stale display causes them to stop investigating a
studio that is actually healthy.

## The fix

In `launchAccountOrRefuse()`'s `if (launch.ok)` branch, fold one more
condition into the existing single read-modify-write that already clears a
stale `claudeAccount` when auto-failover is off: also clear
`rateLimited: null` when the account this call resolved to (`launch.name`)
differs from the account the studio was last launched on
(`existing?.launchedAccount`), and `existing?.rateLimited` is currently set.

Guards against over-clearing:
- only clear when `existing?.rateLimited != null` (nothing to do otherwise);
- only clear when `existing?.launchedAccount` is a non-null string AND it
  differs from `launch.name` — a studio that has never launched, or is
  re-launching on the SAME account, keeps its `rateLimited` untouched.

`state`/`error`/`failoverBlock` are left alone. No D1/AccountLimits read is
added: if the new account also turns out to be rate-limited, the existing
30s/300s live-pane recovery paths will re-observe and re-set `rateLimited`
correctly on their own next tick — skipping that check here is deliberate.

Both the existing `claudeAccount` cleanup and the new `rateLimited` cleanup
land in the same `storage.put`/`recordStudioFn` call, rather than two
separate writes.

## Test plan

Add to `test/studio.account-launched.test.ts`, alongside the existing
"#328" describe blocks, using the file's existing fixtures
(`envWith`, `ALL`, `MAP_2`, `fakeStorage`, `status`, `STATUS_KEY`,
`launchAccountOrRefuse`):

1. A studio recorded on account 1 with a set `rateLimited` observation, repo
   mapped to account 2, auto-failover off → `launchAccountOrRefuse` resolves
   `CLAUDE_CODE_OAUTH_TOKEN_2` and the stored row's `rateLimited` becomes
   `null`.
2. A companion test proving no over-clearing: the studio's mapped/launched
   account does not change (or has never launched) → `rateLimited` is left
   untouched on the stored row.

Run with `vitest run test/studio.account-launched.test.ts` (this repo's
`test` script is `vitest run`, under `@cloudflare/vitest-pool-workers`) —
RED before the fix, GREEN after. No full suite, no build, run alone.

## Review round 1 addendum: the entry-time call must not commit

A fresh-context code review caught a regression in the opposite direction:
`recycle()` calls `launchAccountOrRefuse` TWICE — once at its own entry,
before `recycleWithSync` has even probed the container (let alone destroyed
it), and again, fresh, immediately before the post-destroy container
actually starts (inside the `awaitReady` closure, issue #328). Unconditional
commits meant the ENTRY call's clear (`claudeAccount`, `rateLimited`) could
land in storage even when `recycleWithSync` then refuses outright — a failed
probe, or a confirmed rescue-push failure, without `--discard-unsynced` —
so `destroy()` never runs and the studio never moves anywhere. That left a
studio that stayed exactly where it was with a row falsely claiming it was
no longer rate-limited / no longer on its old account — the mirror image of
#134's own original bug.

Fix: `launchAccountOrRefuse` grew a 5th, optional `commitOkClears = true`
parameter. `recycle()`'s entry call passes `false` — it still does its
existing job (refuse early on an unlaunchable account, with that refusal's
row write unaffected by the flag) without committing either clear.

CORRECTION (round 2 found this claim false — see the round 2 addendum
below): this section originally claimed "every other call site (provision,
restart) is a single call with no such refuse-after-resolve window... since
provision/restart start fresh." That is wrong: `provisionUngated` and
`restartUngated` are BOTH idempotent and skip the actual container start
when it is already running, which turns out to be the exact same class of
gap recycle's entry call has. See the round 2 addendum for the real fix.

New tests, same file: a `commitOkClears=false` unit-level describe block
(resolves the account, writes nothing); a primitive-level composition
mirroring recycle()'s actual two-call sequence, once with a simulated
refusal in between (rateLimited survives) and once with a simulated
successful destroy+relaunch (rateLimited is dropped by the second call); and
a source-pinning describe block (same convention as the existing "#328"
blocks — the DO cannot be constructed under vitest-pool-workers) asserting
the entry call's literal text carries `, false)` and the closure's call does
not. Also updated the stale comment above the closure (previously claimed
the entry call's clear was "already performed... if it was going to" — no
longer true now that it never commits).

## Review round 2 addendum: provision/restart had the identical gap

A second fresh-context review found round 1's own doc comment claim false:
"provision/restart start fresh, no refuse-after-resolve window." In truth,
`provisionUngated` (do.ts) is explicitly idempotent (studio.routes.test.ts's
"provision idempotent" coverage exercises a second POST against an
already-running studio) and `restartUngated` is likewise callable against a
live container. Both guard their actual container start with
`if (!this.ctx.container?.running) await sbAwaitReady(this)` — on an
already-running container, that guard is false and the start is SKIPPED
entirely. The live tmux session keeps running on whatever
`CLAUDE_CODE_OAUTH_TOKEN` it booted with (`studioEnvVars`'s own doc comment:
frozen at boot, never re-read without a fresh start); `launchedAccount` (the
field the clear-guard compares against) is only written by `onStart`, which
never fires when the guard skips the start either.

So `fleet provision <id>` / `fleet restart <id>` against a studio that is
rate-limited on account A, still running, whose repo has since been
remapped to account B: round 1's fix resolved B and, because
`commitOkClears` defaulted to `true` at these two call sites, immediately
nulled `claudeAccount`/`rateLimited` on the row — even though the container
never moved and is still genuinely running (and rate-limited) on A. The
exact false-"healthy" bug #134 exists to fix, reopened through
provision/restart instead of recycle.

Fix: `provisionUngated`/`restartUngated` now call `launchAccountOrRefuse`
with `commitOkClears: false`, same as recycle's entry call, and commit the
clear themselves via a newly-extracted `commitAccountClears` helper (do.ts)
— but only INSIDE the `if (!this.ctx.container?.running) { await
sbAwaitReady(this); ... }` branch, i.e. only once a cold start has actually
happened. `commitAccountClears` re-reads storage fresh (same reasoning as
recycle's own second call: nothing durable is assumed to still hold from
whenever the resolving call ran) and shares its clear-computation logic
(extracted into a pure, no-I/O `accountClears` helper) with
`launchAccountOrRefuse`'s own inline `commitOkClears: true` path, so there
is exactly one copy of the merge logic. `launchAccountOrRefuse`'s own doc
comment and this plan's round 1 addendum (above) are both corrected to
name the real gap.

New tests, same file: a `commitAccountClears` primitive-level describe
block (guard skips the start → `rateLimited` survives; guard runs a cold
start → `commitAccountClears` drops it; a no-op row → no write), and a
source-pinning describe block (same convention as every other such block
in this file) proving `commitAccountClears` is called from INSIDE each
function's cold-start guard, never outside it, and that both functions'
`launchAccountOrRefuse` calls carry `, false)`. The existing "#292 r2"
`StudioDO wiring (source)` test (which pins the literal 4-arg call text) was
updated to expect the new 5-arg `, false)` form instead.

Verified both new source-pinning tests actually catch the regression they
guard against: temporarily reverted `provisionUngated`'s call back to the
old unconditional 4-arg + no-branch shape → 3 tests failed as expected →
restored → 55/55 green again.
