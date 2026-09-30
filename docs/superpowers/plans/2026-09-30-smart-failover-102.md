# account failover: wrap, skip limited, fleet-wide limit state, no flapping (issue #102)

## Problem (verbatim gist)

CTO decision 2026-09-30: exhausted account -> move studio to next account
WITH FREE ROOM, immediately. Old `nextClaudeAccount` (accounts.ts): forward
only, `accounts[idx+1] ?? null`. No wrap (last slot = nowhere to go). No limit
awareness (can land on an account that is itself already exhausted). Limit
state (`LIMIT_SIGHTING_KEY`, failover.ts) was per-STUDIO-ROW DO storage only —
one studio hitting a limit never told any other studio's own next decision.

Want: wrap+skip-limited pick; fleet-wide per-account limit state; all-exhausted
-> stay + show earliest reset; no-flapping guard; FLEET_AUTO_FAILOVER=on
separately already in progress (not this task).

## Design

### accounts.ts — pure, still D1-free (file's own header: no Env/D1 import, bun:test-compilable)

`nextClaudeAccount(accounts, currentName, limits: AccountLimits = {}, now: Date = new Date())`.
`AccountLimits = Record<accountName, ISOuntil | null>`. Wraps: `accounts[(idx+step)%len]`
for step 1..len-1, skips current by construction (loop never revisits idx), skips
any account with a limits entry whose `until` is null (unknown reset — never
clears by the clock) or still ahead of `now`. No entry = free. Defaults keep
every 2-arg call site (there were none outside the test file + failover.ts)
behaving as a plain wrap with no fleet-wide info.

New `earliestAccountReset(accounts, limits, now)`: earliest still-live `until`
among `accounts`, ignoring `null`/passed ones. Feeds requirement 3's message.

This is an EXPLICIT, sanctioned behavior break from #53's old "forward only,
whole anti-loop mechanism" — old test "last account has no next" now wraps.
Anti-loop is now the limits map (an account already marked stays skipped every
lap), not list-position monotonicity.

### rate-limit.ts — fleet-wide record shape, still pure

`accountLimitStateKey(name)` = `"account-limit:" + name`. `AccountLimitState =
{until, seenAt}`. `encode`/`decodeAccountLimitState` (JSON, decode never
throws — a corrupt fleet_state row reads as "not limited", never crashes a
tick unrelated to writing it).

### failover.ts — FailoverDeps.accountLimits (optional port), wired at do.ts

`{ read(): Promise<AccountLimits>; write(name, until, seenAt): Promise<void> }`.
`runAccountFailover`:
- writes fleet-wide (`from`'s account) whenever THIS tick's own `limitChanged`
  is true — before computing candidate, so a switch OR an exhausted-degrade
  both mark the account fleet-wide (either way it's evidence the account is
  limited).
- reads fleet-wide limits once, right before calling `nextClaudeAccount`.
- SCOPES the account list handed to `nextClaudeAccount` by `#271`'s existing
  `start` (mapped-primary index) the SAME way the old "tried" slicing already
  did, extended backward to cover a stale `current` recorded BEFORE the
  primary (`#273 r2`) so it can still step forward into scope — but never lets
  a switch WRAP to before the primary. `scopeFrom = min(start, currentIdx)`
  (or `start` when `current` isn't found at all).
- `tried` (for the exhausted message) is now `deps.accounts.map(name).slice(start)`
  instead of the old `accountsTried(...).slice(start)` — equivalent on every
  existing fixture (both were always the same prefix there), but correct
  under wrap where "tried" is no longer a monotonic walk.
- `exhaustedMessage(studioId, tried, earliestReset?)` — optional 3rd arg,
  appends `" Earliest reset: <iso>."` only when given one. `fleet ls` renders
  `StudioStatus.error` verbatim (`ff.ts`'s `oneLine(row.error)`), so this is
  the whole "show earliest reset in fleet ls" requirement — no CLI change.

### No-flapping — FLAP_GUARD_MINUTES = 5, gated on HOW the last switch matched

One SYNC_SESSION_SECONDS tick (300s = 5m): long enough for a just-completed
switch's `--continue` resume to finish drawing its own transcript, short
enough a genuinely new limit is still caught the very next tick after that.

New `StudioStatus.claudeAccountMovedAt` (ISO) + `claudeAccountMovedVia`
(`"modal" | "inline"`), both written unconditionally on every completed
switch (failed or not — the account changed either way).

The guard fires ONLY when `verdict.inline && existing.claudeAccountMovedVia
=== "modal"` and within the window. Root-cause reasoning (traced through the
file's own residual notes): the ONE genuinely unguarded redraw risk is "after
a SELECT-modal switch (`failoverBlock` written as `null` — select modals
carry no block key), the switched-off account's OWN leftover transcript can
still hold an inline limit message, and `--continue` redraws it on the very
next capture, with no `failoverBlock` for the existing `rerender` check to
catch." An `"inline"`-via switch is ALREADY protected by its own
`failoverBlock`/`rerender` pairing (a redraw of the SAME key is caught there;
a DIFFERENT key is a genuinely new limit) — guarding it too would have blocked
legitimate immediate re-switches (caught by 2 existing tests in
studio.failover-real-panes.test.ts during verification — see below). A
genuine select-style modal (`!verdict.inline`) always overrides the guard
regardless of `via`/cooldown: claude can never redraw one from a resumed
transcript, so seeing one IS live evidence.

I considered gating purely on elapsed time with no `via` split first — broke
2 pre-existing tests that legitimately re-switch on a genuinely different
inline key right after an inline-triggered switch, with the SAME fixed clock
across ticks (no time actually elapses in those fixtures). Reading why
confirmed the `via` split is the semantically correct guard, not a test-fitting
hack: it maps exactly onto the ONE documented unguarded residual.

### do.ts wiring

`readFleetAccountLimits(db, accounts)` — `Promise.all` of `getFlag` per
configured account (bounded by `MAX_CLAUDE_ACCOUNTS`=9, and only reached on a
tick that already found a live modal). `writeFleetAccountLimit(db, name,
until, seenAt)` — one `setFlag`. Both reuse `state.ts`'s existing
`fleet_state` (key/value) table — no new migration, same pattern issue #5's
junior-authorization flag already uses. Kept OUT of accounts.ts/failover.ts on
purpose: both stay D1-free and bun:test-compilable (accounts.ts's own header
is explicit about this boundary).

## TDD

RED first throughout — `apps/fleet/test/studio.account-failover.test.ts`:
- `nextClaudeAccount`: wrap to first when last has no forward slot; skip a
  live-limited account and wrap past it; a passed reset counts free; every
  other account limited (incl. `until: null`) -> null.
- `earliestAccountReset`: earliest still-live reset; null when none.
- `runAccountFailover` (c): every-exhausted now requires a SEEDED fleet-wide
  limit on the other account (old test's "last slot, no wrap" assumption no
  longer holds by itself) — updated 3 pre-existing tests to seed it, added:
  wraps-to-free-account instead of degrading; wraps once a reset has passed;
  one studio's sighting marks the account fleet-wide for a DIFFERENT studio
  (two harnesses sharing one `accountLimits.read`).
  Also: exhausted message names the earliest fleet-wide reset;
  `exhaustedMessage`'s own optional-arg unit test.
- New describe "no flapping": inline-only block within cooldown of a
  MODAL-via move is refused (`flap-guarded`, no relaunch, account unchanged);
  a genuine select modal overrides regardless of cooldown; outside the
  cooldown window an inline block moves normally; a completed switch stamps
  both new fields (modal-via and inline-via cases both checked).

RED confirmed after the fact, precisely, by running the ORIGINAL (pre-#102)
test file against the NEW src/ code: exactly the 4 pre-existing tests this
branch deliberately rewrote fail — "only ever moves FORWARD... last account
has no next" (now wraps to `accounts[0]`, not `null`), "degrades, naming
every account tried" / "the tick AFTER the degradation..." / "adding a THIRD
account..." (all 3 assumed the old no-wrap "last slot = nowhere to go"
invariant, now genuinely wrap to the free first account instead of
degrading) — and NOTHING else in the file breaks. This is the exact,
deliberate behavior break the CTO decision asks for, isolated to precisely
the 4 tests whose own narrative depended on the superseded rule.

GREEN after every edit above, plus fixing 2 pre-existing failures the FIRST
implementation pass caused in `studio.failover-real-panes.test.ts` (both
select-modal-exhaustion-on-3-accounts and inline-redraw-guard tests — root
causes: (1) that file's `studio()` harness had no `accountLimits` wiring at
all, so wrap always saw every account "free"; fixed by wiring a persistent
`Map`-backed fake exactly like do.ts's own, which makes the pre-existing
3-account "exhausted" test pass again for free — a single studio's own
successive switches naturally accumulate fleet-wide state exactly like
production would. (2) the FIRST flap-guard cut gated on elapsed time alone
with no `via` distinction — see "No-flapping" design section above for the
fix and why it's the semantically correct one, not a test-fitting patch.

## Verification

Targeted only (per this task's own boundary — no full suite; `bun run check`
is the one repo-wide gate run, once, per the shared-lock rule):

- `npx vitest run test/studio.account-failover.test.ts` — 87 pass, 0 fail
  (72 pre-existing; 3 of them rewritten to seed fleet-wide limits so "every
  account exhausted" still means that under wrap, 1 rewritten into 4 wrap
  variants — net +15 new: 2 `earliestAccountReset`, 3 more wrap/fleet-wide-
  marking cases under "(c) every account exhausted", 2 earliest-reset-message,
  6 no-flapping incl. the two `claudeAccountMovedVia` stamp checks, +2 more
  from the initial 1-> 4 `nextClaudeAccount` split — see "Deviations" for how
  the no-flapping design landed).
- `npx vitest run test/studio.failover-real-panes.test.ts
  test/studio.rate-limited.test.ts test/studio.failover-106.test.ts
  test/studio.failover-214.test.ts test/studio.failover-274.test.ts
  test/studio.failover-fixtures.test.ts test/studio.account-by-repo.test.ts
  test/studio.account-gate-do.test.ts test/studio.account-launched.test.ts` —
  every file that touches accounts.ts/failover.ts/rate-limit.ts's changed
  exports — 449 pass, 0 fail.
- `npx vitest run test/studio.observation-tick.test.ts
  test/studio.replacement.test.ts test/studio.start-gate-writeback.test.ts
  test/studio.wake-race.test.ts` (other files importing `FailoverDeps`/
  `runAccountFailover`) — 185 pass, 0 fail.
- `cd apps/fleet && flock /tmp/fleet-gate.lock bun run check` (5-tsconfig
  repo-wide typecheck, the one heavy gate this task ran, once) — clean, exit 0.
- `bun scripts/english-check.ts ../..` — clean.

Full repo-wide `vitest run` (148 files) deliberately NOT run — a second heavy
gate on top of `bun run check`, out of this task's own scope per the
reassignment ("lead runs targeted tests only, no full suite"); every file
that imports the touched exports was run individually above instead.

## Deviations / judgment calls

- **FLAP_GUARD_MINUTES = 5**: not specified by the issue; chosen as one
  `SYNC_SESSION_SECONDS` tick (300s), stated reasoning in accounts.ts/failover.ts's
  own doc comments.
- **Flap-guard scope narrowed to `via === "modal"` only**, not every switch —
  see "No-flapping" design section: the literal "any move within N min" rule,
  applied to ALL switches, is provably a no-op in this codebase for
  `"inline"`-via moves (already `failoverBlock`-guarded) and would have
  blocked legitimate immediate re-switches; narrowing to the one path with a
  real, documented, unguarded residual is what makes the guard both correct
  and non-trivial.
- **Primary-scoped wrap range** (`min(start, currentIdx)`) is new design not
  explicitly in the issue text, needed to keep #271's existing "a mapped
  repo's studio never uses an account before its own primary" invariant true
  under wrap — verified against every existing #271 test (mapped primary,
  off-mode, stale-recorded-account #273 r2).
- Did not add an explicit fleet-wide "clear on recovery" write (an account
  proven healthy again by ANY studio's own working pane) — out of the 5
  explicitly-required tests (wrap/skip/reset-passed/all-exhausted/no-flapping);
  "reset passed = free" already covers the common healing path via the clock
  alone. Left as a stated residual, not implemented.
- junior: tried first (`~/.claude/skills/junior/junior.sh --task ... --mode
  text apps/fleet/src/studio/failover.ts`) exactly as instructed. Got `junior:
  junior not authorized for your current task: only the maestro enables it,
  by filing the task with \`fleet task new --junior\`` — confirmed the
  expected 403-shaped refusal (issue #102 carries no `junior` label). Did the
  rest of the read/draft/test work myself.

## Review round 1 fixes (2026-09-30)

A fresh-context review of this feature found 2 real, severe bugs. Both fixed
TDD RED-first, on the same branch, one commit pair each.

### Finding 1 (HIGH) — a `null`-until sighting blacklisted an account forever

`isFree` (accounts.ts) only cleared an account when its recorded `until` was
readable and had passed; a select-style modal sighting (`until: null` —
`failover.ts`'s `limitObservation`, every `!verdict.inline` modal) therefore
never cleared BY THE CLOCK at all, no matter how stale. `nextClaudeAccount`
skips a limited account on every future wrap, so this was a true deadlock:
nothing ever routes a studio back onto that account to re-probe whether the
underlying limit (a monthly/org spend cap) has actually reset — worse than
the pre-#102 behaviour for exactly the #53 incident shape (`/rate-limit-
options`, "Upgrade your plan") that motivated this whole feature.

**Fix**: `AccountLimits`'s value is now `{ until, seenAt }` (was bare
`string | null`) — `seenAt` threaded through `nextClaudeAccount`,
`earliestAccountReset`, and do.ts's `readFleetAccountLimits` (the D1-backed
`AccountLimitState` already stored `seenAt`; only the read projection had been
dropping it). `isFree` now treats a `null`-until entry as free again once
`now - seenAt` exceeds `NULL_UNTIL_CEILING_MS` — 24h, matching this file's own
`DAY_MS`/`firstSighting` day-boundary granularity (accounts.ts imports
nothing, per its own header, so the constant is repeated rather than
imported); no more precise documented figure for "how long a select-modal
limit typically lasts" exists anywhere else in this codebase. Stated as a
RESIDUAL/FIX at `NULL_UNTIL_CEILING_MS`'s own doc comment in accounts.ts,
following this file's convention of naming known gaps plainly (the ceiling
means a genuinely still-limited account can wrongly read free for up to 24h
after its select-modal sighting — accepted trade-off, stated explicitly, in
exchange for a self-healing path where there was none).

**TDD**: RED — `nextClaudeAccount` with a `null`-until entry `seenAt` 30 days
ago still returned `null` (no next account) against the un-fixed `isFree`;
confirmed failing. GREEN — same case now returns the next account; a
`null`-until entry `seenAt` 1 minute ago still correctly returns `null`
(excluded), proving the ceiling doesn't just delete the exclusion.

### Finding 2 (HIGH) — the flap-guard's escape hatch was unreachable for a new limit

The no-flapping guard (`FLAP_GUARD_MINUTES`, failover.ts) fired on ANY inline
verdict within the cooldown window after a `"modal"`-via switch, with the only
override being `!verdict.inline` (a genuine select-style modal). A genuinely
NEW limit on the studio's OWN NEW account that happened to render INLINE
(session/weekly/monthly-spend blocks — measured, `INLINE_LIMIT_HEADLINES`'s
own doc comment, the overwhelmingly common shape) was indistinguishable from a
stale `--continue` redraw of the OLD account's leftover transcript, so it was
wrongly suppressed for up to 5 minutes — the opposite of the requirement's own
stated intent ("no flapping... UNLESS its new account itself now shows a live
limit").

**Fix**: reuses `limitBlockKey`, the redraw guard's own comparison primitive
(the same one `failoverBlock`/`rerender` already use), rather than inventing a
new one. A new `StudioStatus.claudeAccountMovedBlock` field records, on every
completed switch, the block-key this studio already knew about at that
moment: `key` itself for an `"inline"`-via switch (same value `failoverBlock`
gets), or the studio's own `LIMIT_SIGHTING_KEY` sighting's block (read at the
top of `runAccountFailover`, before this tick's own observation) for a
`"modal"`-via switch — `null` when it knew of none (a select modal's own
capture can never also carry an inline block; the two are position-exclusive
in `detectLimitOnScreen`, so there is nothing else to record). The flap-guard
now suppresses a NEW inline observation only when its block-key MATCHES
`claudeAccountMovedBlock` (a genuine stale redraw); a DIFFERENTLY-keyed block,
or one appearing when `claudeAccountMovedBlock` is null (nothing was known at
switch time), is trusted immediately, cooldown or not. Cleared alongside
`failoverBlock` on the same "forget" trigger (a static pane with claude's
footer and no limit on it).

This narrows — but does not fully close — the pre-existing UNMEASURED residual
this file's own detection doc comment names ("a `--continue` redraw of the
persisted limit message is unguarded"): an inline message printed but never
sighted (it never matched the strict idle-ending shape this file requires)
still leaves `claudeAccountMovedBlock: null`, so its redraw is not suppressed
either. Traded deliberately: the OLD, unconditional guard suppressed every
genuinely new inline limit on a freshly-switched account, which measures far
more often than this narrower residual ever has. Restated at the doc comment
in failover.ts.

**TDD**: RED — a select-modal-via switch with no known block
(`claudeAccountMovedBlock` absent) followed, within the cooldown window, by a
genuinely new, differently-keyed inline limit (`WEEKLY_LIMIT_PANE`, distinct
from the session-limit fixture the existing tests used) stayed
`"flap-guarded"` instead of attempting a switch; confirmed failing against the
un-fixed guard. GREEN — the same case now returns `"switched"`; a matching
stale redraw (`claudeAccountMovedBlock` equal to the new inline verdict's own
key) still correctly returns `"flap-guarded"` within the cooldown window, and
a different `claudeAccountMovedBlock` recorded at switch time still does not
suppress a differently-keyed new limit.

**Verification**: `npx vitest run test/studio.account-failover.test.ts
test/studio.failover-real-panes.test.ts test/studio.account-by-repo.test.ts`
— 229 pass, 0 fail. Also ran every other file importing
`runAccountFailover`/`FailoverDeps`/`claudeAccountMovedVia` (`studio.account-
launched.test.ts`, `studio.failover-106.test.ts`, `studio.failover-214.test.ts`,
`studio.failover-274.test.ts`, `studio.rate-limited.test.ts`,
`studio.replacement.test.ts`, `studio.start-gate-writeback.test.ts`,
`studio.wake-race.test.ts`) — 522 pass total across all 11 files, 0 fail.
`flock /tmp/fleet-gate.lock bun run check` (5-tsconfig repo-wide typecheck) —
clean. `bun scripts/english-check.ts ../..` — clean.

## Files touched

`apps/fleet/src/studio/accounts.ts`, `apps/fleet/src/studio/failover.ts`,
`apps/fleet/src/studio/rate-limit.ts`, `apps/fleet/src/studio/types.ts`,
`apps/fleet/src/studio/do.ts` (helper functions + `failoverDeps()` wiring —
D1 access has to live somewhere, and accounts.ts/failover.ts are explicitly
D1-free by their own header comments), `apps/fleet/test/studio.account-failover.test.ts`,
`apps/fleet/test/studio.failover-real-panes.test.ts`.
