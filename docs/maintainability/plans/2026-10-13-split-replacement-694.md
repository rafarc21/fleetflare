# Plan — S26-F7: split test/studio.replacement.test.ts (#694)

Sweep 26 finding F7 (docs/maintainability/2026-10-13-oversized-test-files-sweep-26.md, refs #635), tier GLM-OK. Pure move: 2304-line file, 20 describes, 72 tests split into two files along the sweep-measured seam. Describes move whole, titles verbatim (the `#NNN` in titles are provenance — sweep-24 lesson), no assertion text changed, no behavior change, no helper extraction (sweep-18 dedup is a separate lane).

## Steps

1. Split at :1333. Restart half → test/studio.replacement-restart.test.ts (:1-1332 — imports, shared preamble, describes 1-9). Restore half → test/studio.replacement-restore.test.ts (:1333-2304 — describes 10-20).
2. Restore half gets its own copy of the shared preamble (:1-185 minus the issue-#38 header comment block :26-48, which belongs to the restart half): imports trimmed to used symbols, REPO/STUDIO_ID/NOW/CONTAINER_HAS_PROJECTS_CMD consts, status(), fakeStorage(), fakeStorageWithObserved(), ExecResult, defaultObservationStdout(), restartDeps(), plus scriptedProbe() and healClosure() which sit right above the seam (:1310-1331) and are used only by the restore half.
3. Delete test/studio.replacement.test.ts.
4. Import trims per half (measured): restart half drops runProvision/recycleWithSync/LAST_STOP_KEY/recordBringupObservation(keep — used 10×)/sessionLatestKey/sessionDailyKey/runAccountFailover/paneCaptureCmd/RATE_LIMIT_*/PANE_CAPTURE_MARKER/ClaudeAccount/FailoverDeps/ProvisionConfig/ResolveMemoryRepo/CommitLearningFile/SessionSyncStorage; restore half drops checkProvisionedWithRetry/restartWithFreshVerdict/bringupLogTailCmd/bringupLogAppendCmd/BRINGUP_RETRY_HEALED/BRINGUP_CMD/BRINGUP_LOG_PATH/INCARNATION_PATH/SESSION_LEAD_AGE_SECTION/STATUS_KEY/ROLE_ENV_KEY/ROLE_ENV. Keep every symbol with ANY use in the half; tsc has no noUnusedLocals so a leftover import is not an error, but trim exactly the zero-use ones listed.
5. Verification, strictly serial: (a) `cd apps/fleet && npx vitest run test/studio.replacement-restart.test.ts test/studio.replacement-restore.test.ts` exit 0, 72 passed total; (b) per-file it()/test() count via `grep -cE "\b(it|test)\(\"" <file>`: restart 9? + restore = 72, sum equals baseline; (c) describe titles verbatim: `grep -n '^describe(' on old file (from git show HEAD:...) vs new files — identical set.
6. Commit `test(fleet): S26-F7 split studio.replacement.test.ts — restart vs restore (refs #635, refs #694)`, then `LEFTHOOK=0 git push origin split-694-replacement`.

## Verification

Commands above, each exit 0, real output to completion record. Touch-only vitest run — full suite is CI/merge-gate territory, never run here.

## Boundaries

- Pure move. Any test touching accounts/rescue/leak paths moves verbatim.
- No describe retitle, no assertion edit, no helper extraction, no shared-helper refactor.
- Heavy gate budget: vitest run of the two files is the only gate; no `bun run check` alongside it. If review demands check, run it alone.
- PR body must show it()/test() count per file before vs after (sum equal).
