# same-repo nameWithOwner fold — board #367

**Goal:** Fold the "slug-or-canonical, any case" same-repo rule in apps/fleet/src/github/api.ts into one private predicate and route all three call shapes through it.

**Architecture:** Pure refactor, behavior-preserving, no wire change. Today the rule lives three times: `sameRepoIssues` (lowercase-membership over nodes), `getIssueCloser`'s inline `known`/`sameRepo` closure, and the `names` lists built at each call site. One private `sameRepoName(known: readonly string[], name: string | undefined): boolean` becomes the single fold; `sameRepoIssues` becomes a two-line filter over it. The `r !== undefined` guard from getIssueCloser must survive the fold — it is load-bearing (a PR closer whose repository field is absent reads as foreign, repo: ""). Issue #367, sweep-4 finding F7, doc docs/maintainability/2026-10-11-deep-modules-sweep-4.md, parent #361.

**Tech Stack:** TypeScript, vitest module tests (test/github.api.test.ts, mocked fetch). No Wrangler/D1/DO.

**Spec:** https://github.com/rafarc21/fleetflare/issues/367 — the issue body IS the spec.

## Constraints
- GLM-OK tier: no auth, tokens, rescue, failover, deploy, migrations, credentials.
- All repo content English.
- No behavior change: every function's return shape unchanged; characterization tests in test/github.api.test.ts (closer + closing-references cases) pass unchanged.
- Two-way door: code-only, revertable.

## Steps
1. Pin the undefined-repository guard with one test in test/github.api.test.ts (getIssueCloser describe block): PR closer with NO repository field stays foreign (repo: "").
2. GREEN: add private `sameRepoName(known, name)` in api.ts; rewrite `sameRepoIssues` as a two-line filter over it; replace getIssueCloser's closure with `known` list + `sameRepoName` calls; keep the three doc-comment blocks merged to one home on the new predicate.
3. Full targeted verification: vitest run test/github.api.test.ts, then flock-gated check.
