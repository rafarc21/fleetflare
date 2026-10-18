# Plan — task #1215: amend PR #1213 round 3 (open-PR lookup + workflow wiring tests)

Round 3 of the #1172 shared-head guard, amending PR https://github.com/rafarc21/fleetflare/pull/1213. Push to `1211-gate-shared-head-guard`; no new PR, no merge.

## Root cause
`sharedHeadLookup` (workflow.ts) lists via `listPullsForCommit` = GET `commits/{sha}/pulls`. GitHub never returns OPEN PRs from that endpoint once the sha is on the default branch, so the guard reads an empty list and posts a false green. Round 1 used a paged `listOpenPulls` (GET `pulls?state=open`) + head-sha filter; round 2 (bd144bd) deleted it.

## Change
1. Restore `listOpenPulls` to `github/api.ts`: paged via Link header (`OPEN_PULLS_PAGE_SIZE=100`, `OPEN_PULLS_MAX_PAGES=10`), returns `{number, headSha, baseRef, state}` plus `truncated`; THROWS on non-2xx.
2. `sharedHeadLookup` switches to `listOpenPulls`, keeps `state === "open" && headSha === headSha`, THROWS on error (step.do retries once), and fails closed on truncation via `{error}`.
3. `guardSuccessStatus` (config.ts) unchanged: any `{error}` -> "gate: cannot list shared-head PRs".

## Tests (failing first)
Workflow, vitest `test/gate-workflow-precheck.test.ts` (drives the real engine):
- (a) skip path: sibling OPEN PR, same head sha, different base -> failure in BOTH the status POST and `out.state` (what routes.ts:72 surfaces to the CLI).
- (b) verdict path: same.
- (c) persistent listing error -> failure after the step retries run out.
- (d) a CLOSED sibling is ignored -> green.
- (e) a truncated list -> failure (fail closed).
Keep/update: transient listing error retries green; different head sha ignored.

API, vitest `test/github.api-queries.test.ts`: restore listOpenPulls map/paging/truncation/throws, with `state`.

## Mutants that die
skip posts unguarded success (a); verdict returns final not guarded (b); verdict posts unguarded (b); lookup failure caught as green (c); open-state filter removed (d).

## Verify
`bun test test/bun/gate-config.test.ts test/bun/gate-auto-run.test.ts`; `npx vitest run test/github.api-queries.test.ts test/gate-routes.test.ts test/gate-workflow-precheck.test.ts`; `bun run check`; `bun run english-check`; `bun run test-lies-check`.