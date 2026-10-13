# Plan — S26-F10: split studio.survival-delivery.test.ts (input vs retry) (#697)

Sweep 26 finding F10 (docs/maintainability/2026-10-13-oversized-test-files-sweep-26.md, refs #635).
Pure move: 2168 lines, 19 describes, 140 `it()` over src/studio/survival-delivery, one natural seam.

- `test/studio.survival-input.test.ts` — lines :83-1338: 7 describes, 80 `it()`
  (allowlist, paneBusy signals, 3 branch sources, resolveSurvivalInput wiring,
  matchesTaskNumber, SOURCE 4, snapshot age).
- `test/studio.survival-retry.test.ts` — lines :1339-2168: 12 describes, 60 `it()`
  (delivery, #208/#231 threading, single-flight, pending marker, retry + bound,
  board outage, survivalTasks, draft check, tick wiring). Harness (`INCARNATION`,
  `bringup()`, `harness()`) sits at :1312-1337, just before the seam — moves with the retry half.

## Steps

1. Branch `refactor-697-survival-split` off origin/main (done).
2. Backend Developer, one commit per step, push after each:
   a. RED: add a guard test that fails while the old monolith still exists (e.g. a
      studio.survival-input.test.ts whose first `it` asserts the old file is GONE) — commit, push.
   b. GREEN: delete the old file; create both halves; guard turns green — commit, push.
3. Verbatim rules (sweep hazards): describes move whole, titles verbatim, `#NNN`
   provenance kept; no assertion text changed; no `vi.mock` in this file (verified) —
   nothing to split around mocks; `env.TEST_*` source-pins all sit in the retry half.
   Shared fakes (`fakeObserved`, `session`, `captured`, IDLE_PANE/MIDTURN_PANE) are
   duplicated per half — extraction is sweep-18's lane, never both at once.
   3 stale-name comments elsewhere (vitest.config.ts:82, src/studio/survival-delivery.ts:19,
   src/studio/do.ts:6428) repointed to the new file names in the same GREEN commit.
4. Verification, serial, one heavy gate at a time (flock /tmp/fleet-gate.lock):
   `npx vitest run test/studio.survival-input.test.ts test/studio.survival-retry.test.ts`
   (140/140) → `bun run check` alone → `bun run english-check` → `bun run test-lies-check`.
5. Fresh-context Code Reviewer (cap 30m): it()/test() count per file before vs after,
   sum equal, no assertion text changed. Max 2 rounds.
6. QA + PR + envelope on https://github.com/rafarc21/fleetflare/issues/697.

## Verification

The four commands above, exit 0 each, real output tails into the completion record.
it()/describe() counts per file in the PR body: input 80/7, retry 60/12, old 140/19, sums equal.
