# Maestro wake filter: own tasks/PRs only (board issue #111)

## The problem, as measured

Board #70 is the operator's own retro from a day running 25 parallel
studios. Ask #7 named the two worst noise sources it produced, in the
operator's own words, and both trace to the same place:
`apps/fleet/src/github/webhook.ts`'s `wakeMaestro()`, which calls
`deltaDigest()` (`apps/fleet/src/github/wake-events.ts`) to decide whether an
incoming GitHub webhook delivery deserves a wake. Every wake is a real turn
at max reasoning effort — real Claude token cost — so a wake that tells
maestro nothing it needed to act on is not neutral, it is waste:

1. **"PR synchronize" fires on every push to a PR branch.** A studio pushing
   three fixup commits to its own open PR is three `pull_request.synchronize`
   deliveries, each one waking the repo's maestro for a PR maestro itself
   never holds — only the studios/lanes it supervises hold PRs.
2. **"Other lanes' comments" wake the repo's maestro for tasks it has no
   business seeing.** A comment on a task assigned to some OTHER studio
   already reaches that studio's own lane through board issue #236's
   targeted wake path (`wakeTaskOnComment`/`wakeOnComment` in
   `apps/fleet/src/board/comment-wake.ts`) — a second, generic maestro wake
   for the identical delta is pure duplication, not new information.

Today `deltaDigest` wakes maestro on EVERY watched event
(`issue_comment`, `issues`, `pull_request`, `workflow_run`) for the repo,
with no regard for whose business the event actually is.

## The fix

### 1. `pull_request`: skip every `synchronize` unconditionally

Checked first in the `pull_request` branch, before any other work: if
`action === "synchronize"`, return `null` immediately. Every other
`pull_request` action (`opened`, `closed`, `reopened`, `ready_for_review`,
`edited`, …) is untouched. No per-PR ownership filtering is added — there is
no cheap ownership signal for a PR in this codebase (the `studio:` label
lives on the task ISSUE, never on a PR), and resolving one would mean a new
GitHub API call inside the webhook's synchronous path, which is out of
scope here.

### 2. `issues`/`issue_comment`: wake only for maestro's OWN task

A new predicate, checked against the issue's own `labels` (already present
on the webhook payload — no extra API call) via `taskAssignees` (already
exported, pure, from `apps/fleet/src/board/types.ts` — zero imports of its
own, safe to pull into `wake-events.ts`) and `maestroIdFor` (already defined
in `wake-events.ts`, folds the payload's `repository.full_name` into this
repo's own maestro id):

- **Backlog** (no `studio:` label at all) → own → wake. Maestro is the one
  who triages backlog.
- **Single assignee, and it IS this repo's maestro**
  (`studio:<repo>--maestro`) → own → wake.
- **Single assignee, and it is NOT maestro** (some other lane) → not own →
  do not wake. That lane's own targeted wake (board #236) already covers it.
- **Ambiguous** (more than one `studio:` label) → treated as own → wake.
  Label drift is exactly the kind of thing maestro, not a lane, should see;
  never silently dropped.

`issueOf`'s return shape gains a `labelList: string[]` field (the raw array)
alongside the existing joined-string `labels` field the `issues` display
line still needs verbatim — so the ownership check does not re-parse
`issue.labels` a second time.

## Out of scope (deliberately)

- **`workflow_run`**: untouched. Already cheap — gated to `action ===
  "completed"` only, and CI runs are not lane-specific the way a task issue
  is.
- **The "optional" generic digest for the rest**: issue #111's own body
  calls a digest-for-non-own-events optional. Left out entirely — no stub,
  no TODO, no dead scaffolding.
- **Per-PR ownership**: no `studio:`-equivalent label exists on a PR in this
  codebase; adding one (or resolving ownership through the PR's linked
  issue) would need a new synchronous GitHub API call inside the webhook
  handler, which this task does not authorize.

## Boundary

Touched: `apps/fleet/src/github/wake-events.ts` (the two filters above),
`apps/fleet/test/github.wake-events.test.ts` (new + corrected cases),
`apps/fleet/test/github.webhook.test.ts` (fixups to assertions that assumed
the old always-wake behavior — see that file's own updated comments for
which and why), this plan doc. Nothing under `src/board/`, `src/studio/`,
`container/`, `gates/`, `skills/`, `.github/` touched.
