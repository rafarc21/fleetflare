---
# 1214 — amend PR #1213 round 2: pending-first, live-only reuse, guarded route, retrying lookup (#1172)

Round 2 amend of PR #1213 (#1172 shared-head guard) per maestro gate-integrity
review. Push to same branch; no new PR; no merge. Five items, TDD failing-first.

## 1. Pending before the fresh -p create; reuse only a LIVE -p run (auto-run.ts + auto-run-env.ts)

startGateRun gains `postPending?` (same shape as startEditedGateRun's) and calls it
BEFORE the fresh `-p<pr>` create, so GitHub never sees the head without a pending
gate/verdict. A `-p<pr>` id already existing is reused only while its instance is
LIVE (`isLiveStatus`); a finished one starts `-p<pr>-r<base36 now>` (injected `now`,
mirroring startManualGateRun). auto-run-env.ts's autoRunFromEnv passes postPending
for the non-edited fresh path too (editedPendingPost wording stays).

## 2. reopened + base-change edited as fresh-run triggers (auto-run.ts)

`AUTO_RUN_ACTIONS` gains `"reopened"`. The edited gate also accepts `changes.base`
(the changes type adds `base?: unknown`), so a base move re-runs, not dedupes.

## 3. workflow.ts returns the GUARDED state/description (workflow.ts + routes.ts)

Skip-path (:191) and verdict-path (:318) currently post the guarded status but return
the unguarded `skipped`/`final`. Both return the guardSuccessStatus result instead, so
routes.ts:65 (and cli/gate.ts gateWatchExitCode) surface the same red GitHub shows.

## 4. sharedHeadLookup THROWS so step.do retries; listPullsForCommit, fail closed after retries (workflow.ts + github/api.ts)

sharedHeadLookup switches listOpenPulls -> listPullsForCommit (head-sha-scoped, no
paging/truncation). github/api.ts listPullsForCommit + CommitPull gain `state`, and the
guard filters `state === "open"`. sharedHeadLookup throws on error (so step.do retries);
each call site wraps `.catch(() => ({ error: "..." }))`, so a 5xx that stays 5xx fails
closed only after retries run out.

## 5. Tests, failing first

- auto-run.test.ts: push-back reuse (finished -p -> -p<pr>-r<t>); reopened action;
  base-change edit; `latest !== null` mutant dead (finished -p must start fresh, not
  return runId); dropped recordRun mutant dead (fresh -p records as latest).
- api-queries.test.ts: listPullsForCommit returns state.
- gate-routes.test.ts: guarded skip/verdict output carries state failure + description.
- gate-workflow-precheck.test.ts: one guard-wiring test (lookup 5xx then success -> green).

## Verification

- `apps/fleet`: `bun test test/bun/gate-config.test.ts test/bun/gate-auto-run.test.ts`
- `apps/fleet`: `npx vitest run test/github.api-queries.test.ts test/gate-routes.test.ts test/gate-workflow-precheck.test.ts`
- `apps/fleet`: `bun run check`

refs #1172. No closing keyword.
---