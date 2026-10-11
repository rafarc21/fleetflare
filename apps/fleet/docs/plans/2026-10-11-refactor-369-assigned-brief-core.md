# Refactor #369: one `assignedOpenTasks` core behind the two assigned-brief walkers

**Goal:** Collapse the duplicated listTasks→filter→sort dance shared by `resolveLatestAssignedBrief` and `openTasksNeedingRebrief` into one private helper; exported signatures, behavior, and log lines stay byte-identical.

**Spec:** https://github.com/rafarc21/fleetflare/issues/369 (sweep-4 finding F9, docs/maintainability/2026-10-11-deep-modules-sweep-4.md). Behavior-preserving, GLM-OK, two-way door.

## Constraint

`openAssignedTasks` (board.ts:1385, destroy gate) deliberately fails CLOSED and is out of scope — do not touch it. `REBRIEF_TASK_STATES` stays exported. The two fail-open `console.error` messages keep their exact current bytes (they name different functions on purpose).

## Task 1 — characterization (must pass BEFORE and AFTER, unchanged)

Run from /workspace/fleetflare/apps/fleet:
`bun x vitest run test/board.board.test.ts -t "resolveLatestAssignedBrief" -t "openTasksNeedingRebrief"`
Note: vitest `-t` matches one pattern; run two commands, one per `-t`. Both blocks pass on unmodified code — that is the RED-free baseline (pure refactor, no new behavior). Record counts.

## Task 2 — extract the core

In src/board/board.ts:
1. Add private `assignedOpenTasks(api: BoardApi, repo: string, studioId: string, states: readonly TaskState[]): Promise<BoardTaskView[] | null>` — null means the lookup failed (the fail-open signal). Body: the shared dance — `listTasks(api, repo, { assignedTo: studioId })` in a try/catch, `console.error` with a callerName param passed in (4th string param `who` or similar) so each walker's existing message bytes survive: `` `board: ${who} lookup failed for ${studioId}@${repo}` `` — verify against the two current strings: "assigned-task" and "open-tasks-needing-rebrief" as the middle words.
2. Filter `t.open && t.state !== null && states.includes(t.state)`, sort `[...open].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))`, return the sorted array (empty array allowed — callers decide what empty means).
3. `resolveLatestAssignedBrief`: delegate; null → null; [] → null; else newest + others note + renderBriefPrompt tail unchanged.
4. `openTasksNeedingRebrief`: delegate with REBRIEF_TASK_STATES; null → []; else map to {taskNumber, title} unchanged.
5. Doc comments: each function's comment loses the lines describing the now-shared mechanics only if the helper's own comment covers them; the #124/#137 policy comments stay.

## Verification (sequential, from apps/fleet, one at a time)

- `bun x vitest run test/board.board.test.ts` — all pass, count unchanged from Task 1 baseline plus the rest of the file.
- `bun run check` — clean.
- `bun run english-check` — clean.
- `bun run test-lies-check` — 0/0/0.

## Commit

One commit: `refactor(fleet): one assignedOpenTasks core behind the two assigned-brief walkers (refs #361, closes #369)`
