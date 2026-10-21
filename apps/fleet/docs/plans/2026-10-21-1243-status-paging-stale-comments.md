# #1243 — status read-back paging + stale comments + watchdog narrow + endIfLive

Four PR follow-ups from #1242's review. Worker code only: `apps/fleet/src/gate` + `apps/fleet/src/github/api.ts`.

## (a) getCommitContextStatus paging (api.ts)
Bug: read-back uses combined-status endpoint — first 30 contexts only. A head
with >30 contexts (GitHub Apps post many) hides `gate/verdict`; postGateStatus
read-back returns undefined, throws, run errors on busy repos.
Fix: per-context `statuses?per_page=100` endpoint, page via Link `rel="next"`
with `COMMIT_STATUSES_MAX_PAGES = 10` cap, first match per context wins
(newest-first). Bodyless GET via `GH_HEADERS_GET`, same `ghRequest` path.

## (b) stale comments (workflow.ts:255, auto-run-env.ts:86)
workflow.ts comment says failed pending post "never blocks the run" — false
since #1226 (postGateStatus throws, retries 5x, errors run). Fix to fail-closed.
auto-run-env.ts `pendingPost` catch is correct (best-effort, must not block);
fix comment to say why the swallow is right: the run's own post-pending step
(#1226, fail-closed) is what guarantees the status.

## (c) watchdog reconcile narrowed (watchdog.ts)
Read-then-post race: watchdog reads undefined/pending, posts error, but a newer
same-head run may have posted its own pending/green between read and post.
Narrow: post only when pending description still names THIS run id. Never
clobber a newer same-head run's status.

## (d) endIfLive terminate failure (auto-run.ts)
endIfLive swallows get AND terminate errors -> two live runs on one head.
Narrow: tolerate unknown-instance get (false), but a live instance's failed
terminate THROWS. recordRun (different head) catches+logs+proceeds; startEditedGateRun
(same head) lets it throw and abort.

## Test plan (targeted only)
- vitest: `test/github.api-queries.test.ts`, `test/gate-workflow-precheck.test.ts`
- bun: `test/bun/gate-watchdog.test.ts`, `test/bun/gate-auto-run.test.ts`
- cross-check: `gate-pending-status`, `gate-infra-rerun`, `gate-watchdog-env`,
  `gate-drain`, `board.completed-gate`/`gate-routes` if they touch the mock
- typecheck: `npx tsc --noEmit` (main src project only)