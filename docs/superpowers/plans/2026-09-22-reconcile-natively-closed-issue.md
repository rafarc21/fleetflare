# Reconcile a natively-closed issue (board issue #26)

bug filed against `autoCloseOnPromote` (`src/github/webhook.ts`). issue
asks 3 precise questions. answered here, each confirmed by re-reading
the actual code, not trusted from the issue text alone.

## Q1: did it run for this push at all?

no. `apps/fleet/wrangler.jsonc`'s `GITHUB_REPO_AUTH` (line 71):
`"acme-org=app, demositeltda=app, acme-hq=app"` — no `rafarc21`
entry, and no `GITHUB_INSTALLATION_ID_RAFARC21` var either. an owner
absent from that map falls to the token path (`github/auth.ts`), and
no GitHub App is installed on `rafarc21` at all — a webhook needs an
App installation to be delivered, so GitHub never sends this Worker
ANY webhook, `push` included, for `rafarc21/fleetflare`.
`handleGithubWebhook` (`webhook.ts:212`) is never invoked for this repo;
`autoCloseOnPromote` (`webhook.ts:123`) never runs. upstream of the
function, not a branch inside it.

already documented, not a new finding: `docs/superpowers/plans/
2026-09-18-auto-close-on-promote.md`, "Coverage gap" section (lines
192-207) — "A repo under `rafarc21` ... resolves to the TOKEN auth path
and never sends this Worker a webhook at all. ... `fleet task reap` is
the ONLY coverage for token-path repos". same file's Files-touched
section is where `pr-landed.ts`/`task-reap.ts`/the reap route were
born, board issue #8.

## Q2: does it set the board label, or only close the issue?

both, already. `src/board/close-action.ts`'s `closeTaskOnPromote`:
line 95 `await api.closeIssue(repo, issueNumber)`, then (task.state !==
null) line 103 `await transitionTask(api, repo, issueNumber, { from:
task.state, to: "completed" })`. not the gap.

## Q3: idempotent, or does it skip the label write when GitHub already
closed the issue natively (closing keyword)?

`closeTaskOnPromote` itself: fine, already idempotent. its own `if
(task.state === "completed")` check (close-action.ts:90) reads the
BOARD's own state label, never GitHub's open/closed flag — confirmed
via `src/board/api.ts`'s `toBoardTask`: `state` (line 102, from board
labels) and `open` (line 108, `raw.state === "open"`) are two
independent fields. it never inspects `open` at all. if it ever got
called with an already-closed-on-GitHub issue, it would do the right
thing.

the real bug: it never gets the chance. the candidate list feeding it
— `autoCloseOnPromote`'s Path 2, "envelope cross-check"
(`webhook.ts:148-157`), the ONLY path that can EVER matter for
`rafarc21/fleetflare` per Q1 (Path 1, the commit-walk in
`promote-close.ts`, needs a webhook delivery that never arrives here
either — but Path 1 doesn't filter on `open` and has no bug of its
own, untouched) — is filtered to `open` tasks ONLY, in three places:

  - `src/board/pr-landed.ts:52`, `if (!task.open) continue;`, inside
    `openTasksWithLatestPr` — this file's own header: "the ONE shared
    ... scan ... walked from two opposite directions", used by BOTH
    Path 2 and `fleet task reap`.
  - `src/github/webhook.ts:153`, `.filter((t) => t.open)`, a redundant
    pre-filter before even calling the shared function.
  - `src/board/routes.ts:270`, `.filter((t) => t.open)`, the reap
    route's own call into the SAME shared scan.

a native closing keyword flips `open` false the instant the PR merges
— before ANY reconciliation code looks. once flipped, all three
filters drop the task, permanently, on every existing path. not
"missed this once" — structurally unfixable by re-running anything
that exists today. confirmed against `test/board.pr-landed.test.ts:
107-113`, `"skips a CLOSED task entirely -- not a candidate for either
caller"` — asserts the CURRENT buggy behavior as correct. revised
below.

## fix

predicate change, ONE place: `task.open` -> `task.open || task.state
!== "completed"`. still open -> candidate. natively closed but board
label not yet `completed` -> still a candidate (needs reconciling).
closed AND already `completed` -> genuinely done, skip forever (no
unbounded re-scan of finished work).

applied inside `openTasksWithLatestPr` (`pr-landed.ts:52`), the single
source of truth this file already claims to be. the two now-redundant
(and now actively WRONG — they'd re-exclude before the corrected
internal check runs) pre-filters removed: `webhook.ts:153`,
`routes.ts:270` — both now pass the full task list straight through,
letting `openTasksWithLatestPr`'s own predicate decide.

`close-action.ts` untouched (already correct, Q2/Q3 above).
`promote-close.ts` / Path 1 untouched (no `open` filter, no bug).
`task-reap.ts` itself untouched — it only calls `listOpenTasks`, which
lives in `routes.ts`; confirmed no `open` filtering happens inside
`task-reap.ts`'s own pure core.

## tdd, red then green

`test/board.pr-landed.test.ts`:
- new failing test first: a closed task (`open: false`), board state
  NOT `completed` (e.g. `"working"`) -> still returned as a candidate.
  ran against the OLD code (before the predicate edit) — failed,
  `toEqual([])` instead of the task, exactly the bug.
- existing `"skips a CLOSED task entirely"` test rewritten: the only
  "always skip" case left is closed AND `state: "completed"` —
  renamed/reworded to test that boundary instead of "closed, period".
- new test: closed and `state: "completed"` -> still excluded (the
  boundary the predicate must keep enforcing).
then implemented the fix, all green.

`test/github.webhook.test.ts` / `test/board.routes.test.ts`: checked
both for existing coverage of the two removed pre-filters before
touching anything.
  - `github.webhook.test.ts`'s push-to-default-branch describe block:
    its GET-issues fetch stub hardcodes `state: "open"` (line ~365)
    and every test's `openTaskNumbers` is `[]` — Path 2 candidates are
    never exercised with a real closed task by any existing test, so
    no existing assertion depended on the removed filter. added one
    full end-to-end test instead: native-closed task (GitHub state
    "closed", board label still "working"), envelope names a landed
    PR the push's own commit intersects via `listPullCommits` — proves
    candidate found -> `closeTaskOnPromote` called -> board label
    transitions to `completed`, issue stays closed, comment posted.
    widened the fetch stub's issues-list handler to honor `issueState`
    (was hardcoded open) and added two small new routes (GET comments,
    GET one pull) the new test needs — no existing test's fixtures
    changed shape.
  - `board.routes.test.ts`'s reap-route describe block: every existing
    test already passes the FULL `listIssues` result straight into the
    route (the route itself does the filtering, not the test double),
    so removing `routes.ts:270`'s pre-filter needed no test update for
    existing tests to keep passing. added one new test: a closed,
    not-yet-`completed` task with a landed PR is still reported
    `would-close` by a dry-run reap, proving the route's own removed
    filter no longer hides it.

## verification

from `apps/fleet/`: `bun run check`, `bun run test`, `bun run bun-test`
— all three, real exit codes, not `test` alone (issue's own
requirement, "bun run test alone is HALF the suite").

## boundaries respected

touched only: `src/board/pr-landed.ts`, `src/github/webhook.ts` (one
filter line + passing the full list through), `src/board/routes.ts`
(same), `test/board.pr-landed.test.ts`, `test/github.webhook.test.ts`,
`test/board.routes.test.ts`, this doc, `.fleet/done.json`. untouched:
`close-action.ts`, `promote-close.ts`, `task-reap.ts`. no deploy —
`rollout_step_percentage: 100` on the StudioDO container restarts
every running studio, and this ships as a PR for the lead to review
and land, not a live change.
