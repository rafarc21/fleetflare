# Plan — #805: split github.promote-close.test.ts — resolve vs keywords

## Scope
Pure test split, zero src changes. Refs #735, sweep doc docs/maintainability/2026-10-13-mid-size-test-files-sweep-35.md (F12, GLM-OK lane: issue-closing semantics, not auth). Same shape as the S26-F15 webhook split (PR #720): one file in two, describes move verbatim, shared preamble duplicated — dup-not-extract (extraction is sweep-18's lane).

## Before/after
- before: apps/fleet/test/github.promote-close.test.ts — 687 lines, 5 describes, 40 it() blocks, 60 vitest tests, 81 expect() calls.
- after: test/github.promote-close.test.ts KEEPS the resolve seam (:23-393): resolveIssuesForPushCommits primary path + squash fallback + #198 dedup + #198 time budget, resolveIssuesFromEnvelopeArtifacts, mergeClosable — 25 it() = 25 tests.
- after: NEW test/github.promote-close-keywords.test.ts gets the keywords seam (:395-687): closesIssueByKeyword (#248) with its yes/no loop tables, batched Path 1 (#208) with its ports()/SHAPES harness — 17 it() = 35 tests (the yes table 8 + no table 6 + names test 1 + SHAPES loop 7 + 15 flat = 35). 25 + 35 = 60, matches baseline.
- Header comment at :9-11 (Board issue #8 pure-resolver note) stays with resolve; the #248 comment (:395-396) and #208 banner (:430-435) move with keywords. fakeApi() helper (:13-21) duplicated in both, then imports trimmed per half — keywords half drops resolveIssuesFromEnvelopeArtifacts + mergeClosable + TimeBudget; resolve half drops closesIssueByKeyword + BatchedPull. Verify unused imports with grep after the split.

## Verification (serial, one gate at a time)
- Baseline already run on this branch: 60 passed.
1. `cd apps/fleet && ./node_modules/.bin/vitest run test/github.promote-close.test.ts test/github.promote-close-keywords.test.ts` — 2 files, 60 tests passed. HEAVY-ISH: run alone, nothing else in parallel.
2. Preservation proof: per-describe it() counts before vs after; the 17 moved it() titles byte-identical (diff the moved region against HEAD).
3. `bun run english-check` (from apps/fleet) exit 0.
4. `bun run test-lies-check` (from apps/fleet) exit 0.
- Full suite + `bun run check` belong to local-ci/merge gate, NOT this studio.

## Boundaries
- Test files + this plan only. Refs #805/#735 in commits, no closing keyword (repo refs itself).
- No CI polling. Push with LEFTHOOK=0 git push after every commit.
