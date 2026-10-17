# Plan: #1106 — operator `fleet task message` route (verify + close)

## Problem
Local `fleet task message <n> "<text>"` (#1090) got 404: cli/fleet.ts POSTs
/tasks/<n>/message with operator creds, but only the studio surface handled
`action === "message"`. #1090's "same Worker route" premise wrong.

## Fix (already merged, PR #1111, commit 6d4d960)
- Operator route POST /studio/board/tasks/:n/message (BOARD_ROUTE_RE gains
  `message`; handleBoard action branch calls sendTaskMessage with sender
  `operator`). Cloudflare Access only.
- sendTaskMessage catches GitHubError 404 -> "task #<n> not found in <repo> —
  nothing to message"; closed/terminal 409 unchanged.
- cli/fleet.ts sends `repo` in the body (operator writes read repo from body),
  not the query string.

## Verification (this task)
- Tests on main cover: operator post+wake (sender `operator`), studio spawn
  token 401, unknown 404 naming task, closed 409.
- Local: vitest test/board.routes.test.ts + test/board.task-message.test.ts ->
  110 passed; bun run check exit 0; english-check clean.

## Outcome
Code already on main; no new code. Set task awaiting_merge; PR #1111 carries
the change.