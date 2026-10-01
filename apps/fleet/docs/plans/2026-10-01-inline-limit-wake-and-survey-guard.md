# inline-limit wake-on-reset, and a survey-overlay wake guard (board issue #158)

> Numbering correction, state this in the PR body too: #158's own text cites
> `#125` for the `autoContinueEligible` gate and `#154` for the `▔`-rule wake
> gate. Neither number matches this codebase. The gate is **issue #109**
> (`apps/fleet/docs/plans/2026-09-30-usage-limit-auto-continue.md`); the
> `▔`-rule is **issue #146** (`wake.ts:51-146`'s own doc comment). `#154` in
> this repo is an unrelated burn-cursor-offset migration (`burn.ts`). This
> plan uses the real numbers throughout.

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
1. Once an inline-exhausted row's `working`-branch heal fires
   (`failover.ts:1867-1889`), and ONLY for a row whose degradation was
   genuinely this feature's own inline exhaustion (never the select-modal
   case, which already gets its wake from `autoContinueAttempt`; never a
   `"parked"` (#271, `FLEET_AUTO_FAILOVER` off) row, which `recovery.parked`
   already excludes by construction — it only reads true for
   `exhaustedMessagePrefix` rows, never `parkedMessage` ones; never the
   dead-account path, #141 — see Design §1 for the exact exclusion), attempt
   ONE gated wake with the SAME `AUTO_CONTINUE_PROMPT` the select-modal path
   already uses (already digit-free, so Gap 2's concern does not even apply
   to this specific wake).
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

Both fixes reuse existing infrastructure — no new scheduler, no new
Durable Object field, no new exec primitive:
- Gap 1 piggybacks on the EXISTING `working`-branch heal tick
  (`runAccountFailover`, called every `SYNC_SESSION_SECONDS` by
  `do.ts`'s `syncSessionCycle`) and the EXISTING `runGatedWake` /
  `AUTO_CONTINUE_PROMPT` machinery #109 already built for the select-modal
  case — same dynamic `import("./wake")` pattern `autoContinueAttempt`
  already uses, same reason (module-init-order cycle, see
  `autoContinueAttempt`'s own doc comment).
- Gap 2 extends the EXISTING `runGatedWake` gate pipeline with one more
  gate, in the same file, same style as the `▔`-rule gate it sits beside.

## Design

### 1. Inline-exhaustion wake on heal (`failover.ts`)

At the `working`-branch heal site (`failover.ts:1867-1889`), `clearedAt !==
null` is already the "this tick heals a degraded row" signal. Add, inside
that same `if (existing.rateLimited || forget || clearedAt !== null)` block,
guarded on `clearedAt !== null`:

- Determine whether the row being healed was genuinely THIS feature's own
  inline exhaustion, not a select-modal exhaustion (already woken via
  `autoContinueAttempt`) and not the dead-account path (#141, which writes
  its own distinct message prefix — verify against
  `studio.failover-dead-account.test.ts` and whatever prefix function it
  uses before finalizing the condition). Candidate signal, already written
  at degrade time and already carried on `existing` into this tick:
  `recovery.parked` (true only for `exhaustedMessagePrefix` rows — already
  excludes `"parked"`/#271 and, confirm during TDD, dead-account rows if
  they use a different prefix) AND `existing.rateLimited` present with
  `!existing.rateLimited.select` (`limitObservation`, `failover.ts:1467-1475`,
  only sets `select: true` for a non-inline/select-modal verdict — so its
  absence on a row already confirmed `recovery.parked` is the inline case).
  Write this as a small named local (e.g. `inlineExhaustionHealed`) so the
  condition reads as a single named fact, not an inline boolean expression.
- When that's true AND `!verdict.repainted` (pane genuinely idle on this
  tick's capture, not mid-turn — same signal the hand-back guard just below
  already reads for the identical reason, "a turn is in flight ... skipping
  it here costs nothing but one more 300s tick"): dynamically `import("./wake")`,
  build `GatedWakeDeps` the same way `autoContinueAttempt` does (reuse that
  function's own construction as a reference, do not diverge), and call
  `runGatedWake(gatedDeps, AUTO_CONTINUE_PROMPT)`. Do not block the heal
  write on this call's outcome — the row still flips to `"running"` this
  tick regardless of whether the wake itself succeeds, skips, or fails
  (matches #214's own invariant: the row describes the PANE, not the wake).
- If `verdict.repainted` is true on the healing tick (mid-turn), skip the
  wake this tick. Document as a residual below — since heal only fires once
  per degradation, a coincidental repaint on the exact healing tick means
  this specific wake never retries. Acceptable: already strictly better than
  today (never wakes at all), and the condition is narrow (one specific
  tick, one specific coincidence).

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

Wire the new detector into `runGatedWake` right after the existing GATE 3
modal check (`wake.ts`, after the `if (limit.kind === "modal") { ... }`
block, before the final `return afterLimitGate(...)`), reusing the SAME
`screen.stdout` already captured for GATE 3 — no new exec. On a hit, return
`{ ok: false, skipped: true, error: "feedback survey on screen in
${WAKE_TARGET}; no keystroke sent — <remedy, same style as the modal
refusal message>" }`.

## Files touched

- `apps/fleet/src/studio/failover.ts` — the heal-site addition (§1).
- `apps/fleet/src/studio/wake.ts` — new survey detector + GATE 3 wiring (§2).
- `apps/fleet/test/studio.auto-continue.test.ts` — split/extend the inline
  tests per Scope point 5.
- `apps/fleet/test/fixtures/activity-panes.ts` (or a new
  `test/fixtures/survey-panes.ts` if that reads cleaner once the fixture
  exists — developer's call) — new UNMEASURED feedback-survey fixture(s).
- A new or existing wake-gate test file (`test/studio.wake-gate.test.ts` or
  similar) — the new survey-gate RED tests.

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
