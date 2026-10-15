# #916 plan — S45-F3 split orca-registry.test.ts (refs #907)

Pure move (sweep-45 F3, docs/maintainability/2026-10-15-oversized-tests-sweep-45.md F3 +
hazards). 1831-line bun-lane file -> two; describes whole, titles verbatim, 112 runtime /
434 expect sum holds (teardown 25, rows 87). Fakes preamble :48-198 duplicated verbatim,
no extraction. Guard preamble :1-16 to both, first sentence names own halves.

- orca-registry-teardown.test.ts <- :200-631: FIXED_NOW/tmpWorktree/tmpSalvageRoot
  (:205-228), describes :230 teardown, :402 #175 healing, :518 #193 fallback, :573 #297
  multi-instance; helpers folderRows/WEB/runningStudio (:497-517), INST* (:566-571).
- orca-registry-rows.test.ts <- :617-1831: describes :632 #175 races, :770 fileLockAt,
  :897 #39 titles, :1074 #55 task-titled, :1106 #55 ROW, :1404 #220 ranking, :1475
  partial answers, :1654 #322 pairs, :1772 findAttachHandle; helpers tmpRegistryFile
  (:628), registryLockPath (:728), tmpLockDir (:766), WT/st/fleetTerm/studio (:1096-1104),
  ID/STALE_TITLE/stId (:1135-1137), PILOT (:1327), LIST_OK (:1472).
- FIXED_NOW/tmpWorktree/tmpSalvageRoot duplicated into rows half too (used :1076, :1556-1700).
- Imports per half exact per implementer brief (grep-verified; studioWorkspaceName is
  dead in both halves — comment-only mentions — so NEITHER imports it). nodeOs +
  mock.module stays in rows' closeStudioRow test (:1710-1731). registry-writer.ts untouched.
- Verify serial: bun test both files, title grep-set diff, tsc -p test (flock),
  english-check, test-lies-check. Commits "refs #916, refs #907". Push, PR.
