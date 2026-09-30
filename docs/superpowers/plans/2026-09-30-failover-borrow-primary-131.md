# Borrow another repo's primary on total exhaustion + `--account mapped` (board task #131)

## Problem statement

Board issue #131, filed 2026-09-30, two asks.

**Ask 1 (issue body)**:

> Observed 2026-09-30. Repo A's mapped account hit its 5h limit. Other
> non-primary accounts were marked limited. Repo B's primary account had
> room.
>
> Failover reported "every account has been tried" and left repo A's leads
> parked on the limit modal. Cause: #117 excludes other repos' mapped
> primaries from the wrap. Working fix was a manual remap of repo A in ops
> config + Worker-only deploy.
>
> Want: when every non-primary account is limited, failover may borrow
> another repo's primary (lowest burn first), log it loudly, and hand back
> when repo A's own account resets. Keep #117's guarantee for the normal
> case.
>
> Tests: all non-primary limited + other primary free → borrows; own primary
> resets → moves back; normal case unchanged.

**Ask 2 (comment on the same issue)**:

> Related gap: with FLEET_AUTO_FAILOVER=on, launchAccount prefers the
> studio's RECORDED account over CLAUDE_ACCOUNT_BY_REPO. A map change never
> reaches a studio an earlier failover recorded elsewhere, and `fleet
> provision` on a live pane does not relaunch claude. Only lever today: flip
> failover off + recycle. Want an operator verb, e.g. `fleet recycle <id>
> --account mapped`, that clears the record and relaunches on the mapped
> slot (rescue first).

This task is split into two dispatch stages on the same branch
(`task-131-failover-borrow-primary`). **This document is written by Stage A
(the operator-verb implementer)**, which builds ONLY Ask 2. Stage B
(borrow-failover logic, Ask 1) is a separate, later dispatch on this same
branch and is NOT implemented here — the section below is a committed design
reference for it, not code.

## Design — Ask 2 (`fleet recycle --account mapped`) — IMPLEMENTED (Stage A)

### The gap

`launchAccount` (`apps/fleet/src/studio/accounts.ts:363-385`): with
`autoFailoverOn(env)` true and a non-null `recorded` account, returns that
recorded account WITHOUT even consulting `CLAUDE_ACCOUNT_BY_REPO` — the map
is dead weight once a studio has ever failed over. `recorded` comes from
`StudioStatus.claudeAccount` (DO storage, `STATUS_KEY`).

`launchAccountOrRefuse` (`apps/fleet/src/studio/do.ts`) is the gate every
provision/restart/recycle path calls before touching a container. There was
already a narrow precedent for clearing a stale recorded account — but only
when `!autoFailoverOn(env)` (failover flag OFF). With the flag ON — the exact
case this ask targets — nothing cleared `claudeAccount`. That was the gap.

### The fields

- `apps/fleet/src/studio/cli-args.ts`: `recycle`'s `CliCommand` variant gains
  `forceMappedAccount?: true` — present only when `--account mapped` was
  given, same "optional, only present when true" discipline `destroy`'s own
  `park?: true` (issue #59) already established. The bespoke boolean-flag
  parser (not `parseFlags`, which stays task-only) is extended to also pull a
  value-taking `--account <value>` pair out of `rest` before the boolean scan
  runs; the only legal value is the literal string `"mapped"` — anything else
  (including a missing value, or the flag given twice) is a usage error
  naming what's wrong (`fleet recycle: --account only accepts "mapped"`).
- `apps/fleet/cli/fleet.ts`: `cmdRecycle` gains a `forceMappedAccount = false`
  parameter and adds `account=mapped` to the recycle POST's query string when
  true — same convention as the existing `discard-unsynced=true`/
  `fresh-session=true` flags.
- `apps/fleet/src/studio/types.ts`: `ProvisionConfig.forceMappedAccount?:
  true` — optional, present only when true, right beside `freshSession?`/
  `cancelFreshSession?`.
- `apps/fleet/src/studio/routes.ts`: the `POST /recycle` route reads
  `url.searchParams.get("account") === "mapped"` and spreads
  `{ forceMappedAccount: true }` into the `ProvisionConfig` it builds, same
  spread-conditional style already used there for `freshSession`. cli-args.ts
  is the only validator of the value — this route just reads the boolean
  outcome.

### The clear, and why its ORDERING matters (the #328 race)

`StudioDO.recycle()` (`apps/fleet/src/studio/do.ts`) resolves the launch
account TWICE — once at entry (to refuse before destroying a running
container, issue #271) and again, freshly, inside the `awaitReady` closure
right before the container actually starts (issue #328 round-2/round-3 fix
for a real race against a concurrently-running `runAccountFailover`, which
runs on this studio's own `syncSessionCycle` alarm independently of
recycle's `OPERATION_KEY` lock). `test/studio.account-launched.test.ts`
(lines ~227-371 as of this writing) documents "the buggy shape: a stale
entry-time snapshot clobbers a failover that lands mid-recycle" vs "the fixed
shape: a fresh re-read... survives."

A new `clearForceMappedAccount(storage, recordStudioFn)` helper (exported
from `do.ts`, beside `launchAccountOrRefuse`) clears `claudeAccount` AND the
`claudeAccountMovedAt`/`claudeAccountMovedVia`/`claudeAccountMovedBlock`
"we're on a non-default account" audit trail (a forced-mapped recycle
deliberately puts the studio back on its plain mapped slot, not a
failover-moved one) — mirroring the shape of the existing
`!autoFailoverOn(env)` clear in `launchAccountOrRefuse`, extended to the
three moved-audit fields.

`recycle(cfg, discardUnsynced)` calls `clearForceMappedAccount` when
`cfg.forceMappedAccount` is true, as the VERY FIRST statement in its body —
before its own first `launchAccountOrRefuse` call. This is the load-bearing
choice: clearing happens inside `recycle()`'s own atomic flow, so BOTH of its
`launchAccountOrRefuse` calls (the entry-time refusal and the later,
freshly-resolved in-closure call) see the cleared state and fall through to
`CLAUDE_ACCOUNT_BY_REPO`'s mapped slot. A route-level pre-step (clearing
before `stub.recycle()` is even invoked, as a separate RPC call or a
separate write before the one that does the recycle) would reopen the exact
race #328 closed: a concurrently-running `runAccountFailover` could rewrite
`claudeAccount` in the gap between a route-level clear and recycle()'s own
first read.

If the mapped slot's secret does not exist, the ordinary refusal path
`launchAccountOrRefuse` already enforces handles it unchanged — the clear
only has to land early enough that the refusal check evaluates against the
cleared (not stale) state; no new error handling was needed.

"Rescue first" was already `recycle()`'s existing behavior (`recycleWithSync`
rescues/syncs before destroying) — confirmed by reading, unchanged by this
work; the account-clear was added as an early step in the same flow, not a
reordering of it.

### Files touched (Stage A)

- `apps/fleet/src/studio/cli-args.ts` — `CliCommand`'s `recycle` variant
  gains `forceMappedAccount?: true`; the bespoke recycle parser accepts
  `--account mapped` (any order relative to `--discard-unsynced`/
  `--fresh-session`); `VERBS.recycle`'s `args`/`summary` documents the flag.
- `apps/fleet/cli/fleet.ts` — `cmdRecycle` takes `forceMappedAccount` and
  adds `account=mapped` to the recycle POST's query string; the `recycle`
  dispatch case passes `parsed.forceMappedAccount === true` through.
- `apps/fleet/src/studio/types.ts` — `ProvisionConfig.forceMappedAccount?:
  true`.
- `apps/fleet/src/studio/routes.ts` — the recycle route reads
  `?account=mapped` into `cfg.forceMappedAccount`.
- `apps/fleet/src/studio/do.ts` — new exported `clearForceMappedAccount`
  helper (beside `launchAccountOrRefuse`); `recycle()` calls it, gated on
  `cfg.forceMappedAccount`, as its first statement.
- `apps/fleet/test/studio.cli-args.test.ts` — parsing coverage: `--account
  mapped` sets the field; any other value (or a missing value, or the flag
  given twice) is a usage error naming what's wrong; coexists with
  `--discard-unsynced`/`--fresh-session` in any order; a plain recycle keeps
  its exact pre-existing shape (no `forceMappedAccount` key at all); the help
  text names the flag.
- `apps/fleet/test/studio.account-launched.test.ts` — a source-pinning block
  (same technique the existing #328 block uses, since the DO cannot be
  constructed under `vitest-pool-workers`) proving
  `cfg.forceMappedAccount` is checked, and calls `clearForceMappedAccount`,
  before recycle()'s first `launchAccountOrRefuse(` call; a primitive-level
  composition proving the clear, once run, makes the very next
  `launchAccountOrRefuse` fall through to the mapped slot instead of the
  stale recorded one, with `FLEET_AUTO_FAILOVER=on` (the exact case
  `launchAccount`'s own doc comment says never consults the map); a
  regression pin that a plain recycle (no `--account mapped`) never calls
  the new helper at all and leaves `claudeAccount`/the moved-audit trail
  untouched.
- `apps/fleet/test/studio.routes.test.ts` — `?account=mapped` reaches the DO
  as `cfg.forceMappedAccount`; absent, or any other value, leaves the field
  absent.
- This plan doc.

### Verification (Stage A)

RED confirmed first: implementation files stashed, the three new test files
run, 13 new tests failing (9 in `studio.cli-args.test.ts`/
`studio.routes.test.ts`, 4 in `studio.account-launched.test.ts`) —
`TypeError: clearForceMappedAccount is not a function` and literal
`"usage"` results where a parsed `recycle` command was expected. Then GREEN:
implementation restored, same three files run clean (302/302 passed).

```
$ cd apps/fleet && npx vitest run test/studio.cli-args.test.ts test/studio.account-launched.test.ts test/studio.routes.test.ts
 Test Files  3 passed (3)
      Tests  302 passed (302)

$ cd apps/fleet && npx vitest run test/studio.account-gate-do.test.ts test/studio.account-failover.test.ts
 Test Files  2 passed (2)
      Tests  102 passed (102)
```

Full gate (run one at a time, never in parallel — see this repo's fleet-wide
memory ceiling note), all exit 0:

```
$ cd apps/fleet && bun run check
$ tsc --noEmit && tsc --noEmit -p container && tsc --noEmit -p cli && tsc --noEmit -p test-integration && tsc --noEmit -p test
(clean, exit 0)

$ cd apps/fleet && bun run test
$ vitest run
...
 Test Files  151 passed (151)
      Tests  5276 passed (5276)
   Duration  264.83s
(exit 0)

$ cd apps/fleet && bun run english-check
$ bun run scripts/english-check.ts
english-check: clean
(exit 0)
```

## Design — Ask 1 (borrow another repo's primary) — NOT YET IMPLEMENTED, Stage B

This section is a committed design reference for the next developer. It was
NOT built by Stage A — `apps/fleet/src/studio/accounts.ts` and
`apps/fleet/src/studio/failover.ts` were explicitly out of scope for this
dispatch (reserved for Stage B, to avoid collision).

### Shape

- **New `FailoverOutcome` kind `"borrowed"`**: a second pass, entered only
  when the EXISTING first pass in `nextClaudeAccount`
  (`apps/fleet/src/studio/accounts.ts`) — the one that already respects
  `reservedAccounts`/other-repo-primary exclusion (the invariant the issue
  body calls "#117"; in this repo's own test-file comments the same
  cross-repo-exclusion regression is labelled "#103" —
  `test/studio.account-failover.test.ts:1281`, "issue #103: a repo-A studio
  wrapping past a fleet-wide-limited account never lands on repo B's own
  mapped primary"; confirm which issue number the board actually intends
  before citing it in new code/comments, the two trace the same invariant
  either way) — returns `null`, AND `deps.autoFailover` is true. The second
  pass then tries `otherRepoPrimaries` candidates (the accounts the first
  pass's `reserved` set excludes), filtered to free/not-limited, ordered by
  LOWEST 5h-window burn first (not list order, unlike the first pass's
  forward-wrap).
- **New `FailoverOutcome` kind `"returned"`**: hand-back — when a studio is
  currently on a borrowed account and its OWN mapped primary becomes free
  again, switch back to it immediately (not merely on the next 5h reset —
  whenever a live limit sighting or periodic check observes the primary is
  free again).
- **New `StudioStatus` fields**: `borrowedAccount?: string | null` (the
  account name currently borrowed, if any) and `borrowedFromRepo?: string |
  null` (which repo's primary it was borrowed from, for logging/audit only).
- **New `FailoverDeps.accountBurn?: { read(): Promise<Record<string, {
  window5hOutput: number }>>> }`**, mirroring the existing `accountLimits`
  shape/pattern: a new parallel `account-burn:<name>` `fleet_state` row,
  written wherever burn is currently mirrored to the registry
  (`mirrorBurnToRegistry` in `do.ts`), read the same way `accountLimits` is
  read in the DO's own `failoverDeps()` construction (mirrors
  `accountLimitStateKey`/`writeFleetAccountLimit`/`readFleetAccountLimits`
  in `do.ts`/`rate-limit.ts` — `accountLimitStateKey(name)` ->
  `fleet_state.value` via `getFlag`/`setFlag`; a burn-scoped sibling key
  would follow the identical read/write/key-naming shape).

### Open question Stage A did NOT resolve — verify before implementing

First, grep every call site of `runAccountFailover(` to confirm whether it
already runs on a cadence independent of a live limit sighting (needed for
the hand-back check to fire even when nothing is currently wrong — i.e. a
periodic tick that runs even when the pane shows no rate-limit modal), or
whether hand-back needs a NEW periodic hook parallel to
`evaluateDegradedRecovery` (issue #214, `failover.ts`). This was not
confirmed by Stage A's research and must be verified before implementing,
not assumed. (`do.ts:2818`, `await
runAccountFailover(failoverDeps, storage, idFallback, recordStudioFn,
observedStorage ?? undefined)`, is the one call site found by Stage A's own
grep during this dispatch — worth re-checking whether it is the syncSession
tick itself, and whether that tick runs on a fixed cadence regardless of
observed state, before assuming hand-back "just works" off it.)

### Open question — RESOLVED (Stage B, 2026-09-30)

Grepped every call site of `runAccountFailover(` in `apps/fleet/src` (test
files each construct their own harness and call it directly; production has
exactly one call site). The one production call site is `do.ts:2818`, inside
`syncSessionCycle` — and `syncSessionCycle` is NOT gated on any observed
state: `StudioDO.syncSession()` (`do.ts`, the scheduled alarm callback) calls
it unconditionally via `runScheduledTick`, on the fixed `SYNC_SESSION_SECONDS`
cadence (the alarm reschedules itself in a `finally`, "unconditionally, exactly
as before" per that method's own doc comment), and `syncSessionCycle` itself
runs its steps — session sync, aside-ship, `mirrorBurnToRegistry`, THEN
`runAccountFailover`, THEN the readiness check — each in its own try/catch,
none gated on whether a limit was ever seen. `runAccountFailover` itself then
unconditionally execs `paneCaptureCmd()` and computes a fresh `verdict` on
every single tick, whether or not anything is currently wrong: a healthy
studio runs this exact code path every 300s and gets `verdict.kind ===
"working"` (the "no limit, pane is clean" branch) every time.

That settles the question: `runAccountFailover`'s own periodicity is already
independent of a fresh limit sighting, so the hand-back check does NOT need a
new hook parallel to `evaluateDegradedRecovery` — `evaluateDegradedRecovery`
itself is called FROM inside this same already-periodic `working` branch (see
`runAccountFailover`'s own `if (verdict.kind === "working")` block), which is
exactly the existing precedent this feature follows: the hand-back check is
added as one more step inside that same branch, guarded on
`existing.borrowedAccount` being set so the overwhelming majority of ticks (a
studio that has never borrowed anything) pay nothing beyond one field read.
No new alarm, no new schedule, no new call site — the tick that already runs
on a fixed cadence regardless of observed state is reused exactly as it is.

### Must-not-regress

The reserved-primaries regression test at
`test/studio.account-failover.test.ts:1281` ("issue #103" in this file's own
comment, the invariant the board issue calls "#117" — repo A's studio,
limited on slot 3, wraps FORWARD and lands back on its OWN primary (slot 2),
never on repo B's fleet-wide-FREE mapped primary, slot 4) MUST keep passing.
The new second pass only ever triggers when the FIRST pass (own-chain,
reserved-primaries-respecting) already returned `null` — i.e. the studio's
own primary is ALSO limited, not merely "skipped as reserved" the way slot 4
is in that test. A regression here would mean an ordinary, non-exhausted
failover starts landing on another repo's primary, exactly the starvation
the reservation exists to prevent.

## Files touched (this stage, Stage A only)

See "Files touched (Stage A)" above. Stage B will append its own list (and
its own Verification output) to this same document when it lands, rather
than starting a new plan doc — same convention this repo already uses for
multi-round fixes within one issue (see e.g. the #328 fix rounds documented
inline in `do.ts`'s own comments).

## Files touched (Stage B)

- `apps/fleet/src/studio/accounts.ts` — extracted `accountIsFree` from
  `nextClaudeAccount`'s own `isFree` closure (same rule, now shared); new
  `nextBorrowedAccount` (the borrow second pass: among `reserved` accounts,
  free, lowest 5h burn first); new `repoForAccount` (the reverse of
  `otherRepoPrimaries`, display-only, for naming a borrowed account's repo in
  an operator message).
- `apps/fleet/src/studio/failover.ts` — `FailoverDeps` gains optional
  `accountBurn` (read-only, mirrors `accountLimits`' shape) and `otherRepoOf`
  (display-only repo-name lookup); `FailoverOutcome` gains `"borrowed"` and
  `"returned"`; new `borrowedMessage`/`returnedMessage`; the exhaustion path
  (inside `runAccountFailover`) now tries `nextBorrowedAccount` when the first
  pass (`nextClaudeAccount`) returns `null` and `deps.autoFailover` is true,
  tracked via one `isBorrow` flag that drives the outcome kind, the
  `StudioStatus.borrowedAccount`/`borrowedFromRepo` fields and the notify
  wording; the `working`-verdict branch (already runs every
  `SYNC_SESSION_SECONDS` regardless of observed state — see the resolved open
  question above) gains a hand-back check, gated on
  `existing.borrowedAccount` being set and the studio's own `deps.primary`
  reading free again (`accountIsFree`); new private `handBack` performs the
  hand-back switch (exec + relaunch + record + notify), deliberately
  reusing less machinery than the ordinary switch — see `handBack`'s own doc
  comment for the three things it does NOT do and why (no redraw-guard
  bookkeeping, no `claudeAccountMovedVia`, no `observedStorage` bring-up
  re-verification — stated as a residual, not silently dropped).

  Review round 2 (2026-09-30): the `observedStorage` residual above was
  stated but unproven — no test had ever driven a hand-back WITH
  `observedStorage` passed. Now pinned by
  `test/studio.account-failover.test.ts`'s `"hand-back does not re-verify
  observedStorage (residual, tracked)"`, which seeds `incarnation`/
  `lastShipOkAt` before a hand-back and asserts the whole `Observed` record
  is byte-identical after — proof, not just doc-comment assertion, that
  session-verdict/incarnation data goes stale across a hand-back. Candidate
  for a follow-up issue if `fleet inspect`'s session-verdict display after a
  hand-back turns out to matter in practice (not filed here).
- `apps/fleet/src/studio/types.ts` — `StudioStatus` gains
  `borrowedAccount?: string | null` and `borrowedFromRepo?: string | null`.
- `apps/fleet/src/studio/rate-limit.ts` — new `accountBurnStateKey`,
  `AccountBurnState`, `encodeAccountBurnState`, `decodeAccountBurnState` —
  the exact parallel `account-burn:<name>` sibling of
  `accountLimitStateKey`/`AccountLimitState`/`encodeAccountLimitState`/
  `decodeAccountLimitState`.
- `apps/fleet/src/studio/do.ts` — new `readFleetAccountBurn`/
  `writeFleetAccountBurn` (the D1-backed read/write half of
  `FailoverDeps.accountBurn`, parallel to `readFleetAccountLimits`/
  `writeFleetAccountLimit`); `mirrorBurnToRegistry` gains an optional
  trailing `accountBurnWrite` port, called with this studio's own
  `launchedAccount` and `burn.window5hOutput` whenever wired (absent: mirrors
  exactly as before — every existing 2-arg call site, including every test,
  is untouched); `syncSessionCycle` gains a parallel optional trailing
  `accountBurnWrite` parameter, threaded down to `mirrorBurnToRegistry`;
  `StudioDO.syncSession()`'s one production call wires it to
  `writeFleetAccountBurn(this.env.DB, …)`; `failoverDeps()` gains
  `accountBurn.read` (wired to `readFleetAccountBurn`) and `otherRepoOf`
  (wired to `repoForAccount`). Did NOT touch `clearForceMappedAccount` or
  `recycle()`'s account-clear step — Stage A's own territory, untouched.
- `apps/fleet/test/studio.account-failover.test.ts` — new
  `describe("repoForAccount …")`, `describe("nextBorrowedAccount …")`, and
  `describe("runAccountFailover — borrow another repo's primary …")` blocks;
  `harness()` gains `accountBurn`/`otherRepoOf` options and an
  `accountBurnReads` counter (the mutation-style proof's own instrument). The
  existing `describe("runAccountFailover — auto-failover ON with a mapped
  primary (#271)")` block, including the golden #103 test at its original
  line, is UNCHANGED.
- This plan doc.

### RESIDUAL, stated rather than hidden

`readFleetAccountBurn`'s mirrored figure is never read-time-expired against
the 5h window the way `StudioStatus.burn` itself is (`registry.ts`'s
`expireBurnWindow`, issue #181): `AccountBurnState` carries only
`window5hOutput`, per this plan doc's own original shape, with no
`window5hStart` to expire it against. A stopped studio's last mirrored figure
for its account therefore freezes at whatever it held when the container went
down, the same shape of staleness #181 fixed for the per-studio figure but
not extended here. The consequence is bounded: `accountIsFree` (the
fleet-wide LIMIT map) is what decides whether a borrow candidate is usable at
all; a stale burn figure can only mis-ORDER two already-free candidates
against each other, never turn an exhausted account into a usable one or vice
versa. Documented here rather than fixed, given the scope of this dispatch —
a natural follow-up for whoever next touches this fleet-wide burn mirror.

## Verification (Stage B)

RED confirmed first, the same way Stage A's own verification did: with only
`test/studio.account-failover.test.ts` changed (the five new `describe`
blocks plus the `harness()` extensions) and every implementation file
(`accounts.ts`, `do.ts`, `failover.ts`, `rate-limit.ts`, `types.ts`) stashed
back to `origin/main`'s Stage-A state, the full file was run:

```
$ cd apps/fleet && npx vitest run test/studio.account-failover.test.ts
 Test Files  1 failed (1)
      Tests  11 failed | 98 passed (109)
```

12 new tests were added; 11 failed (`nextBorrowedAccount is not a function`,
`repoForAccount is not a function`, and `{ kind: "no-modal" }`/
`{ kind: "exhausted" }`/`{ kind: "switched" }` where `"borrowed"`/`"returned"`
was expected). The 12th ("not yet borrowed, own primary free, no limit on
screen: hand-back never fires") passed even against the stashed
implementation, by construction — it asserts the ABSENCE of new behavior
(`existing.borrowedAccount` is never set, so there is nothing for a hand-back
check to act on whether or not one exists), so it is a true negative, not a
false pass; 98 pre-existing tests in the same file were unaffected either
way. Then implementation restored, same file GREEN:

```
$ cd apps/fleet && npx vitest run test/studio.account-failover.test.ts
 Test Files  1 passed (1)
      Tests  109 passed (109)
```

Two things this run proves directly:

- the golden #103/#117 regression test (line ~1281 pre-Stage-B, unmodified)
  still passes unchanged — the reserved-primaries wrap never lands on another
  repo's primary in the ordinary (non-total-exhaustion) case;
- the new sibling test in the must-not-regress section above (same fixture,
  own primary ALSO limited) passes with `{ kind: "borrowed", … }` — proving
  the stricter condition is what gates the borrow path, not a loosened
  reservation check;
- the mutation-style test ("the first pass's own free candidate wins, and the
  second pass is never even consulted") passes, AND asserts
  `h.accountBurnReads === 0` — not just that the outcome was `"switched"`,
  but that `deps.accountBurn.read` was never even called, so a mutant that
  ran both passes unconditionally and compared burn globally (reopening
  #103/#117's starvation bug) would fail this test even if it happened to
  pick the right winner by coincidence.

Full gate, run ONE AT A TIME per this repo's own memory-ceiling rule (never
concurrently with another heavy gate), all exit 0:

```
$ cd apps/fleet && flock /tmp/fleet-gate.lock bun run check
$ tsc --noEmit && tsc --noEmit -p container && tsc --noEmit -p cli && tsc --noEmit -p test-integration && tsc --noEmit -p test
(clean, exit 0)

$ cd apps/fleet && flock /tmp/fleet-gate.lock bun run test
$ vitest run
...
 Test Files  151 passed (151)
      Tests  5288 passed (5288)
   Duration  275.20s
(exit 0)

$ cd apps/fleet && flock /tmp/fleet-gate.lock bun run english-check
$ bun run scripts/english-check.ts
english-check: clean
(exit 0)
```

5288 = Stage A's own 5276 baseline + 12 new tests (the three new `describe`
blocks: `repoForAccount`, `nextBorrowedAccount`, and `runAccountFailover —
borrow another repo's primary`), 151 test files unchanged in count. Zero
regressions across the full suite, including every `runAccountFailover`
describe block and `nextClaudeAccount`/`otherRepoPrimaries (issue #103)`/
`earliestAccountReset (issue #102 requirement 3)` block this task's own
must-not-regress section named.

## Fix-first round (maestro review of PR #135)

The maestro reviewed PR #135 (this same branch) and returned FIX-FIRST: 4
bugs, plus 2 mutation-coverage gaps, plus one minor ordering bug — all
missed by the first code review and QA pass. Each finding below has its own
RED test, committed before its fix (or, for the two pure coverage gaps,
committed as a standalone test-only commit with a manual RED/GREEN mutation
check in place of a production fix). Full commit list at the end of this
section.

### Finding 1 — hand-back kills a lead mid-turn or during a concurrent operation

`failover.ts`'s hand-back guard (inside the `verdict.kind === "working"`
branch) fired on ANY working verdict, including a repainting (mid-turn) pane
— `verdict.repainted`, the same signal `forget` a few lines above already
refuses to act on — and regardless of whether a fresh `OPERATION_KEY` lock
was held by a concurrent provision/restart/recycle/failover. Hand-back's own
`accountSwitchCmd` (`respawn-pane -k`) kills whatever the pane is running, so
either case lost real, in-flight work.

**Fix**: the guard now also requires `!verdict.repainted` and
`!operationLockFresh(await storage.get(OPERATION_KEY), deps.now())` — the
identical op-lock check the `heal` computation a few lines above, and the
ordinary switch path further below, already make. A skipped tick is not an
error: the next 300s tick tries again.

**RED test**: `test/studio.account-failover.test.ts`, two new tests in the
Stage-B borrow/hand-back describe block — a repainting (mid-turn) pane with
the primary free (hand-back must not fire), and an idle pane with the
primary free but a FRESH `OPERATION_KEY` held (hand-back must not fire
either). Both asserted the studio stayed borrowed, no relaunch, no notify.

### Finding 2 — clearing a forced-mapped account left the borrow flags set

`clearForceMappedAccount` (`do.ts`) cleared `claudeAccount`/the three
moved-audit fields but left `borrowedAccount`/`borrowedFromRepo` set; the
sibling `#273 r2` flag-off stale-clear inside `launchAccountOrRefuse` had the
identical gap. A stale `borrowedAccount` surviving either clear makes the
NEXT hand-back check (gated on exactly that field) fire against a studio
that is not actually borrowing anything any more, killing the fresh lead the
clear just launched.

**Fix**: both sites now also clear `borrowedAccount: null, borrowedFromRepo:
null`; `clearForceMappedAccount`'s own no-op guard was extended to check
both fields too, so a row that is already fully clear still writes nothing.

**RED test**: `test/studio.account-launched.test.ts`, a new describe block —
one test per site, each seeding `borrowedAccount`/`borrowedFromRepo` and
asserting both are null afterward.

### Finding 3 — the borrow gate missed free accounts positioned before the primary

The first pass (`nextClaudeAccount` over `scopedAccounts`) only ever scans
this studio's own chain (primary forward); the borrow pass only ever scans
`reserved` names (other repos' mapped primaries). An account that is BOTH
positioned before this studio's own primary AND not `reserved` for another
repo — a genuinely unclaimed spare — fell into a blind spot neither pass
ever looked at, so the old code jumped straight to borrowing another
repo's own primary while a plain free spare sat unused.

**Fix**: new `accounts.ts` helper `firstFreeAccount(accounts, reserved,
limits, now)` — a plain, list-order, position-0-inclusive scan for the first
account that is neither reserved nor limited. `failover.ts`'s exhaustion
path now tries it as tier 2, between the first pass (own chain) and the
third pass (borrow a reserved primary): `candidate ?? outOfScopeSpare ??
borrowed`. `isBorrow` narrows to "landed via the THIRD pass specifically"
(drives the outcome kind and `borrowedFromRepo`, which only a genuine
reserved-primary borrow carries).

This fix's own RED test requires `StudioStatus.borrowedAccount` to survive a
tier-2 landing (not just a third-pass borrow) — so the write-condition half
of finding 4 (below) was pulled forward into this same fix commit, ahead of
finding 4's own anchor-widening half. Documented as a deliberate reallocation
in the finding-3 fix commit message itself.

**RED test**: `test/studio.account-failover.test.ts`, new describe block
`"tier 2 — an unclaimed spare before this studio's own primary"` — the exact
fixture the review comment describes: `[repo-B's primary (reserved), a free
plain spare, this studio's own primary (limited), the rest of its own chain
(limited)]` → the studio lands on the spare, never on repo-B's primary. A
second test (regression pin, not itself RED): the spare ALSO limited → falls
through to borrowing the reserved primary, unchanged. Two existing Stage-B
fixtures ("every account... limited" / "lowest-burn-first") needed a
one-line update (marking account 1 limited too) once the blind spot closed —
account 1 in `four`/`five` was always an unclaimed spare those fixtures never
accounted for.

### Finding 4 — a borrowed pre-primary account widened later search and lost the borrow flag

Two parts, both rooted in the SAME `#273 r2` widening
(`Math.min(start, currentIdx)`, meant to let a stale legacy `current` from
before the primary step FORWARD into scope):

1. **Scope anchor.** Once tier 2 (finding 3) can land a studio on an account
   positioned before its own primary, a LATER tick with that account as
   `current` re-triggers the widening — letting the ordinary first pass wrap
   onto ANOTHER pre-primary account too, violating #271's own "an account
   before a repo's mapped primary is never that repo's to use". Fixed by
   gating the widening on `existing.borrowedAccount == null`
   (`borrowedActive`): the #273 r2 stale-legacy case never sets that field
   (it predates Stage B), so every #273 r2 test's own anchor is provably
   unaffected — confirmed by running them, not assumed. When the studio's
   `current` then falls outside the now-anchored `scopedAccounts`, the first
   pass falls back to `firstFreeAccount(scopedAccounts, ...)` instead of
   `nextClaudeAccount`: there is no position to step FORWARD from, and
   `nextClaudeAccount`'s own `null`-current convention would wrongly skip
   position 0 (it treats position 0 as "already there") rather than treat it
   as a genuine candidate.
2. **Write condition.** Landed as part of finding 3's own fix commit, ahead
   of this one — see that finding's write-up above for why. Kept here as the
   second reasoning trail: generalized from `isBorrow` (true only for the
   third, reserved-primary pass) to `deps.primary != null && next.name !==
   deps.primary` — ANY switch landing away from the studio's own primary
   keeps `borrowedAccount` set, cleared only by a genuine return to it.
   `borrowedFromRepo` stays keyed on the narrower `isBorrow`: an unclaimed
   spare (or a plain own-chain landing) was never "borrowed FROM" a repo.
   The two conditions are deliberately INDEPENDENT — `isBorrow` still decides
   wording (`borrowedMessage` vs `switchedMessage`: "borrowed repo B's
   primary" reads differently from "switched to a spare"), while the STATE
   write no longer keys on it alone. Conflating them would have meant either
   naming a tier-2 landing a "borrow" in the notify (wrong — nobody's account
   was actually borrowed) or losing hand-back tracking for it (the original
   bug) — keeping them separate resolves both.

**Why the anchor change is safe for #273 r2**: that fixture's own `current`
is `existing.claudeAccount` (auto-failover OFF, so `current` actually
resolves to `deps.primary` itself per the `current` derivation a few lines
above — `existing.claudeAccount` is only consulted when `deps.autoFailover`
is true) — `borrowedAccount` was never a field #273 r2 predates Stage B, so
it is never set in that fixture, and `borrowedActive` is always false there.
The widening formula is byte-identical to before in that branch.

**Why the write-condition change is safe for the message-wording code**:
`borrowedMessage`/`switchedMessage`'s own call sites (`isBorrow ? ... : ...`)
were left untouched — only the `StudioStatus` write's own spread condition
changed. The two were verified independently: the message-content assertions
in every Stage-B test (checking `h.notices[0]` substrings) still pass
unchanged, proving wording never drifted, while the new `borrowedAccount`
assertions prove the state field now tracks correctly.

**RED test**: `test/studio.account-failover.test.ts`, new describe block
`"scope stays anchored while actively borrowed"` — the anchor-discriminating
fixture `[X (free spare, before the borrowed account), CUR (borrowed,
now limited), Y (free spare, between CUR and primary — exactly where the old
widening bug would expose), primary (limited), a reserved other-repo
primary]`: the OLD widened first pass would step forward from `CUR` and find
Y first (reachable, never X); the FIXED code finds X via tier 2's own
list-order scan (X is never in scope for the first pass either way). RED:
old code lands on Y. A sibling regression-pin test (already green after
finding 3's own commit, not itself RED here) reproduces the "moves to yet
another account" ping described in the review, confirming `borrowedAccount`
stays set via the write-condition half.

### Finding 5 — mutant gaps (no production fix; test-only commits)

**5a** (`recycle --account mapped skips rescue` stays green under a
source-skip mutant): the existing Stage-A tests only grep source order. New
test in `test/studio.session.test.ts` composes the same two primitives
`StudioDO.recycle()` itself composes — the real `clearForceMappedAccount`,
then the real `recycleWithSync` — and reuses the exact exec-order assertion
the "sync before rescue-push before destroy" test already uses. Verified
meaningful with a manual mutation (forcing `recycleWithSync`'s own `alive`
to `false` whenever `cfg.forceMappedAccount` is set, simulating a mutant
that skips the pre-destroy phase): this was the only failure; reverted
before the real commit.

**5b** (`hand-back ignores primary still limited` stays green): new
ping-pong test in `test/studio.account-failover.test.ts` — stays borrowed on
a tick where the primary is STILL limited, then fires on the very next tick
once it frees up. Verified meaningful with a manual mutation
(`accountIsFree(ownPrimary, ...)` → `true` in the hand-back guard): this was
the only failure; reverted before the real commit.

### Minor — a missing mapped secret refused after already wiping the record

`recycle()` called `clearForceMappedAccount` unconditionally before
`launchAccountOrRefuse` ever discovered the mapped slot's secret was
missing. No container was ever touched (correct — the refusal still
happened), but the row lost `claudeAccount`/the moved-audit trail/the borrow
flags on what was, underneath, a no-op.

**Fix**: new `do.ts` export `refuseUnlessMappedAccountLaunchable(env, id,
storage, recordStudioFn)`, called from `recycle()` BEFORE
`clearForceMappedAccount`. Resolves `launchAccount(env, repo, null)` —
`null` forces the MAPPED slot's own resolution, bypassing both
`FLEET_AUTO_FAILOVER`'s recorded-account preference and any recorded
account, which is exactly what `--account mapped` needs to check — and on
refusal writes the same `degraded`/error shape `launchAccountOrRefuse`
already writes (so `fleet ls` shows why) plus throws the same
`LaunchRefusedError`, without ever calling the clear.

**RED test**: `test/studio.account-launched.test.ts`, new describe block —
a missing mapped secret: `refuseUnlessMappedAccountLaunchable` throws, and
`claudeAccount`/the moved-audit trail/the borrow flags are byte-identical to
before the call. A second test: a launchable mapped slot is a true no-op
(nothing written, nothing thrown). A third test (source-order pin) confirms
`recycle()` calls it before `clearForceMappedAccount`.

### Commits (in order; test before fix, per finding, pushed after each)

```
f49242d test(fleet): RED — hand-back must not fire mid-turn or under a fresh op-lock (finding 1)
829de3b fix(fleet): hand-back skips mid-turn panes and fresh op-locks (finding 1)
6ba9aa8 test(fleet): RED — clearForceMappedAccount/#273 r2 clear leave borrowedAccount set (finding 2)
aafc2d2 fix(fleet): clear borrowedAccount/borrowedFromRepo alongside claudeAccount (finding 2)
0d6b895 test(fleet): RED — an unclaimed spare before primary loses to a reserved primary (finding 3)
3a40e51 fix(fleet): scan unclaimed spares before borrowing a reserved primary (finding 3 + finding-4 write-condition)
1221736 test(fleet): RED — the #273 r2 widening lets the first pass wrap onto an account before primary while borrowed (finding 4)
cfd0fa1 fix(fleet): keep the search anchored at `start` while actively borrowed (finding 4 anchor)
7917d3a test(fleet): ping-pong pin — hand-back genuinely gates on the primary's freeness (finding 5b, test-only)
21c56f5 test(fleet): behavioral pin — recycle --account mapped never skips the rescue phase (finding 5a, test-only)
c84afb8 test(fleet): RED — a missing mapped secret refuses AFTER wiping the record (Minor finding)
b84636f fix(fleet): refuse before clearing when the mapped slot's secret is missing (Minor finding)
```

### Verification

Per-finding: each RED test run in isolation against its own target test file
before its fix landed (confirmed failing for the stated reason, never a
typo/syntax error), then GREEN after. Full per-file re-runs after every
fix (`test/studio.account-failover.test.ts`, `test/studio.account-launched.test.ts`,
`test/studio.session.test.ts`) confirmed zero regressions throughout,
including the golden #103/#117 test, every `#271`/`#273 r2` test, and every
pre-existing Stage B borrow/hand-back test. Final full-file counts and the
three gate commands' results are in the dispatch's own report back to the
lead (not duplicated here to avoid the doc drifting from the actual
terminal output).

## Fix-first round, review 2 (2nd, independent review of PR #135, 2026-09-30)

A second fresh-context review caught a real production regression in this
round's own finding-4 write-condition change, above: the generalized write
condition gated `borrowedAccount` on `deps.primary != null`, reasoning (per
that finding's own doc comment) that "every caller that predates #271 keeps
the plain pre-#271 shape" for an absent primary. That reasoning holds inside
this file's own `harness()` — `primary` defaults to `undefined` there — but
NOT in real deployment: do.ts's `failoverDeps()` always wires `primary:
this.primaryAccount()`, and `primaryAccount()` -> accounts.ts's
`launchAccount` never returns null in the no-map case, it falls through to
`accounts[0]`. So `deps.primary` is a non-null string for every studio with
at least one `CLAUDE_CODE_OAUTH_TOKEN*` secret set, mapped repo or not.

Concretely: a plain multi-account fleet that never configured
`CLAUDE_ACCOUNT_BY_REPO` (the original, pre-#271 #53 feature) fails its lead
over from account 1 to account 2 — an entirely ordinary switch — and the old
write condition wrongly recorded it as a "borrow" (`borrowedAccount:
"CLAUDE_CODE_OAUTH_TOKEN_2"`). The next tick to find the pane idle would then
run hand-back: kill+relaunch the pane to force it back to account 1,
uninvited, for a fleet that never opted into Stage B semantics at all.

**Fix**: a new `FailoverDeps.primaryIsMapped: boolean` (optional, default
`false` — the safe "never opted into Stage B" shape) — true only when THIS
studio's own repo is a genuine KEY in the parsed `CLAUDE_ACCOUNT_BY_REPO` map
(`parseAccountMap(env.CLAUDE_ACCOUNT_BY_REPO)[repo] !== undefined`), computed
in do.ts's new `primaryIsMapped()` private method and wired into
`failoverDeps()` alongside `primary`. The write condition in `failover.ts`
now gates on `deps.primaryIsMapped && next.name !== deps.primary`, replacing
`deps.primary != null && next.name !== deps.primary` — `deps.primary` itself
is unchanged and still used for the name comparison; only the "is this a
REAL mapped primary" gate changed. `types.ts`'s `StudioStatus.borrowedAccount`
doc comment was also updated: it now states plainly that the field is never
set at all for a studio whose repo has no `CLAUDE_ACCOUNT_BY_REPO` entry.

**RED test** (`test/studio.account-failover.test.ts`, new describe block
"review round 3: borrowedAccount must stay null for a repo with no
CLAUDE_ACCOUNT_BY_REPO entry"): mirrors the existing "(a) a pane showing the
rate-limit modal triggers exactly ONE switch" fixture shape (two plain
accounts, no map), but passes `primary: "CLAUDE_CODE_OAUTH_TOKEN"` to
reproduce production's real no-map wiring (`primaryAccount()`'s fallback),
with `primaryIsMapped` deliberately omitted (the harness's own safe default).
First test: after the ordinary switch, `borrowedAccount`/`borrowedFromRepo`
are `null`. Second test: continuing from that state, a later idle-pane tick
never fires hand-back (`out.kind` is not `"returned"`, exactly one
`respawn-pane` exec total — the original switch's, never a second one).
Confirmed RED against the unfixed code first (`borrowedAccount` read back as
`"CLAUDE_CODE_OAUTH_TOKEN_2"` in both), then GREEN after the fix.

Every existing genuinely-`#271`-mapped Stage B test (the whole "borrow
another repo's primary (issue #131, Stage B)" describe block, including its
nested "tier 2" and "scope stays anchored while actively borrowed" blocks —
13 `harness()` calls in total) now passes `primaryIsMapped: true` explicitly,
alongside the `primary` it already passed, so they keep testing the
genuinely-mapped case they were meant to. The golden `#103`/`#117` regression
test and the other plain `#271`-labelled-primary tests outside that block
(which never assert on `borrowedAccount`) were left unmodified — their
assertions do not depend on this gate either way, confirmed by running them
unchanged.
