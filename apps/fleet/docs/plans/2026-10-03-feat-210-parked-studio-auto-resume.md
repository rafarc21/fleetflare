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
