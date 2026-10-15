# #916 plan — S45-F3 split orca-registry.test.ts: teardown/healing vs rows/locks (refs #907)

Sweep 45 finding F3 (docs/maintainability/2026-10-15-oversized-tests-sweep-45.md F3 section,
now on main). Second cut of the sweep-26 F6 product (#693, PR #714). Pure move: 1831-line
bun-lane file -> two files, describes whole, titles verbatim, sum of tests unchanged.
Split hazards section of the sweep doc read and honored: fakes duplicated not extracted,
bun-lane guard preamble copied verbatim into both files, no shared beforeEach exists.

## Baseline (measured 2026-10-15, origin/main 0b9d6993)

bun test test/bun/orca-registry.test.ts = 112 pass / 0 fail, 434 expect() calls, 3.26s.
Static test() count 110; two for-loop templates run 2x each (:525 #193 order loop ->
teardown half, :1600 #135 label loop -> rows half) -> 112 runtime.
Per half: teardown 24 static / 25 runtime; rows 86 static / 87 runtime.

## Steps

1. This plan doc, committed first.
2. Create both new files; old file DELETED in same commit. Move describes whole.
3. RED check before full copy: rows file with describes but without its helpers fails on
   unresolved names — that is the real RED. GREEN = full split, both files pass.
4. Verify (serial, one gate at a time): bun test both new files (sum 112 pass / 434
   expect); titles verbatim via grep-set diff; tsc -p test under flock; english-check;
   test-lies-check.
5. Push, open PR (no closing keywords).

## Seams (verified by line-grep against the working file)

- test/bun/orca-registry-teardown.test.ts <- old :200-631 (divider at :200 + FIXED_NOW,
  tmpWorktree, tmpSalvageRoot at :205-228 + 4 describes: "removeStudioWorkspace — teardown"
  :230, "#175 — lost-entry healing by PATH" :402, "#193 — exact-path fallback" :518,
  "#297 — multi-instance studios" :573). ~432 lines, 25 runtime tests.
- test/bun/orca-registry-rows.test.ts <- old :617-1831 ("#175 — registry races" :632,
  fileLockAt :770, "#39 — row titles" :897, "#55 — teardown finds task-titled rows" :1074,
  "#55 — fleet ls ROW column" :1106, "#220 — ranking scope-add" :1404,
  "#124/#299/#516/#135 — partial answers" :1475, "#322 — pair functions" :1654,
  "#220 — findAttachHandle" :1772 + their divider clusters). ~1215 lines, 87 runtime tests.
- Fakes preamble :48-198 (Fake, memoryLock, TEST_TITLE, memoryRegistry, boardTask, fake,
  REPOS, worktrees, worktreesWithPath, terminalEntries, TERM_CREATED, CREATED) DUPLICATED
  verbatim in both. No extraction (sweep-45 hazard 2; extraction is sweep-18/43 lane).
- Mid-file helpers keep homes: tmpWorktree/tmpSalvageRoot/FIXED_NOW + divider-comment
  :200-229 go to BOTH (rows half uses tmpWorktree at :1076,:1700 and tmpSalvageRoot at
  :1556,:1570,:1586,:1606,:1625). folderRows/WEB/runningStudio (:497-517) teardown only.
  INST1/INST2/INST_ROWS/instAttach (:566-571) teardown only. tmpRegistryFile (:628),
  registryLockPath (:728), tmpLockDir (:766), WT/st/fleetTerm/studio (:1096-1104),
  ID/STALE_TITLE/stId (:1135-1137), PILOT (:1327), LIST_OK (:1472) rows only.
- Imports per half (exact, no unused): both import from ../../cli/orca-workspace
  removeStudioWorkspace, readStudioRows, ensureStudioWorkspace, classifyStudioRow,
  describeWorkspaceRemoval, type OrcaDeps, type OrcaResult, type WorkspaceRegistry;
  type ContextSalvageDeps; + from ./helpers/orca-fixtures ORCA_ENV, ok, terminals; from
  bun:test test, describe, expect. Teardown adds: studioWorkspaceName (:397),
  type WorkspaceRemovalOutcome (:374); NO attachTitle, NO mock/spyOn. Rows adds:
  studioWorkspaceTitle, openStudioRow, closeStudioRow, reconcileStudioWorkspaces,
  fileLockAt, fileWorkspaceRegistry, lockFileName; attachTitle from
  ../../cli/attach-liveness; boardTask needs BoardTask, st/studio need StudioStatus;
  mock, spyOn from bun:test. node:fs/node:os per half: teardown = mkdtempSync, mkdirSync,
  writeFileSync, rmSync, readFileSync, tmpdir; rows = mkdtempSync, mkdirSync,
  writeFileSync, rmSync, readFileSync, utimesSync, tmpdir, nodeOs, dirname. nodeOs +
  mock.module(node:os homedir) stays inside closeStudioRow test (:1710-1731), rows only.
- Header comment block :1-16: each new file carries a verbatim copy of the bun-lane guard
  preamble, edited ONLY in the first sentence to name its own two halves (hazard 1).
- orca-workspace.registry-writer.ts + orca-workspace.exit-code.ts fixtures untouched;
  rows file still references the writer via import.meta.dir in the 8-process race test.

## Guard rails

Titles verbatim, no string inside any test changes. Sum 112 runtime / 434 expect holds
(teardown 25 + rows 87). Commit msgs conventional English, "refs #916" + "refs #907",
never closing keywords. No push to main; LEFTHOOK=0 push. Test-only diff: git diff
origin/main --stat shows only the two new files + the deleted old file + this plan.
