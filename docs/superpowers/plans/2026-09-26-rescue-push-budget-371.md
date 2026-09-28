# rescue: stop starting pushes near the server deadline; print `RESCUE_FAILED <id> budget <n> not attempted` (board issue #371, #362 follow-up)

## Context — stacks on an unmerged branch

This work is built directly on top of PR #362's own branch
(`fix-359-rescue-all-timeout`, HEAD `8aa02e3` at the time this branch was
created), NOT on `main`. `fix-371-rescue-budget-guard` cannot be merged before
#362 lands, and must be rebased onto `main` once #362 is merged (a lead-level
decision, not made here).

## The problem (issue #371, review of #362)

#362's own fix (`RESCUE_PUSH_TIMEOUT_SECONDS` = 45, `KILL_GRACE_SECONDS` = 5
from `exec-deadline.ts`) bounds every SINGLE stalled push to its own ≤50s
worst case, wrapping it in `timeout -k 5 45 git push ...`. That closes "one
stalled push hangs the whole exec", but does nothing about the AGGREGATE: the
server's own `EXEC_CLASSES.rescue` (`sandbox-api.ts`) wraps the ENTIRE
generated script in one outer `timeout -k <grace> 300` — a hard 300s ceiling
on the whole run, regardless of how many individual pushes it contains. Six or
more genuinely stalled pushes (6 × 50s = 300s) can still exhaust that outer
budget; once it fires, `do.ts`'s `isDeadlineExit` discards EVERY line the
script already printed — including already-successful `RESCUE_PUSHED` lines
from earlier worktrees/branches/stashes in the SAME run — as untrustworthy,
with zero indication of which target was even in flight when the axe fell.

Fix: rescue.ts must know how much of the SERVER's own deadline remains, and
refuse to start a new push once too little is left for even one more push's
own worst case — reporting exactly which targets it skipped, and why.

## Design

### Real elapsed time via `date +%s`

*(Corrected below — #371 fresh review, Finding 2. The original version of
this section, reproduced further down under "Review round 2", claimed
`date +%s` was REQUIRED instead of bash's own `$SECONDS` builtin because this
script runs inside a reused, long-lived shell session (`sessionId:
"fleet-rescue"`). That claim was independently checked against the actual
code and found factually wrong — see "Review round 2" below for the
correction and how it was verified.)*

`date +%s`, captured once at the very top of the generated script's own text
(`__rescue_start=$(date +%s)`), is a real wall-clock read. It is not strictly
necessary here — every exec, regardless of `sessionId`, runs as a brand-new
`bash -c` subprocess (`withKillDeadline` wraps EVERY command that way,
`sbExec` calls it unconditionally before dispatching to either
`execWithSessionToken` or a one-shot `sb.exec` — a "session" only carries
cwd/env across separate `sbExec` calls, it does not change how any ONE
command's own subprocess starts), so a fresh `$SECONDS` would have worked
identically. `date +%s` is used anyway for clarity/robustness independent of
that detail: it is the simplest, most obviously-correct way to measure real
elapsed wall-clock time without depending on a bash-version-specific or
context-dependent builtin, and it costs one cheap `date` subprocess at script
start plus one more per budget check — negligible next to a 45s+ push
timeout.

### `rescue_budget_ok()` — one guard function, generated identically in both command builders

*(Updated — #371 fresh review, Finding 1: `mult`, a 2nd optional argument
defaulting to 1, was added below. See "Review round 2" for why.)*

```sh
rescue_budget_ok() {
  local id="$1" mult="${2:-1}" now remaining
  now=$(date +%s)
  remaining=$(( <serverDeadlineSeconds> - (now - __rescue_start) ))
  if [ "$remaining" -lt $(( mult * (<pushTimeoutSeconds> + <KILL_GRACE_SECONDS>) )) ]; then
    echo "RESCUE_FAILED $id budget $remaining not attempted"
    return 1
  fi
}
```

`<serverDeadlineSeconds>`, `<pushTimeoutSeconds>`, and `<KILL_GRACE_SECONDS>`
are all TypeScript-side literals interpolated into the generated bash text
(not runtime bash variables) — the same convention `rescue.ts` already uses
for every other constant threaded into these scripts. `mult` (a genuine
runtime bash variable, unlike the three above) scales the threshold to the
CALLER's own worst case: `1` (the default, used at the branch-walk and
stash-walk call sites) for exactly one push's own worst case
(`pushTimeoutSeconds + KILL_GRACE_SECONDS`, matching `#359`'s own header
comment on `RESCUE_PUSH_TIMEOUT_SECONDS`); `2` (passed explicitly at the
dirty-tree and clean-but-ahead call sites) for a first-attempt-plus-retry
pair — see "Review round 2" below for why the single-push threshold
undercounted those two call sites.

`serverDeadlineSeconds` is a brand-new, fifth, optional parameter on both
`rescuePushCmd` and `rescueSnapshotCmd` (default `RESCUE_SERVER_DEADLINE_SECONDS`
= 300, matching `EXEC_CLASSES.rescue`'s own `timeoutMs`) — a third test seam,
identical convention to `root` and `pushTimeoutSeconds`: production always
uses the real default; tests inject small values for speed.

### Why the guard cannot live inside `rescue_push()`

`rescue_push()` (the shared function used by the main-checkout dirty-tree and
clean-but-ahead branches) is always invoked via command substitution —
`target=$(rescue_push "$w" "$id" "$target" "$target_generated")`. Its ENTIRE
stdout is captured into `$target`, never reaching the script's real stdout.
An `echo "RESCUE_FAILED ..."` placed inside `rescue_push()` itself would
silently vanish into that captured string instead of being visible on the
exec's real output — do.ts's `parseRescueExecResult` would never see it. The
guard must therefore run at the CALL SITE, inside `rescue_one()` itself
(a plain function call, never `$(...)`), where `echo` reaches real stdout.

### The 8 push call sites, and where each guard actually goes

Read `rescue.ts` in full (not merely the board issue's own — slightly
imprecise — description of "branch-walk and stash-walk each with their own
two-attempt push") to confirm the true shape: each command builder
(`rescuePushCmd`/`rescueSnapshotCmd`) has exactly 4 raw `timeout -k ... git
push` invocations —

1. `rescue_push()`'s own first attempt (used by both the dirty-tree and
   clean-but-ahead branches of `rescue_one()`)
2. `rescue_push()`'s own immediate non-fast-forward retry (same function,
   runs back-to-back with #1, no new loop iteration in between)
3. the branch-walk's single push (always to a freshly generated ref — no
   retry, since a brand-new ref can never be rejected non-fast-forward)
4. the stash-walk's single push (same reasoning as #3 — no retry)

×2 command builders = 8 total, matching the issue's own count. Because a
first-try + its own immediate nff retry is ONE logical push attempt (no new
iteration runs between them), only ONE `rescue_budget_ok` check is needed
ahead of that pair, not two — so the actual number of GUARD insertions is 4
per function (dirty-tree call site, clean-ahead call site, branch-walk,
stash-walk), each guarding 1 or 2 of the 4 raw push lines:

- Dirty-tree branch of `rescue_one()` (function-return control flow):
  `if ! rescue_budget_ok "$id" 2; then fail=$((fail+1)); return; fi` right
  before `target=$(rescue_push ...)` — `mult=2`; see "Review round 2" below
  for why this call site (which CAN run `rescue_push()`'s own retry) is
  budgeted for two pushes' worst case, not one.
- Clean-but-ahead branch of `rescue_one()` (same function-return shape):
  identical guard, same id, `mult=2`, before its own `rescue_push` call.
- Branch-walk (`while ... done <<< "$allbranches"`, a loop body): `if !
  rescue_budget_ok "checkout:$b"; then fail=$((fail+1)); continue; fi` —
  `continue`, never `return`, matching this loop's own existing control flow
  for every other failure in it. `mult` defaults to 1: this push always
  targets a freshly generated ref, never retried.
- Stash-walk (`while ... done <<< "$stashlist"`, a loop body): same shape,
  `rescue_budget_ok "checkout:stash-$sn"` with `continue`, `mult` defaulting
  to 1 for the same reason.

`rescueSnapshotCmd`'s copies are identical in shape (its own `rescue_push()`
callers use `snapshot_target()` instead of `rescue_target()`, but the guard
placement, control flow, and `mult` values match exactly).

### `do.ts`'s `parseRescueExecResult` — an optional trailing detail

`failLine` was `^RESCUE_FAILED (\S+) (\S+)$` — exactly two tokens,
end-anchored. The new line shape (`RESCUE_FAILED <id> budget <n> not
attempted`) has four tokens after the prefix and would not match. Changed to
`^RESCUE_FAILED (\S+) (\S+)(?: (.*))?$` — the trailing group is OPTIONAL and
captures everything after the two required fields verbatim (`"12 not
attempted"`, not further split), so:

- an old two-token line (`push`/`commit`/`add`/`status`/`rev-parse`/
  `rev-list`) parses identically to before — the third capture group is
  `undefined`, and `fails`'s mapping only adds a `detail` key when it is
  defined (`...(m[3] !== undefined ? { detail: m[3] } : {})`), so existing
  callers' `toEqual({ worktree, step })` assertions keep matching unchanged.
- the new budget line parses as `{ worktree: "wtX", step: "budget", detail:
  "12 not attempted" }`.
- the regex stays end-anchored, so anything that isn't exactly two OR three
  space-separated fields still fails to match — fail-closed, unchanged
  posture from before.

`RescuePushFailedError.fails`'s own type gained an optional `detail?: string`
field to match. `failedDesc`'s formatting (used in the thrown error's own
message, not only raw stdout) now reads `${worktree} (${step}${detail ? `:
${detail}` : ""})` — a budget-skip's remaining-seconds detail now genuinely
surfaces in the exception message a caller actually sees/logs, not only on
raw stdout that most callers never read directly.

## TDD

RED first, both layers:

1. `test/bun/rescue-push.test.ts`, real git, real `timeout`/`gtimeout`/perl
   shim (this file's own existing convention) — 7 member worktrees, each
   genuinely dirty, pushing behind the SAME slow (`sleep 3`) `post-receive`
   hook `installSlowPostReceiveHook` (the file's own pre-existing #359
   fixture) already uses — the issue's own "test with 7 stalled pushes".
   `pushTimeoutSeconds=2` / `serverDeadlineSeconds=8` (threshold = 2 +
   `KILL_GRACE_SECONDS`(5) = 7) is chosen so exactly ONE push can start
   (`remaining` is still ≥ 7 before any real time elapses) and every push
   after it provably cannot: that one push alone consumes ≥ 2 real seconds
   (`timeout -k 5 2` never sends its own SIGTERM before a full 2 real seconds
   pass — a guarantee, not a timing race), so by the time the SECOND
   worktree's own check runs, `remaining` has already dropped to 6 or below,
   deterministically < 7. RED confirmed live against the pre-fix branch: all
   7 worktrees were genuinely pushed-and-killed (≈14.7s per parametrized
   variant, both `rescuePushCmd` and `rescueSnapshotCmd`), 0 budget-skips —
   exactly the failure mode this issue describes. GREEN after: exactly 1
   `RESCUE_FAILED <id> push` line, 6 `RESCUE_FAILED <id> budget <n> not
   attempted` lines, whole test under ~6s (down from a would-be ~14.7s just
   for a 7-target run at this scale, and unboundedly worse in production
   where a single stalled push costs up to 50s).

2. `test/studio.session.test.ts` (`rescuePush` describe block) — a fake exec
   response combining an old-format `RESCUE_FAILED agent-a1 push` line with a
   new-format `RESCUE_FAILED agent-a2 budget 12 not attempted` line. RED
   confirmed live against the pre-fix regex: the thrown message contained
   `"agent-a1 (push)"` but not `"agent-a2 (budget: 12 not attempted)"` (the
   budget line failed to match `failLine` at all, silently dropped from
   `fails`). GREEN after: both lines parse, `fails` equals
   `[{ worktree: "agent-a1", step: "push" }, { worktree: "agent-a2", step:
   "budget", detail: "12 not attempted" }]`, and both descriptions appear in
   the thrown message.

## Verification

Targeted runs only (scoped to the touched files, per this task's own
boundary — not the repo-wide `bun run check`/`bun run test` heavy gate):

- `bun test test/bun/rescue-push.test.ts` — 62 pass, 0 fail, 199 expect()
  calls (was 60 pass before this branch's own two new tests were added; the
  full file, not only the new describe block, was re-run to confirm no
  regressions in any of #359/#362's own existing coverage).
- `npx vitest run test/studio.session.test.ts` — 216 pass, 0 fail (215
  pre-existing + 1 new).
- `npx vitest run test/studio.destroy.test.ts` — 20 pass, 0 fail (sanity
  check: this file also imports rescue-related exports from `do.ts`).

Full-repo `bun run check` (5 tsconfig projects) and the full `bun run test`
vitest suite were deliberately NOT run here — those are the shared heavy
gate this task's own dispatch explicitly scoped out ("targeted runs, not the
full repo heavy gate"); the lead's own merge-time gate covers them.

Round 2 (this fresh review's own fixes, see below) re-ran the same targeted
files: `bun test test/bun/rescue-push.test.ts` — 64 pass, 0 fail, 207
expect() calls (62 pre-existing + 2 new; one pre-existing test's own
threshold-dependent fixture parameters needed updating to match the new,
doubled threshold — see below); `npx vitest run test/studio.session.test.ts`
— 216 pass, 0 fail, unchanged (Finding 2 touched only comments, and Finding 1
never changed `do.ts`'s own parsing).

## Deviations from the dispatch

- The board issue's own body describes the branch-walk and stash-walk as
  each having "their own two-attempt push (first try + nff retry) inlined
  directly" — reading the actual code shows this is not the case: both walks
  push to an already-freshly-generated ref exactly once, with no retry
  (correct, since a brand-new ref can never be rejected non-fast-forward).
  The real per-function raw-push-line count is 4 (2 in the shared
  `rescue_push()` + 1 branch-walk + 1 stash-walk), still totaling 8 across
  both command builders — the guard placement above reflects the CODE as
  read, not the issue body's own imprecise paraphrase, per the dispatch's own
  instruction to verify by reading rather than trusting that description.

## Review round 2 (fresh-context review, 2026-09-26) — two fixes

### Finding 1 [BLOCKING] — the single-push threshold undercounted rescue_push()'s own retry-pair worst case

The dirty-tree and clean-but-ahead call sites (4 of the 8 guarded
checkpoints — both branches, in both command builders) call the SHARED
`rescue_push()`, which can run TWO independently `timeout`-bounded pushes
back-to-back: a first attempt (which, unlike the branch-walk/stash-walk's
own always-fresh-ref pushes, targets rescue_target()'s resolved branch name
and so CAN be genuinely rejected non-fast-forward) and, only on that
rejection, an immediate retry to a fresh `-nff-` fallback ref. Combined
realistic worst case at these 4 sites: `2 * (pushTimeoutSeconds +
KILL_GRACE_SECONDS)` (≈95–100s in production), not the single-push figure
(≈50s) the original guard budgeted. A checkpoint starting with just over 50s
of server deadline remaining was wrongly let through by the original guard;
if it then hit "attempt 1 slow, attempt 2 stalls", the exec's own outer
300s deadline could still fire and wipe out earlier worktrees' own
already-successful `RESCUE_PUSHED` lines — the exact failure this whole fix
exists to close, still reachable at these 4 sites.

Fixed by parameterizing `rescue_budget_ok` with a `mult` argument (default
1) and passing `2` explicitly at the two `rescue_push()` call sites in each
command builder (4 total) — see the "`rescue_budget_ok()`" and "8 push call
sites" sections above (both updated in place, not duplicated, so this
section states the delta rather than repeating the full design). The
branch-walk and stash-walk keep the default (`mult=1`, unchanged): their
target is always a freshly generated ref, structurally never rejected
non-fast-forward, so a single-push budget remains correct there.

Test: `test/bun/rescue-push.test.ts`'s "#371 review Finding 1" describe
block, using the SAME real non-fast-forward fixture as "#263 N3" (a
checked-out, non-default branch pushed-to from a second clone, forcing a
genuine rejection) plus a slow `post-receive` hook on the RETRY's own
destination (the rejected first attempt never reaches a `post-receive` hook
at all — a rejected push updates no ref). Two cases, both `rescuePushCmd`
only (matching "#359 round 2 review, item 3"'s own precedent: a real
branch-collision retry fixture has no `rescueSnapshotCmd` equivalent, since
that builder's `snapshot_target()` always returns an already-generated ref):

- remaining budget covers the DOUBLED threshold (`serverDeadlineSeconds =
  2 * (pushTimeoutSeconds + KILL_GRACE_SECONDS)`) — the checkpoint is let
  through, the reject-then-retry pair runs, and the slow-but-successful
  retry lands as a real `RESCUE_PUSHED`.
- remaining budget covers only the SINGLE-push threshold (strictly between
  the single and doubled thresholds) — RED against the pre-fix code (the old
  guard let this through, since it only ever compared against the single
  threshold); GREEN after the fix: `RESCUE_FAILED checkout budget <n> not
  attempted`, and `rescue_push()` never runs at all (proven both by the
  absence of any `RESCUE_PUSHED` line and by elapsed time staying under 1s —
  nowhere near even the hook's own 1s sleep, let alone `pushTimeoutSeconds`).

One pre-existing test (the "#371 (#362 follow-up)" describe block's own
7-stalled-member-worktrees test) needed its own fixture parameters updated:
it runs each worktree's push through the SAME dirty-tree call site the fix
above doubled the threshold at, so its `serverDeadlineSeconds=8` (chosen
against the old single threshold of 7) no longer let even the first push
through under the new, doubled threshold of 14. Updated to
`serverDeadlineSeconds=14`, with the test's own doc comment corrected to
show the new arithmetic — the test's actual intent (exactly one push
attempted, the rest budget-skipped) is unchanged, only the numbers needed to
track the new threshold.

### Finding 2 [non-blocking, fixed] — the `date +%s` vs. `$SECONDS` comment misattributed its own reason

The original comments (`rescue.ts` ×2, and this plan doc's own "Real elapsed
time" section, reproduced unmodified above this section) claimed `date +%s`
was REQUIRED instead of bash's own `$SECONDS` builtin because the generated
script runs inside a REUSED, long-lived shell session
(`EXEC_CLASSES.rescue: {sessionId: "fleet-rescue"}`), so `$SECONDS` "would
not reset per invocation". Checked directly against the actual code before
changing anything (per this review's own instruction not to take the
reviewer's word for it):

- `apps/fleet/src/studio/exec-deadline.ts`'s `withKillDeadline(cmd,
  timeoutMs)` returns `` `timeout -k ${KILL_GRACE_SECONDS} ${seconds} bash -c
  ${shellQuote(cmd)}` `` — the ENTIRE generated script is always wrapped as
  the argument to a brand-new `bash -c` invocation.
- `apps/fleet/src/studio/sandbox-api.ts`'s `sbExec` calls `const command =
  withKillDeadline(cmd, timeoutMs)` UNCONDITIONALLY, before branching on
  whether `sessionId` is set (`sessionId !== undefined ?
  sb.execWithSessionToken(command, sessionId, ...) : sb.exec(command,
  ...)`) — the wrapping happens identically regardless of which session (or
  no session) the command is routed through.

So every exec, `sessionId` or not, spawns a genuinely fresh `bash -c` child
process every time; a session's persistence affects things like
working-directory/env carried across SEPARATE `sbExec` calls in that same
session, not the internal state (`$SECONDS` included) of the one-shot
`bash -c` subprocess any SINGLE call runs. The original justification was
factually wrong — confirmed, not merely asserted, by reading both files
named above. `$SECONDS` would have worked fine here too.

Corrected in all 3 places (`rescue.ts`'s `RESCUE_SERVER_DEADLINE_SECONDS` doc
comment, `rescue.ts`'s inline comment above `rescuePushCmd`'s own
`__rescue_start=$(date +%s)` line, and this plan doc's "Real elapsed time"
section above) to state the actual reason: `date +%s` is not strictly
necessary given the fresh-`bash -c`-per-exec behavior just described, but is
used anyway for clarity/robustness independent of that detail — the
simplest, most obviously-correct way to measure real elapsed wall-clock time
without depending on a bash-version-specific or context-dependent builtin,
at a negligible cost (one `date` subprocess at script start, one more per
budget check) next to a 45s+ push timeout.

## Rebase onto main (2026-09-26) — PR #362 and PR #374 both landed

PR #362 (`fix-359-rescue-all-timeout`, this branch's original base) was
squash-merged into `main` as `57a4e9f4`. Separately, PR #374 (issue #367,
"archive completion records on the ship tick, fix ops-path collision") also
merged into `main`, touching the same two files this branch touches
(`apps/fleet/src/studio/do.ts` and `apps/fleet/test/studio.session.test.ts`).

This branch's own commits — exactly the 9 genuinely #371-specific ones
(`a0f7eec` "RED — 7 stalled pushes exhaust the server exec deadline" through
`129478b` "add .fleet/done/371.json gate record") — were rebased with:

```
git rebase --onto origin/main 8aa02e3 fix-371-rescue-budget-guard
```

`8aa02e3` (`fix(test): perl timeout shim ... — #359 round 3 review`) is the
last commit tagged `#359` on this branch — i.e., the exact tip of the old,
now-superseded `fix-359-rescue-all-timeout` history this branch was
originally stacked on, confirmed against PR #362's own last commit
(`gh pr view 362 --json commits`, which reports the identical SHA
`8aa02e31208611349d1a998ff10bd642776fd470`).

The rebase produced **zero conflicts** in either shared file: PR #374's
archive/ops-path work (`archiveDoneRecords`, lines ~860–1030 and ~3540–3570 of
`do.ts`) and this branch's own budget-guard/failLine-detail work
(`parseRescueExecResult`, lines ~590–720) sit in entirely disjoint regions of
both files, so git's own three-way merge resolved them independently without
help. Re-ran `npx vitest run test/studio.session.test.ts` immediately after
the rebase (before touching anything else): 230 pass, 0 fail — the 216 tests
from this branch's own two rounds plus 14 new ones PR #374 added, all
coexisting correctly.

`git log origin/main..fix-371-rescue-budget-guard --oneline` after the rebase
shows exactly the 9 #371-specific commits, none of the 749 already-merged
#359/#362 commits this branch used to carry.

## Live production incident fix (2026-09-26) — a benign `remote:` hint line misclassified as failure

Maestro's own live observation, posted as an issue #371 comment (2026-09-26
09:01Z, `main` at `57a4e9f4`, i.e. after #362 had already merged and was
running in production): `example-app--pilot` reported `"FAILED
rescue-snapshot failed (exit 0: remote: ... RESCUE_PUSHED ...
RESCUE_PUSHED ...)"` — both pushes genuinely landed, exit 0, zero
`RESCUE_FAILED` lines, but the exec was still thrown as a failure.

### Diagnosis

`parseRescueExecResult`'s old success gate was:

```ts
if (fails.length === 0 && pushes.length > 0 && pushes.length === lines.length) { ... success ... }
```

— every line of `res.stdout` had to independently parse as a recognised
`RESCUE_PUSHED` line, with zero tolerance for anything else. If exactly one
extra, unrecognised (but harmless) line reaches `res.stdout` alongside real
`RESCUE_PUSHED` lines and zero `RESCUE_FAILED` lines, `pushes.length ===
lines.length` goes false and the whole thing falls through to the generic
catch-all `throw new Error(\`${label} failed (exit ${res.code}${stderr ? ...
: ""}): ${out}\`)` — which is exactly maestro's literal quoted message shape
(`"... failed (exit 0): <content>"`).

**Live repro, to pin down exactly where the `remote:` text was landing**: built
a real `--bare` git repo with a `post-receive` hook echoing GitHub's own
"Create a pull request for '...' on GitHub by visiting: ..." hint text (git
prefixes ALL server-side hook output with `remote:` when displaying it
client-side — confirmed live, this is how GitHub's real hint reaches a real
`git push` client). Ran the ACTUAL, unmodified `rescuePushCmd()`-generated
script against this real remote via `Bun.spawnSync` with properly separated
`stdout`/`stderr` pipes (the same mechanism `test/bun/rescue-push.test.ts`'s
own `sh()` helper already uses), for both:

- the shared `rescue_push()` helper's own dirty-tree push path (captures
  stderr into a local `perr` via `2>&1 1>/dev/null`, discarded entirely on
  success) — result: `remote:` text never reaches EITHER of the exec's real
  streams at all on a successful push (it's captured into `perr` and simply
  never echoed anywhere).
- the branch-walk's own unguarded push (`if ! timeout ... git push ...
  </dev/null; then ... else echo RESCUE_PUSHED ...; fi` — genuinely zero
  output redirection at all) — result: `remote:` flows straight through to
  the exec's real **stderr**, cleanly separate from stdout, which contained
  only the well-formed `RESCUE_PUSHED ...` line.

Conclusion: with clean stream separation, `rescue.ts`'s own git-push call
sites — guarded or not — never let this hint reach `res.stdout`. The parser
therefore already handles this correctly under a normal, separated-streams
exec transport; both live-repro runs, fed through `parseRescueExecResult`,
classify as success unchanged. Whatever specific plumbing in the production
container's own exec transport let `res.stdout` and `res.stderr` content mix
for the incident maestro observed is outside `rescue.ts`'s or `do.ts`'s own
control (and outside what this fix can directly instrument or reproduce byte
-for-byte from this repo). Per maestro's own explicit fix directive, the
correct response is to harden the PARSER against this class of incident
regardless of its exact transport-level cause, rather than chase a specific
plumbing theory that cannot be pinned down or fixed from this codebase.

### Fix

Dropped the `pushes.length === lines.length` requirement entirely — success
is now exit code (already gated by `isDeadlineExit`, checked first,
unchanged) + zero `RESCUE_FAILED` lines + at least one `RESCUE_PUSHED` line,
full stop:

```ts
if (fails.length === 0 && pushes.length > 0) { ... success ... }
```

A genuine `RESCUE_FAILED` line still always throws, unconditionally,
unchanged (the `fails.length > 0` branch immediately below is untouched) —
only an incidental, unrecognised-but-harmless EXTRA line (a `remote:` hint,
a `To <url>` push summary, or anything else that might someday ride along on
`res.stdout`) no longer flips a real success into a false failure.

### TDD

RED: `test/studio.session.test.ts`, `rescuePush` describe block — a fake
exec response whose `stdout` is the REAL, live-captured "Create a pull
request" hint text (from the live repro above) followed by two genuine
`RESCUE_PUSHED` lines, `code: 0`, zero `RESCUE_FAILED` lines. Confirmed RED
against the pre-fix code: threw `Error: rescue-push failed (exit 0):
remote: ...\nRESCUE_PUSHED task/42-fix-thing 3 files\nRESCUE_PUSHED
fleet/rescue/pilot/wt/agent-a1-20260925060000 1 commits` — reproducing
maestro's exact reported shape verbatim. GREEN after the fix: `pushed: true`,
`branch: "task/42-fix-thing"`, `files: 3`, `kind: "files"`, `pushes` carrying
both entries — identical outcome to the equivalent clean-stdout test just
above it in the same describe block.

### Verification

- `npx vitest run test/studio.session.test.ts` — 231 pass, 0 fail (230
  post-rebase + 1 new).
- `bun test test/bun/rescue-push.test.ts` — 64 pass, 0 fail, 207 expect()
  calls, unaffected (this fix touches only `do.ts`'s parser, not any
  `rescue.ts` shell text).

## PR #376 review round 2 (maestro, 2026-09-26) — one must-fix, two suggestions

Maestro's review: budget guard proven live (Linux, 7 stalled pushes, exit 0
at 226s, no deadline exit), mutants A/B red, Mac 96/96, Linux 96/96, vitest
435. HOLD on one must-fix; two additional suggestions taken as well.

### 1. MUST-FIX — the `remote:`-line fix (above) over-reached, undoing #251's fail-closed guarantee

Proven live by maestro: exit 2 (a mid-script bash syntax error) plus one
genuine `RESCUE_PUSHED` line got reported as `pushed: true` — the success
gate above (`fails.length === 0 && pushes.length > 0`) dropped `res.code`
from the condition entirely, so any exec that crashed non-zero after
printing at least one real push line read as a full success, silently
losing every unreached worktree. Separately, a malformed `RESCUE_FAILED
push` line (empty/missing worktree id, which doesn't match `failLine`'s own
`(\S+)` group) also silently passed through, because the fix also dropped
ALL line-completeness checking, not just tolerance for `remote:` lines.

Fixed in `apps/fleet/src/studio/do.ts`'s `parseRescueExecResult`: filter
`remote:`-prefixed lines out of `lines` BEFORE deriving `pushes`/`fails`
(`nonRemoteLines`), require `res.code === 0` explicitly, and restore the
completeness check scoped to the filtered set
(`pushes.length === nonRemoteLines.length`). The original `remote:`-line fix
stays intact: a benign hint line among otherwise well-formed output still
doesn't flip a real success into a false failure, because it's filtered out
before the completeness check runs.

TDD, RED first (`test/studio.session.test.ts`, `rescuePush` describe block):

- Test A: `code: 2`, stdout one genuine `RESCUE_PUSHED` line, stderr a
  syntax-error message. RED against the pre-fix code: resolved
  `{ pushed: true, ... }` instead of rejecting. GREEN after: rejects,
  message contains both `exit 2` and the real stderr text (the
  unreached-worktree information is not silently swallowed).
- Test B: `code: 0`, stdout a genuine `RESCUE_PUSHED` line plus a malformed
  `RESCUE_FAILED  push` line (two spaces — empty worktree id). RED against
  the pre-fix code: resolved as success. GREEN after: rejects (falls through
  to the same generic "unrecognisable output" throw that predates this whole
  feature).
- Test C (regression, unchanged): the original `remote:`-hint scenario still
  classifies as success.

Verification: `npx vitest run test/studio.session.test.ts` — 233 pass, 0
fail (231 pre-existing + 2 new).

### 2. Flaky Mac 7-stall test — deadline sat exactly on the doubled-threshold boundary

`test/bun/rescue-push.test.ts`'s 7-stalled-worktree test and the Finding-1
doubled-threshold boundary test both injected `serverDeadlineSeconds`
values that sat EXACTLY on `2 * (pushTimeoutSeconds + KILL_GRACE_SECONDS) =
14` — `date +%s` truncates rather than rounds, so whether a check passes or
fails right at that exact boundary is a real sub-second timing race (4/5
failures measured on a loaded Mac).

Fixed: widened the 7-stall test's `serverDeadlineSeconds` from `14` to `17`
(~3s slack), and added an explicit `marginSeconds = 3` to the Finding-1
boundary test's own `doubledThreshold`. Recalculated empirically (ran the
real fixture, not hand-derived): with the wider margin, `remaining` after
one stalled-and-killed push is still >= the doubled threshold, so a SECOND
push is also let through before the third worktree's own check finally
skips — `pushFails` 1 -> 2, `budgetFails` 6 -> 5 (still sums to 7, still well
under the 8s ceiling). Confirmed stable across 3 repeated runs of the full
file (64/64 pass each time), not just a single run.

### 3. Suggested — whole-second clock margin in `rescue_budget_ok` itself

`date +%s`'s truncation (not rounding) means real elapsed time can be up to
just-under-1s more than the integer difference `rescue_budget_ok` computes —
a small, real gap between calculated and actual remaining budget, at zero
margin previously. Added `RESCUE_BUDGET_MARGIN_SECONDS = 5` (production
constant) as a fourth, optional `budgetMarginSeconds` test-seam parameter on
both `rescuePushCmd` and `rescueSnapshotCmd`, added to the threshold at both
`rescue_budget_ok` definitions (`... + ${budgetMarginSeconds}`). The two
budget-guard describe blocks' own tests pass an explicit
`budgetMarginSeconds=0` so their hand-derived zero-margin threshold math
(items 2's recalculation above) stays exact and independent of production's
default.

### Verification (round 2)

- `npx vitest run test/studio.session.test.ts` — 233 pass, 0 fail.
- `bun test test/bun/rescue-push.test.ts` — 64 pass, 0 fail, 207 expect()
  calls; re-run 3 times to confirm the widened-margin tests are stable, not
  merely lucky once.
- `bun test test/bun/git-wrapper.test.ts` — 129 pass, 0 fail (sanity check:
  also calls `rescuePushCmd`/`rescueSnapshotCmd`, unaffected by the new
  optional 6th parameter's default).
- `npx tsc --noEmit` (apps/fleet) — clean.

Targeted runs only, per this task's own boundary (do.ts, rescue.ts, their
two test files, this plan doc, and the external done-record) — the full
repo-wide `bun run check`/`bun run test` heavy gate was deliberately not run
here; that's the lead's own merge-time gate.
