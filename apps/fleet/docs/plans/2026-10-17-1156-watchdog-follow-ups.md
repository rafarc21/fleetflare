# Gate watchdog follow-ups (#1156)

Five non-blocking fixes from the #1150 round-2 review, all decided. No redesign.

1. **Red check depends on GitHub, no fallback.** `hasRedLeg` resolves the canonical repo name via
   `getPullRequest` every sweep, so GitHub down >~80 min makes every sweep fail with no final verdict.
   Fix: apply the same 115-min final-age rule rerun-launch errors already get (watchdog.ts:144-149).
   Wrap the `hasRedLeg` call: before GATE_WATCHDOG_FINAL_AGE_MS a failed red check rethrows (the row is
   kept and the next sweep retries); at the final age the run ends with the final error verdict.
2. **Switched-off repos hold sweep slots.** The `!deps.gated(repo)` skip returns without retiring.
   Fix: `await deps.index.retire(repo, pr, runId, row.progressedAt ?? 0);` before `return "skipped";`
   (retire is conditional on `progressedAt`, so a moved pointer is untouched). Add a test.
3. **Final verdict post unstamped.** Call `deps.index.progress(repo, pr, runId, now)` before
   `deps.post(...)` in BOTH final branches (red/rerun and the catch branch). `WatchdogIndex` already
   has `progress` via `GateRunIndex`. Add tests.
4. **Final post failure ignored after retire.** Reorder both final branches so the post lands before
   the end and the retire: `progress`, `post`, `endRunOrThrow`, `retire`. `post` returns a boolean
   (postGateStatus's failed-after-retries contract), and a failed post throws, keeping the run live and
   its row in the sweep so the next sweep retries the verdict instead of losing it. Test pins the order:
   post succeeds then retire; post fails then failed.
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
`src/gate/watchdog.ts`, `test/bun/gate-watchdog.test.ts`, `test/gate-run-index.test.ts` (one line).