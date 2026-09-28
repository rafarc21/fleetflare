# A comment on an existing task never wakes its studio — #236

Date 2026-09-25. Board issue: https://github.com/rafarc21/fleetflare/issues/236

## Problem

Measured live: an operator (or the maestro) comments an unblock on a task
parked `input_required`, and the studio that owns that task never sees it.
The only thing that reliably wakes a studio today is filing a BRAND NEW task
(`fleet task new --studio`), which goes through `wakeOnAssign`
(`src/board/assign-wake.ts`). A comment on an EXISTING task does nothing —
there is no wake path for it at all.

`src/github/webhook.ts`'s `handleGithubWebhook` has exactly one wake path for
a non-`push` event: `wakeMaestro`, which resolves `maestroIdFor(repo)`
(`src/github/wake-events.ts`) and wakes ONLY that repo's single maestro
studio. It has no concept of "which studio owns THIS specific commented-on
issue" — it is a supervision wake for the maestro, not a delivery mechanism
for the task's own assignee. `deltaDigest`'s handling of `issue_comment`
builds a generic "something happened, maestro should look" one-liner
(comment author + excerpt) for that same supervision wake; it is a different,
more generic mechanism than what #236 needs and is left untouched.

This is the same root-cause family as two other issues, both since merged:
- **#158** (fixed by #159, merged): a same-studio reassignment never woke
  anyone, because the wake edge only fired on the FIRST assignment.
- **#213** (fixed by #229, merged): a task filed at a stopped studio was
  never delivered once the studio came back up, because nothing
  re-delivered it on bring-up.

All three are instances of one gap: the board can change (or receive new
information) while a studio holds no open turn, and nothing outside the
studio notices and hands it one. #236 is the "a comment landed" instance of
that gap.

## Trigger conditions

A qualifying `issue_comment` event (`action: "created"` only — an edit or a
delete of an existing comment carries no new instruction and must not
re-fire this) wakes the task's assignee when EITHER is true:

**(a) The task's board state is `input_required`.** This is the state that
exists specifically to say "waiting on an answer" — any new comment on such a
task is a plausible candidate for being that answer, so no extra marker is
required.

**(b) The comment carries an explicit marker.** For a task assigned to a
running studio in ANY state — not only a "live" one — a plain comment is
ambiguous — is it an instruction, or just discussion? The issue itself names
`/wake` as an example marker; this design adopts it literally: a comment
whose FIRST LINE is exactly `/wake`, or starts with `/wake ` (the literal
string followed by a space), is treated as an explicit wake request
regardless of the task's current state, including a `completed` or `closed`
task — a completed task might still get a legitimate late comment worth
surfacing, and nothing about an explicit request should depend on the
board's current state label. (An earlier draft of this section said "any
other live state" here while also saying "regardless of state" two sentences
later — a contradiction; the code has always implemented "any state", not
"any live state", and this text is corrected to match the code, not the
other way around.) The first-line-only rule keeps the check cheap and
unambiguous — a marker buried mid-comment is easy to miss and easy to spoof
by quoting someone else's comment.

Board state is read directly off the label list the `issue_comment` payload
already carries (`issue.labels[].name`), through `taskStates` (existing,
`src/board/types.ts`). If the label set is ambiguous — zero or more than one
state label present, which only happens if something other than this Worker
edited labels by hand — the task is treated as NOT `input_required`, falling
back to requiring the explicit marker. Ambiguity should never silently
upgrade into a wake.

## Bot / studio-comment exclusion

A studio's own §6 envelope comment (the structured result/status comment it
posts back to the board) must never trigger this path. If it could, a lead
posting its own result would wake itself — a self-sustaining loop, exactly
the failure mode `wake-events.ts`'s `WAVE_LOG_TITLE` exclusion already exists
to prevent for the maestro's wave log.

Two signals gate this, per the issue's own spec ("bot/studio comments never
trigger") — but they are NOT equally load-bearing on every repo, and round 2
of this fix (review verdict: HOLD) corrected an earlier draft of this section
that overclaimed the second one's reach:

1. **`parseEnvelopeComment(body) !== null`** (`src/board/envelope.ts`) — the
   primary signal, and the ONLY one that holds on every repo. A real §6
   envelope is a very specific fenced-JSON shape a human typing an unblock in
   plain English will never accidentally produce, so this alone already
   excludes every studio ENVELOPE comment; plain (non-envelope) studio
   comments are a residual, covered below. This check is ABSOLUTE: nothing,
   including an explicit `/wake` marker, overrides it.
2. **The comment author's login ends in `[bot]`** — reusing this codebase's
   existing, established convention (`webhook.ts`'s own `sender.login`/
   `pusher.name` handling on the push path, and `wake-events.ts`'s
   `deltaDigest` reading `comment.user.login`) of trusting the
   GitHub-populated actor field over any hand-typed metadata. But per
   `wake-events.ts` line ~40's own precedent ("Every fleet actor
   authenticates as the same installation, so the sender's login cannot
   distinguish maestro from a studio"), this signal is **inert on TOKEN-auth
   repos**: on every `rafarc21/*` repo (`wrangler.jsonc`'s `GITHUB_REPO_AUTH`
   does not list `rafarc21`, so it falls through to the token path), the
   operator, the maestro, every studio, AND this Worker itself all
   authenticate as the same PAT and post as plain `rafarc21` — never a
   `[bot]` login. On that class of repo, envelope SHAPE (signal 1) is the
   ONLY real discriminator; signal 2 never fires at all.

   On APP-auth repos (`acme-org`, `demositeltda`, `acme-hq`, per
   `wrangler.jsonc`'s `GITHUB_REPO_AUTH`), signal 2 is real: the cloud
   maestro posts as `example-bot[bot]` (measured: 48 WAVE comments on
   `acme-org/websites`). Fix round 2 corrected a bug here — the `[bot]`
   exclusion previously ran unconditionally, so even an explicit `/wake` from
   the maestro's own `[bot]` login never triggered this path. As of round 2:
   an explicit `/wake` marker beats the `[bot]` filter (never the envelope
   check), so **the cloud maestro must lead its comment with `/wake` to ever
   trigger this path** — a plain `[bot]`-authored comment with no marker
   still never wakes anything, by design.

Given envelope shape is the only reliable discriminator on TOKEN-auth repos,
this design's residual, honestly-stated exposure there is:

- A studio posting a PLAIN (non-envelope) comment on its OWN `input_required`
  task — and studios do post plain comments sometimes, e.g. `"PR up: ..."` or
  `"Conflict resolved ..."` — would wake itself. This is accepted risk, not a
  gap this design closes: an extra wake costs at most one wasted turn (see
  the dedup decision below for the same reasoning applied to a different
  case).
- A Worker-side `fleet task verify` comment on an `input_required` task would
  also wake its assignee. This is operator-invoked (a human ran the command)
  and accepted as fine.
- The lineage-comment path (`renderLineageComment`, posted by this Worker's
  own `assignTask` on an adopt or a reassign) and the close-comment path
  (`src/board/close-action.ts`, posted on auto-close-on-promote specifically,
  when a push closes the issue by promoting it) are each safe only BECAUSE of
  write ORDER: the board's state label resets to a non-`input_required` state
  BEFORE that comment posts. If either ordering ever changed, that path would
  start self-waking on TOKEN-auth repos with no `[bot]` signal to catch it.
  This is stated here explicitly rather than left implicit, since it is
  exactly the kind of invariant a future refactor could silently break.

Either signal 1 or 2 is sufficient to exclude a comment when it applies; the
explicit marker (see "Trigger conditions" above) overrides signal 2 only,
never signal 1.

## Which studio gets woken

The commented-on issue's OWN labels, via the existing `taskAssignees(labels)`
(`src/board/types.ts`) — never the repo's maestro. If the label set resolves
to zero assignees (a backlog task nobody owns) or more than one (drift — a
hand-edited issue carrying two `studio:` labels), no wake is sent: there is
no single unambiguous target, and guessing one converts "no wake" into
"wrong studio woken", the exact failure `maestroIdFor`'s own `null` posture
already refuses to risk.

The wake itself goes through the same gate stack `wakeOnAssign`
(`src/board/assign-wake.ts`) already established for "board event -> targeted
studio wake": ask the D1 registry for the assignee's recorded state BEFORE
touching a Durable Object (never `stopped`, never absent from the registry),
then call the DO's `wakeStudioOnAssignment` RPC, which runs
`runGatedWake` — the stopped/never-provisioned refusal, the claude-pane
probe, and the single-flight lock — exactly the same path an assignment-time
wake takes. `wakeStudioOnAssignment` is the right method (not `wakeStudio`):
per its own doc comment in `src/studio/do.ts`, it deliberately does NOT arm
the maestro's supervision sweep, because arming that clock is the maestro's
own job and this is a targeted nudge to a studio of any role, not a
supervision signal.

This implementation does not import or call `wakeOnAssign` itself, nor touch
`src/board/assign-wake.ts`: the digest it builds (`assignDigest`) is
task-only and has no notion of a comment URL. A new, small, standalone module
(`src/board/comment-wake.ts`) mirrors `wakeOnAssign`'s gating shape — same
`AssignWakeDeps` port, same refusal reasons for "not in the registry" and
"stopped" — against a digest built for this trigger instead. This was a
deliberate near-duplication of a ~20-line gating body rather than a
refactor of already-reviewed, already-tested code while #159/#229 were still
in flight touching the same wake machinery (see the coordination note below —
both have since merged); unifying it is named
explicitly as follow-up work below.

## Digest format

One line, always — the same constraint `assignDigest` documents: a literal
newline typed into the claude TUI is a SUBMIT, so a multi-line digest would
arrive as several half-prompts. Per the issue's own output-format spec
("naming the task and the comment URL"), round 3 (review verdict: HOLD on
MUST 1) restores the exact 3-part line — a read-pointer APPENDED onto the
comment-URL digest, not a replacement of the URL:

```
WAKE TASK COMMENT #<n> "<title>" | <comment html_url> | read: fleet task show <n>
```

Both parts earn their place, for two different reasons:

- The comment's own `html_url` says WHICH comment is new — useful when
  several land close together (see the two-in-a-row test, "Tests" below).
- The trailing `read: fleet task show <n>` pointer covers the lead reading
  the WHOLE thread, which matters specifically because a burst wake can be
  refused, not queued: `runGatedWake`'s single-flight lock (see the "Dedup
  decision" section below) means a later comment in a fast burst can have
  its OWN wake dropped, so its content might only ever be visible by reading
  the thread, not from any single digest.

Deliberately a pointer to the comment (and the task), not a copy of the
comment's body: the lead reads the comment itself (and the task) with a real
turn, rather than being handed a possibly-truncated excerpt to act on blind.
The title is flattened the same way `assignDigest`'s is (via `oneLine`,
`src/github/wake-events.ts`, issue #159), since a GitHub issue title is
attacker- or at least operator-controlled text and nothing already
guarantees it is one line as typed.

## Dedup decision: no persisted "already woken" tracking

#159 and #229 both add protection against re-waking for something a studio
has ALREADY seen — a same-studio reassignment that changed nothing on the
board, or a bring-up re-delivering the same already-known task on every
container restart. Both are solving "repeat wake for UNCHANGED information."

#236's trigger is different in kind: each qualifying comment IS new
information — an operator's actual, once-said unblock text, uniquely
identified by its own comment id/URL. There is no "the same comment fires
twice" case analogous to #159/#229's "the same assignment fires twice",
because GitHub only delivers `issue_comment.created` once per comment (a
redelivery after a timeout is the one exception, and that is a duplicate
DELIVERY of the identical event, not a second real occurrence — see below).

Given that, this design adds NO persisted "already woken for this task/
comment" marker. Two consecutive qualifying comments on the same task both
wake it, once each. The alternative — suppressing the second because "we
already woke this studio for this task once" — would silently swallow a
genuinely new unblock, which is a worse failure than one extra wake: a missed
second wake means a stuck task that LOOKS handled (a wake happened
"already"), while an extra wake costs at most one wasted Claude turn if the
lead had nothing new to act on.

The repeat-wake risk of two overlapping deliveries racing each other in the
same Worker isolate is PARTIALLY covered by `runGatedWake`'s single-flight
lock (`singleFlightWake`, `src/studio/wake.ts`, applied uniformly to every
call through `wakeStudioOnAssignment`) — round 2 of this fix corrects an
earlier draft's overclaim here ("that lock is sufficient"), which is not an
accurate description of what `singleFlightWake` actually does:

- The lock is **in-memory**, held on the DO instance's own `{ busy: boolean }`
  field. It is only effective against CONCURRENT calls landing on the SAME
  live isolate; it says nothing about calls separated in time or landing on
  an isolate that was evicted and recreated in between.
- On a race, the lock **REFUSES** the second call — `singleFlightWake`
  returns `{ ok: false, skipped: true, ... }` immediately. It does NOT queue
  the second wake for later and does NOT retry it. If two DISTINCT
  qualifying comments land close together and race into this lock, the
  second one's wake attempt is refused (logged as `skipped`, per
  `logWakeOutcome`), not delivered on a delay — that comment's own wake is
  simply dropped. The comment itself is not lost (it stays on the issue), but
  nothing in this path re-surfaces it once its own wake attempt has been
  refused — the NEXT successful wake on that task is the only thing that
  gives the lead a reason to look at the issue again.
- There is **no deduplication of a genuinely redelivered webhook** anywhere
  in this path — no `X-GitHub-Delivery` id is read, stored, or compared
  against a prior delivery. If GitHub redelivers the same `issue_comment`
  event after a timeout, this path processes it exactly as if it were new
  and, if it still qualifies, wakes again (assuming the first wake is no
  longer in flight, so the single-flight lock does not apply). This is a real
  residual gap, not one this design closes.

In short: the single-flight lock covers exactly one case (two calls racing
concurrently within the same isolate) and covers it by refusing, not
absorbing. It does not cover a burst of genuinely distinct qualifying
comments arriving with enough spacing to each acquire the lock in turn (both
wake, as intended — see the dedup decision above), and it does not cover a
redelivered or duplicate webhook. No new lock, no new stored marker is added
here; this section states the existing lock's real scope rather than
overclaiming it.

## Coordination note: #159 and #229

Neither #159 nor #229 is depended on here — this implementation stands alone
against current `main`. Both are now MERGED (confirmed: `main` is at
`8ca4d912` or later, which includes #229/#213, merged and deployed). This
implementation was written and reviewed while both were still in flight, and
stands alone by design, not because either was unavailable at merge time.
There is still a real consolidation available: both #229's bring-up-delivery
path and this issue's comment-triggered path are, underneath, answering the
same question — "has this studio's CURRENT task content already reached
it?" — just from two different triggers (a container coming back up vs. a
comment landing). #229's persisted dedup marker keyed on `(studio, task)`
for its own re-delivery-on-restart problem is a plausible shared home for a
FUTURE version of this path's decision too, IF a future requirement ever
wants "one wake per task doesn't double up across trigger types" — which
this design deliberately does not need today (see the dedup decision above:
each new comment is new information, not a repeat of the same information
#229 guards against). This is stated as a follow-up worth revisiting now
that #229 has landed, not as work done now, and not as a reason this design
should have waited on it.

## Tests

Five scenarios, fixture-based against `test/github.webhook.test.ts`'s
existing `issue_comment` payload shape and `post`/`sign`/`fakeCtx` helpers:

1. `input_required` task, assigned to studio X, a genuine operator comment ->
   exactly one gated wake, targeted at X, naming the task and comment URL.
2. The studio's own §6 envelope comment on the same shape of task -> no wake.
3. A `working` task with a plain comment and no marker -> no wake (the
   "marker required outside `input_required`" half of the spec).
4. A task in any state, assigned to a RUNNING studio, comment
   starting with `/wake` -> one gated wake.
5. Two genuine `input_required` comments in a row on the same task -> BOTH
   wake (proving the no-extra-dedup decision above).
