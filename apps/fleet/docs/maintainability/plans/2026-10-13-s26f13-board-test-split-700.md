# S26-F13 plan — board.board.test.ts split (refs #635)

Task #700. Pure move: test/board.board.test.ts (2002 lines, 27 top-level
describes) splits into test/board.create.test.ts and test/board.assign.test.ts.
No new tests, no reworded titles, no assertion edits. Sweep-26 doc F13 +
"Split hazards" section governs; sweep-18 already landed the fakeApi/task
helpers (PR #708), so each half keeps a thin local wrapper over
test/helpers/board-api.ts — duplicated by design, never deduped here.

## Split (current line numbers, post-#708 file)

- create.test.ts: describes at :43-286 (createTask core, path overlap #112,
  security-refuses-glm-lead #249, findLiveAssignedTask), :1636-1726 (idempotency
  #139), :1786-1839 (continues #54), :1843-1957 (label-repair trio #82/#86),
  :1958-2002 (autoStartSubmittedTasks #86). Plus interleaved closeTerminalTasks
  (:1730-1780) — create-side per task body "reap" cluster wording.
- assign.test.ts: all other describes (:288-1633, :1747-1782 gap excluded) —
  transitionTask, commentEnvelope, listTasks, showTask, resolveBoardRepo,
  taskAssignees, assignment family, studio gates, briefs, revoke #249.

Correction to sweep line numbers: file is 2002 lines after PR #708 helper
extraction, not 2019; block map above is re-derived from the current file.

## Steps

1. Baseline: `npx vitest run test/board.board.test.ts` — record test count.
2. Move describes whole, titles verbatim, comments attached to a moved block
   move with it. Duplicate header consts per half (MSG_ID, task/fakeApi thin
   wrappers, brief) — per-half thin-wrapper override pattern from PR #708.
   Prune each half's imports to what it uses (both keep GitHubError; create
   keeps TERMINAL_CLOSE_PAGE + autoStartSubmittedTasks; assign keeps the rest).
3. Delete test/board.board.test.ts. Update the .gitleaks.toml comment listing
   old filename (regex values unchanged) — comment at line ~34 mentions
   board.board.test.ts; it must name the two new files instead.
4. GREEN: `npx vitest run test/board.create.test.ts test/board.assign.test.ts`
   — total test count equals baseline. Sum of it()/test() per file reported in
   PR body must sum equal to baseline (maestro guard).
5. `npx tsc --noEmit -p test` not needed (file excluded? no — vitest root
   tsconfig covers test/**; run `npx tsc --noEmit` from apps/fleet, one gate).
6. Commit, push.

## Verification (heavy gates: vitest board files x2 runs, one tsc)

- vitest run on the two new files, count == baseline.
- `npx tsc --noEmit` (root project, covers test/).
- it()/test() count per file before vs after, sum equal, no assertion text
  changed (diff check: moved hunks identical).
