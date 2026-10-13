# S26-F13 plan — board.board.test.ts split (refs #635, refs #700)
Pure move of apps/fleet/test/board.board.test.ts (2002 lines post-PR-#708
helper extraction, not the 2019 the sweep doc read; 27 top-level describes)
→ board.create.test.ts + board.assign.test.ts. Titles verbatim, no new
tests, no assertion edits. Sweep-26 doc F13 and its "Split hazards" section
govern. Sweep-18 helpers already landed: each half keeps a thin local
wrapper over test/helpers/board-api.ts, duplicated by design.
## Split (current line numbers)
- create.test.ts: :43-286 createTask core (#112, #249, findLiveAssignedTask);
  :1636-1726 idempotency #139; :1786-1839 continues #54; :1843-1957
  label-repair trio #82/#86; :1958-2002 autoStartSubmittedTasks #86.
- assign.test.ts: :288-1633 transitionTask through openTasksNeedingRebrief
  (assignment, hooks, revoke #249, gates, briefs) and :1730-1780
  closeTerminalTasks.
## Steps
1. Baseline: npx vitest run test/board.board.test.ts — record count.
2. Move describes whole, attached comments with them; duplicate MSG_ID and
   the task/fakeApi/brief wrappers per half; prune imports per half; delete
   old file; update .gitleaks.toml comment filenames (regex unchanged).
3. GREEN: vitest on both new files, count == baseline; per-file it()/test()
   counts sum equal (maestro guard); npx tsc --noEmit.
