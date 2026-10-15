# #916 plan — S45-F3 split orca-registry.test.ts (refs #907)

Pure move, sweep-45 F3 second cut (docs/maintainability/2026-10-15-oversized-tests-sweep-45.md
F3 + Split hazards). 1831-line bun-lane file -> two; describes whole, titles verbatim.

Baseline: 112 pass / 434 expect, 3.26s. Teardown half 25 runtime, rows half 87.
Fakes preamble :48-198 duplicated verbatim (no extraction — hazard 2). Header guard
preamble :1-16 copied to both, first sentence names own halves (hazard 1).

- orca-registry-teardown.test.ts <- :200-631: FIXED_NOW/tmpWorktree/tmpSalvageRoot
  (:205-228), describes :230 teardown, :402 #175 healing, :518 #193 fallback,
  :573 #297 multi-instance (+folderRows/WEB/runningStudio/INST* helpers).
- orca-registry-rows.test.ts <- :617-1831: describes :632 #175 races, :770 fileLockAt,
  :897 #39 titles, :1074 #55 task-titled, :1106 #55 ROW, :1404 #220 ranking,
  :1475 partial answers, :1654 #322 pairs, :1772 findAttachHandle
  (+tmpRegistryFile/tmpLockDir/registryLockPath/WT/st/fleetTerm/studio/ID/STALE_TITLE/stId/PILOT/LIST_OK helpers).
- FIXED_NOW/tmpWorktree/tmpSalvageRoot also in rows half (used :1076,:1556-1700).
  Imports per half exact (plan brief lists them); nodeOs + mock.module stays in rows'
  closeStudioRow test. registry-writer.ts fixture untouched.

Verify serial: bun test both files (112/434 sum), title grep-set diff, tsc -p test
  (flock), english-check, test-lies-check. Commit "refs #916, refs #907", no closing
  keywords. Test-only diff (two new files, old deleted, this plan). Push, PR.
