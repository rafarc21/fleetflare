# Plan — S24-F14: record the sole-test-importer class, configure the future lint (#613)

Refs #588 (sweep doc `docs/maintainability/2026-10-12-unused-exports-sweep-24.md`,
§S24-F14). Tier GLM-OK. Docs-only: no code change, no export touched.

## Finding

209 in-scope exports across 30+ modules are imported only by their own
module's test file. These are deliberate unit-test seams on pure modules —
the repo's test-lies-check gate enforces that these tests exercise the
module, not mocks. Verdict: KEEP every one. No en-masse un-export.

## Change

Two doc edits, one branch:

1. Sweep doc §S24-F14 gains the full per-module distribution (the issue names
   only the top-10 head; the doc previously listed no full count per module).
2. Sweep doc §S24-F14 gains a "Future lint configuration" subsection: the
   recipe any future unused-export linter (knip or successor) must follow so
   these 209 seams are never flagged.

## Facts to record (verified 2026-10-12 against knip v6.41.0)

- knip's DEFAULT mode counts imports from test files as usage — the 209
  seams would NOT be flagged in a default run. No config needed for that.
- knip `--production` mode (`entry` patterns suffixed `!`) EXCLUDES test
  files from the analysis — a production-mode run WOULD flag every seam.
  If production mode is ever adopted, pair it with `ignoreIssues.exports`
  scoped to the seam modules, or skip production mode for them.
- knip v6 schema options that exist: `ignoreExportsUsedInFile` (default
  false — exports used only in-file; NOT our case), `includeEntryExports`
  (default false), `ignoreIssues` (per-glob issue-type suppression — the
  right lever if production mode ever flags the seams), `ignore` (per-glob).
  `ignoreExportsUsedInTest` no longer exists in the v6 schema (dropped:
  default behavior already treats test imports as usage).
- Vitest test files live at apps/fleet/test/*.test.ts; bun:test lane at
  apps/fleet/test/bun/*.test.ts; entry candidate apps/fleet/src/index.ts.

## Steps

1. This plan doc (this commit).
2. Backend Developer: run the importer-map verification per module head-listed
   in §S24-F14 (grep each module's exported names for importers outside the
   defining file and its own test), record per-module counts, append the
   full distribution + lint recipe to the sweep doc §S24-F14.
3. Verify: `cd apps/fleet && bun run english-check` exit 0; doc greps spot-check
   3 modules by hand.
4. Fresh-context review, max 2 rounds.
5. PR, envelope on the issue.

## Verification

- `cd apps/fleet && bun run english-check` exit 0.
- Spot-check: for 3 sample names from the recorded list (one from
  install-cache.ts, one from github/api.ts, one from burn.ts), grep
  apps/fleet for importers — defining file + its own test only.
- No .ts file changed: `git diff origin/main --name-only` lists only
  .md files.

## Boundaries

- Docs-only. No code, no test, no export keyword, no dependency added.
- One heavy gate at a time — english-check is the only script run; it is
  light. No browser QA — no visual surface.
