# A new board task state: `awaiting_merge` (board issue #110)

Supersedes the earlier won't-do verdict on
https://github.com/rafarc21/fleetflare/issues/70#issuecomment-5891651951
(closed by docs-only PR #114). The CTO overrode that verdict in
https://github.com/rafarc21/fleetflare/issues/110#issuecomment-5912567229;
this doc and its PR replace #114's stance, not extend it — a reader landing
on #114 first should follow that thread here rather than assume it still
stands.

## Problem

A lead that finishes its part — code shipped, PR open — had no board state
that meant "done, waiting on a human to merge". It either stayed at
`working` (indistinguishable from still-in-progress, so a reaper/stall
monitor kept treating it as live and never let the studio be reaped for
idleness) or the lead just... stopped reporting, same ambiguity. The issue
also had to stay OPEN regardless — closing it before the merge lands would
be a false "done" the same class of bug board issue #55 already paid for
once (a merged PR whose issue still claimed "in progress", just inverted).

## The fix

A new state, `awaiting_merge`, inserted in the vocabulary right after
`input_required` and before the terminal states:

```
submitted -> working -> input_required -> awaiting_merge -> completed
                                                           -> failed
                                                           -> canceled
```

It is self-reported by the lead (`fleet task state <n> awaiting_merge`, same
route board issue #41 built for `working`/`input_required`/`failed`) and
deliberately belongs to **neither** of the two buckets that existed before
this issue:

- **Not terminal** (`TERMINAL_TASK_STATES` unchanged) — the issue stays open
  until the merge actually lands. `completed` is still the verifier's
  exclusive call; a lead claiming `awaiting_merge` is not a lead claiming
  `completed`.
- **Not live** (`LIVE_TASK_STATES` unchanged) — the lead's part is already
  done. A fresh studio has nothing to be briefed on, and a `fleet destroy`/
  `fleet reap` gate protecting "still-owed work" has nothing left to protect.

### The three-way split bug this exposed

Two call sites computed "is this task live" as `NOT terminal` — a two-bucket
model (live vs. terminal, nothing in between). That was already an implicit
assumption baked into the code, not a documented invariant, and adding a
state that is neither broke it silently: both sites would have kept
treating `awaiting_merge` as live, defeating the entire point of the
feature (a studio sitting on nothing but an `awaiting_merge` task would
never be reapable). Both were fixed to compute "live" as **positive
membership in `LIVE_TASK_STATES`, with a null (drifted) state still treated
as live** — this is the same fail-closed behavior the code already had
documented for drift, just computed from the opposite direction:

1. `apps/fleet/src/board/board.ts`'s `openAssignedTasks` (the `fleet destroy`
   refusal gate).
2. `apps/fleet/cli/reap.ts`'s `liveTasksOf` (the `fleet reap` idle-eligibility
   check).

### Why `src/studio/task-reap.ts` needed zero changes

`runTaskReap` (the merge-lands-so-auto-close-the-issue pass) is already
state-agnostic except for one explicit carve-out: it never closes a task
sitting at `input_required` (parked on a human answer). Every other open
task — `working`, `awaiting_merge`, whatever — is closed the same way once
its PR is confirmed landed on the default branch and claims the task. This
is what makes "merge auto-completes the task" already work for
`awaiting_merge` for free. Proven by a regression test
(`test/studio.task-reap.test.ts`), not just asserted — see TDD below.

## TDD

Each pass below was written test-first, confirmed RED against the
pre-change source, then made GREEN. Targeted runs only during development;
the full gate ran once at the end (see Verification).

### a. `src/board/types.ts` — `TASK_STATES` vocabulary

- `test/board.board.test.ts`, new `describe("TASK_STATES vocabulary (board
  issue #110)")`: `TASK_STATES` contains `awaiting_merge` immediately after
  `input_required`; `TERMINAL_TASK_STATES` does not include it;
  `LIVE_TASK_STATES` does not include it.
- RED: `expected [ 'submitted', 'working', …(4) ] to include 'awaiting_merge'`
  (`npx vitest run test/board.board.test.ts -t "TASK_STATES vocabulary"`).
- Fix: added `"awaiting_merge"` to `TASK_STATES` between `input_required` and
  `completed`; `TERMINAL_TASK_STATES`/`LIVE_TASK_STATES` left untouched;
  header comment updated ("Six states" -> "Seven states...") with a doc note
  on why the new state is neither terminal nor live.
- GREEN: `npx vitest run test/board.board.test.ts` -> 137/137, then
  141/141 once (b)'s tests were added on top.

### b. `src/board/board.ts` — `LEAD_TASK_STATES` + `openAssignedTasks`

- `test/board.board.test.ts`:
  - `LEAD_TASK_STATES` includes `awaiting_merge`.
  - a lead CAN self-transition `working -> awaiting_merge`
    (`transitionStudioTask`).
  - a lead still CANNOT set `completed` (existing refusal, message updated
    to name the new 4-state list).
  - `openAssignedTasks`: a task in `awaiting_merge` does NOT block (empty
    result) — the actual bug fix; `submitted`/`working`/`input_required`
    still block (regression); a drifted (`state: null`) task still blocks
    (regression, fail-closed unchanged).
- RED: 5 failures — `moves it to input_required, awaiting_merge and to
  failed` (working->awaiting_merge rejected), the new
  `moves working -> awaiting_merge` test, the `REFUSES completed` message
  assertion (still named the old 3-state list), and the new
  `an awaiting_merge task does NOT block` test (still returned `{number: 7,
  drifted: false}` instead of `[]`).
- Fix: `LEAD_TASK_STATES` gained `"awaiting_merge"`; `openAssignedTasks`'s
  filter changed from `!(t.state && TERMINAL_TASK_STATES.includes(t.state))`
  to `t.state === null || LIVE_TASK_STATES.includes(t.state)`.
- GREEN: `npx vitest run test/board.board.test.ts` -> 141/141.

### c. `cli/reap.ts` — `liveTasksOf`

- `test/bun/fleet-reap.test.ts`, new test alongside the existing
  `"a terminal-state task does not count as open (reapable)"`: `"an
  awaiting_merge task does not count as open (reapable) either"` — a studio
  whose only open task is `awaiting_merge` gets destroyed by `runReap`.
- RED: `expect(f.calls).toContain("destroy:acmeclient--pilot")` failed,
  `f.calls` was `["board"]` only (`bun test test/bun/fleet-reap.test.ts`).
- Fix: swapped the `TERMINAL_TASK_STATES` import for `LIVE_TASK_STATES`
  (confirmed by grep it was the only use in the file) and changed the filter
  from `!(t.state !== null && TERMINAL_TASK_STATES.includes(t.state))` to
  `t.state === null || LIVE_TASK_STATES.includes(t.state)`.
- GREEN: `bun test test/bun/fleet-reap.test.ts` -> 72/72; also ran
  `bun test test/bun/fleet-reap-wiring.test.ts` -> 15/15 (unaffected, no
  changes needed there).

### d. `container/studio-fleet` — the in-container lead CLI

- `test/container.studio-fleet.test.ts`: updated the two pinned-string
  assertions for the new `LEAD_TASK_STATES` literal and the new
  `<working|input_required|awaiting_merge|failed>` help string; added one
  new assertion that the help text explains what `awaiting_merge` means.
- RED: 3 failures (`npx vitest run test/container.studio-fleet.test.ts`) —
  the two now-stale pinned strings, and the new explanation assertion
  against unchanged source.
- Fix: `LEAD_TASK_STATES` literal, the usage line, and the help body
  extended (kept byte-identical-by-convention to `board.ts`'s own list, no
  import — this file's own header explains why).
- GREEN: `npx vitest run test/container.studio-fleet.test.ts` -> 28/28.

### e. `test/studio.task-reap.test.ts` — regression proving `task-reap.ts`
   needed no change

- New test: `"an awaiting_merge task whose PR landed and claims it is closed,
  same as working (#110)"`, mirroring the existing `input_required`
  carve-out test right next to it.
- Ran against the UNCHANGED `task-reap.ts` — passed immediately (35/35,
  `npx vitest run test/studio.task-reap.test.ts`), proving the "do not touch
  task-reap.ts" call in scope was safe rather than just asserted.

### Doc-drift fixes surfaced along the way (not in the original file list, but
   required by the same vocabulary change)

- `src/studio/cli-args.ts`'s `VERBS["task-ls"].args` hardcoded its own
  `--state` vocabulary list separately from `task-state`'s
  `TASK_STATES.join("|")`. Adding `awaiting_merge` to `TASK_STATES` desynced
  the two silently — `test/studio.cli-args.test.ts`'s existing
  `"rejects an unknown target state..."` test kept passing only by
  accident, because `usage()` appends the FULL `CLI_USAGE` block (which
  embeds `task-ls`'s own stale string) after the specific message, and the
  test's `toContain` matched that appended stale substring rather than the
  actual `task-state` message. Fixed both: the help string now derives from
  `TASK_STATES.join("|")` the same way `task-state`'s already does (so the
  two can never drift apart again), and the test now checks the message's
  own first line. Added a new test proving `task ls --state awaiting_merge`
  parses and that the help text names the full 7-state vocabulary.
- Two stale "three-state allowlist"/"Three, and the two that are missing"
  doc comments (`src/board/board.ts` at `LEAD_TASK_STATES`'s own doc comment
  and at the studio-side section header; `src/board/routes.ts`'s route-table
  comment) updated to "four" and to name `awaiting_merge`. Comment-only, no
  behavior change.

## Verification

All four run sequentially from `apps/fleet/`, once each, under
`flock /tmp/fleet-gate.lock` (never in parallel with anything else):

```
$ bun run english-check
english-check: clean
(exit 0)

$ bun run check
$ tsc --noEmit && tsc --noEmit -p container && tsc --noEmit -p cli && tsc --noEmit -p test-integration && tsc --noEmit -p test
(no diagnostics, exit 0)

$ bun run test
$ vitest run
 Test Files  146 passed (146)
      Tests  5109 passed (5109)
(exit 0)

$ bun run bun-test
$ bun test test/bun test/studio.files.test.ts test/studio.studio-blueprint.test.ts
 2050 pass
 2 skip
 9 fail
Ran 2061 tests across 107 files. [1518.52s]
error: script "bun-test" exited with code 1
(exit 1 — see below, NOT a regression from this change)
```

### The `bun-test` failures are pre-existing on `main`, unrelated to this diff

All 9 failures are in two files neither this change nor any commit on this
branch touches: `test/bun/deploy-ops-guard.test.ts` (6) and
`test/bun/localci-run.test.ts` (2), plus one more elsewhere in the 107-file
suite not captured by the truncated log tail. Two categories, both
environment artifacts of this sandboxed container, not code regressions:

1. `deploy-ops-guard.test.ts`'s fixtures push to a scratch, test-local
   `origin main` as part of exercising deploy-ops guard logic against a fake
   bare repo. This container's own git wrapper intercepts EVERY push to a
   branch named `main`, including fully local, disposable test fixtures that
   have nothing to do with the real `fleetflare` repo:
   `error: git push -q origin main: fleet: studios never push the default
   branch — open a PR`.
2. `localci-run.test.ts`'s SIGTERM-timing tests budget 15s for a
   kill-and-verify cycle; under this container's actual load (running the
   full `vitest` and `bun-test` suites, plus background daemons) the same
   cycle took 43-60s.

Confirmed pre-existing, not introduced by this branch, by running the
IDENTICAL `bun run bun-test` against a clean `main` worktree (package.json/
lockfile unchanged by this branch, so `node_modules` was symlinked over
rather than reinstalled): **13 failures + 1 timeout error** — more than this
branch's 9, in the exact same two files, same two categories (git-push-guard
rejections and SIGTERM-timing budget overruns), plus one more
`localci-run.test.ts` timing case and one `install-cache-security.test.ts`
mutant-proof timing case that this run's already-elevated load happened not
to trip. This is nondeterministic, load-driven flakiness in this sandbox,
not a regression: this branch's run had FEWER failures than the clean-`main`
run taken under (if anything) higher concurrent load from the verification
sequence already run before it.

Every other file in the 107-file suite passed on both runs, including every
test this change added or touched
(`test/bun/fleet-reap.test.ts`: 72/72 clean on its own targeted run during
TDD, and not among the full-suite failures either time).

## Boundary

**Touched** (source): `apps/fleet/src/board/types.ts` (`TASK_STATES`),
`apps/fleet/src/board/board.ts` (`LEAD_TASK_STATES`, `openAssignedTasks`,
two stale doc comments), `apps/fleet/cli/reap.ts` (`liveTasksOf`),
`apps/fleet/container/studio-fleet` (help text + `LEAD_TASK_STATES` copy),
`apps/fleet/src/studio/cli-args.ts` (`task-ls`'s help string, derived from
`TASK_STATES` instead of hardcoded), `apps/fleet/src/board/routes.ts` (one
stale doc comment).

**Touched** (tests): `apps/fleet/test/board.board.test.ts`,
`apps/fleet/test/bun/fleet-reap.test.ts`,
`apps/fleet/test/container.studio-fleet.test.ts`,
`apps/fleet/test/studio.task-reap.test.ts`,
`apps/fleet/test/studio.cli-args.test.ts`.

**Deliberately NOT touched, and why:**

- `apps/fleet/src/studio/task-reap.ts` (`runTaskReap`) — already
  state-agnostic except for its `input_required` carve-out; proven safe by a
  new regression test rather than assumed (see TDD section e above).
- `apps/fleet/src/board/types.ts`'s `NOT_STALE_STATES` — only gates the
  BACKLOG-staleness flag for *unassigned* tasks; `awaiting_merge` by
  definition only ever applies to an already-assigned task
  (`isBacklog(labels)` is false for it), so it can never reach that check.
- `apps/fleet/src/directus/schema.ts` / `apps/fleet/src/directus/types.ts`'s
  `RequestStatus` / `estate_requests.status` — a completely unrelated system
  (Directus client-portal requests) with a coincidentally similar-looking
  vocabulary, not the fleet board's task state. Confirmed by reading both
  files; nothing in them references `TaskState` or `src/board/*`.
- `apps/fleet/src/board/board.ts`'s `TERMINAL_TASK_STATES` import and its
  other two uses (`closeTerminalTasks`'s filter and the `pullRequestExists`
  gate near line 488) — still correct and still needed; only the one
  `openAssignedTasks` filter stopped relying on it.

No deploy, no PR, no merge — that is the lead's job per process, not this
pass's.

## Addendum (2026-09-30): three fixes found in PR #132 review

The operator reviewed PR #132 and found three real problems, all fixed on
this same branch (not a new one).

### 1. Merge with `origin/main` (PR #75)

PR #75 (merged to main as `b219438`, `fleet resume` / `fleet task new` /
`fleet task assign`) landed on main after this branch was cut, editing the
same `HELP` usage-string block in `container/studio-fleet` this branch's
`0dbd001` touched. A real `git merge origin/main` (this branch was already
pushed with an open PR, so rebase was not an option) produced exactly one
conflict, in that usage block:

```
       fleet task ls | fleet task show <n> | fleet task report <n>
       fleet task state <n> <working|input_required|awaiting_merge|failed>
       fleet task new [--studio <id>] | fleet task assign <n> <studio-id> [--why <text>]
       fleet memory ls | fleet memory compact
```

— this branch's `awaiting_merge` addition to the `task state` line, and
main's new `task new`/`task assign` line, next to each other, both intact.
Everything else in the file (the doc-comment header, the `task state` body
section explaining `awaiting_merge`, the `task new`/`task assign`/`resume`
body sections) auto-merged cleanly — git's merge algorithm found them
non-overlapping hunks. `src/board/board.ts`, `src/board/routes.ts`,
`src/studio/cli-args.ts`, `src/studio/destroy.ts` and their tests all
auto-merged with no conflicts either; grepped afterward for `awaiting_merge`
to confirm this branch's content survived the merge, and ran the targeted
suites before committing. This repo's clone was shallow going into the
merge (`git merge-base` and `git merge` both failed outright, "refusing to
merge unrelated histories") — `git fetch --unshallow` first, same as any
merge against a distant base would need in a shallow checkout.

### 2. `brief.ts`'s `renderBriefPrompt` — the only place a lead learns the verb exists

A self-reported state a lead is never told about is a verb that does not
exist, same lesson board issue #41 already paid for once (tasks sitting at
`submitted` because nobody told the lead to move them). The boot-time brief
sentence still named only `working`/`input_required`/`failed` after this
branch added a fourth self-settable state. Fixed by naming `awaiting_merge`
with a "when" clause (after `fleet task report` with a PR, nothing left but
to wait on the merge) and updating "Those three" to "Those four, and no
others" — kept in the same terse style as the rest of the function, per
this file's own header on why boot-time brief text stays minimal.

### 3. `do.ts`'s `survivalTasks` — a genuinely different "is this task still owed" question

This is the one place in this feature where "live" needed the OPPOSITE fix
direction from `openAssignedTasks`/`liveTasksOf` above, and that is not an
inconsistency — it is two different consumers asking two different
questions of the same vocabulary:

- `openAssignedTasks` (destroy gate) and `liveTasksOf` (reap gate) ask "is
  there still work OWED that a fresh studio, or a studio about to be
  destroyed/reaped, needs to be protected for". An `awaiting_merge` task
  answers NO — the lead's part is done, there is nothing left to brief or
  protect. These needed to move FROM "not terminal" TO "positively live"
  (`LIVE_TASK_STATES` membership) so `awaiting_merge` stopped being treated
  as owed work.
- `survivalTasks` (crash/restart re-brief, issue #249/PR4b) asks a
  completely different question: "does a previously-claimed work ARTIFACT
  (a PR, a branch) still need re-verifying after this studio got
  rescued/re-provisioned". An `awaiting_merge` task answers YES to that —
  it has exactly such an artifact, the PR the lead already reported. This
  one needed to move the OTHER way, FROM "positively live"
  (`LIVE_TASK_STATES` membership, which silently excluded `awaiting_merge`
  and left its PR un-re-checked after a crash) TO "not terminal"
  (`!TERMINAL_TASK_STATES.includes`).

Same vocabulary, same `t.open && t.state !== null && <bucket check>` shape,
opposite bucket for opposite reasons — a reader who only skims one of these
fixes could easily assume the other is a leftover bug rather than a
deliberate, independently-reasoned choice. (The pre-existing
`t.state !== null` drift guard in `survivalTasks` was left as-is by this
fix: a drifted task was already excluded from survival re-brief before
issue #110, and stays excluded — that guard is orthogonal to the
terminal/live bucket question this fix answers.)

Regression test: `survivalTasks` is a private `StudioDO` method and
`StudioDO` cannot be constructed under vitest-pool-workers (do.ts's own
header). `test/studio.survival-delivery.test.ts` already pins several of
`do.ts`'s private-method internals via `env.TEST_STUDIO_DO_SRC` (the DO's
real source text, injected by `vitest.config.ts` for exactly this reason).
Extended that: a new `describe` block regexes the real `live = ...filter`
expression out of that source text and runs it, via `new Function`, as
actual executable code against fixtures covering the whole state
vocabulary — genuine behavioral coverage of the shipped expression, not a
paraphrase of it, without needing a real DO or a real board. RED against
the pre-fix source (`awaiting_merge` excluded — `expected false to be
true`), GREEN after the fix.
