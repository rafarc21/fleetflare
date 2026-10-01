# inline-limit wake-on-reset, and a survey-overlay wake guard (board issue #158)

> Numbering correction, state this in the PR body too: #158's own text cites
> `#125` for the `autoContinueEligible` gate and `#154` for the `▔`-rule wake
> gate. Neither number matches this codebase. The gate is **issue #109**
> (`apps/fleet/docs/plans/2026-09-30-usage-limit-auto-continue.md`); the
> `▔`-rule is **issue #146** (`wake.ts:51-146`'s own doc comment). `#154` in
> this repo is an unrelated burn-cursor-offset migration (`burn.ts`). This
> plan uses the real numbers throughout.

> **Post-implementation review corrections** (fresh-context re-review,
> same PR, 2026-10-01) — three findings, all now fixed, all kept here
> because they correct claims THIS plan originally made, not just the code:
>
> 1. **Design §1's own `recovery.parked` claim was wrong.** The text
>    originally here read "`recovery.parked` (true only for
>    `exhaustedMessagePrefix` rows — already excludes `"parked"`/#271 ...)".
>    That is false: `parkedMessage` (#271) starts with the exact same
>    `exhaustedMessagePrefix` `exhaustedMessage` does, BY DESIGN (so #214's
>    heal clears either the same way) — `recovery.parked` cannot tell a #271
>    park from genuine exhaustion at all. A multi-account fleet with
>    `FLEET_AUTO_FAILOVER=off`, triggered by an INLINE block (a free second
>    account made the `!next` branch's `candidate` non-null), writes via
>    `parkedMessage` with `rateLimited` shaped exactly like a genuine inline
>    exhaustion (no `select`, no `dead`, both independent of `autoFailover`)
>    — the heal wake fired on the operator's own deliberate park, exactly
>    what Scope's OUT section forbids. Fixed with a new field,
>    `StudioStatus.operatorParked`, stamped at write time from the `!next`
>    branch's own local `parkedOn` (independent of which verdict triggered
>    it). Design §1 below is corrected to describe this, not the original
>    (wrong) `recovery.parked`-only condition.
> 2. **Design §2's wiring point missed one exit path.** `wake.ts`'s own
>    #144 switched-block early return (`if (switched ===
>    limitBlockKey(limit)) return afterLimitGate(...)`, inside the
>    `limit.kind === "modal"` branch) sat BEFORE the survey check this plan
>    originally placed "right after the existing GATE 3 modal check, before
>    the final `return afterLimitGate(...)`" — i.e., after the whole modal
>    branch, including that early return. A stale switched-block redraw and
>    a feedback-survey overlay coinciding on the same screen therefore
>    skipped the survey gate. Fixed by moving the survey check to run
>    FIRST, immediately after `detectLimitOnScreen`, before any branching
>    on `limit.kind` — see Design §2's corrected wiring note.
> 3. **A second, faster heal path this plan never looked at.** Design §1's
>    "Mechanism" section scoped Gap 1's fix to `runAccountFailover`'s own
>    300s `working`-branch heal — but issue #274 (`do.ts:4612`'s own doc
>    comment) already added a SECOND, independent heal path reusing the
>    SAME `evaluateDegradedRecovery` on a 30s ship-tick cadence, specifically
>    BECAUSE a lead sitting `degraded` for up to 5 minutes under the 300s
>    path alone was a measured problem (#274's own MEASURED timelines).
>    Running ~10x more often, that fast path almost always won the race and
>    flipped a row to `"running"` before `runAccountFailover`'s own slower
>    tick ever saw it degraded again — which made Gap 1's whole fix
>    unreachable in the common case: the row still healed (as it always
>    did), but the NEW wake never fired. See Design §3 (new) for the fix:
>    the heal-write + wake logic is now a single shared function,
>    `healDegradedRowAndWake` (`failover.ts`), called from BOTH cadences —
>    the same extraction pattern #274 itself already established for
>    `evaluateDegradedRecovery`, for the identical reason ("can never fork
>    into two subtly different implementations").

## The gap, as measured

Two separate gaps, both reported in #158.

**Gap 1 — an inline session-limit block never gets a wake, even after its
reset passes.** Issue #109's auto-continue only ever fires from
`runAccountFailover`'s `!next` branch, gated by
`autoContinueEligible = parkedOn === null && !verdict.inline` (`failover.ts`,
`!next` branch). For an inline block (`verdict.inline === true`) this is
always `false` — by the #109 plan's own stated design, an inline-exhausted
row was assumed to "self-clear through the EXISTING #214 `working`-branch
recovery once its own printed reset passes the clock, so it needs no Esc at
all" (comment directly above `autoContinueEligible`). That assumption is
wrong in practice: `evaluateDegradedRecovery`'s `shouldHeal` / the `heal`
write in `runAccountFailover`'s `working` branch (`failover.ts:1867-1889`)
flips the row's `state` back to `"running"` and clears
`autoContinueAt`/`autoContinueLastTriedAt` — but it never sends a single
keystroke into the pane. Claude Code does not resume a turn on its own just
because the inline block scrolled past staleness; it sits at its own idle
prompt until something types into it, same as it does after an Esc on the
select-modal path (which, unlike here, DOES get a wake — from
`autoContinueAttempt`, same tick as its Esc). MEASURED 2026-10-01 02:50Z (the
issue's own report): lead showed the inline line, reset passed, "nothing
resumed it for 5+ min"; operator re-sent the task by hand.

**Gap 2 — a wake can land on Claude Code's own feedback-survey overlay and
answer it.** Field note on #158 (2026-10-01 02:56Z, rafarc21): after a
reset, 2 of 6 studios showed Claude Code's feedback survey (options
1/2/3/0) above the prompt. A wake whose text contains digits (a task number,
a time like "02:50") can answer that survey, because `runGatedWake`'s GATE 3
(`wake.ts:641-686`) only recognizes the shapes `detectLimitOnScreen` (strict)
knows. Nothing in `runGatedWake` or in the loose gate
(`looseLimitOnScreen`/`LOOSE_LIMIT_PATTERNS`, `wake.ts:135-146` — used
elsewhere, not currently wired into `runGatedWake` itself) recognizes a
feedback-survey overlay at all, because no such shape has ever been added —
confirmed by grep, there is no "survey"/"feedback" detector anywhere in this
codebase.

## Scope

IN:
1. Once a degraded row heals (`healDegradedRowAndWake`, called from BOTH
   `runAccountFailover`'s 300s `working`-branch heal AND do.ts's #274 fast
   30s ship-tick heal — see Design §3), and ONLY for a row whose degradation
   was genuinely this feature's own inline exhaustion (never the
   select-modal case, which already gets its wake from
   `autoContinueAttempt`; never a `"parked"` (#271, `FLEET_AUTO_FAILOVER`
   off) row — excluded via the new `StudioStatus.operatorParked` field, NOT
   `recovery.parked` alone, which does NOT exclude it by construction (see
   the post-review correction callout at the top of this doc and Design
   §1); never the dead-account path, #141 — see Design §1 for the exact
   exclusion), attempt ONE gated wake with the SAME `AUTO_CONTINUE_PROMPT`
   the select-modal path already uses (already digit-free, so Gap 2's
   concern does not even apply to this specific wake).
2. No new bookkeeping field for "already woken once": the heal write's own
   precondition (`existing.state === "degraded"`) is consumed by the SAME
   write that flips it to `"running"`, so this fires at most once per
   degradation, for free, the same invariant the surrounding code already
   states ("at most one write per degradation in each direction").
3. Independent of `FLEET_AUTO_FAILOVER`: confirmed by reading
   `runAccountFailover`, the `working`-branch heal logic
   (`failover.ts:1797-1889`) runs unconditionally for any `verdict.kind ===
   "working"` tick — `deps.autoFailover` is read later in that branch
   (line ~1919, hand-back) but never gates the heal/forget/cleared logic
   itself. No change needed to preserve this; just don't introduce a new
   `deps.autoFailover` read.
4. A new, SEPARATE loose gate in `runGatedWake` (`wake.ts`, inserted into
   GATE 3's existing block, after the modal check, before falling through to
   `afterLimitGate`) that refuses to send ANY keystrokes while Claude Code's
   own feedback-survey overlay is on screen — zero keystrokes, for every
   `runGatedWake` caller (auto-continue, `assignWakeMessage`,
   `commentWakeMessage`), not just this issue's own inline-reset wake.
5. RED tests (extend `test/studio.auto-continue.test.ts`, add a focused
   survey-gate test near `studio.wake-gate.test.ts`):
   - inline-limit fixture (`INLINE_PANE` or a reset-passed variant of it),
     reset passed → exactly one wake attempt with `AUTO_CONTINUE_PROMPT`.
   - inline-limit fixture, reset NOT passed → zero wake attempts, zero Esc
     (the EXISTING test at `studio.auto-continue.test.ts:230-245` already
     asserts this for the still-live case; keep it green, split off the
     reset-passed case as a new `it`, do not weaken the still-live one).
   - survey-overlay fixture present → `runGatedWake` returns
     `{ ok: false, skipped: true, ... }` with zero `exec` calls carrying the
     prompt text (reuse the existing harness's exec-call recorder pattern
     from `studio.wake-gate.test.ts`/`studio.wake-race.test.ts`).
   - survey-overlay NOT present, ordinary idle pane → wake still goes
     through (no regression).
   - existing `▔`-rule regression (#146,
     `REAL_PERMISSION_PROMPT_UNKNOWN_FOOTER_PANE`) and `studio.wake-race.test.ts`
     / `test/bun/wake-guard.test.ts` stay green, unmodified.

OUT (explicitly not doing):
- NOT touching the `"parked"` (#271) outcome — operator's own deliberate
  `FLEET_AUTO_FAILOVER=off` choice stays untouched, same exclusion #109
  itself already states.
- NOT sanitizing digits out of `assignWakeMessage`/`commentWakeMessage`
  (the issue's other offered remedy, "send a digit-free resume line"). A
  task number or a time is load-bearing content a human reads later
  (`fleet ls`, the board); stripping digits from those specific messages
  would make them unreadable. The detect-and-refuse gate (point 4 above)
  protects every wake uniformly, including those two, without mangling any
  message — chosen over sanitizing text, which this file's own `▔`-rule doc
  comment already warns is the wrong kind of fix for an unmeasured UI shape
  (see Design §2 for why a bare numbered-row pattern was already tried and
  REJECTED here once, #146, and why this gate must not repeat that mistake).
- NOT sourcing a real capture of the survey overlay — none exists in this
  repo. The new fixture is explicitly marked `UNMEASURED` per this repo's
  own fixture-provenance convention (`test/fixtures/rate-limit-panes.ts`'s
  VERBATIM/REBUILT/UNMEASURED documentation discipline), and the detector is
  scoped conservatively (Design §2) rather than guessed wide. Flagged as a
  residual below.

## Mechanism

Both fixes reuse existing infrastructure — no new scheduler, no new exec
primitive; ONE new Durable Object field (`StudioStatus.operatorParked`,
added by the post-review correction, finding 1):
- Gap 1 piggybacks on the EXISTING heal evidence (`evaluateDegradedRecovery`)
  and the EXISTING `runGatedWake` / `AUTO_CONTINUE_PROMPT` machinery #109
  already built for the select-modal case — same dynamic
  `import("./wake")` pattern `autoContinueAttempt` already uses, same
  reason (module-init-order cycle, see `autoContinueAttempt`'s own doc
  comment). Post-review correction, finding 3: the heal+wake logic lives in
  ONE shared function (`healDegradedRowAndWake`, `failover.ts`), called from
  BOTH places that ever heal a degraded row — `runAccountFailover`'s own
  300s `working`-branch heal AND `do.ts`'s #274 fast 30s ship-tick heal
  (`runShipTickWithObservation`) — never duplicated inline in either one.
  See Design §3.
- Gap 2 extends the EXISTING `runGatedWake` gate pipeline with one more
  gate, in the same file, same style as the `▔`-rule gate it sits beside.
  Post-review correction, finding 2: that gate now runs FIRST, before any
  branching on `limit.kind`, so it catches every exit out of the modal
  branch — the #144 switched-block early return included.

## Design

### 1. Inline-exhaustion wake on heal (`failover.ts`) — CORRECTED, see the
callout at the top of this doc

`healDegradedRowAndWake` (the shared function Design §3 introduces) owns
this: `recovery.shouldHeal && !opLockFresh` is the "this call heals a
degraded row" signal, and the write it performs includes the wake decision.

- Determine whether the row being healed was genuinely THIS feature's own
  inline exhaustion — not a select-modal exhaustion (already woken via
  `autoContinueAttempt`), not the dead-account path (#141), and **not a
  `"parked"` (#271, `FLEET_AUTO_FAILOVER=off`) row** — the exclusion this
  section originally got wrong. `recovery.parked` is true for ANY
  `exhaustedMessagePrefix` row, which `parkedMessage` (#271) shares with
  `exhaustedMessage` BY DESIGN — it does NOT, by itself, exclude a #271
  park. Nor does `rateLimited.select`/`.dead` alone: both are set
  independent of `autoFailover`, and a #271 park triggered by an INLINE
  block (a free second account existed) leaves `rateLimited` with neither
  set, the exact shape a genuine inline exhaustion has. The real signal is
  `StudioStatus.operatorParked` — a new field, stamped at write time from
  the `!next` branch's own local `parkedOn` (both of `runAccountFailover`'s
  write sites there: the fresh-degrade write and the anti-loop-guard
  re-write), `true` only when `parkedOn !== null` at that moment, cleared
  back to `null` in the same heal write that resets
  `autoContinueAt`/`autoContinueLastTriedAt`. The final condition
  (`inlineExhaustionHealed`, `failover.ts`'s `healDegradedRowAndWake`):
  `recovery.parked && !existing.operatorParked && existing.rateLimited !=
  null && !existing.rateLimited.select && !existing.rateLimited.dead`.
- When that's true AND the caller's own `safeToWake` signal allows it
  (pane genuinely idle, not mid-turn — see Design §3 for what each of the
  two call sites threads in here, and why they differ): dynamically
  `import("./wake")`, build `GatedWakeDeps` the same way
  `autoContinueAttempt` does, and call `runGatedWake(gatedDeps,
  AUTO_CONTINUE_PROMPT)`. Does not block the heal write on this call's
  outcome — the row still flips to `"running"` regardless of whether the
  wake itself succeeds, skips, or fails (matches #214's own invariant: the
  row describes the PANE, not the wake).
- If `safeToWake` is false on the healing call (mid-turn), skip the wake
  that time. Documented as a residual below — since heal only fires once
  per degradation, a coincidental mid-turn moment on the exact healing call
  means this specific wake never retries. Acceptable: already strictly
  better than before (never wakes at all), and the condition is narrow (one
  specific call, one specific coincidence).

### 2. Survey-overlay gate (`wake.ts`)

Add a new loose detector, analogous to `looseLimitOnScreen` but a SEPARATE
function and a SEPARATE pattern list — do not fold it into
`LOOSE_LIMIT_PATTERNS`, which this file's own doc comment (`wake.ts:51-132`)
already states is scoped to MODAL ROWS (an exact footer, the `▔` rule, a
known headline), explicitly NOT a general numbered-option-row pattern — that
was tried once already (PR #102's first cut, and again considered at #146)
and REJECTED both times for matching a lead's own numbered prose
(`test/fixtures/rate-limit-panes.ts`'s `NOT_DETECTED` corpus) and the
ghost-composer row (`test/studio.wake-race.test.ts`, `"❯ 1. Upgrade deps"`).

A new, narrower heuristic is required to avoid repeating that exact mistake.
Candidate shape, informed by the field note ("options 1/2/3/0 above the
prompt", "no ▔ rule" — i.e., NOT drawn inside the same boxed-modal chrome
every other entry here keys on): within the bottom `LOOSE_TAIL_LINES`
non-blank rows, look for at least 2 CONSECUTIVE rows that are each a BARE,
SHORT, numbered-choice line — just a digit (optionally `0`-`3` per the field
note, but do not hardcode the digit SET, only the SHAPE) with no more than a
few characters of label, nothing else on the row — distinguishing this from
both rejected shapes above by requiring the WHOLE row to be short and bare
(a lead's prose numbered item and the ghost-composer row both carry a full
sentence after the number; a survey choice row, per the field note, does
not). Treat the exact regex as something to DERIVE from the UNMEASURED
fixture you build in test, not something to lock in before writing the RED
test — write the fixture first (a plausible but explicitly-UNMEASURED
feedback-survey pane, following this file's own `test/fixtures/
activity-panes.ts` "same base pane, overlay swapped in" convention used for
the #146 regression pair), then the detector that makes it refuse without
also refusing the existing `NOT_DETECTED` corpus and
`REAL_PERMISSION_PROMPT_*` fixtures.

Wire the new detector into `runGatedWake`, reusing the SAME `screen.stdout`
already captured for GATE 3 — no new exec. On a hit, return `{ ok: false,
skipped: true, error: "feedback survey on screen in ${WAKE_TARGET}; no
keystroke sent — <remedy, same style as the modal refusal message>" }`.

**Wiring point — CORRECTED, see the callout at the top of this doc.**
Originally placed right after the whole `if (limit.kind === "modal") { ...
}` block, before the final `return afterLimitGate(...)`. That missed one
exit path: `wake.ts`'s own #144 switched-block early return (`if (switched
=== limitBlockKey(limit)) return afterLimitGate(...)`) lives INSIDE the
modal branch and returns before control ever reaches a check placed after
that whole block — a stale switched-block redraw coinciding with a survey
overlay would skip the survey gate entirely. Fixed position: immediately
after `const limit = detectLimitOnScreen(...)`, BEFORE any branching on
`limit.kind` at all — this way nothing downstream, early return included,
can run before it does.

### 3. Two heal cadences, one shared heal-and-wake function (`failover.ts`,
`do.ts`) — NEW, post-review correction, finding 3

Issue #274 (`do.ts:4612`'s own doc comment) already added a SECOND place
that calls `evaluateDegradedRecovery` and heals a degraded row:
`runShipTickWithObservation`'s fast-path block, reusing the SAME 30s
ship-tick pane frame (`ShipResult.paneFrame`) #221 already captures — built
specifically because a lead sitting `degraded` for up to 5 minutes under
`runAccountFailover`'s 300s-only cadence was itself a measured problem
(#274's own MEASURED timelines, `studio.failover-274.test.ts`'s header).
Running on a 30s cadence — roughly 10x `runAccountFailover`'s own 300s one —
this fast path almost always observes `recovery.shouldHeal` and flips the
row to `"running"` before the slower path's own next tick ever sees
`state === "degraded"` again. Design §1's wake, added only inline in
`runAccountFailover`'s own `working` branch, would therefore be unreachable
in the common case: the row still heals (unchanged, as it always did), but
the new wake never fires — reproducing #158's original symptom even with
Design §1 and §2 both otherwise correct.

**Fix: extract the heal-write + `inlineExhaustionHealed` + gated-wake logic
into ONE shared function, `healDegradedRowAndWake` (`failover.ts`), called
from BOTH places that ever heal a degraded row.** Same extraction pattern
#274 itself already established for `evaluateDegradedRecovery` — that
function's own doc comment states the reason directly: "so BOTH the slow
300s `runAccountFailover` path and the fast 30s ship-tick path ... make
EXACTLY the same call from the same evidence." `healDegradedRowAndWake`
owns: computing `clearedAt` from `recovery.shouldHeal` ANDed with the
caller's own `opLockFresh`; building and writing the healed `StudioStatus`
(`state`, `rateLimited`, `autoContinueAt`, `autoContinueLastTriedAt`,
`operatorParked`, `exhaustionClearedAt` — do.ts's own PRE-#158 heal write
only ever cleared the first three of these six; folded into this one
shared write rather than left as two subtly different `cleared` shapes);
performing the write + the registry-mirror call; and firing the gated wake
when `inlineExhaustionHealed` holds and the caller's own `safeToWake` signal
allows it.

Does NOT own `runAccountFailover`'s own #186 redraw-guard retirement
(`forget` — resets `failoverBlock`/`failoverBlockOccurrences`/
`claudeAccountMovedBlock`): that is specific to the slower, account-switch-
aware path and has no 30s-path equivalent (the fast tick has never written
those fields), so `runAccountFailover` folds any such reset into the row it
passes in BEFORE calling the shared function, rather than the shared
function knowing about it.

**`safeToWake` — the two cadences do not share an equivalent "pane is not
mid-turn" signal, so each threads its own:**
- `runAccountFailover` (300s): `!verdict.repainted` — a genuine two-capture
  comparison (`detectRateLimitModal`'s own probe, `PANE_QUIESCE_SECONDS`
  apart). Unchanged from Design §1's original mechanism.
- `runShipTickWithObservation` (30s, #274): has no two-capture signal at
  all — its own exec captures the pane ONCE per tick (#274's own "zero
  added execs" design). Threads `result.paneVerdict?.kind === "idle"`
  instead: `activity.ts`'s `readActivityFrame`, parsed from the SAME
  `SECTION_PANE` frame #221 already reads for THIS tick's activity verdict
  (no new exec here either) — `"idle"` means claude's own idle input box is
  on screen with no working-spinner status line, which is a NARROWER,
  strictly more conservative substitute than `!repainted`: any non-idle
  frame (`working`, `waiting-members`, `waiting-question`, `unknown`) skips
  the wake, where `!repainted` would only skip on a detected mid-turn
  repaint specifically. Verified, not assumed, before choosing it — see
  Residuals below for the one gap this substitution leaves open.

## Files touched

- `apps/fleet/src/studio/failover.ts` — the heal-site addition (§1); the new
  `StudioStatus.operatorParked`-aware `inlineExhaustionHealed` condition
  (post-review finding 1); the new shared `healDegradedRowAndWake` export
  and its two `!next`-branch write sites now stamping `operatorParked`
  (post-review finding 1); `runAccountFailover`'s `working` branch now
  calling the shared function instead of its own inline heal+wake logic
  (post-review finding 3).
- `apps/fleet/src/studio/do.ts` — `runShipTickWithObservation`'s #274
  fast-path heal block now calls the same shared `healDegradedRowAndWake`
  instead of its own inline write (post-review finding 3, NEW file for this
  plan).
- `apps/fleet/src/studio/types.ts` — new `StudioStatus.operatorParked` field
  (post-review finding 1, NEW file for this plan).
- `apps/fleet/src/studio/wake.ts` — new survey detector + GATE 3 wiring
  (§2), moved to run before the `limit.kind === "modal"` branch rather than
  after it (post-review finding 2).
- `apps/fleet/test/studio.auto-continue.test.ts` — split/extend the inline
  tests per Scope point 5; a new case pinning the #271-park-via-inline-block
  exclusion (post-review finding 1).
- `apps/fleet/test/studio.wake-race.test.ts` — the survey-gate RED tests;
  a new case combining the #144 switched-block fixture with the survey
  fixture, proving the gate now wins regardless of order (post-review
  finding 2).
- `apps/fleet/test/studio.failover-274.test.ts` — new cases proving the
  heal wake fires on the FAST (30s) path alone, not only when
  `runAccountFailover` happens to run first (post-review finding 3, NEW
  file for this plan).
- `apps/fleet/test/fixtures/survey-panes.ts` — new UNMEASURED
  feedback-survey fixture(s).

## Test plan

- `bun run test` (vitest-pool-workers) — all of the above are DO-level /
  pure-function tests, this is the primary lane.
- `bun run bun-test` — only if any new/changed test lives in the bun-test
  lane (check `package.json`'s `bun-test` file list before assuming; if the
  touched test files aren't in that list, this lane is unaffected by this
  change and still must be run once, clean, as part of final verification,
  per `CONTRIBUTING.md`: "Both test lanes matter … alone is half the
  suite").
- `bun run check` — full `tsc --noEmit` across all four tsconfig projects.
- `bun run apps/fleet/scripts/english-check.ts` (from repo root, per
  CONTRIBUTING.md) / `bun run english-check` from `apps/fleet`.
- Run each ONCE, sequentially, never two heavy gates at once (house rule) —
  `bun run test`, then `bun run bun-test` (needs tmux + a real shell;
  confirm container has both before running), then `bun run check`.

## Residuals, stated rather than hidden

- The survey-overlay fixture is UNMEASURED — no real capture of Claude
  Code's feedback-survey overlay exists anywhere in this repo. The detector
  is deliberately conservative; it may both under-match (a real survey shape
  that doesn't match the heuristic) and, less likely given the narrowing in
  §2, over-match something not yet seen. Follow-up: capture a real pane the
  next time the survey appears (`tmux capture-pane`) and feed it back as a
  VERBATIM fixture, same discipline `rate-limit-panes.ts` already follows.
- The inline-exhaustion wake skips firing on a tick where `verdict.repainted`
  is true at the exact moment of heal (§1) — a narrow, one-tick race; next
  tick still heals (state is already `"running"` by then, so nothing re-arms
  it, meaning a wake that loses this race never fires at all, not just
  delayed). Accepted rather than solved: solving it fully would need new
  bookkeeping (a field to retry the wake on a later tick even after heal),
  which is a bigger change than this gap's measured severity (one field of
  the two gaps reported) justifies right now.
- `recovery.parked`'s exact interaction with the dead-account (#141) path is
  stated as "verify during TDD" in Design §1 rather than pre-solved — the
  dead-account detector's own message-prefix function needs a direct read
  before the exclusion condition is final; get this from
  `studio.failover-dead-account.test.ts` and the dead-account message
  builder, not assumed.
- **`safeToWake` on the fast (30s) path is a narrower, single-capture
  substitute for `runAccountFailover`'s two-capture `!verdict.repainted`
  (Design §3) — not an identical signal.** `result.paneVerdict?.kind ===
  "idle"` requires claude's own idle input box AND no working-spinner
  status line on THIS tick's single capture; `!verdict.repainted` requires
  two captures (`PANE_QUIESCE_SECONDS` apart) to be IDENTICAL. A pane that
  is genuinely idle but whose single capture happens to land on an
  `"unknown"`-shaped frame (an unrecognised render, `activity.ts`'s own
  `readActivityFrame` doc comment: "never guess between thinking and
  stopped") skips the wake on the fast path where the slower path's own
  `!repainted` check might not have. Accepted rather than solved: the fast
  path's own PRE-#158 heal (#274) never had ANY mid-turn guard at all before
  this feature — a wake gated on `paneVerdict?.kind === "idle"` is strictly
  no worse than that path's existing risk profile, and heal firing only
  once per degradation means a skipped wake here is the SAME one-tick-race
  trade already accepted for the slow path just above, not a new kind of
  loss.
- The shared `healDegradedRowAndWake` (Design §3) does not retry a skipped
  wake on a later call either — same "heal is at-most-once per degradation"
  invariant as Design §1's original residual, now shared by both cadences
  rather than specific to one.
