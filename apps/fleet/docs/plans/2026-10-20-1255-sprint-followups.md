# Plan — #1255: fleet sprint follow-ups (#1245)

## Objective

Four sprint bugs found in review of #1245's `fleet sprint` verbs. Fix each.

## Bugs

(a) `fleet sprint status` total counts closed issues that carry no state label.
    `sprintSummaries` (sprint.ts) computes `total = tasks.filter(state !==
    "canceled")`, so a CLOSED issue with no state label (a hand-closed or
    drifted issue still pointed at the milestone) inflates the denominator.
    Fix: a task counts toward `total`/`completed` only when it is OPEN, or
    closed AND still carrying a board state label. Concretely, exclude a
    closed task whose `state === null`.

(b) `closeSprint` moves closed non-completed (failed) issues to the backlog.
    A `failed` task is closed on GitHub (issue #55 closes terminal states).
    `closeSprint`'s write loop is keyed on `t.state` only, so a closed failed
    task falls into the `else` branch and gets re-pointed at `backlog`. Fix:
    CLOSED issues stay in the sprint milestone — only OPEN non-completed
    non-canceled tasks move to backlog.

(c) `openSprintTitles` (cli/fleet.ts) lets a network error escape as an
    unhandled rejection → a stack trace, not a refusal message. Fix: wrap the
    fetch in try/catch; any throw returns `null` (the caller already prints the
    "could not read the open sprints" refusal line for null).

(d) `resolveOrCreateBacklogMilestone` (board.ts) is check-then-create, so two
    concurrent first uses can both create a `backlog` milestone. Fix: make it
    idempotent — after `createMilestone`, re-list and REUSE the OLDEST
    `backlog` milestone (lowest number) rather than trusting the just-created
    one; and if a pre-existing one appears on the re-list, return that.

## Boundaries

`apps/fleet/src/board/sprint.ts`, `apps/fleet/src/board/board.ts`,
`apps/fleet/cli/fleet.ts`, plus their tests. No other surface.

## Verification

`bun run test` (full vitest), `bun run check`, `bun run english-check` — all
exit 0. Tests added alongside each fix (TDD: RED first).