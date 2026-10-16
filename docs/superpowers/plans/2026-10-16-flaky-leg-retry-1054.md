# Gate retries a red leg once (flaky detection), keeps the infra cause

Issue: https://github.com/rafarc21/fleetflare/issues/1054
Refs #715 (gate runner). TDD, targeted tests only.

## Change

1. leg-run.ts `runLegStep`: when the `start-<leg>` step returns state
   "failure", run the leg ONCE more as a second step `retry-<leg>` (same
   dispatch, same step config). Retry success -> success with description
   "flaky: passed on retry". Retry failure/error -> return the retry's
   result. A first "success" or "error" never retries.
2. leg-run.ts: on a non-2xx reply, read the 503 body's `error` field into the
   thrown message "<leg>: <error>" (cut at 200 chars). The catch surfaces that
   message as the error description instead of "<leg> did not report a result".
3. The 25-min leg deadline stays infra (no change).

## Files

- apps/fleet/src/gate/leg-run.ts (runLegStep + a small error-body reader)
- apps/fleet/test/bun/gate-leg-run.test.ts (flaky retry + infra-cause tests)

## Verify

- cd apps/fleet && bun install --frozen-lockfile
- bun test test/bun/gate-leg-run.test.ts test/bun/gate-run-leg.test.ts
- bun run check
- bun run test-lies-check