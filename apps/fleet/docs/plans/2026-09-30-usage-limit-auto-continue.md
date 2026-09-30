# usage-limit auto-continue after reset (board issue #109, #70 ask 5)

## The gap, as measured

Issue #53/#102 (`src/studio/failover.ts`) already moves a studio to the next
claude account the moment its pane shows the rate-limit modal, and issue #271
already lets an operator turn that off (`FLEET_AUTO_FAILOVER`). Issue #104
adds fleet-wide skip-limited-accounts so a switch never lands on an account
another studio already exhausted. None of that helps once EVERY account is
exhausted at once: `runAccountFailover`'s `!next` branch writes the row
`degraded`, tells the operator (`exhaustedMessage`), and stops — by design,
per its own doc comment ("NO RETRY LOOP ANYWHERE"). The row then sits
`degraded … is parked on the rate-limit modal` until a human does something,
and `wake.ts`'s own gate 3 refuses to help: a select-style modal (`kind:
"modal"`, `!verdict.inline`) is "refused ALWAYS … not the wake, not an Esc",
with the refusal message spelling out the only sanctioned remedy: `ff <id>`,
attach, "press Esc, detach, re-assign" — by hand.

MEASURED, `failover.ts`'s own #214 doc comment: three leads degraded at
22:52Z on 2026-09-24; the maestro dismissed each modal with a lone Esc at
23:32Z; all three resumed and kept committing. Forty minutes of idle billed
container time, and only because a human happened to be watching. `#70` asks
5 that this stop needing a human at all when the reset is knowable, and
degrade gracefully to a bounded retry when it is not.

## Scope: the genuinely exhausted case only

Only `FailoverOutcome.kind: "exhausted"` (the tick that first writes
`degraded` with nowhere left to go, `parkedOn === null` in the `!next`
branch) and its follow-on `"already-degraded"` ticks. NOT the `"parked"`
outcome (issue #271: `FLEET_AUTO_FAILOVER` off, or a candidate account exists
but auto-failover itself is disabled) — that is the operator's own choice to
keep a studio on a fixed account, stated as deliberate in `parkedMessage`,
and must stay manual. The gate for this is exactly the `parkedOn === null`
branch of the `if (!next)` block `runAccountFailover` already has; nothing
about `"parked"`'s code path changes.

## Mechanism: no new scheduler, piggyback the existing 300s tick

`do.ts`'s `syncSessionCycle` calls `runAccountFailover` on every
`SYNC_SESSION_SECONDS` (300s) alarm, itself re-armed by `StudioDO.rearm`
(`STUDIO_TICKS`) — there is no primitive anywhere in this codebase for
"schedule one alarm at an exact future Date" for this purpose; every tick is
fixed-cadence and self-rearming, budgeted by `TICK_DEADLINES_MS.syncSession`
(480s). "Wait for the reset time and resume" is therefore implemented the
only way this fleet implements any deferred action: check, on every regular
tick, whether the due time has passed, and do nothing on the ticks it has
not. No new alarm, no new schedule, no new wake-up mechanism — the same
300s cadence that already detects the modal is what notices the reset.

## Design

### 1. Two new `StudioStatus` fields (`src/studio/types.ts`)

```ts
/** Issue #109: the earliest readable fleet-wide reset among the accounts
 *  tried at the moment this studio's exhaustion was first recorded (reuses
 *  earliestAccountReset, already computed for exhaustedMessage at that call
 *  site) — null when no tried account had a readable reset (the common
 *  case: a select-style modal never prints one). Consumed (set back to
 *  null) the first time an auto-continue attempt fires against it, so a
 *  known reset that does not actually clear the exhaustion falls back to
 *  the same hourly cadence as an unknown one, rather than re-firing every
 *  5-minute tick forever. */
autoContinueAt?: string | null;
/** Issue #109: when an auto-continue attempt (Esc + wake) was last made,
 *  regardless of outcome — the hourly retry-cap clock for an unknown
 *  reset, and the anti-hammer clock for a known one that already fired
 *  once. */
autoContinueLastTriedAt?: string | null;
```

Written alongside the existing `state: "degraded"` / `error: message` write
in the `!next` branch, only on the `parkedOn === null` (genuinely exhausted)
path — never on `"parked"`. `autoContinueAt` is set from `earliestReset`,
already computed at that call site for `exhaustedMessage`'s own `Earliest
reset:` clause, so this costs no new read. Cleared by the SAME #214
recovery path that already clears `rateLimited`/`state`/`error` — the
`working` branch's `cleared` spread (`runAccountFailover`, around the
`heal`/`clearedAt` logic) gains these two fields alongside
`failoverBlock`/`claudeAccountMovedBlock`, so a row that genuinely recovers
carries no stale auto-continue bookkeeping into its next (unrelated)
exhaustion.

A degraded row can be re-written on a LATER tick even while still
exhausted, if `exhaustedMessage`'s own text changes (a fresher
`earliestReset` from another studio's sighting) — the anti-loop guard
compares `existing.error === message` and falls through to a fresh write
when it does not. That fresh write recomputes `autoContinueAt` from the
newer `earliestReset` (self-correcting: a stale estimate is replaced by a
better one), but must spread `existing` for `autoContinueLastTriedAt` rather
than reset it — the hourly cap must survive a message-text refresh, or a
fleet with many studios sighting fresher resets every few minutes could
re-arm the cap and hammer the pane. Stated here so the implementation step
does not silently drop it.

### 2. `dismissModalCmd()` (`src/studio/failover.ts`) — the one narrow exception to "not the wake, not an Esc"

Styled exactly like `accountSwitchCmd()` immediately above it in the same
file: same doc-comment rigor (state WHY, WHAT WAS MEASURED where it
applies, residuals), built through `withStudioTmux`/`STUDIO_TMUX` like
every other tmux command here. ONE shell invocation, no Worker round-trip
in between — the same reasoning `wakeCmd`'s own scan-then-type gives for
why races matter (a modal that clears between a probe and an act must not
get answered by the act):

1. re-capture the pane (`${STUDIO_TMUX} capture-pane -p -t studio:claude`)
   and re-confirm a select-style modal is STILL on screen, immediately
   before sending anything. Cheapest existing check to reuse: `wake.ts`'s
   `looseLimitOnScreen`/`LOOSE_LIMIT_PATTERNS` is a `grep -E` over the tail
   that already runs entirely inside a container exec (no round trip) and
   already exists as an in-shell primitive — `failover.ts`'s own
   `detectLimitOnScreen` is a pure JS function with no shell form, so
   re-confirming with it would need a second Worker-side round trip
   (capture, ship stdout back, parse, decide, exec again), reopening
   exactly the race this command exists to close. `LOOSE_LIMIT_PATTERNS`
   is deliberately biased toward FALSE POSITIVES ("a false negative can
   press Enter on '❯ 1. Upgrade your plan'" — its own doc comment), which
   is the correct bias here too: this command must refuse to act, never
   act wrongly, so treating any modal-shaped row as "still there" and
   backing off to a no-op is exactly right.
2. if still there: send exactly ONE keystroke,
   `${STUDIO_TMUX} send-keys -t studio:claude Escape`. Nothing else — no
   Enter, no digit, no C-u, ever.
3. if the modal is no longer there: do nothing. A no-op, not an error — the
   race window is real (the pane can recover, or a human can already have
   dismissed it, between this tick's earlier `paneCaptureCmd` probe and
   this exec) and must fail toward doing nothing.

WHY A LONE ESC IS SAFE where `wake.ts`'s gate 3 refuses a wake (text +
Enter) into the identical modal shape: Esc is the modal's own CANCEL —
`RATE_LIMIT_MODAL_MARKERS`'/`bottomLimitModal`'s own footer line reads
`Enter to confirm · Esc to cancel`, and every measured select variant
(`accountSwitchCmd`'s own header: V1/V3/#53) draws that footer or an
equivalent. Esc cancels the dialog outright; it can never land on a
highlighted option ("Upgrade your plan", "Add funds") the way a stray digit
followed by Enter could — there is no digit, no Enter, and no text in the
keystroke at all for the modal to interpret as a choice. `wake.ts`'s own
gate-3 comment ("not the wake, not an Esc") is therefore updated by this
feature, and only by this feature, to name the one caller now allowed to
send it — `dismissModalCmd`, gated by its own immediate re-check, never the
generic wake path.

### 3. Orchestration inside `runAccountFailover`'s `!next` branch

Today the `!next` branch does exactly two things: write `degraded` +
notify on the FIRST tick that sees no candidate account, and on every later
tick that still sees the same message, the anti-loop guard returns
`already-degraded` with no write, no exec, no notify at all. This feature
adds one more step, run on BOTH of those ticks whenever `parkedOn === null`
(never on `"parked"`) and the tick's OWN already-captured `verdict` (no
extra pane exec — the same `verdict` this call already computed from
`paneCaptureCmd`) is a genuine select-style modal, `verdict.kind === "modal"
&& !verdict.inline`:

- an INLINE exhausted block (session/weekly/monthly-spend/out-of-credits
  with nowhere to fail over to) is explicitly excluded from the ACT step.
  It needs no Esc at all: it already self-clears through the EXISTING
  `working`-branch/#214 recovery once its own printed reset passes the
  clock (`isResetStale`/`limitKeyIsLive`) — typing anything at it, or
  killing the pane with Esc, is both unnecessary and a needless keystroke
  into a pane that will clear itself. This is also why "parse all known
  limit wordings" (#109's own ask) needs no new parsing work — see §4.

- **due-ness**: `existing.autoContinueAt` set and `now >= autoContinueAt`,
  OR `autoContinueAt` is `null` (unknown reset — the overwhelmingly common
  select-modal case) and (`autoContinueLastTriedAt` is `null` or `now -
  autoContinueLastTriedAt >= 1 hour`). This is literally "unknown reset =
  retry hourly", and it is ALSO the ongoing cadence after a known reset's
  first attempt: on firing, `autoContinueAt` is set back to `null`
  (consumed) regardless of whether it was a known deadline or already
  null, so a first Esc that does not actually clear the exhaustion (the
  fleet is STILL out of room) falls back to the same hourly cap rather
  than re-firing on literally the next 5-minute tick.

- **when due**: exec `dismissModalCmd()`, then call `runGatedWake` (not the
  raw `runWake`) with a short resume prompt, a new `AUTO_CONTINUE_PROMPT`
  constant — proposed wording `"usage limit reset — resuming"`.
  `runGatedWake` over `runWake` because it is the ONE place in this
  codebase that already re-derives, from a fresh probe, "is claude even up,
  and is a limit modal still on screen" before typing (gates 1-3,
  `wake.ts`) — reusing it means this feature does not re-implement that
  logic a second time, and its gate 3 re-check is the harmless backstop the
  design calls for: if `dismissModalCmd`'s own re-check raced and the modal
  is somehow STILL there (or reappeared) by the time `runGatedWake` probes
  again, gate 3 refuses the wake exactly as it does today for every other
  caller — a `skipped: true` outcome, not an error, and no keystroke sent.
  `runGatedWake` needs a `GatedWakeDeps`; `runAccountFailover` already
  holds everything to build one inline (`recordedState` from
  `existing.state`, `exec: deps.exec`, `now: deps.now`, `studioId`,
  `switchedBlock` from `existing.failoverBlock`, `limitSighting` from the
  `sighting` this call already read) — no new port on `FailoverDeps`.

- **recording**: `autoContinueLastTriedAt = deps.now()` is written on the
  row EITHER WAY — successful wake or `runGatedWake` refusal — so the
  hourly cap holds regardless of outcome; a repeatedly-refused attempt must
  not retry every tick.

- **state/error are not touched by this step.** Recovery to `running`
  stays entirely owned by the EXISTING #214 `working`-branch logic on a
  LATER tick, once the pane genuinely shows claude idle with no limit on
  it (`evaluateDegradedRecovery`). This step's only job is getting the
  pane to a state where THAT check can eventually pass — it never writes
  `state`, never writes `error`, and never itself declares the studio
  recovered.

This is a deliberate, narrow amendment to `runAccountFailover`'s own "NO
RETRY LOOP ANYWHERE" doc comment: it is still true that no account is ever
retried, and the three guarantees that comment lists (forward-only account
walk, switch-always-recorded, degrade-once) are untouched — this adds a
SEPARATE, explicitly bounded retry of the DISMISSAL, capped at once per
known-reset-due-moment plus once per hour thereafter, never of the account
list itself. The plan for implementation should update that doc comment to
say so explicitly, rather than let the two statements sit side by side and
look contradictory.

New `FailoverOutcome` kinds, since this file logs every outcome but
`no-modal` (`syncSessionCycle`'s own doc comment) and a decision nobody can
see in a tail is a decision nobody can audit — the same reasoning
`"rerender"`/`"flap-guarded"`/`"recovered"` each already state for
themselves:

```ts
// A currently-exhausted, select-modal-shaped row whose due-check said "not
// yet" — carries what an operator needs to know WHY nothing happened.
| { kind: "auto-continue-waiting"; tried: string[]; dueAt: string | null }
// An attempt was made: `dismissed` is whether the re-check found the modal
// still there (and so actually sent Esc) vs. already gone (no-op);
// `wake` is runGatedWake's outcome, coarsened to never carry a token or a
// raw error string, matching every other outcome in this file.
| { kind: "auto-continued"; tried: string[]; dismissed: boolean; wake: "ok" | "skipped" | "failed" }
```

`"auto-continue-waiting"` replaces `"already-degraded"` ONLY on the path
this feature actually evaluates (`parkedOn === null`, select-style modal);
an inline-exhausted row, or a caller with no auto-continue wiring at all
(a `FailoverDeps` that predates this feature — none proposed here, but
kept as the same "everything optional, everything degrades to today's
behaviour" posture this whole file already uses everywhere else), keeps
returning `"already-degraded"` unchanged.

### 4. Parsing coverage — already done, and this is a claim worth stating plainly

`rate-limit.ts`'s `RESETS`/`parseResetUtc`/`isResetStale`, via
`failover.ts`'s `INLINE_LIMIT_HEADLINES`/`RESETS` grammar, ALREADY parse
every known wall-clock wording this fleet has measured: session, weekly,
and monthly-spend reset clauses (`INLINE_LIMIT_HEADLINES`'s own doc
comment: counted from real transcripts, session 83, monthly spend 19,
weekly 9, out of credits 2). A select-style modal — the ONLY shape this
feature acts on — is measured, across every fixture in
`test/fixtures/rate-limit-panes.ts` (V1/V2/V3) and every live capture named
in `failover.ts`'s header, to NEVER print a reset at all: its footer is
`Enter to confirm · Esc to cancel`, never a clock. "Parse all known limit
wordings" is therefore already satisfied by code that ships today — this
plan adds NO new wording, NO new regex, and NO new parsing. The "unknown
reset" case this feature's hourly retry exists for is consequently not an
edge case to special-case around; it is the OVERWHELMINGLY COMMON case for
a select-style modal specifically, which is exactly why the hourly-retry
fallback is this feature's PRIMARY path, not a rare corner of it.

## Files touched

- `src/studio/types.ts` — `autoContinueAt`, `autoContinueLastTriedAt` on
  `StudioStatus`, documented alongside `failoverBlock`/`rateLimited`.
- `src/studio/failover.ts` — `AUTO_CONTINUE_PROMPT`, `dismissModalCmd()`,
  the due-ness/attempt step inside the `!next` branch's anti-loop guard and
  first-write path, the two new `FailoverOutcome` kinds, the `working`
  branch's `cleared` spread gains the two new fields, and the "NO RETRY
  LOOP" doc comment gains a paragraph naming this feature's own bounded
  exception.
- `src/studio/wake.ts` — gate 3's doc comment ("not the wake, not an Esc")
  gains one sentence naming `dismissModalCmd` as the sole, narrowly-gated
  exception; no behavioural change to `runGatedWake`/`runWake` themselves.
- `src/studio/do.ts` — none expected: `runAccountFailover`'s signature and
  `syncSessionCycle`'s call to it are unchanged: `FailoverDeps` already
  carries `exec`/`now`/`accounts`/`notify`, and `runGatedWake`'s
  `GatedWakeDeps` is built inline from those plus `storage`, not threaded
  in from outside.

## Test plan

- `test/bun/usage-limit-dismiss.test.ts` (new, real tmux — same pattern as
  `test/bun/claude-account-switch.test.ts`'s `fakeTmux` harness and
  `accountSwitchCmd` describe block): `dismissModalCmd()`'s shell, run for
  real, sends `Escape` and ONLY `Escape` when a select-modal pane
  (`MODAL_PANE`-shaped, or a real V1/V3 fixture from
  `test/fixtures/rate-limit-panes.ts`) is showing; sends NOTHING (no
  `send-keys` call at all) when the pane shows an idle prompt instead;
  never sends `select-window`/`select-pane`/`switch-client`/
  `attach-session` (same forbidden-substring discipline every other real-
  tmux test in this file's neighbourhood already asserts).
- `test/studio.auto-continue.test.ts` (new, vitest, fake `FailoverDeps`/
  `storage` — same shape `test/studio.account-failover.test.ts` and
  `test/studio.failover-274.test.ts` already use) covering:
  - known-reset, not yet due — no exec beyond the existing probe, no
    write, `"auto-continue-waiting"`;
  - known-reset, due — `dismissModalCmd`-shaped exec and a wake attempt
    happen, `autoContinueLastTriedAt` set, `autoContinueAt` consumed back
    to `null`, `"auto-continued"`;
  - unknown-reset, first tick — attempted immediately
    (`autoContinueLastTriedAt` was never set);
  - unknown-reset, second tick within 1h — no attempt, `"auto-continue-
    waiting"`;
  - unknown-reset, after 1h — attempted again;
  - inline verdict, exhausted, nowhere to fail over — never attempts Esc or
    wake, relies entirely on the existing #214 working-branch recovery
    (`"already-degraded"` unchanged, no new fields written);
  - `"parked"` outcome (auto-failover off) — `autoContinueAt`/
    `autoContinueLastTriedAt` never written, auto-continue never attempted,
    matching `parkedMessage`'s own "no switch attempted" contract;
  - the `working`-branch recovery clear (#214) also clears both new fields
    on a genuine heal.
- Both lanes: `bun run check`, `bun run test`, `bun run bun-test`.

## Residuals, stated rather than hidden

- **A false "still exhausted" read right after a genuine reset**, if the
  container/pane has not repainted yet by the time this tick's probe runs.
  Self-heals on the very next 300s tick — the same self-healing posture
  every other verdict in this file already has, and no worse than today's
  entirely-manual dismissal, which has the identical race.
- **An Esc sent into a DIFFERENT modal** that happens to share the same
  marker shape `looseLimitOnScreen`/`LOOSE_LIMIT_PATTERNS` matches (a
  permission prompt, say — issue #221's own fix-round-2/3 residuals already
  note this shape is not exclusive to the rate-limit modal). Bounded by the
  same re-check-immediately-before-sending discipline `accountSwitchCmd`
  already relies on elsewhere in this file, and by the keystroke itself:
  Esc is a safe cancel for a permission prompt too (it never confirms
  one), so even a mismatched-modal Esc costs at most one cancelled prompt,
  never a wrong "yes".
- **The wake right after Esc lands on a lead with genuinely nothing to
  resume** — the fleet is still out of room, or the account that reset is
  the very one that already told the whole fleet it was limited a moment
  ago and gets marked limited again next tick. Harmless: no different from
  any other wake into an idle lead (`AUTO_CONTINUE_PROMPT` is a short,
  generic nudge, not a claim that work exists), and the hourly cap this
  feature already imposes is what stops that from repeating every 5
  minutes.
- **The anti-loop guard's own "no write, no exec, no notify" invariant is
  now conditionally false** for a currently-exhausted, select-modal row:
  roughly once an hour (or once at the known reset), that tick DOES exec
  twice and write once. Stated plainly because `runAccountFailover`'s own
  doc comment currently promises "the common case is one container exec
  and no writes at all" for every `already-degraded` tick — still true for
  the overwhelming majority of ticks under this feature (55 of 60 minutes,
  roughly), but no longer true for literally every one of them, and the
  updated doc comment (§3 above) must say so rather than leave the two
  statements looking contradictory.
- **A message-text refresh (a fresher `earliestReset` from another
  studio's sighting) re-writes the degraded row** without being a genuine
  "first" degradation. `autoContinueAt` is recomputed (self-correcting:
  a better estimate replaces a stale one) but `autoContinueLastTriedAt`
  must be preserved from `existing` across that write, or the hourly cap
  could be silently re-armed by an unrelated fleet-wide sighting on a busy
  fleet. Called out here so the implementation does not drop it by
  spreading the wrong object.
