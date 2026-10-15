# Plan — S43-F2: shared webhook test harness (#880)

Ref #850 (sweep 43, F2). Census: docs/maintainability/2026-10-14-dup-fixtures-sweep-43.md.
github.webhook-core.test.ts and github.webhook-autoclose.test.ts (PR-#720 split
pair) hand-sync byte-identical envWithStudio() (:44) and post() (:87) blocks.
Goal: helpers/webhook-harness.ts owns both; suites keep their counter state.

## Steps

1. RED baseline: vitest run on the two files at origin/main — 75 tests green.
2. Write test/helpers/webhook-harness.ts: exports WebhookCtl, WebhookHarnessDeps,
   envWithStudio(secret, deps), post(deps, secret, body, sig, event), drainLast(deps).
   Counter state stays suite-owned: wakes/rpcCalls as const arrays (reset in
   place, wakes.length = 0), getCalls/wakeOutcome/onWake/lastCtx inside a
   const ctl object (members reassigned in beforeEach) — snapshot-safe for the
   harness, same override discipline as helpers/board-api.ts.
3. Adopt in github.webhook-core.test.ts: delete local envWithStudio + post +
   drainLast + the moved counters' declarations (lines ~22-108), declare the
   const arrays + ctl, bind h/send, beforeEach resets in place, rename the ~13
   bare getCalls/wakeOutcome/onWake references to ctl.*, post( -> send(,
   drainLast() -> drainLast(h).
4. Same adoption in github.webhook-autoclose.test.ts (1 onWake site;
   envWithToken spreads envWithStudio(SECRET, h)).
5. GREEN: same vitest run — same 75 pass; tsc -p test clean; english-check clean.
6. Commit, push, PR (refs #850, refs #880), review, QA, done record.

## Boundaries

Test-only files; no src/ change. Verify runs the two-file vitest twice (light)
plus tsc -p test once. No full suite, no bundler build.
