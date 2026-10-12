# Plan — #471 S9-F4 drop `export` on 19 self-file-only consts

Refs https://github.com/rafarc21/fleetflare/issues/471 (parent sweep #428, finding F6; doc docs/maintainability/2026-10-12-dead-code-sweep-9.md §F6). Tier GLM-OK. Bounded: 19 keyword-only deletions across 10 files, one PR, two-way door (revert restores the keywords).

## Problem

Nineteen exported constants have zero consumers outside their own defining file. Each greps (all of apps/fleet: src, cli, test, test-integration, scripts, page, container) to exactly its defining file. Sharpest case: `WAKE_VERDICT` in src/studio/wake.ts — the wire-format magic string of the wake protocol, looks importable, never imported by any other module. An exported constant nobody imports lies about its blast radius: a reader assumes the symbol is shared API surface, and a future change must consider external consumers that do not exist.

## Change

Drop the `export` keyword on each of the nineteen lines below. Constant, value, and every in-file usage stay; only the keyword goes. Line numbers verified on this branch post-merge (issue numbers were pre-merge; cli/reap.ts and cli/fleet.ts drifted — real lines below).

| Const | File:line | In-file usage |
|---|---|---|
| `GH_PROXY_VERBS` | src/studio/gh-wrapper.ts:42 | :147 |
| `GH_BUILTIN_COMMANDS` | src/studio/gh-wrapper.ts:51 | :90 |
| `STUDIO_REAL_GH_PATH` | src/studio/gh-wrapper.ts:57 | :61, :183, :203 |
| `STUDIO_GH_WRAPPER_PATH` | src/studio/gh-wrapper.ts:58 | :182, :204 |
| `WAKE_VERDICT` | src/studio/wake.ts:237 | :423-:428, :540, :560 |
| `SUBMIT_FRAGMENT_CHARS` | src/studio/wake.ts:263 | :267 |
| `WATCH_EVERY_MINUTES` | src/studio/container-watch.ts:13 | :16 |
| `PATH1_BATCH_MIN_BUDGET_MS` | src/github/promote-close.ts:66 | :178 |
| `REAP_CAPTURE_MAX_AGE_MS` | cli/reap.ts:63 | :199 |
| `REAP_REFUSALS_BEFORE_BACKOFF` | cli/reap.ts:68 | :364 |
| `OPEN_PRS_TIMEOUT_MS` | cli/fleet.ts:497 | :546, :594 |
| `REAP_STATE_PATH` | cli/fleet.ts:2360 | :2541-:2542 |
| `REAP_READ_TIMEOUT_MS` | cli/fleet.ts:2364 | :2415 |
| `BRINGUP_LOG_TAIL_LINES` | src/studio/provision.ts:1252 | :1281 |
| `SESSION_ADOPT_SCRIPT` | src/studio/provision.ts:3124 | :3182 |
| `SESSION_ADOPT_KILL_SECONDS` | src/studio/provision.ts:3128 | :3181 |
| `SESSION_ASIDE_GLOB` | src/studio/session-sync.ts:614 | :550, :560, :634 |
| `INFLATE_READ_VIEW` | src/studio/burn.ts:1578 | :1659 |
| `RESCUE_GC_DEFAULT_DAYS` | src/board/routes.ts:319 | :333 |

Explicitly OUT of scope (issue lists them CLAUDE-ONLY): `REMOTE_BRANCHES_LIST_FILE`, `RESCUE_DISCOVERY_TIMEOUT_SECONDS` (rescue scripts), `REPO_AUTH_WILDCARD` (auth). No auth, tokens, rescue, failover, deploy, migrations, or credentials touched. `RESCUE_GC_DEFAULT_DAYS` is a board route's local default-days for its own GC endpoint — keyword removal only.

## Steps

1. Apply the 19 keyword deletions (table above), one commit.
2. Verify, one heavy gate at a time, each ALONE:
   - Per const, `grep -rE "(^|[^A-Za-z0-9_.])NAME([^A-Za-z0-9_]|$)"` across apps/fleet (src, cli, test, test-integration, scripts, page, container) still shows the defining file only.
   - `cd apps/fleet && bun run check` → exit 0 (tsc --noEmit on all five tsconfigs). HEAVY GATE — run alone, nothing else heavy in parallel.
   - `cd apps/fleet && bun test` on: test/bun/gh-wrapper.test.ts, test/studio.provision.test.ts, test/studio.wake.test.ts, test/bun/wake-cmd.test.ts, test/studio.container-watch.test.ts, test/github.promote-close.test.ts, test/bun/fleet-reap.test.ts, test/cli.reap-terminal.test.ts, test/bun/cli.fleet-ls-prs.test.ts, test/studio.session-aside.test.ts, test/bun/session-aside.test.ts, test/studio.burn.test.ts, test/board.fleet-routes.test.ts, test/board.leak.test.ts → all pass.
3. Code Reviewer: fresh-context review of the diff (rounds cap 2).
4. QA: n/a for keyword-only removal (no browser surface), covered by reviewer + tests.
5. PR with Summary / Evidence / Merge Danger per template; two-way door.
