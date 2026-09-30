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

## Files touched

`apps/fleet/src/studio/accounts.ts`, `apps/fleet/src/studio/failover.ts`,
`apps/fleet/src/studio/rate-limit.ts`, `apps/fleet/src/studio/types.ts`,
`apps/fleet/src/studio/do.ts` (helper functions + `failoverDeps()` wiring —
D1 access has to live somewhere, and accounts.ts/failover.ts are explicitly
D1-free by their own header comments), `apps/fleet/test/studio.account-failover.test.ts`,
`apps/fleet/test/studio.failover-real-panes.test.ts`.
