# Plan — gate run/watch print one line per leg (issue #1049, refs #715)

Maestro using `fleet gate run` sees only the verdict line. Want: one line per leg — state mark, name, wall time, test counts.

## Changes

1. `container/gate-server.ts` — new pure `parseTestSummary(stdout, stderr): string | undefined`. Strip ANSI first. vitest: last line matching `/Tests\s+.*\(\d+\)/` returned trimmed. bun test: last `N pass` + last `N fail` lines joined `", "`. No match → undefined. `GateBody` + `RunOutcome` gain `summary?`; test-run return paths (success and failure) and `runGate`'s return carry it, so R2 body and container /result both have it. Early exits (clone/install/merge) keep no summary.
2. `src/gate/fanout.ts` — `LegRunMeta {ms?, summary?}`; `normalizeLegResult` passes ms/summary through (unknown-state error keeps none); new pure `outcomeLegs(results)` → `OutcomeLeg {leg, state, ms?, summary?, description?}[]`, plan order (Promise.all preserves it).
3. `src/gate/leg-run.ts` — inside the step callback: `Date.now()` before/after `dispatch` → `ms` on the returned result (inside the callback so a Workflow replay reuses the cached value). Callback return spreads the normalized result (summary from DO payload) plus ms.
4. `src/gate/workflow.ts` — final output gains `legs: outcomeLegs(results)`; `GateRunOutcome` state branch typed with it. Skipped branches unchanged.
5. `src/gate/routes.ts` — status `out` cast + response gain `legs` (pass-through, dropped when absent).
6. `cli/gate.ts` — `GateStatusResponse.legs?`; pure `formatMs` ("1m23s", "3s", "0s"); pure `legLines(status)`: `mark.padEnd(4) + name.padEnd(widest) + time + (summary ?? description) cut 100`. `runGate` + `cmdGateWatch` print the lines after the verdict line. Exit codes unchanged.

run-leg.ts and verdict.ts untouched: the container's /result JSON carries summary through the DO verbatim; the LegResult base type stays.

## Tests (RED first, then GREEN)

1. `test/bun/gate-server.test.ts` — parseTestSummary: vitest line (with ANSI, last match wins), bun pass+fail / pass-only, no match → undefined; runGate carries summary in R2 body and /result outcome.
2. `test/bun/gate-fanout.test.ts` — normalizeLegResult passes ms/summary; outcomeLegs picks fields in plan order.
3. `test/bun/gate-leg-run.test.ts` — ms is a number on every result, summary flows from the DO payload; existing toEqual assertions gain `ms: expect.any(Number)`.
4. `test/gate-routes.test.ts` (vitest) — a complete output with legs passes through verbatim.
5. `test/bun/cli-gate.test.ts` — formatMs cases; legLines mark/pad/cut; runGate prints one line per leg.

## Verify

Touched tests, `bun run check`, `bun run test-lies-check`, one at a time. PR + envelope on #1049 → awaiting_merge.
