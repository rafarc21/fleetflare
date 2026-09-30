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
row write unaffected by the flag) without committing either clear. Every
other call site (provision, restart, and recycle's own second, post-destroy
call) keeps the default `true`: none of those has a refuse-after-resolve
window between the call and the account actually being used, since
destroy() has either not happened at all (provision/restart start fresh) or
has already unconditionally happened (recycle's second call).

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
