# S35-F2 plan — orca-ensure.test.ts second cut, issue #795

Census: sweep 35 (mid-size test files), issue #735. Spec: issue #795.
File is itself a sweep-26 split product of orca-workspace.test.ts (PR #714)
— this is the second cut, along the reconcile seam.
Baseline measured 2026-10-13: `bun test` on the file = 35 tests, 0 fail.

## Steps

1. New `apps/fleet/test/bun/orca-ensure-verbs.test.ts` — ensure core:
   describes "name derivation", "orcaPresent", "ensureStudioWorkspace —
   the five hard requirements" (old :192-355, 13 tests). Pure move,
   bodies verbatim.
2. New `apps/fleet/test/bun/orca-ensure-reconcile.test.ts` — verbs/reconcile:
   describes "duplicate terminals — reconcile", "fleet tabs — the reconcile
   verb", "#216 — preview/plan", "process-level exit code + dotted repo"
   (old :358-756, 22 tests). Pure move, bodies verbatim.
3. Both files carry the shared preamble (Fake, memoryLock, TEST_TITLE,
   boardTask, fake(), REPOS, worktrees, worktreesWithPath, terminalEntries,
   TERM_CREATED, CREATED, studio) — duplicated per file, NOT hoisted to
   helpers: per-suite fakes differ, and the sweep-33 F4 rule already keeps
   per-suite fixtures local. Prune unused per half: verbs half keeps only
   what its tests use; reconcile half likewise (each half keeps memoryLock
   + fake + fixtures it actually calls). `worktreesWithPath` and
   `memoryRegistry`/`boardTask` are already dead in the current file — do
   not carry them anywhere; they belong to orca-registry.test.ts.
4. Header comments rewritten per file: cross-reference each other and
   orca-registry.test.ts (which keeps its existing pointer updated from
   "orca-ensure.test.ts" to the two new files).
5. Delete old orca-ensure.test.ts.
6. TDD: the split itself needs no new RED test (pure move); the gate is
   `bun test` on the two new files = 35 tests, 0 fail, identical count.
7. Verify ONE heavy gate at a time, never parallel: `bun test` on the 2
   files, then `bun test test/bun test/studio.files.test.ts
   test/studio.studio-blueprint.test.ts` (bun-test script, still one gate),
   then `npx tsc --noEmit -p test` from apps/fleet. Then english-check.
8. Push branch after first commit; PR per template; completion record.

## Risk

Pure test-file move, no src/ change. Door: two-way. `git status` must show
only: 2 added, 1 deleted, 1 modified (orca-registry.test.ts header pointer).
