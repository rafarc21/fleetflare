# Plan — #1245: `fleet sprint open/status/close` + `task new` requires sprint

Sprint = GitHub milestone (existing: `task new --sprint`, `task ls --sprint`,
board.ts resolves title→number, never implicit-create). This adds the three
sprint lifecycle verbs, the backlog escape hatch, and makes `--sprint` the
default (not the exception) for `task new`. CLI-only; no Worker route is needed
beyond two new `/studio/board/sprints*` endpoints (see step 5).

## Objective

1. `fleet sprint open "<title>" --maestro <name> --goal "<outcome>"` — create a
   milestone; refuse if the title exists. Store `Owner: <name>` + goal in the
   milestone description (parseable lines).
2. `fleet sprint status [title]` — `Sprint <title>: x/y (z%)` (x = completed,
   y = milestone tasks minus canceled), then one line per non-completed task
   `(n, state, studio)`. No title → every open sprint.
3. `fleet sprint close <title>` — refuse while any task is
   working/input_required/awaiting_merge, or any linked PR is open; move the
   remaining submitted tasks to milestone `backlog` (create once if missing —
   the one implicit create allowed); close completed issues; close the
   milestone.
4. `fleet task new` — refuse without `--sprint` unless `--backlog` (files into
   the `backlog` milestone). The refusal names the open sprints.
5. `fleet sprint ls` — open sprints with owner, goal, x/y.

## Design decisions

- **Repo on every sprint verb** follows the same detect-and-report convention
  `task new`/`task ls` use: `--repo` wins, else cwd's git remote, else the
  Worker's fleet default.
- **Owner/goal in the description**, not new fields. GitHub milestones carry a
  description; `Owner: <name>` is the parseable line the task requires.
- **`--backlog` is a milestone**, not a state label. `task new --backlog`
  resolves-or-creates the `backlog` milestone and files there. `--sprint` and
  `--backlog` are mutually exclusive (parse-time).
- **Backlog implicit-create is scoped** to `task new --backlog` and
  `sprint close`'s reassignment — the only two places the task allows it.
  `resolveMilestone` itself keeps refusing unknown titles.
- **close refuses first, moves second.** The live-state gate and the open-PR
  gate run before any write. Then, per task in the sprint: completed → close
  issue; otherwise → re-point milestone to `backlog`. Canceled tasks are never
  counted in y and never moved (they are already finished work).
- **`sprint status` is read-only**: completed = `state === "completed"`; y =
  tasks in the milestone that are not `canceled`.

## Steps

1. `apps/fleet/src/board/api.ts` — `createMilestone`, `closeMilestone`,
   `setIssueMilestone`, `listOpenMilestones` (milestones need `description`
   carried through `listMilestones` too). Wire into `BoardApi`
   (board.ts) + `githubBoardApi` (routes.ts) + test fakes.
2. `apps/fleet/src/board/milestone.ts` — `renderMilestoneDescription`,
   `parseMilestoneOwner`, `resolveOrCreateBacklogMilestone` (pure, testable).
   `TaskBrief.backlog` (brief.ts), `createTask` resolves it.
3. `apps/fleet/src/board/sprint.ts` — `openSprint`, `sprintSummaries`,
   `closeSprint` (pure over `BoardApi` + `getPullRequest`).
4. `apps/fleet/src/board/routes.ts` — `GET/POST /studio/board/sprints`,
   `POST /studio/board/sprints/close` (method-first, `resolveBoardRepo`).
5. `apps/fleet/src/studio/cli-args.ts` — `task new --backlog`; `sprint`
   verb with `ls`/`open`/`status`/`close`; `VERBS` entries.
6. `apps/fleet/cli/sprint-format.ts` + `cli/fleet.ts` — `cmdSprint*`,
   `cmdTaskNew`'s sprint-required refusal.
7. Tests alongside each step (TDD: RED first). Update `skills/fleet-cockpit`
   and `skills/maestro-playbook` `task new`/sprint references.

## Boundaries

`apps/fleet/cli` + `apps/fleet/src/board` + `apps/fleet/test` +
`skills/`. No container changes. No Cloudflare deploy from a studio (the two
new routes ride the existing Worker; a Worker deploy is a separate, gated
operator action — stated in the PR body).

## Verification

`bun run test` in `apps/fleet` (vitest, the full board + cli suite). No
RED/GREEN mutation of a heavy gate — this is one ordinary suite run, run once
at the end, one heavy gate at a time.