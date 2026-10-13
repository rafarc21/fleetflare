# Plan — S26-F10: split studio.survival-delivery.test.ts (input vs retry) (#697)

Sweep 26 F10 (docs/maintainability/2026-10-13-oversized-test-files-sweep-26.md, refs #635). Pure move: 2168 lines, 19 describes, 140 `it()`.

- `test/studio.survival-input.test.ts` — :83-1338: 7 describes, 80 `it()` (allowlist, paneBusy, 3 branch sources, resolveSurvivalInput wiring, matchesTaskNumber, SOURCE 4, snapshot age).
- `test/studio.survival-retry.test.ts` — :1339-2168: 12 describes, 60 `it()` (delivery, #208/#231 threading, single-flight, pending marker, retry + bound, board outage, survivalTasks, draft check, tick wiring). Harness at :1312-1337 moves with the retry half.

Steps (Backend Developer, one commit per step, push after each):
1. RED: a guard `it` in the new survival-input file asserting the old file is gone — red while the monolith exists. Commit, push.
2. GREEN: delete the old file, create both halves, guard turns green. Repoint the 3 stale-name comments (vitest.config.ts:82, src/studio/survival-delivery.ts:19, src/studio/do.ts:6428). Commit, push.
3. Verbatim rules (sweep hazards): describes move whole, titles verbatim, `#NNN` provenance kept, no assertion text changed. No `vi.mock` in this file (verified); all `env.TEST_*` source-pins sit in the retry half. Shared fakes (`fakeObserved`, `session`, `captured`, IDLE_PANE/MIDTURN_PANE) duplicated per half — extraction is sweep-18's lane, never both at once.
4. Verification, serial, one heavy gate at a time (flock /tmp/fleet-gate.lock): `npx vitest run test/studio.survival-input.test.ts test/studio.survival-retry.test.ts` (140/140) → `bun run check` → `bun run english-check` → `bun run test-lies-check`, all exit 0, real tails to the completion record.
5. Fresh-context Code Reviewer (cap 30m): it() count per file before vs after, sums equal, no assertion text changed. Max 2 rounds. Then QA + PR + envelope on https://github.com/rafarc21/fleetflare/issues/697.
