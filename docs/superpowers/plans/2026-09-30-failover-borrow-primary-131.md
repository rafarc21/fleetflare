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
