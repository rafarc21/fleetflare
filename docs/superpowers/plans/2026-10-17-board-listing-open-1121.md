# Plan — board listing for big repos under 5 s (#1121, refs #1117 item 2)

## Decision: option 2 (narrow reap's read to `state=open`), floor preserved by a one-call total count

Profiled live on this repo (REST, per-page 100, 2026-10-17):

- `state=all` listing, serial pages (`listIssues` today): **8.3 s**, 12 pages, 1166 rows (630 issues + 536 PRs).
- `state=open` listing, serial pages: **1.5 s**, 2 pages, 180 rows.
- GraphQL `issues.totalCount` (non-PR, all states — the exact number `board.length` compares against today): **0.5 s**, one call.

Why not option 1 (incremental `since=` sync): `since` moves the cursor, not the page count — a busy day refills pages, and a quiet one still costs the same first read. Missed-update handling needs a full-read fallback, which is the slow path back. Option 2 is one flag on a call reap already makes.

Floor: `board.length` after the PR filter is exactly GitHub's non-PR issue count, so `issues.totalCount` is the same number for one call instead of 12 pages. The floor keeps its meaning (a monotone count that only grows) and costs 0.5 s.

## Changes

1. `src/board/api.ts`: `countIssues(token, repo)` — one GraphQL call, `issues.totalCount`, no PRs. Reuses the private `ghGraphQL`.
2. `src/board/board.ts`: `BoardApi.countIssues`; `ListTasksQuery.open?: boolean` threaded into `apiQuery` as `ListIssuesQuery.open`.
3. `src/board/api.ts`: `ListIssuesQuery.open?: boolean` → `state=open` in the URL (default stays `all`).
4. `src/board/routes.ts`: operator GET `/studio/board/tasks` reads `open` param → `query.open`; new `GET /studio/board/tasks/count` → `api.countIssues`.
5. `cli/fleet.ts` reapDeps: `listBoard` → `/tasks?repo=X&open=1`; `studioTasks` unchanged (label filter already scopes it; still `open=1`); new `boardTotal()` dep → `/tasks/count?repo=X`.
6. `cli/reap.ts`: floor check moves from `board.length` to `deps.boardTotal()`; `listBoard` still feeds live-task detection. A `boardTotal` throw = bad read, reaps nothing. `boardRows` stores the total now — same state file, same key, no migration (a stale all-rows baseline just holds until the first new write, same direction).

## RED tests (fleet-reap.test.ts, board.api.test.ts, fleet-reap-wiring.test.ts)

- reap: `listBoard` returns 0 rows but total >= half baseline → proceeds (open board CAN be legitimately empty).
- reap: total under half baseline → reaps nothing, keeps baseline.
- reap: `boardTotal` throws → reaps nothing.
- api: `listIssues` with `open: true` sends `state=open`.
- board.ts: `open` reaches the api query.
- wiring: reap's board read URL carries `open=1`; count route hit once.

## Steps

1. Plan doc (this file).
2. RED: reap floor tests + api/board open tests; run touched files; commit.
3. GREEN: implement 1–6; touched files green; commit.
4. Verify (one at a time): `bun test test/bun/fleet-reap.test.ts test/bun/fleet-reap-wiring.test.ts test/board.api.test.ts test/board.fleet-routes.test.ts`; `bun run check`; `bun run test-lies-check`.
5. Push after first commit; PR refs #1121; envelope.

## Boundaries

Touch only: `src/board/api.ts`, `src/board/board.ts`, `src/board/routes.ts`, `cli/reap.ts`, `cli/fleet.ts`, the four test files, this plan doc. Never `/fleet/tasks` (studio surface), never `task-reap.ts` (issue #8's PR-evidence reap — different read), never the nudge logic. GraphQL limit: search API is 30/min but GraphQL counts ride the core 5000/h limit — one call per poll is free.
