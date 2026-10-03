# parked studio never auto-resumes when an account frees (board issue #210)

## The bug, as measured

2026-10-03: a studio failed over, then every Claude account got fleet-wide
recorded as rate-limited (issue #102's `AccountLimits`/`accountIsFree`,
`src/studio/accounts.ts`), so the lead parked at an empty prompt with no
modal — the "inline" exhaustion kind (`StudioStatus.exhaustionKind`).
Headroom returned on one account slot (a usage-credit top-up, not a
scheduled reset). The studio sat idle ~7 hours, billing a container the
whole time, until an operator manually typed "continue".

## Why the two existing recovery mechanisms both miss this

Neither existing degraded-studio recovery mechanism ever checks fleet-wide
account freedom at all:

1. **`evaluateDegradedRecovery`/`healDegradedRowAndWake`** (`failover.ts`,
   run from both `runAccountFailover`'s `working` branch and do.ts's 30s
   ship-tick path) — PURELY pane-visual. It only heals once the pane's own
   footer already looks like a normal idle claude prompt with no limit line
   printed, and fires its own wake only for `exhaustionKind === "inline"`
   rows once the pane already looks clear. It never asks "is any account
   free" — it is reacting to the PANE, not the fleet-wide limit state. Worse,
   for an inline block with NO parseable reset ("You're out of usage
   credits.", no "resets ..." suffix) the pane can sit on the SAME frozen
   screen forever: nothing ever retypes anything, so the pane never visually
   changes, so this mechanism never gets a chance to run at all.

2. **`autoContinueAttempt`/`autoContinueDue`** (`failover.ts`, run from
   `runAccountFailover`'s already-degraded branch) — fires an active wake
   (dismiss-modal + `runGatedWake` + `AUTO_CONTINUE_PROMPT`) but ONLY for
   `exhaustionKind !== "inline"` (select-style modal rows), on a blind hourly
   timer (`AUTO_CONTINUE_RETRY_MS`) or a known printed reset time
   (`autoContinueAt`). It never checks `accountIsFree` either — it blindly
   retries on a clock regardless of whether anything actually freed, wasting
   up to 59 minutes out of every 60 even when an account was free the whole
   time.

So: inline exhaustion (this bug's exact shape) only gets an active wake if
the pane itself already looks clear; select-style exhaustion gets a blind
hourly retry. Nothing proactively asks "has an account freed up fleet-wide"
and wakes based on THAT, regardless of exhaustionKind or what the pane
currently shows. This is the gap ask 2 below closes with a NEW, third
mechanism.

## The three fixes

### Ask 1 — record `parkedAt` when a studio genuinely parks

`StudioStatus.parkedAt?: string | null` (`src/studio/types.ts`) — an ISO
instant. The REASON is already `exhaustionKind` (`"dead" | "inline" |
"select" | null`, #109/#158/#170) — no new reason field, no duplicated
state.

Stamped in `runAccountFailover`'s fresh-degrade write (`failover.ts`, the
`const degraded: StudioStatus = {...}` block), ONLY when `parkedOn === null`
— the genuine "no free account at all" shape, never the separate
`parkedOn !== null` "#271 operator chose not to move" case (deliberate
operator choice, out of scope). `existing.parkedAt ?? now` so a repeat
already-degraded tick (a message-text refresh) never resets the clock ask 3
reads from.

Cleared to `null` at the two sites that heal a parked row:
  - `healDegradedRowAndWake` — the pane-visual heal, alongside the existing
    `exhaustionKind: null` clear (the only other explicit
    `exhaustionKind: null` write in `failover.ts`/`do.ts` — grepped, there is
    only one).
  - The ordinary account-switch landing (`runAccountFailover`'s `switched`
    write) — a studio that moves off a limited account and resumes is no
    longer parked, same as a heal. Only on a LANDED switch (`!failed`); a
    failed relaunch records a DIFFERENT degradation, not this one.

### Ask 2 — periodic tick: wake the moment anything reads free

A NEW function, `anyAccountFreeToResume`, added ALONGSIDE
`autoContinueDue`/`autoContinueAttempt` — their own internals are untouched
(heavily reviewed, #109/#158/#170, one-way-door). Checks, fresh every tick:

  - **(a)** is the account THIS ROW is currently on free again right now
    (`accountIsFree`)? `nextClaudeAccount`'s own wrap (the ordinary switch
    search) starts at `current`'s NEXT position and never re-checks
    `current` itself — by design, it finds somewhere ELSE to go, not whether
    the studio's own current slot recovered. A same-account usage-credit
    top-up (this bug's own repro) falls exactly into that gap.
  - **(b)** does the SAME 3-tier selection the ordinary switch path runs
    (`nextClaudeAccount` -> `firstFreeAccount` -> `nextBorrowedAccount`) find
    ANY free account at all? Computed UNCONDITIONALLY (never gated on
    `deps.autoFailover`), so a parked-with-auto-failover-off row still gets
    the complete answer.

Gated on `existing.parkedAt` (not just `exhaustionKind`): `parkedAt` is only
ever stamped for the genuine `parkedOn === null` shape, never the `#271`
operator-choice park — confirmed against the existing "auto-failover OFF...
the next tick does not re-card or switch" test (both accounts genuinely
free, `parkedOn !== null`, no `parkedAt` ever stamped): without this half of
the gate, `anyAccountFreeToResume` would find the untouched free account and
fire a wake every tick, which that test's own `already-degraded` outcome
proves must never happen.

ALSO gated on `deps.accountLimits` being wired at all (found via mutation
while running the existing suite — see Residuals below): `accountIsFree`'s
own "account not in the map" default reads as free UNCONDITIONALLY, which is
correct for a plain wrap scanning OTHER accounts nobody has recorded
anything about, but is meaningless read as "this row's own account is free"
with a caller that tracks no fleet-wide state at all. Every caller/test
written before #102 lacks this dep; absent, the whole ask-2/ask-3 check
stays a no-op, the same "absent optional dep -> no behavior change"
convention this file already keeps everywhere else.

Also excludes `exhaustionKind === "dead"` — a dead account never auto-heals
(org access disabled, nothing clears on its own; `accountIsFree` itself
already gives `dead` unconditional priority over every other rule).

The wake itself (`freeAccountWakeAttempt`) mirrors `autoContinueAttempt`'s
shape (dismiss-then-`runGatedWake`, reusing `AUTO_CONTINUE_PROMPT` verbatim)
but is independent: fires for every `exhaustionKind` but `"dead"` (inline AND
select), skips the dismiss step for `"inline"` (no modal to Esc), and carries
no due-ness/anti-hammer clock of its own — it is gated on a REAL state
change (an account becoming free, re-checked fresh every tick), not a blind
timer, so firing it every tick an account stays free is not hammering
anything. `runGatedWake`'s own gates (stopped/no-claude/modal/survey — read
in full before writing this, `src/studio/wake.ts`) are the "never into a
modal" guard this feature leans on, same as the two existing mechanisms
already do.

Composition with `autoContinueAttempt`: tried FIRST inside the
already-degraded branch; if it fires a wake, `autoContinueAttempt`'s own
block is skipped for that same tick (one wake, not two racing into the same
pane).

### Ask 3 — stop a studio parked too long with nothing free at all

`PARKED_AUTO_STOP_HOURS = 6` (`failover.ts`). The repro idled ~7h before a
human noticed; 6h gives ask 2's own 300s-cadence check many dozens of chances
to resume the studio first if ANYTHING frees up, while bounding the
worst-case idle-billing window meaningfully below what was actually
measured.

In the same already-degraded branch, once ask 2 finds NOTHING free (neither
check above): if `now - parkedAt >= PARKED_AUTO_STOP_HOURS`, call the new
optional `deps.stopParkedStudio?: () => Promise<void>` capability. Wired in
`do.ts`'s `failoverDeps()` to `async () => { await this.destroyStudio(false,
false, true); }` — the exact "operator ran `fleet destroy --park`" verb
(`routes.ts`'s own `destroy` route, `park=true`), rescue-first included.
`destroyStudio`'s own `runDestroy` callback already disarms this studio's
ticks itself, ONLY once `this.destroy()` resolves — the same ordering
`routes.ts`'s operator-triggered call site already relies on; NOT duplicated
here (the task's own suggested wiring called `disarmStudioTicks` a second
time from `failoverDeps()` — read first, confirmed redundant, left out).

Because `parkedAt` is only ever stamped for `exhaustionKind !== undefined`
rows reached via `parkedOn === null` (ask 1's own scoping), and the whole
ask-2/ask-3 block is gated on `exhaustionKind !== "dead"`, a `"dead"` row's
auto-stop branch is unreachable by construction — confirmed by a dedicated
test (`exhaustionKind 'dead', parked well past 6h: never auto-stopped`)
rather than special-cased.

Distinguishing an auto-stop from an operator's own `fleet destroy --park`:
`destroy.ts`'s own `destroyAndRecord` write (`error: unrescued,
containerRunningSince: null, parked: park, stoppedAt`) spreads `...existing`
FIRST and only overrides those four fields plus `state` — every OTHER field
on the row, `exhaustionKind` and `parkedAt` included, survives onto the
stopped row untouched. An auto-stopped row therefore always carries a
leftover `exhaustionKind`/`parkedAt` an operator's own deliberate park
(typically run on a healthy, never-exhausted studio) would not. No new field
invented; verified by reading `destroy.ts` before concluding this, per the
task's own instruction.

Review round 1 correction: the paragraph above, as first written, implied an
operator could read this distinction off `fleet ls`. Checked against
`cli/readiness-format.ts` directly (both the table formatter and
`LsJsonRow`/the `--json` output it builds): neither renders `parkedAt` or
`exhaustionKind` anywhere today — a stopped row's `fleet ls` line looks
identical whether it got there via auto-stop or a manual `--park`. The data
is genuinely recorded and queryable (a direct D1/row read, or a future `fleet
ls` addition), just not surfaced in any CLI view yet; that is a separate,
not-yet-scoped follow-up, not something this feature already gives an
operator for free.

## Test list (`test/studio.parked-auto-resume.test.ts`)

1. Fresh genuine exhaustion (every account limited, `parkedOn === null`) ->
   `parkedAt` stamped, `exhaustionKind` recorded. Plus the `parkedOn !== null`
   counter-case: never stamped.
2. A repeat already-degraded tick never resets `parkedAt` to a later time.
3. A pane-visual heal, and an ordinary account-switch landing, both clear
   `parkedAt` to `null`.
4. Inline-exhausted row with an unreadable reset (so mechanism 1 never gets a
   pane change to react to): once its own account's null-until grace passes,
   ask 2 fires `runGatedWake` with `AUTO_CONTINUE_PROMPT`, no dismiss-modal
   attempted.
5. Select-exhausted row: once its own account reads free, ask 2 fires exactly
   ONE wake — proven against a tick where #109's own independent hourly retry
   is ALSO due, so this is a genuine no-double-wake composition proof, not
   just "the other mechanism never got a chance."
6. Nothing free at all (own account, spare, borrow all miss): neither ask-2
   check fires, row stays exactly as today.
7. `deps.accountLimits` not wired at all: the whole check no-ops (regression
   found via the full targeted suite — see Residuals).
8. `exhaustionKind === "dead"`: never gets the wake or the auto-stop, even
   well past every staleness grace.
9. `parkedAt` > 6h ago, nothing free: `deps.stopParkedStudio` called, outcome
   names the park.
10. `parkedAt` < 6h ago: `deps.stopParkedStudio` NOT called.
11. `deps.stopParkedStudio` absent: the whole ask-3 check no-ops cleanly, no
    throw.

## Residuals

- Found only by running the existing `test/studio.auto-continue.test.ts`
  suite after the first implementation pass: that file's own harness never
  wires `deps.accountLimits` at all (it predates #102 in spirit), so
  `accountIsFree`'s bare "not tracked" default made EVERY account read as
  free the moment ask 2's condition (a) ran — firing a wake on the very next
  already-degraded tick regardless of elapsed time. Fixed by gating the
  entire ask-2/ask-3 block on `deps.accountLimits` being present (see Ask 2
  above) and added as a dedicated test (list item 7) rather than left as a
  silent behavior change for any caller that has not opted into fleet-wide
  limit tracking.
- A `parkedOn === null` -> `parkedOn !== null` transition between ticks (an
  operator flips `FLEET_AUTO_FAILOVER` off mid-park while a genuine
  exhaustion is already recorded) leaves a stale `parkedAt` on the row
  (the message text changes, so the anti-loop guard's `existing.error ===
  message` comparison fails and the row falls through to the fresh-degrade
  write, which spreads `...existing` and only conditionally sets `parkedAt`
  when `parkedOn === null` — never explicitly clearing it on the `!== null`
  branch). Rare (requires a live operator action mid-incident) and
  self-correcting the moment any later tick heals the row normally; not
  fixed here to keep this change narrowly scoped to the three asks.

## Review round 1 (fresh-context review, 2026-10-03)

Two blocking findings, one doc nit. TDD throughout: a RED commit for both
code findings, pushed, then the fix, pushed.

**Finding 1 (severe) — auto-stop could silently no-op and lie about
success.** `do.ts`'s `stopParkedStudio` passed `force=false` into
`destroyStudio`. `destroy.ts`'s own `runDestroy` refuses (fail-closed) a
non-forced destroy whenever the studio has an open assigned board task, or
whenever that check itself cannot confirm — and a studio genuinely stuck
parked mid-task almost always has exactly that (that is why it is still
running). So the realistic case: `destroyStudio` silently refused, no rescue
ran, the container stayed up billing — yet `FailoverDeps.stopParkedStudio`
was typed `Promise<void>`, so `runAccountFailover`'s own call site reported
`"auto-stopped"` unconditionally regardless of what actually happened.

Fix: `do.ts` now wires `stopParkedStudio: () => this.destroyStudio(true,
false, true)` — `force: true` because this specific trigger is unattended
(nobody is there to retry with `--force` the way an operator would).
Confirmed by reading `destroy.ts` first that `force` skips ONLY the
open-task refusal gate; `destroyWithSync`'s own rescue-push/session-sync/
learning-harvest sequence is never gated on it and still runs in full
whenever the container answers its probe (pinned by
`test/studio.destroy.test.ts`'s own pre-existing "--force overrides the
refusal... the full destroy sequence proceeds" case — reused, not
reinvented). One pre-existing side effect worth naming rather than hiding:
`destroyStudio`'s own `discardUnsynced: discardUnsynced || force` wiring
means `force` ALSO turns a probe-failure/rescue-push-confirmed-failure
refusal into "proceed anyway" — exactly what an operator's own `--force`
already does today, not a new behavior this wiring introduces.
`discardUnsynced` itself stays `false`, a separate human choice this
automated call never makes.

`FailoverDeps.stopParkedStudio` now returns the real `DestroyOutcome`
instead of `void`. `runAccountFailover`'s call site reports a NEW outcome
kind, `"park-refused"` (carrying the refusal `reason`, or a caught throw's
message), whenever the stop did not actually happen, instead of claiming
`"auto-stopped"`. Tests (`test/studio.parked-auto-resume.test.ts`): a
refusal reports `park-refused`; a throw ALSO reports `park-refused`
(fail-safe, never fail-open); a genuine success still reports
`auto-stopped` exactly as before. A wiring-level test
(`test/studio.account-failover.test.ts`, alongside the existing
`failoverDeps()` tests that call the real `StudioDO.prototype.failoverDeps`
on a fake `this`) pins that `destroyStudio` is called with
`(true, false, true)` and that the real outcome rides back unchanged.

**Finding 2 (moderate) — the free-account check didn't match the real
selection for an active-borrow, out-of-scope `current`.** `anyAccountFreeToResume`'s
tier-1 check always called `nextClaudeAccount(scopedAccounts, current, ...)`,
but the REAL selection (`runAccountFailover`'s own `candidate`) branches on
`currentOutOfScope` first: `firstFreeAccount(scopedAccounts, ...)` instead,
whenever an active borrow's `current` sits before the search anchor (no
position to step forward from — `nextClaudeAccount` returns null
immediately, current not found). Fixed by threading the SAME
`currentOutOfScope` boolean the real selection already computes into
`anyAccountFreeToResume`, and branching identically.

Only ever observable with auto-failover OFF: with it on, the real
`candidate` computation (already correctly `currentOutOfScope`-aware) finds
the same free account on the exact same tick and switches away before
`anyAccountFreeToResume` is ever reached — proven by first writing the
literal repro the review asked for (active borrow, auto-failover ON, an
account within the scoped chain frees) and observing it already produces
`"switched"`, never reaching the buggy branch at all. The reachable repro
needs auto-failover off, a genuine exhaustion first (so `parkedAt` stamps),
then the free account creating a `"parked"` (#271-shaped) message on one
tick and the SAME message again on the next (so the anti-loop guard's
`existing.error === message` matches and the `anyAccountFreeToResume`
branch is actually entered) — see the new
"review round 1, finding 2" describe block in
`test/studio.parked-auto-resume.test.ts` for the full three-tick fixture.

**Doc nit.** This file's own "Distinguishing an auto-stop..." paragraph
(above) originally implied an operator could read the auto-stop/manual-park
distinction off `fleet ls`. Checked `cli/readiness-format.ts` directly:
neither the table formatter nor `LsJsonRow`/`--json` renders `parkedAt` or
`exhaustionKind` anywhere today. Corrected in place (see that paragraph's
own "Review round 1 correction" addendum) rather than left overclaiming.
Judged a one-line `fleet ls` surfacing of these fields as its own,
not-yet-scoped follow-up (a new table column/JSON field plus its own tests)
rather than folding it into this already-multi-part fix.

## Review round 2 (fresh-context human review, 2026-10-03) — fix-first

Three BLOCKER findings, one Major finding, plus a rebase item deferred on a
dependency that has not merged. TDD throughout: a RED commit per finding,
pushed, then the fix, pushed.

**Finding 1 (BLOCKER, data-loss risk) — `force=true` also disabled the
rescue-failure refusal, so an unattended stop could destroy WITHOUT a
successful rescue.** Round 1's own fix (above) wired `stopParkedStudio:
() => this.destroyStudio(true, false, true)`, reasoning `force: true`
skipped ONLY the open-task gate. That reasoning missed `destroyStudio`'s own
`discardUnsynced: discardUnsynced || force` wiring (one level up from
`runDestroy`'s own `force` param, which really does control ONLY the
open-task gate): `force: true` here ALSO turned a failed container probe or
a CONFIRMED rescue-push failure refusal (`destroy.ts`'s `destroyWithSync`,
~L204 and ~L276) into "proceed anyway" — correct, deliberate behavior for a
HUMAN's own `fleet destroy --force`, backwards for this UNATTENDED trigger,
which must never destroy without a successful rescue when nobody is there to
catch the refusal.

Fix: `destroyStudio` gained a 4th parameter, `skipOpenTaskGate = false`
(every existing caller unaffected by the default). It widens ONLY the value
passed as `runDestroy`'s own `force` param (`force || skipOpenTaskGate`);
`guard.discardUnsynced` stays exactly `discardUnsynced || force`, never
touching `skipOpenTaskGate`. `stopParkedStudio` now calls
`this.destroyStudio(false, false, true, true)` — `force: false` (so
`discardUnsynced` stays `false`, and the probe/rescue-push-confirmed-failure
refusals stay fully armed), `skipOpenTaskGate: true` (so an open assigned
board task alone no longer blocks the attempt). Pinned at the pure-function
level in `test/studio.destroy.test.ts` (an open task is skipped while a
probe/rescue-push failure still refuses, with `force: true` standing in for
`force || skipOpenTaskGate` and an explicit `guard.discardUnsynced: false`
standing in for the two original arguments both being `false`) and at the
source-text level in `test/studio.observation.test.ts` (the exact
`force || skipOpenTaskGate` / `discardUnsynced: discardUnsynced || force`
lines, and the exact `stopParkedStudio` wiring).

**Finding 2 (BLOCKER) — a stale `parkedAt` survived a stop -> resume cycle,
causing an immediate re-stop (~5 min later).** Three spread sites carried
`parkedAt` forward unchanged across a stop/resume cycle: `destroy.ts`'s
stopped-row write, and `provision.ts`'s fresh-provision/restart status
builds (`runProvision`, `runRestart`), all spread `...(existing ??
freshStatus(id))` with no explicit `parkedAt` override. Worse,
`failover.ts`'s own degrade-write read `existing.parkedAt ?? now`
UNCONDITIONALLY, so a row that had genuinely passed through
`"stopped"`/`"provisioning"`/`"running"` since the old `parkedAt` was
stamped — a NEW episode by construction — still carried the OLD, hours-stale
clock forward the instant the SAME exhaustion reappeared, instantly
satisfying the 6h auto-stop threshold on the very next tick.

Fix (belt and suspenders, per the review's own instruction): (1) the
LOAD-BEARING half, `failover.ts`'s degrade-write, now preserves the old
`parkedAt` ONLY when `existing.state === "degraded"` (a genuine same-episode
repeat); any other prior state restarts the clock from `now`. (2) the
DEFENSE-IN-DEPTH half, `destroy.ts`'s stopped-row write and both of
`provision.ts`'s status builds, now explicitly set `parkedAt: null`. Tests:
`test/studio.parked-auto-resume.test.ts` pins the exact repro (parked,
auto-stopped — simulated via a direct `state: "running"` write with the
stale `parkedAt` left in place — then the same exhaustion reappears: the
clock restarts, and the auto-stop does not immediately refire);
`test/studio.destroy.test.ts` and `test/studio.provision.test.ts` each pin
their own explicit clear.

**Finding 3 (BLOCKER) — the free-account wake could fire forever on a still-
limited current account, accomplishing nothing, while also masking the
auto-stop.** `anyAccountFreeToResume` fired the wake whenever EITHER the
current account was free OR the ordinary 3-tier switch selection
(`candidate`/`outOfScopeSpare`/`borrowed`) found anything free anywhere. A
wake is just "dismiss + continue on the account the pane is CURRENTLY
sitting on" — it can only ever help if the CURRENT account itself is the one
that freed. A free spare/borrow tier while the current account stayed
limited meant firing the wake accomplished nothing (claude hits the same
limit again) while ALSO reading as "something's free, don't stop" on the
OLD auto-stop condition — the row could never be recognized as genuinely
stuck. The literal #210 bug shape, reintroduced by this feature's own first
draft.

Fix, three parts: (1) `anyAccountFreeToResume` is replaced by
`currentAccountFreeToResume`, which asks ONLY `accountIsFree(currentAccount,
...)` — the ordinary 3-tier selection already owns "is anything else free"
(it runs earlier in the same tick, with auto-failover on; with it off,
nothing moves by design, #271, and this mechanism must respect that
boundary too). (2) a new anti-hammer field, `StudioStatus.
freeAccountWakeLastTriedAt`, mirrors `autoContinueLastTriedAt`'s own hourly
cadence (`AUTO_CONTINUE_RETRY_MS`) so a wake that fires but does not resolve
anything does not refire every single 300s tick. (3) the auto-stop's own
triggering condition is simplified to elapsed-time (`>=
PARKED_AUTO_STOP_HOURS` since `parkedAt`) + still-degraded + not-dead,
checked BEFORE the free-account check and independent of what it reads that
tick — "wakes have not healed it in 6h" is on its own sufficient, and immune
to this finding's own kind of bug by construction (it never has to
correctly re-derive "is anything free" at all).

The existing round-1 finding-2 test (the only test that exercised the
removed OR-branch) is corrected to its actually-correct expectation (no
wake fires when only a different, non-current tier frees). The two original
ask-2 demo tests, and the new tests this finding adds, needed their own
25h-clock-jump fixtures reworked: once the auto-stop is unconditional past
6h, any scenario that waits a full day for the 24h null-until grace to lift
is ALSO, by then, long past the 6h stop threshold — so those tests now
either backdate the account's own fleet-wide sighting (crossing the grace
while `parkedAt` itself stays under 6h) or assert `"auto-stopped"` directly.

**Finding 5 Part A (Major) — a refused auto-stop needed its own backoff and
a single notify.** `park-refused` returned without ever writing the refusal
onto the row or telling the operator, and would have retried
`deps.stopParkedStudio` (a real board-API call, in production) every single
300s tick forever. Fix: two new fields, `StudioStatus.parkRefusalReason`/
`parkRefusedAt`, written onto the row BEFORE the outcome returns.
`parkRefusedAt` is also the bounded retry cadence (same
`AUTO_CONTINUE_RETRY_MS` shape) — a standing refusal is not retried (or
renotified) more often than once an hour. The operator is notified via
`deps.notify` only when the reason actually CHANGED from the last one
recorded (the same "unchanged message, no new notify" rule the ordinary
exhaustion message's own anti-loop guard already uses,
`existing.error === message`) — a changed reason (the board task situation
shifted) notifies again.

**Finding 5 Part B (doc only) — does this auto-stop interact with an
operator actively attached to the studio's tmux session?** Checked
`src/studio/inspect.ts` directly (the one file in this codebase that
documents the `tmux list-clients`/attach mechanics in depth, issue #47) and
grepped the whole repo for `list-clients`: it appears EXACTLY ONCE, in
`inspect.ts`'s own doc comment, as an EMPIRICAL VERIFICATION NOTE that
`capture-pane -p` itself never creates an attached client — not as a live
check anything calls. There is no "is an operator currently attached"
primitive anywhere in this codebase today, and this auto-stop path (nor any
other path) never checks for one. Stated here explicitly, per the review's
own instruction, rather than silently: an operator who has `fleet attach`ed
to a parked studio's tmux session gets no special treatment from
`PARKED_AUTO_STOP_HOURS` — if the row is still degraded with the same
exhaustion 6 hours after `parkedAt`, the auto-stop fires regardless of
whether anyone is watching. No new attach-detection machinery was built for
this: the review's own instruction was not to invent one unless a trivial,
already-available, zero-new-risk check existed, and none does
(`list-clients` is a real tmux round trip this file's whole design
(`sbExec`-only, never `sbAttachPty`) goes out of its way to avoid paying for
on every read-only check it already runs; adding it here would be new
scope, not a trivial reuse).

**Finding 4 (the #209/#211-dependent rebase) — DEFERRED, not attempted.**
The review's own 5th finding asks that this file's 3-tier `candidate`/
`outOfScopeSpare`/`borrowed` selection (`runAccountFailover`) be rebased onto
PR #211's shared `selectFreeAccount`/`nextBorrowedAccount` helpers (itself
building on PR #209). PR #211 has not merged to `main` as of this round —
rebasing onto helpers that do not exist yet on `main` is not attempted here.
A one-line `TODO (#210 review, finding 4)` comment marks the exact call site
(`failover.ts`, immediately above the `candidate` computation) referencing
this issue and PR #211, so the rebase is easy to find once that PR lands.

## 2026-10-03, finding 4 resolved — rebase onto #211's merged `deriveSearchAnchor`/`selectFreeAccount`

PR #211 (`fix(failover): launch gate consults fleet-wide AccountLimits before
launching (#209) (#211)`, commit `b061940`) merged to `main`, followed by
#212 (commit `9cf78e5`). This branch was 17 commits ahead of / 2 commits
behind `main`; `git rebase origin/main` replayed all 17 cleanly except one
genuine conflict, resolved as described below. The whole rebase stayed
linear (no merge commit) so `git log` still reads as one straight RED/GREEN
history.

**What #211 changed in `failover.ts`.** The old inline
`const currentIdx = current == null ? 0 : deps.accounts.findIndex(...)` /
`const anchor = borrowedActive ? start : (currentIdx < 0 ? start :
Math.min(start, currentIdx))` / `const currentOutOfScope = borrowedActive &&
currentIdx >= 0 && currentIdx < anchor` block — the exact formula this
file's own review round 2 finding 4 (PR #135) first wrote inline — was
extracted into `accounts.ts`'s `deriveSearchAnchor(accounts, start, current,
borrowedActive)`, shared with `launchAccountOrReroute`'s own gate so the two
can never drift a third time. The old inline `outOfScopeSpare = candidate
=== null && deps.autoFailover ? firstFreeAccount(deps.accounts.slice(0,
anchor), reserved, limits, deps.now()) : null` became `selectFreeAccount
(deps.accounts, anchor, current, currentOutOfScope, reserved, limits,
deps.now())`, also from `accounts.ts`. Both are pure re-derivations of the
SAME formula this file already carried — #211 did not change the algorithm,
only who owns the one copy of it.

**The conflict.** `git rebase` found exactly one hunk conflicting in
`failover.ts`: this branch's own `18f9dbc` (review round 2, finding 3) GREEN
commit carried a hunk reinstating the local `currentOutOfScope` computation
and the `TODO (#210 review, finding 4)` comment immediately above
`candidate`, in the SAME spot `main`'s rebase-so-far had already replaced
with the `deriveSearchAnchor` destructure. Resolution: take `main`'s side —
deleted the reinstated `currentOutOfScope` line and the TODO comment
entirely, keeping the single `const { anchor, currentOutOfScope } =
deriveSearchAnchor(...)` call already in place a few lines above. This
single deletion both finishes finding 4's own rebase AND removes the TODO
it asked to resolve — the inline 3-tier selection in `runAccountFailover`
had nothing else of its own left to migrate; it already called
`firstFreeAccount`/`nextClaudeAccount`/`nextBorrowedAccount` the same way
both before and after, and the one piece #211 centralized
(`anchor`/`currentOutOfScope`/`outOfScopeSpare`'s own tier-2 lookup) now
reads identically to `main`.

**The `currentIdx` fallout.** `deriveSearchAnchor` returns `anchor`/
`currentOutOfScope` only — it does not return the `currentIdx` local that
used to compute them, and that local no longer exists anywhere in the
rebased `runAccountFailover`. This branch's own #210 free-account-wake block
(review round 2, finding 3's own `18f9dbc` commit) read `const
currentAccount = currentIdx >= 0 ? deps.accounts[currentIdx] : null;`
further down the same function, relying on that now-gone outer-scope
variable. Rebuilt it locally, at the point of use, with the exact same
formula `deriveSearchAnchor` itself computes internally (`accounts.ts`:
`current == null ? 0 : accounts.findIndex((a) => a.name === current)`):

```ts
const currentIdx = current == null ? 0 : deps.accounts.findIndex((a) => a.name === current);
const currentAccount = currentIdx >= 0 ? deps.accounts[currentIdx] : null;
```

This keeps the existing convention every other reader of "where is this
studio right now" in this file already follows (`current === null` reads as
position 0 "by construction"; a NAMED `current` absent from `deps.accounts`
— secret deleted/renamed — reads as not-found, `null`, never position 0) —
`currentAccountFreeToResume`'s own doc comment states this convention
explicitly, and this re-derivation satisfies it unchanged.

**No second drifting copy found.** Checked both `currentAccountFreeToResume`
and `freeAccountWakeAttempt` (the two other #210-only functions near this
area) for an inline copy of the 3-tier selection the TODO was about:
neither carries one. `currentAccountFreeToResume` only calls
`accountIsFree(currentAccount, limits, now)` on the single account the
caller resolves; `freeAccountWakeAttempt` performs the wake itself (dismiss
+ `runGatedWake`) and never re-derives a candidate account at all. Nothing
else needed rewiring.

**Verification.** Targeted suite (`test/studio.account-failover.test.ts`,
`test/studio.parked-auto-resume.test.ts`, `test/studio.account-by-repo.test.ts`,
`test/studio.account-launched.test.ts`, `test/studio.destroy.test.ts`,
`test/studio.provision.test.ts`) — three of these import `cloudflare:test`
(added by #211's own `envWith` change) and cannot run under plain `bun
test`, which has no workers pool; run instead under `vitest run` on the
same six files: 407/407 passed. Full gates, run one at a time under
`flock /tmp/fleet-gate.lock`: `bun run test` (full vitest suite) — 157 test
files, 5586 tests, all passed; `bun run check` (`tsc --noEmit` across all
five configured projects) — clean, no errors.
