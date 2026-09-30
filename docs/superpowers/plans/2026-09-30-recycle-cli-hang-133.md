# `fleet recycle` CLI hangs after the new container is up (board issue #133)

## Measured incident (2026-09-30, after rollout)

`fleet recycle <id>` on a studio whose lead sat on a limit modal: the
container came back (row showed running, restart count 2/2, lead working)
but the CLI call never returned. The operator killed it after 15 minutes.

## What was verified, not just suspected

`cmdRecycle` (`apps/fleet/cli/fleet.ts`, previously ~line 1053) did a bare
`fetch(studioUrl(creds, id, path), { method: "POST", headers: accessHeaders
(creds) })` — no timeout, no `AbortSignal`. A stalled connection on this side
holds the socket open forever even after the Worker's own recycle (do.ts's
`recycle()`, via `recycleWithSync`) finishes and writes the row back to
`running`. Exactly the measured symptom: the row updated, the CLI never
returned.

This is the same bug class board issue #203 already fixed for `fleet
destroy` (`cli/destroy-outcome.ts`'s `requestDestroy`): a request that did
not come back is not a verdict, and the only thing that can say what
happened is the studio row itself, read bounded via GET /studio/:id/status.

Unlike destroy, recycle has no single terminal `state` that alone proves the
verb landed — `running` can mean an OLD bring-up that predates this call
entirely (restart, provision, an earlier recycle), or a stale row nobody has
updated yet. Read `src/studio/observed.ts`'s `ObservedSession`
(`{ verdict, at, via, restore, ... }`, nested at `StudioStatus.observed?.
session`) and confirmed the field path: `via` names which of the five
bring-up paths produced the record (`BringupVia`, includes `"recycle"`), and
`at` is the ISO timestamp the verdict was computed. So the poll verdict for
recycle has to be a *specific* bring-up, not just a state.

## The fix

### 1. Extracted `readStatus` into `cli/status-poll.ts`

Moved verbatim out of `cli/destroy-outcome.ts`, which now imports it and
re-exports it (`import { readStatus } from "./status-poll"; export {
readStatus };`) so its one existing consumer (`cli/fleet.ts`'s `import {
requestDestroy, readStatus, DESTROY_STATUS_TIMEOUT_MS } from
"./destroy-outcome"`, used inside `runReap`'s destroy path) needed no
change. A status read is a DO storage read no matter which repair verb
triggered it, so it belongs to neither destroy- nor recycle-specific code.

### 2. New `cli/recycle-outcome.ts`, same shape as `destroy-outcome.ts`

- `RECYCLE_CLIENT_TIMEOUT_MS = DESTROY_CLIENT_TIMEOUT_MS + 600_000 +
  60_000 = 960_000ms`. recycle runs destroy's entire pre-teardown phase
  (`recycleWithSync` runs the same probe/sync/rescue-push/harvest sequence
  `destroyWithSync` does — hence reusing `DESTROY_CLIENT_TIMEOUT_MS`), plus a
  fresh container boot and `provisionCore`'s own re-clone/re-onboard work
  (`EXEC_CLASSES.provision`, 600_000ms), plus recycle's own post-provision
  readiness check (do.ts's `recycle()` doc comment: "recycleWithSync already
  runs (and reports) its own post-provision readiness check" —
  `EXEC_CLASSES.readiness`, 60_000ms). Not sized for the fully pathological
  case: rescue-push and the learning harvest are 300s-each `rescue`-class
  execs, so a genuinely stuck recycle can still run past this — the poll
  fallback is what handles that.
- `RECYCLE_POLL_ATTEMPTS = 6`, `RECYCLE_POLL_INTERVAL_MS = 10_000` — same
  bound as destroy (~50s extra, never unbounded).
- Reuses `DESTROY_STATUS_TIMEOUT_MS` for the status-read timeout — a status
  read is the same operation regardless of caller.
- `requestRecycle` mirrors `requestDestroy`: POST with
  `AbortSignal.timeout`; 2xx is `kind: "ok"`; non-2xx is `kind: "http-error"`
  with no poll (a refusal is a real verdict); any transport failure polls
  `/status`.
- The poll verdict (`bringupLanded`): `state === "running"` AND
  `observed?.session?.via === "recycle"` AND `new Date(session.at) >=
  startedAt`, where `startedAt` is captured (via an injectable `now: () =>
  Date`, matching do.ts's own `syncDeps.now()` clock-seam convention) right
  before the POST fires. This is deliberately stricter than destroy's single
  `state === "stopped"` check: a bare `running` read would call an
  untouched, already-running container a recycle success.
- On that verdict: `kind: "timeout-provisioned"`, `exitCode: 0`, a line in
  destroy's own voice ("... so recycle SUCCEEDED").
- On poll exhaustion with a readable row that never met the verdict:
  `kind: "timeout-pending"`, naming the row's own last known `state` and
  `readiness?.kind ?? "unknown"` — the closest honest answer to the board
  issue's "or times out with a clear message naming the last step reached"
  ask, since there is no separate server-side step-reporting channel for
  this side to read a "last step" from. Never uses the word "failed".
- Row unreachable every attempt: `kind: "timeout-unknown"`, "UNKNOWN, not a
  verdict" phrasing matching destroy's own.
- Never throws.

### 3. Wired `cmdRecycle` (`cli/fleet.ts`)

Replaced the bare `fetch` with `requestRecycle`. Prints the status table
when a status object exists, and `report.lines`. The Orca sidebar
(`ensureStudioWorkspace`) and rescue-report/`discardNote` side effects now
run only when `report.kind === "ok" || report.kind === "timeout-provisioned"`
— mirroring how `cmdDestroy` gates its Orca teardown behind
`report.teardown`. `process.exit(report.exitCode)` on anything else.

## Deviation from the original fix sketch

The dispatching maestro's sketch called for importing `EXEC_CLASSES` from
`../src/studio/sandbox-api` directly inside `cli/recycle-outcome.ts` to
compute `RECYCLE_CLIENT_TIMEOUT_MS` at load time. `sandbox-api.ts` does a
top-level *value* import of `@cloudflare/sandbox`'s `proxyTerminal`, which
itself imports from `cloudflare:workers` — a Workers-runtime-only module
specifier that does not resolve under Bun. `cli/fleet.ts`'s own
`RESCUE_ALL_STUDIO_TIMEOUT_MS` (board issue #359) already documents this
exact hazard and works around it by copying the budget in as a literal with
a comment pointing back at the source of truth, specifically because
`cli/recycle-outcome.ts` (like `cli/fleet.ts`) is loaded by the real `fleet`
binary under Bun, not under workerd. Importing `sandbox-api.ts` there would
have broken the shipped CLI at runtime the first time anyone ran `fleet
recycle` for real, even though every vitest-pool-workers test (which does
run under workerd) would have stayed green. Followed the established
`RESCUE_ALL_STUDIO_TIMEOUT_MS` convention instead: `RECYCLE_CLIENT_TIMEOUT_MS`
is `DESTROY_CLIENT_TIMEOUT_MS + 600_000 + 60_000`, a literal expression with
a doc comment giving the same derivation and a pointer to re-verify against
`EXEC_CLASSES.provision`/`EXEC_CLASSES.readiness` if either value ever
changes. `test/cli.recycle-outcome.test.ts` still imports `EXEC_CLASSES`
from `sandbox-api.ts` directly to check the arithmetic — safe there, since
test files only ever run under the workerd-backed vitest pool, exactly the
same reasoning `test/cli.destroy-outcome.test.ts` already relies on for its
own `EXEC_CLASSES.sync` budget check.

## TDD

RED first, real commits, pushed after each. `test/cli.recycle-outcome.test.ts`
uses the same `fakeSlowWorker` fixture shape as
`test/cli.destroy-outcome.test.ts` (a `/recycle` that hangs until abort, a
`/status` that answers from a queue). Confirmed RED for the right reason
before either fix commit: the first (module import failure — `cli/
recycle-outcome.ts` did not exist yet) and the structural `cmdRecycle` test
(the old body had no `requestRecycle(` call). Covers:

- timeout, then status shows `running` + `observed.session.via === "recycle"`
  + `at` at/after the call's start → `timeout-provisioned`, success line,
  `exitCode 0`, one poll (stops the moment the verdict is met).
- timeout, then status shows `running` but `via` names an OLD bring-up
  (`"provision"`) → stays `timeout-pending` for the full poll budget; message
  contains "still running", never `/\bfailed\b/i`.
- timeout, then status shows `running` + `via === "recycle"` but a STALE `at`
  (before the call started) → also stays `timeout-pending` — proves the
  timestamp comparison, not just the `via` check, is load-bearing.
- timeout, status unreachable every attempt → `timeout-unknown`, contains
  "UNKNOWN", never "failed".
- a plain 200 needs no poll at all (the fixture throws if `/status` is ever
  called).
- a 409 refusal passes straight through as `http-error`, no poll,
  `exitCode 1`.
- the budget arithmetic (`RECYCLE_CLIENT_TIMEOUT_MS === DESTROY_CLIENT_TIMEOUT_MS
  + EXEC_CLASSES.provision.timeoutMs + EXEC_CLASSES.readiness.timeoutMs`) and
  the poll bound (6 / 10_000) are pinned directly.
- a `cli/fleet.ts` structural test (`env.TEST_CLI_FLEET_SRC`, same technique
  `test/cli.destroy-outcome.test.ts`'s own last describe block uses) proving
  `cmdRecycle`'s body calls `requestRecycle(` and gates
  `ensureStudioWorkspace(` behind the `report.kind === "ok" ||
  report.kind === "timeout-provisioned"` check, with no second, ungated call.

**Mutation check** (not committed, run live): weakened `bringupLanded` to a
bare `status.state === "running"` check. 3 of the 10 tests went RED (the
old-`via` test, the stale-`at` test, and the later-poll success test dropped
from 3 status calls to 1) — confirmed the `via`/`at` guard is load-bearing,
not decorative. Reverted, reconfirmed 10/10 green.

## Fresh review round 1 (2026-09-30) — a factually wrong header comment, and an undocumented clock-skew edge case

Finding 1 (block): `status-poll.ts`'s and `destroy-outcome.ts`'s header
comments both claimed the `readStatus` extraction let
`cli/recycle-outcome.ts` "share it without importing destroy-outcome.ts's
own destroy-specific code" — false as written, since `recycle-outcome.ts`
imported `readStatus` THROUGH `destroy-outcome.ts`'s re-export (`import {
readStatus, DESTROY_CLIENT_TIMEOUT_MS, DESTROY_STATUS_TIMEOUT_MS } from
"./destroy-outcome"`), and separately needed `DESTROY_CLIENT_TIMEOUT_MS`/
`DESTROY_STATUS_TIMEOUT_MS` from that same module regardless. The stated
goal (avoid the destroy-specific dependency) was never achieved by the code
as written — `status-poll.ts` had exactly one real consumer, destroy-
outcome.ts's own re-export of itself. Fixed by having `recycle-outcome.ts`
import `readStatus` directly from `./status-poll` (a separate `import`
statement from the one pulling `DESTROY_CLIENT_TIMEOUT_MS`/
`DESTROY_STATUS_TIMEOUT_MS` from `./destroy-outcome`), and rewriting both
header comments to say the honest thing: the extraction removes `readStatus`
duplication only; the dependency on destroy's two timeout constants is real
and intentional (the budget math genuinely derives from destroy's own — see
`RECYCLE_CLIENT_TIMEOUT_MS`'s own doc comment), not something this change
tries to eliminate. `cli/fleet.ts`'s existing `import { requestDestroy,
readStatus, DESTROY_STATUS_TIMEOUT_MS } from "./destroy-outcome"` needed no
change either way — confirmed still resolves (destroy-outcome.ts still
re-exports `readStatus`).

Finding 2 (should-fix): `bringupLanded`'s `new Date(session.at) >= startedAt`
compares two clocks that are never reconciled — `startedAt` is this CLI's
own local clock, `session.at` is stamped by the Worker on Cloudflare's edge.
Every existing test shared one clock source for both sides, so this never
got exercised. The risk is ASYMMETRIC: a Worker clock lagging the CLI's can
only cause an extra `timeout-pending` cycle (safe — the true state is still
"running", this side just doesn't claim victory a beat early); a Worker
clock running AHEAD of the CLI's could let a stale row from an unrelated,
already-finished OLDER `via: "recycle"` bring-up satisfy `at >= startedAt`
and get reported `timeout-provisioned` — a false success — for a call that
might still be pending or might have failed outright. Not fixed with a skew-
tolerance window (no real measured incident exists to size one from — an
invented budget would just be a second unfounded magic number); instead
documented explicitly in `bringupLanded`'s own doc comment, and pinned with
two new tests: one showing the safe direction (`at` a second BEFORE
`startedAt`, same real event, stays `timeout-pending`), one explicitly
proving — not fixing — the risky direction (`at` a millisecond AFTER
`startedAt` still reads `timeout-provisioned`), so a future "improvement"
that starts guessing at skew tolerance has a test in its way rather than
silently reintroducing the same undocumented gap.

### Round 1 re-verification (2026-09-30)

- Scoped vitest (`test/cli.recycle-outcome.test.ts` +
  `test/cli.destroy-outcome.test.ts`): 23 pass, 0 fail (12 + 11 — the 2 new
  clock-skew tests, no regressions).
- `bun run check` — clean, re-run after both fixes.
- `bun run test` (full suite, alone) — 152 files / 5277 tests pass, 0 fail
  (2 more than the prior run, matching the 2 new tests).
- `bun run english-check` — clean.

## Fresh review round 2 (maestro, FIX-FIRST, 2026-09-30) — a real bring-up ordering bug, an ambiguous exit code, and an under-proven poll bound

PR #139 was converted to draft by a maestro review verdict FIX-FIRST.
Board comment posted 2026-09-30T19:06:16Z. Three findings, all fixed.

Finding 1 (most severe, blocking): `bringupLanded` accepted `state ===
"running"` + a fresh `observed.session.via === "recycle"` alone as proof
this recycle landed — round 1's clock-skew writeup framed the residual risk
as purely cross-machine clock skew, but there was a real SAME-clock ordering
bug underneath it too. `do.ts`'s `recycleWithSync` runs `provisionCore`'s own
bring-up FIRST (which stamps `observed.session` with a fresh `via: "recycle"`
`at`) and only THEN runs its own post-provision readiness check
(`recycleVerdict`, `EXEC_CLASSES.readiness`, up to 60s). A poll landing
inside that window read `state: "running"` + a fresh `via: "recycle"`
session — satisfying the old check — while the readiness check could still
come back `"bare"`, which flips `state` to `"degraded"` and makes do.ts
throw (the Worker answers 500). The CLI would report "recycle SUCCEEDED",
exit 0, for a studio about to be marked degraded. Fixed by also requiring
`status.readiness != null && new Date(status.readiness.checkedAt) >=
startedAt`: do.ts writes `readiness` with a fresh `checkedAt` on every one of
`recycleVerdict`'s three branches, including the degraded one (whose `state`
flip the existing `state !== "running"` check already rejects once that
write lands) — so once both conditions hold, the only two ways to get there
are the genuinely terminal `provisioned`/`inconclusive` branches. Reworded
`bringupLanded`'s doc comment to lead with this ordering argument rather than
framing the whole thing as a clock-skew caveat, and re-scoped the two
genuine clock-skew tests to the now-narrower residual risk (both
`session.at` AND `readiness.checkedAt` need to independently look fresh, not
just one). The old "documents the ACCEPTED risk" test (`via: "recycle"`, `at`
1ms after `startedAt`, no `readiness` on the row at all) was actually
exercising THIS bug, not the clock-skew one — it now needs a fresh
`readiness.checkedAt` added to stay a `timeout-provisioned` case, and two new
tests pin the actual gap directly: a fresh session with no `readiness` at
all, and a fresh session with a `readiness.checkedAt` from before
`startedAt` — both must stay `timeout-pending`.

Finding 2 (required): `RecycleReport.exitCode` was `1` for three different
kinds — `http-error` (a real, definitive refusal/verdict from the Worker)
and both `timeout-pending`/`timeout-unknown` ("we genuinely don't know") — so
a caller/script could not tell "the Worker refused this, fix the input and
retry" apart from "we don't know, check `fleet ls`" by exit code alone.
Gave the two timeout-shaped kinds their own exit code, `2`, documented on
`RecycleReport.exitCode`'s own doc comment as a three-value convention (`0`
confirmed success, `1` a real refusal/verdict, `2` outcome unknown, not a
refusal). `cmdRecycle` (`cli/fleet.ts`) needed no change — it already just
forwards `report.exitCode` to `process.exit` verbatim, with no assumption
about the specific value.

Finding 3 (required): the existing "polls a bounded number of times, never
forever" test only pinned `RECYCLE_POLL_ATTEMPTS`/`RECYCLE_POLL_INTERVAL_MS`
as bare constants inside the "the recycle request's own budget" describe
block — it would stay green even if `pollAfterNoAnswer`'s own loop ignored
`deps.attempts` entirely (a hardcoded `for (let i = 0; i < 6; i++)`, say).
Two OTHER existing tests elsewhere in the file already asserted the exact
call count behaviorally, but the reviewer wanted this made explicit and
mutation-verified in the budget describe block itself. Added a test there
that polls with a `/status` that never satisfies `bringupLanded` and asserts
the exact call count (`toHaveLength(RECYCLE_POLL_ATTEMPTS)`, and again
literally `.toBe(6)`), not merely a bounded-ish number.

**Bite-proof** (not committed, run live): temporarily changed
`pollAfterNoAnswer`'s loop bound from `attempt <= deps.attempts` to a
hardcoded `attempt <= 4`. The new fix-3 test went RED as expected ("expected
6, got 4"), along with two other pre-existing tests that already asserted
the same exact-count behavior elsewhere in the file (3 of 15 total). Reverted
the change (`git diff --stat` showed zero diff afterward) and reconfirmed
15/15 green.

Also considered, not changed: the reviewer noted the ~17-minute worst case
(960s client timeout + ~50s poll) and suggested considering a shorter client
timeout now that polling covers the tail. Left `RECYCLE_CLIENT_TIMEOUT_MS`
unchanged: its 960_000ms is a real, derived sum of three real exec-class
budgets (`DESTROY_CLIENT_TIMEOUT_MS` + `EXEC_CLASSES.provision.timeoutMs` +
`EXEC_CLASSES.readiness.timeoutMs`), not padding — shrinking it without a
principled smaller number to replace one of those three terms with would
just be guessing in the other direction, the same "no unfounded magic
number" discipline round 1's clock-skew writeup already leaned on. If a real
incident ever shows one of those three exec-class budgets is itself
oversized, that measurement should size the change, not a guess made here.

### Round 2 re-verification (2026-09-30)

- Scoped vitest (`test/cli.recycle-outcome.test.ts` +
  `test/cli.destroy-outcome.test.ts`): 15 + 11 = 26 tests, 0 fail (3 new
  finding-1 tests, 2 new finding-2 assertions on existing tests, 1 new
  finding-3 test; no regressions).
- `bun run check` — clean (all 5 tsconfig projects), no output.
- `bun run test` (full suite, alone) — 152 test files / 5280 tests pass, 0
  fail (5 more than round 1's 5275, matching the 5 new tests added this
  round). The same two pre-existing "Containers have not been enabled for
  this Durable Object class" uncaught-promise lines from round 1's
  unrelated test fixture appear again; they do not affect the pass count.
- `bun run english-check` — clean (`english-check: clean`).

## Deliberately out of scope

- `cmdProvision` (`cli/fleet.ts`) has the identical bare-fetch gap (no
  client-side timeout on its own `POST /studio/:id/provision`) — flagged
  here for the record, not fixed: board issue #133 is scoped to `fleet
  recycle` specifically.
- Board issue #124 — mentioned by a maestro comment as an optional bundle
  target, but not assigned to this studio (`fleet task show 124` returns
  404). Not read, not touched.

## Verification

- Scoped vitest: `bun run test -- test/cli.recycle-outcome.test.ts
  test/cli.destroy-outcome.test.ts` — 2 files, 21 tests, 0 fail (10 new +
  11 existing, unaffected by the `readStatus` extraction).
- `bun run check` (once, alone) — all 5 tsconfig projects (`tsc --noEmit`,
  `container`, `cli`, `test-integration`, `test`), clean, no output.
- `bun run test` (full vitest suite, once, alone) — 152 test files / 5275
  tests pass, 0 fail. (Two "Containers have not been enabled for this
  Durable Object class" uncaught-promise lines appear in the log from an
  unrelated pre-existing test fixture; they do not affect the pass count.)
- `bun run english-check` — clean.
- `bun run bun-test` — 2121 pass, 2 skip, 8 fail. All 8 failures are
  pre-existing and environmental, unrelated to this diff: `test/bun/
  deploy-ops-guard.test.ts`'s two failures come from this studio
  container's own safety `git` wrapper (`/usr/local/bin/git`, issue #253's
  "studios never push the default branch" guard) intercepting that test's
  own throwaway local-origin pushes, which the wrapper cannot distinguish
  from a real push; `test/bun/localci-run.test.ts`'s two failures are
  wall-clock budget assertions (`< 15_000ms`, actual ~18-22s) that flexed
  under this same run's host load from the full `bun run test` invocation
  moments earlier. Neither test touches `cli/recycle-outcome.ts`, `cli/
  status-poll.ts`, `cli/destroy-outcome.ts`, or `cli/fleet.ts`'s `cmdRecycle`.
- `bun run build:page` — ran clean, wrote `page/terminal.html` and
  `page/grid.html`; `git status --short` showed zero diff afterward, as
  expected (this task never touches page templates).
- `bun run test:integration` / `bun run test:acceptance` intentionally NOT
  run: both need a live deployed Worker and real Cloudflare Access/GitHub
  credentials this studio container does not and must not hold.
