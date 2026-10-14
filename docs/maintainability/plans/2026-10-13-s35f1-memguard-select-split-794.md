# Plan — S35-F1 split test/bun/memguard-select.test.ts into core vs loop halves

Task: https://github.com/rafarc21/fleetflare/issues/794 (parent sweep #735, finding F1, GLM-OK lane).
Doc: docs/maintainability/2026-10-13-mid-size-test-files-sweep-35.md §F1.

## Problem

782 lines, 17 describes, 68 lexical tests over container/memguard.ts —
one file spans two unrelated seams: pure victim/adj selection vs the
escalation loop, lead-parent resolution and log format.

## Change

Pure move, one file becomes two. Describes whole, titles verbatim, zero
assertion edits. Import lines trimmed per half (the only non-move edit).

1. `test/bun/memguard-select-core.test.ts` — current :1-465: file header
   verbatim, fixture preamble (dirs/tmp/afterEach, FixtureProc, procTree,
   SELF, FLOOR, PANE, LEAD, STUDIO, the :319 adj-plan byPid sorter),
   describes isProtected, protectedSet, readProcs, pickVictim, adjPlan,
   adjScan, readMemory — 36 tests. Imports from container/memguard:
   adjPlan, adjScan, isProtected, newAdjCache, pickVictim, protectedSet,
   readMemory, readProcs.
2. `test/bun/memguard-select-loop.test.ts` — current :466-782 plus a copy
   of the same fixture preamble, under a short new header noting it is the
   loop half of the former memguard-select.test.ts, that pure selection
   lives in memguard-select-core.test.ts and live behaviour in
   memguard-docker.test.ts. Describes decide, step, nextTickMs,
   formatLogLine, redact, trimLog, resolveLeadParentPid,
   refreshLeadParentPid — 32 tests. Imports from container/memguard:
   decide, formatLogLine, initialState, isProtected, nextTickMs,
   readProcs, redact, refreshLeadParentPid, resolveLeadParentPid, step,
   trimLog, types GuardConfig and Proc; plus redactSecrets from
   ../../src/studio/redact.
3. Delete memguard-select.test.ts.

Fixture preamble duplicated, not extracted: sweep-33's fold bar is 3
copies, this makes 2 (same call as the S26-F14 bringup-hooks split — no
helper extraction, dedup lane is separate).

## Stale-name comments (3 files name the old file)

- container/memguard.ts:482 (redact equivalence) -> memguard-select-loop.test.ts
- src/studio/memguard-log.ts:7 (formatLogLine pins) -> memguard-select-loop.test.ts
- test/studio.memguard-log.test.ts:5 (same) -> memguard-select-loop.test.ts
Sweep docs naming the old file are historical records — untouched.

## Verification

- Baseline before the move: cd apps/fleet && bun test test/bun/memguard-select.test.ts — 68 pass.
- After: cd apps/fleet && bun test test/bun/memguard-select-core.test.ts test/bun/memguard-select-loop.test.ts — 68 tests, 0 fail (36+32).
- cd apps/fleet && npx vitest run test/studio.memguard-log.test.ts — green (comment-touched file).
- cd apps/fleet && bun run english-check — clean.
- cd apps/fleet && bun run check — heavy gate (five tsc projects), once, alone, under flock /tmp/fleet-gate.lock.
