# Drop profile.ts test-only container-class re-export — board #453

**Goal:** Remove the test-only re-export of the container-class triple (`BIG_PROFILE_ROLES`, `isBigProfileRole`, `doClassForRole`) from apps/fleet/src/studio/profile.ts:15 and shrink the import at line 13 to `isBigProfileRole` only — the one member profile.ts actually uses (realDoClassForRole, line 34). test/studio.profile.test.ts then imports the triple from ../src/studio/container-class directly and keeps importing `realDoClassForRole`, `studioNamespace`, `getStudioStubForRow` from ../src/studio/profile. No behavior change.

**Architecture:** Sweep-6 finding F7 (issue #453, parent sweep #415, doc docs/maintainability/2026-10-12-deep-modules-sweep-6.md §F7). profile.ts's own comment (lines 5-12) declared the re-export exists ONLY so test/studio.profile.test.ts can exercise the triple alongside this file's other exports — a comment-declared test-only export. Grep-verified: no other production importer of the re-export (routes.ts uses realDoClassForRole below, not doClassForRole; provision.ts imports container-class directly for the `cli`/`bun` Env-chain-isolation reason in that file's header). Same shape as #407 (WATCH_INTERVAL_MS removal) and the sweep-1 culture rule (#357): a test-only export dies, tests import the owning module directly.

**Tech Stack:** TypeScript (workers + test tsconfig projects); verification via vitest + tsc.

**Spec:** https://github.com/rafarc21/fleetflare/issues/453 — the issue body IS the spec.

## Constraints
- GLM-OK tier: import/export shape only, no behavior, no auth/credentials touched.
- All repo content English.
- Two-way door: pure code, ~5 changed lines across 2 files.

## Steps
1. Characterization baseline: from apps/fleet run `bun run vitest run test/studio.profile.test.ts` UNCHANGED — ALL PASS (17 tests).
2. Edit apps/fleet/src/studio/profile.ts: replace the lines 5-15 comment block + triple import + re-export with the new four-line comment + `import { isBigProfileRole } from "./container-class";`. Every other line untouched.
3. Edit apps/fleet/test/studio.profile.test.ts: split the single profile import into `doClassForRole, isBigProfileRole, BIG_PROFILE_ROLES` from ../src/studio/container-class and `realDoClassForRole, studioNamespace, getStudioStubForRow` from ../src/studio/profile.
4. Re-run `bun run vitest run test/studio.profile.test.ts` — ALL PASS with the new import paths.
5. Gates, one at a time (flock): from apps/fleet `flock /tmp/fleet-gate.lock bun run check` exit 0, then `flock /tmp/fleet-gate.lock bun run english-check` exit 0.
6. Commit `refactor(fleet): drop profile.ts test-only container-class re-export (refs #453)`, push `LEFTHOOK=0 git push -u origin fix-453-profile-reexport`, verify with `git log origin/main..origin/fix-453-profile-reexport --oneline`, then write /workspace/.fleet/done/453.json per the standard shape with REAL output tails from steps 1, 4, 5.
