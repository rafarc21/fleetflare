# Plan — sweep 23: orphan tests + unused fixtures (refs #579)

Read-only sweep; deliverables = findings doc + GLM-OK issues. No src change.

1. Inventory runners: vitest config include/exclude, package.json bun-test
   script, bunfig preload, workflows lanes (READ ONLY), localci lanes.
2. Classify all 336 test files by runner; report path-orphans with glob
   evidence. Result: 0 orphans.
3. Grep census: `.only(`/`.skip(`/`.todo(`, duplicate it-names with
   describe-context. Result: 0 findings.
4. Reference census on all 19 non-test helpers/fixtures. Result: 0 unused.
5. Findings doc `docs/maintainability/2026-10-12-orphan-tests-sweep-23.md`
   (S23-F1 litter fix GLM-OK, S23-F2 observation), file GLM-OK issue(s).
6. Doc-only PR to main, refs #579, no closing keywords.
