# Auto-close on promote (board issue #8)

**Problem:** issues never close after their PR merges and the code deploys.
GitHub only auto-closes an issue via a closing keyword (`Fixes #N`) when the
PR's commits land on the repo's DEFAULT branch. Every PR in this fleet merges
into `staging` first — the keyword never fires there. Promoting
`staging` -> `main` later does not re-process the original PRs' keywords
(it's a *different* PR, often a squash of many). Backlog accumulates; a human
(or an agent burning thousands of tokens) has to grind through the board by
hand to find which "open" issues are actually done.

This doc is the design; the PR that ships it draws its body from here.

## Trigger: push to the default branch, and only that

`push` webhook, `ref` equal to `refs/heads/<default branch>` — asked via the
existing `getDefaultBranch(token, repo)` (`src/github/api.ts:273`), never a
literal `"main"`. This is the ONLY trigger for v1.

**Rejected: `deployment_status`.** Sounds more "correct" — an issue closing
only once the code is *actually live* is a tighter claim than "merged to the
branch that gets deployed". Rejected anyway: deploys in this fleet are
operator-gated (`wrangler.jsonc`'s `rollout_step_percentage: 100`, and the
house rule "never deploy without approval"), so a deploy can lag a merge by
hours or days. Gating issue-closure on a `deployment_status` event would leave
reviewed, merged, *done* work sitting open on the board for however long the
operator takes to click deploy — the exact backlog-noise problem this feature
exists to kill, just moved one step later. `main` already reads as "promoted
to production" elsewhere in this same file (`webhook.ts`'s `WATCHED` set
backing the UNAPPROVED WRITE alarm) — trigger-on-default-branch-push is
consistent with that existing convention, not a new one. `deployment_status`
is recorded here as a real future enhancement (e.g. a stricter mode some repo
opts into), not built.

Cost note: every push (including a feature-branch push) costs one
`getDefaultBranch` call to find out whether it's the one that matters, because
the alternative — reusing `webhook.ts`'s pre-existing `WATCHED` literal
`"refs/heads/main"` as a cheap prefilter — is exactly the hardcoding this
design was told not to do. Pushes are comparatively rare next to comment/PR
events this Worker already handles per delivery, so the extra call is judged
acceptable for v1.

## Commit -> PR -> issue resolution

New pure module, `src/github/promote-close.ts`. Two independent resolution
paths, run for every push to the default branch, merged and de-duplicated by
issue number (first evidence wins — commit-path checked first, since a
`closingIssuesReferences` hit is a stronger signal than an inferred one).

### Path 1 — commit walk + GraphQL (the primary mechanism)

For each commit in the push's `commits[]`:

1. `GET /repos/{o}/{r}/commits/{sha}/pulls` (new: `listPullsForCommit`) — the
   PR(s) this commit belongs to.
2. For each PR found: GraphQL `closingIssuesReferences` on
   `repository(owner,name){ pullRequest(number){ closingIssuesReferences }}`
   (new: `closingIssuesForPull`, one POST to `api.github.com/graphql`, same
   `GH_HEADERS`/bearer-token shape every REST call in `api.ts` already uses —
   this file had no GraphQL client at all before this task). Query kept
   deliberately minimal: `nodes { number }`, nothing else.
3. **Squash-merge fallback**, the case the issue text calls out explicitly:
   staging -> main promotion is almost always a squash merge, which creates
   ONE NEW commit with a NEW sha that was never part of any original small
   PR. So step 1's lookup on *that* sha returns the PROMOTION PR itself
   (base=main, head=staging or similar), not the original feature PR — and
   step 2 on the promotion PR usually comes back with an EMPTY
   `closingIssuesReferences`, because nobody writes "Fixes #N" in a
   promotion PR's body.

   Rule used (the simpler, more robust one the issue itself offers as an
   alternative to a base/head-ref heuristic): if `closingIssuesReferences` on
   the PR found in step 1 is empty, treat it as a possible promotion/squash
   PR and fall back to `GET /repos/{o}/{r}/pulls/{n}/commits` (new:
   `listPullCommits`) — this endpoint returns the PR's ORIGINAL constituent
   commits *regardless of merge strategy*, because squash-merging changes
   what lands on the base branch, never what the PR's own `/commits`
   endpoint reports. Recurse steps 1-2 on each of those original commits.

   Depth-limited to ONE extra level. A promotion-of-a-promotion is not a real
   shape in this fleet's actual workflow (there is one staging, one main);
   building unbounded recursion for a case that doesn't happen would be
   machinery with no failing test to justify it. A depth-limit hit is logged
   and skipped, not looped.

### Path 2 — envelope cross-check (the case with no closing keyword at all)

A board task IS the GitHub issue (1:1, same number — confirmed by reading how
`showTask`/`transitionTask` address tasks, both by issue number). Its most
recent §6 result envelope may carry `artifacts: [{kind:"pr", pr:"<n>"}]`
(`board/types.ts`'s `EnvelopeArtifact`). Some PRs never use a literal
"Fixes #N" in the body at all — GraphQL's `closingIssuesReferences` comes back
empty for a structural reason (no keyword), not a squash reason, and path 1's
fallback (which re-walks commits, not envelopes) does not help here.

So: for every OPEN task whose latest envelope names a PR, check whether that
PR's evidence (its `merge_commit_sha`, or — if unmerged into the default
branch directly — its own original commit list via the same
`listPullCommits` used above) intersects the CURRENT push's own `commits[]`.
This costs no extra GitHub call beyond the merge-commit-sha lookup: the
push's commit list is already in hand from the webhook body, free.

**Shared, not duplicated.** The "which open tasks have a PR artifact in their
latest envelope" scan (`board/pr-landed.ts`, new) is written ONCE and used
from BOTH directions:
  - here (push-triggered): push just landed, check every open task's claimed
    PR against ITS commit list;
  - `fleet task reap` (poll-triggered, section below): no push exists, so
    "landed" is answered by asking GitHub directly instead.

It reuses `verify.ts`'s existing `findLatestResultEnvelope` (comments scanned
BACKWARDS for the newest `intent:"result"` envelope) — the same precedent
board task #119 already established for "the current truth about a task's
result lives in its newest result envelope, not necessarily its last
comment".

## Shared close-action (idempotent, called from both triggers)

`board/close-action.ts`, `closeTaskOnPromote(env, api, repo, issueNumber,
evidence: {sha, branch})`:

1. **Dedup guard, first, before any write.** Derives a deterministic id —
   `gh_close_${repo}_${issueNumber}_${sha}` — and inserts a marker row via
   the existing `events` table + `appendEvent`'s `ON CONFLICT(id) DO NOTHING`
   (`events/log.ts`), the exact pattern `telegram/webhook.ts` already uses
   for Telegram's own redelivery dedup (`tg_${project}_${update_id}`). A
   repeat delivery for the same push (GitHub retries a slow/failed webhook)
   or a `reap` run that re-discovers the same already-closed evidence is
   therefore a silent, successful no-op — not a second close, not a second
   "closed by..." comment.
2. `PATCH /repos/{o}/{r}/issues/{n} {state:"closed"}` (new: `closeIssue`,
   `src/github/api.ts` — the only issue helpers that existed before this
   task were read/label/comment, no close).
3. Board CAS to `completed`, via the EXISTING `transitionTask`
   (`board.ts:140`) exactly as it already works — read the issue's current
   state, pass it as `from`. `transitionTask` ALREADY treats `from === to`
   as a no-op that writes nothing (see its own doc comment), so calling it
   with `from: "completed", to: "completed"` when the task somehow got
   closed by other means (a prior run, or the studio's own normal
   sprint-close) is handled for free — no special-casing needed here beyond
   not calling it at all when the task carries no single state label (board
   drift; logged, GitHub issue still closes, board state is left for a human
   to fix rather than guessed at).
4. One comment: `"closed by <sha>, promoted to <branch>"` (originally
   Portuguese; translated in the #66 follow-up).

GitHub's open/closed and this fleet's board `state` label are separate
things by design (`board.ts`'s own header: "Deploy truth is measured from
branch + host, NEVER from a label" / "a terminal board state leaves the
issue OPEN, closing it is sprint close's job"). This function does BOTH
writes on purpose — closing the loop those two systems never closed
automatically before.

## `fleet task reap [--dry-run|--apply]` — deterministic backfill

`src/studio/task-reap.ts`, DI'd the same way `task-state.ts`'s
`TaskStateDeps<C>` is (no `Env`, no live `fetch` baked into the pure core).
Lists every OPEN board task, reads its latest envelope's PR artifact via the
SAME `board/pr-landed.ts` scan section 2 uses, and for each task with one,
asks whether that PR is now reachable from the default branch:

- if merged directly into the default branch: landed.
- else (the common case — merged into `staging`): `GET
  /repos/{o}/{r}/compare/{default}...{merge_commit_sha}` (new:
  `commitReachableFromBranch`, wraps the same compare endpoint
  `compareExists` already uses, but reads `ahead_by` instead of discarding
  the body) — `ahead_by === 0` means the merge commit contributes nothing
  beyond what the default branch already has, i.e. it (or everything it
  squashed together downstream) is already there. This is the mechanically
  correct, squash-strategy-agnostic answer to "is this reachable", and it is
  a *different* mechanism from section 2's push-triggered check on purpose:
  reap has no push commit list to compare against, so it asks GitHub for
  ancestry directly instead of relying on the free but push-scoped
  intersection check.

Default (bare `fleet task reap`, and the explicit `--dry-run` synonym): report
only — every task's outcome is `would-close` / `skipped (why)`, nothing
writes. `--apply`: same computation, but every `would-close` task goes
through the identical `closeTaskOnPromote` section 3 defines — a webhook
close and a later `reap --apply` for the same (repo, issue, sha) triple do at
most one real write between them, courtesy of the shared dedup guard.

Server route: `POST /studio/board/tasks/reap {apply: boolean, repo?}`,
mounted beside the existing `/tasks/:n/state` etc. under `/studio/board/`
(same Access-gated surface, same `resolveBoardRepo` repo convention every
other board write already follows). The Mac CLI never holds a GitHub token —
only the Worker mints one — so this has to be a server route, not client-side
polling.

CLI: `cli-args.ts` gains `{cmd:"task-reap", apply:boolean}`; `cli/fleet.ts`
gains `cmdTaskReap`, one POST via `boardRequest`.

## Coverage gap (required, stated plainly, not buried)

Webhooks only ever arrive at this Worker from repo owners that have the
GitHub App installed (currently: `acme-org`, `demositeltda`, `acme-hq` —
see `github/auth.ts`'s per-owner provider routing). A repo under `rafarc21`
— **including this very repo, `fleetflare`** — resolves to the TOKEN auth
path and never sends this Worker a webhook at all. The push-triggered
auto-close in section 2 will NEVER fire for a token-owned repo, structurally,
not as a bug.

`fleet task reap` is the ONLY coverage for token-path repos: it works by
POLLING the GitHub REST API with a minted token rather than waiting for an
inbound webhook GitHub never sends. An operator (or a periodic sweep) running
`fleet task reap --apply` against `rafarc21/fleetflare` is, for now, the only
way an issue in this repo closes itself at all. This is not a corner case —
it is this repo's *only* path, today.

## Testing approach

- `github/api.ts` new primitives (`listPullsForCommit`, `listPullCommits`,
  `closeIssue`, `closingIssuesForPull`, `getPullRequest`,
  `commitReachableFromBranch`) — mocked-fetch unit tests, `github.api.test.ts`
  conventions (a captured-calls array, `respond()` overridable per test,
  never a live network).
- `promote-close.ts` — pure, DI'd over a small port with fake async
  functions, no HTTP anywhere. Squash-fallback is tested directly: a commit
  whose direct PR lookup returns empty `closingIssuesReferences`, recursing
  into that PR's own `/commits` to find the real originating commit and, from
  it, the real issue. Depth-limit (no infinite recursion) and the envelope
  cross-check (a PR with no closing keyword, matched by commit-sha
  intersection with the push) both get their own cases.
- `close-action.ts` — real D1 (`cloudflare:test`'s `env.DB`, same as
  `github.webhook.test.ts` already uses for `appendEvent`/`readSince`), fake
  `BoardApi`. Idempotency: same evidence called twice performs the real
  work once. The "already completed" no-op: relies on `transitionTask`'s own
  existing no-op path rather than reimplementing it.
- `github.webhook.test.ts` — extended with a full push-to-default-branch
  scenario ending in issue closed + task transitioned + comment posted,
  using the file's existing `sign()`/`push()`/global-`fetch` stub
  scaffolding (widened to dispatch by URL instead of one fixed Telegram
  shape).
- `task-reap.ts` pure core — dry-run vs `--apply`, no-PR-artifact (skip,
  never crash), PR not yet on default (skip), PR landed (would-close /
  closed depending on the flag).
- `POST /studio/board/tasks/reap` — `board.routes.test.ts`'s existing
  `fakeApi()`/`authorized()`/`reach` pattern.
- `cli-args.ts` — `studio.cli-args.test.ts`'s existing per-verb pattern, plus
  the generic `VERBS`/`renderHelp` coverage that already runs against every
  verb without change.

## Files touched

- `src/github/api.ts` — `listPullsForCommit`, `listPullCommits`,
  `closeIssue`, `closingIssuesForPull` (new GraphQL client), `getPullRequest`,
  `commitReachableFromBranch`
- `src/github/webhook.ts` — `PushPayload` gains `commits: {id, message}[]`;
  push-to-default-branch wiring calling into `promote-close.ts` +
  `close-action.ts`
- `src/github/promote-close.ts` (new) — the pure commit/PR/issue resolver,
  both paths, squash fallback, merge/dedup
- `src/board/pr-landed.ts` (new) — the shared "open tasks with a PR
  artifact in their latest envelope" scan
- `src/board/close-action.ts` (new) — the idempotent close-action
- `src/board/board.ts` — `BoardApi` gains `closeIssue`
- `src/board/routes.ts` — `githubBoardApi` wires `closeIssue`; new
  `POST /studio/board/tasks/reap` route
- `src/studio/task-reap.ts` (new) — the pure reap orchestrator
- `src/studio/cli-args.ts` — `task-reap` command + verb help
- `cli/fleet.ts` — `cmdTaskReap`, wired into `main`
- test files for all of the above, plus `closeIssue` added to every existing
  `BoardApi` test double (`board.board.test.ts`, `board.envelope.test.ts`,
  `board.fleet-routes.test.ts`, `board.routes.test.ts`, `board.verify.test.ts`)
- this doc

## Boundaries respected

Untouched: `cli/orca-workspace.ts` (board issue #6), `skills/`, `.github/`
(board issue #7), `apps/fleet/container/`. No GitHub issue on this repo was
ever hand-labelled or hand-closed via `gh` during development — every close
path exercised in a test is a mocked/injected fetch, never a real call
against `rafarc21/fleetflare`.
