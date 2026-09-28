# Fleet Task Verify

**Problem (Fleet board task #119):** P5a's Stop gate refuses to let a task
complete unless its §6 result envelope carries a `verification` block, but
nothing ever checks that block's *steps are actually followable*. Measured
live on task #109: the envelope's own words ("Actions tab -> Fleet Check ->
Run workflow, against branch `ci/fleet-check-workflow`") 404'd the moment a
human followed them literally, because `workflow_dispatch` only ever fires
from a repo's *default* branch. A confidently worded wrong instruction reads
identically to a correct one on the page — and the result envelope is the
exact artifact a human is meant to trust most.

**Fix:** a new, strictly read-only verb — `fleet task verify <n>` — that
reads the newest §6 result envelope on a task and mechanically re-checks it.
It never blocks anything, never gates a Stop, never transitions or closes a
task; it exists purely to surface, in one annotation comment, whether the
envelope's own claims are true.

`attemptVerification` (`src/board/verify.ts`, new) does the whole thing:

1. `findLatestResultEnvelope` walks a task's comments **backwards** looking
   for the newest one whose `envelope.intent` is `"result"` — searching from
   the end rather than trusting "the last comment", since a later plain
   human reply (or an earlier non-result envelope, e.g. a `clarify`) must
   not shadow the actual result being verified.
2. `verification.url` is fetched through one injected seam, `VerifyFetch` —
   a plain unauthenticated GET, because the whole point is reproducing what
   a human clicking the link would see. Never throws: a rejected fetch reads
   as `attempted-failed` with the caught message, same as any other
   non-2xx status.
3. Every step's text is scanned by `extractRefCandidates` for anything that
   looks like a PR (`#123`, `pull/123`), a branch (the literal keyword
   `branch` immediately before a git-ref-shaped token), or a commit (a
   standalone 7-40 char hex word requiring at least one `a-f` letter, to
   keep a bare decimal number — a date, an issue number typed without `#`
   — from being mistaken for a truncated sha). A step matching no pattern is
   `not-mechanically-checkable`, not silently skipped — the CLI/comment
   still lists it, naming that a human has to follow it by hand.
4. Each candidate is resolved against two new `BoardApi` calls,
   `branchExists`/`commitExists` (`src/github/api.ts`), mirroring the
   existing `pullRequestExists` convention exactly: a 404 from GitHub's own
   API means "does not exist", any other failure is caught and reported as
   the check's own failure text rather than an uncaught exception. A step
   is `attempted-ok` only if *every* candidate in it resolves; one missing
   or errored candidate makes the whole step `attempted-failed`, naming
   which and why.
5. `renderVerifyComment` turns the url result plus every step result into
   one heading ("Verify — task #N, checking result envelope `msg_id`") and
   one skimmable `✅ / ❌ / ➖` line per check, explicit that this is
   mechanical-followability only, not a correctness judgment, and that it
   never blocks/transitions/closes anything.
6. `api.createComment` is posted exactly once — the only write
   `attemptVerification` ever makes, full stop. No label change, no state
   transition, no closing.

A 404-shaped no-op (nothing posted) is returned when the task has no result
envelope yet, or — defensively, since the Stop gate already requires it on
every result — when the newest one somehow carries no `verification` block
at all.

Worker-side, `src/board/routes.ts` widens `BOARD_ROUTE_RE` to accept a
`verify` action alongside the existing `state|envelope|adopt|assign`, and
dispatches `POST /studio/board/tasks/:n/verify` to `attemptVerification`
*before* the unnamed-action fallback, same ordering discipline `adopt`/
`assign` already follow. The route's own `realVerifyFetch` wraps the live
`fetch` in a try/catch so a network failure classifies as
`attempted-failed` inside the comment rather than crashing the route into a
502 an operator would otherwise have to explain from Worker logs alone.

CLI-side, `src/studio/cli-args.ts` gains a `task-verify` command (same
grammar as the existing `task-show <n>`), and `cli/fleet.ts`'s
`cmdTaskVerify` POSTs to the new route, detecting/reporting the repo the
same way every other task command does, then prints the envelope's
`msg_id`, one line per classified check, and the URL of the comment that
got posted.

## Files touched

- `apps/fleet/src/github/api.ts` — new `branchExists`/`commitExists`,
  mirroring the existing `pullRequestExists` (404 = does not exist)
- `apps/fleet/src/board/board.ts` — `BoardApi` port gains
  `branchExists`/`commitExists`
- `apps/fleet/src/board/verify.ts` (new) — `findLatestResultEnvelope`,
  `extractRefCandidates`, `checkCandidate`, `checkStep`, `checkUrl`,
  `renderVerifyComment`, `attemptVerification`; pure over `BoardApi` plus
  the one injected `VerifyFetch` seam, so every rule is provable without a
  network
- `apps/fleet/src/board/routes.ts` — `BOARD_ROUTE_RE` accepts `verify`;
  `githubBoardApi` wires the two new existence checks; new
  `realVerifyFetch`; `POST /studio/board/tasks/:n/verify` dispatched to
  `attemptVerification`
- `apps/fleet/src/studio/cli-args.ts` — new `task-verify` command + verb
  help text
- `apps/fleet/cli/fleet.ts` — new `cmdTaskVerify`, wired into `main`'s
  command dispatch
- `apps/fleet/test/board.board.test.ts`, `test/board.envelope.test.ts`,
  `test/board.fleet-routes.test.ts` — minor updates for the widened
  `BoardApi`/route surface
- `apps/fleet/test/board.routes.test.ts` — coverage for the new `verify`
  route (dispatch, 404 when no envelope, comment posted)
- `apps/fleet/test/board.verify.test.ts` (new) — the bulk of the coverage:
  envelope selection walking backwards past a later plain comment/earlier
  `clarify`, ref extraction (PR/branch/commit, multi-match, false-positive
  avoidance for decimal-only "commit" lookalikes), `attemptVerification`'s
  ok/failed/no-envelope/no-verification-block paths, comment rendering
- `apps/fleet/test/studio.cli-args.test.ts` — coverage for the new
  `task-verify` parse path

## Boundaries respected

`src/board/envelope.ts` (the §6 envelope schema/parsing itself) and the
Stop-gate hook are both untouched — this verb reads envelopes that already
exist, it never changes what counts as a valid one, and it never
participates in the gate's own pass/fail decision:

```
$ git diff origin/main -- apps/fleet/src/board/envelope.ts container/studio-bringup.sh
(empty)
```

The new route is wired only into the operator-facing surface: `handleBoard`
is gated by `verifyAccess` (the Cloudflare Access JWT check every
`/studio/*` operator route already requires), the same gate `adopt`/
`assign`/`state`/`envelope` sit behind. It was **not** added to the
studio-side spawn-token surface (`src/studio/spawn.ts`,
`isSpawnTokenShaped`/`resolveSpawnParent`) — a studio's own spawn token
still cannot trigger a verify, only an operator (or the CLI acting as one)
can.

## Commits / PR

- `f3c599c` — `feat(fleet): add read-only fleet task verify <n> (board task #119)`
- PR #123: https://github.com/acme-org/websites/pull/123

## Verification

- `bun run check` — clean, no output, exit 0 (5 tsconfig projects)
- `bun run test` — 1594/1594 tests passing across 65 files
- `git diff origin/main -- apps/fleet/src/board/envelope.ts container/studio-bringup.sh`
  — empty, hard boundaries respected
