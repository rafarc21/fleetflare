# Gate watchdog follow-ups (#1156)

Five non-blocking fixes from the #1150 round-2 review, all decided. No redesign.

1. **Red check depends on GitHub, no fallback.** `hasRedLeg` resolves the canonical repo name via
   `getPullRequest` every sweep. Store it at record time: migration `0010_gate_repo_full_name.sql`
   (`ALTER TABLE gate_pr_head ADD COLUMN repo_full_name TEXT;`, nullable). `GateRunRecord` gets
   `repoFullName?`; `d1RunIndex.record` stores it; `startGateRun`/`startManualGateRun` wire it from
   the resolve step's `pull.repoFullName`. `hasRedLeg` uses the stored name, else the GitHub call;
   `sweepRun` wraps `hasRedLeg` in the final-age rule rerun-launch errors get (watchdog.ts:144-149):
   past GATE_WATCHDOG_FINAL_AGE_MS a failing red check treats the run as not-red only at final age,
   else rethrows.
2. **Switched-off repos hold sweep slots.** The `!deps.gated(repo)` skip returns without retiring.
   Fix: `await deps.index.retire(repo, pr, runId, row.progressedAt ?? 0);` before `return "skipped";`
   (retire is conditional on `progressedAt`, so a moved pointer is untouched). Add a test.
3. **Final verdict post unstamped.** Call `deps.index.progress(repo, pr, runId, now)` before
   `deps.post(...)` in BOTH final branches (red/rerun and the catch branch). `WatchdogIndex` already
   has `progress` via `GateRunIndex`. Add tests.
4. **Final post failure ignored after retire.** Reorder post-before-retire in both final branches:
   `endRunOrThrow`, `progress`, `post`, `retire`. A post that throws keeps the row (outcome "failed")
   so the next sweep retries; a finished run is then read as not-live and retires silently (accepted
   limitation, same as today). Test pins the order: post succeeds then retire; post throws then failed.
5. **N1c (comment 6223292963).** `decisiveResultKeys` picks retry over first try unconditionally, so
   a red first try whose retry stored an error reads as not-red. Fix in `hasRedResult`: for each leg
   base, read the first try; when it is `failure` and a retry exists, red only when the retry is not
   `success`; otherwise keep the current decisive pick. Bun tests: first failure + retry error -> red;
   first failure + retry success -> not red (covered); first error + try2 success -> not red (covered).

## Verification
RED-first TDD: each fix's test written first, confirmed failing, then implementation.
- `cd apps/fleet && bun test test/bun/gate-watchdog.test.ts test/bun/gate-infra-rerun.test.ts test/bun/gate-auto-run.test.ts`
- `bun run test test/gate-run-index.test.ts test/gate-watchdog-env.test.ts`
- `bun run check` (tsc, one heavy gate), `bun run english-check`, `bun run test-lies-check`

## Files
`src/gate/watchdog.ts`, `src/gate/watchdog-env.ts`, `src/gate/auto-run.ts`,
`src/gate/auto-run-env.ts`, `src/gate/workflow.ts`,
`migrations/0010_gate_repo_full_name.sql` (new), `test/bun/gate-watchdog.test.ts`,
`test/gate-run-index.test.ts`.