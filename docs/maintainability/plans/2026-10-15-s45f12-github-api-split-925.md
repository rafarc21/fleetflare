# S45-F12 github.api.test.ts split — plan (refs #925, refs #907)

Pure move of describes, titles verbatim, zero test-body edits. 137 it():
9 describes -> files half, 23 -> queries half.

## Files
- Create test/github.api-files.test.ts — lines 1-501 verbatim: setup +
  write-path describes (mergePullRequest, fetchRepoFile, upsertRepoFile,
  doneRecordPutter, createRepoFile, listInstallationRepos, getDefaultBranch,
  commitFilesOnNewBranch, openPullRequest).
- Create test/github.api-queries.test.ts — lines 502-1461 verbatim:
  query/exists describes (listRepoTree .. ghRequest merge order).
- Delete test/github.api.test.ts (git rm).

## Seams (split hazards)
- GH_STD_HEADERS/GH_GET_HEADERS (:810-824) used by BOTH halves — each half
  keeps its own copy, never an import across test files.
- vi (doneRecordPutter mint) + Env type — files half only.
- Imports = exactly what each half's code uses; tsc --noEmit is the proof.

## Verify (one at a time — tsc is a heavy gate)
1. npx vitest run both files — 2 files, 137 tests, 0 failed. 2. tsc. 3. english-check.
