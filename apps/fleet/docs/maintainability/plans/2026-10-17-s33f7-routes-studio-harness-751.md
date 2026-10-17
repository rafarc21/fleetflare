# S33-F7 plan — shared routes-studio-harness, issue #751

Census: sweep 33 (duplicated test setup), issue #733. Spec: issue #751.
Baseline 2026-10-17: `studio.routes-handle.test.ts` and `studio.routes-accounts.test.ts`
carry a ~90-line provision harness kept in sync by hand since their split (PR #728).
Handle lines 86-384 and accounts lines 72-370 verified byte-identical.

## Steps

1. New `apps/fleet/test/helpers/routes-studio-harness.ts` owning the shared pair:
   `STUDIO_ID`, `FAKE_ROLE_PROMPT`, `FAKE`, `decodeRolePrompt`, `fakeFetchBlueprintFile`,
   `fakeStorage`, `fakeStudioNamespace`, `envWithFakeStudio`, `envWithThrowingVerb`,
   and `fakeRescueAnswer` (with `setFakeRescueAnswer`/`resetFakeRescueAnswer` setters —
   ES module bindings are read-only, so the accounts test's in-place reassignments
   become setter calls).
2. `studio.routes-handle.test.ts`: delete the local harness; keep the handle-only
   `FAKE_ROLE_MD_KEEP_ALIVE_FALSE` const and the `FAKE_FLEET_JSON`/`FAKE_ORG_JSON`/
   `FAKE_ROLE_MD` destructure; import the shared names from the helper.
3. `studio.routes-accounts.test.ts`: delete the whole local copy; import the shared
   names; replace the two `fakeRescueAnswer =` reassignments with
   `setFakeRescueAnswer(...)` / `resetFakeRescueAnswer()`.
4. Trim now-unused imports in both files (the moved bodies were their only consumer).
5. Verify (sequential): targeted vitest on the two files, `tsc --noEmit` (root),
   english-check, test-lies-check.
6. Commit + push; completion record.

## Risk

Pure test-fixture move; no `src/` or `container/` change. Door: two-way.