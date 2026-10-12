# Plan — src/race-timeout.ts: raceWithDeadline, one home (refs #450)

Sweep-6 finding F4 (parent #415, doc docs/maintainability/2026-10-12-deep-modules-sweep-6.md §F4).
Two src/ sites hand-roll the REJECTING `Promise.race` + `setTimeout` + `finally clearTimeout`
deadline idiom; the existing resolving twin lives in container/ego-browser/process-reap.ts:124,
which src/ can never import (container/Dockerfile.studio ships container/ but never src/, and
container/tsconfig.json includes only container/** — same import discipline src/base64.ts documents).

## New module: apps/fleet/src/race-timeout.ts

Dependency-free (same rule as src/base64.ts header). One export:

- `raceWithDeadline<T>(promise: Promise<T>, timeoutMs: number, makeTimeoutError: () => Error, setTimeoutFn: typeof setTimeout = setTimeout): Promise<T>`
  — rejecting variant: timer armed for `timeoutMs` via `setTimeoutFn`, `Promise.race([promise, deadline])`,
  `clearTimeout` in `finally` either way so a fast path never leaks a timer. Rejects with
  `makeTimeoutError()` when the deadline wins.

## Migrate (behavior identical at every call site)

- `src/exceptions.ts` `recordWorkerException` insert deadline (:264-284): the inline timer dance
  becomes `await raceWithDeadline(db.prepare(...).bind(...).run(), INSERT_TIMEOUT_MS, () => new Error(\`recordWorkerException insert timed out after ${INSERT_TIMEOUT_MS}ms\`))`.
  Comment at :141-142 updated to point at the shared helper.
- `src/studio/sandbox-api.ts` `sbExec` deadline (:219-235): the timer body keeps its abandoned-set
  side work AT THE CALL SITE — wrap the promise, do not move that logic into the helper. The
  side work (mark session abandoned, `call.then(release, release)`) moves into the `makeTimeoutError`
  factory closure if needed to keep one race call, but stays sbExec-local.

NOT touched: container/ego-browser/process-reap.ts (keeps its own resolving raceWithTimeout — image
boundary); src/studio/do.ts's three copies (:1647, :3645, :4931 — CLAUDE-ONLY, deferred to maestro lane).

## TDD

1. Characterization GREEN first: `bun run test -- exceptions.test.ts` (case "1a") and
   `bun run test -- studio.exec-deadlines.test.ts` pass BEFORE any fold; test/bun/ego-browser-process-reap.test.ts untouched.
2. RED: new `apps/fleet/test/race-timeout.test.ts` — deadline wins → rejects with makeTimeoutError()'s
   error; promise wins first → resolves with value; timer cleared on fast path (no dangling timer —
   assert via injected fake setTimeoutFn + clearTimeout call count); injected clock works; timeoutMs=0 fires.
   Import fails → RED.
3. GREEN: implement src/race-timeout.ts, fold both call sites.
4. Both characterization suites pass unchanged after the fold.
5. `bun run check` + `bun run english-check` exit 0, one at a time (gate budget).

## Bounds

~80 changed lines, one PR. Two-way door: revert restores two local dances.
