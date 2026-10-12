# S24-F8: un-export PullRequestInfo and RepoMatch (refs #612)

Sweep 24 finding F8 (docs/maintainability/2026-10-12-unused-exports-sweep-24.md,
refs #588). Two type-only exports in `apps/fleet/src/github/` have no importer
outside their own file:

- `src/github/api.ts:907` — `export interface PullRequestInfo`. Only
  out-of-file mention is a comment in `src/board/board.ts:67` ("Narrowed from
  github/api.ts's PullRequestInfo"); board.ts declares its own narrower inline
  type at board.ts:69. The interface is used in-file as `getPullRequest`'s
  return type (api.ts:928).
- `src/github/wake-events.ts:105` — `export type RepoMatch`. Appears nowhere
  outside wake-events.ts. Used in-file as `sameRepoSlug`'s return type
  (wake-events.ts:109). All three callers (assign-wake.ts:199,
  wake-gate.ts:41, comment-wake's inline check) compare string literals
  ("same"/"different"/"unknown") or import `sameRepoSlug` only — none imports
  the type.

Sweep's own correction is on the record: MintTokenOpts (app.ts:79) was a
first-pass false positive — it IS imported by src/github/auth.ts:58 — and any
change there belongs to the auth lane anyway. This task does not touch app.ts.

## Change

Drop the `export` keyword on both declarations. Nothing else: no rename, no
move, no doc-comment rewrite — the JSDoc above each stays accurate (it
documents the type for readers of the file, which is where every reader now
lives).

## Verification

- `bun test test/bun/wake-gate.test.ts test/bun/assign-wake.test.ts test/bun/comment-wake.test.ts test/bun/open-prs.test.ts` (adjust to the suite files that actually exist under apps/fleet/test/bun — run the ones covering wake-gate, assign-wake, comment-wake, open-prs) — expect all pass, unchanged.
- `cd apps/fleet && bun run check` — all five tsc configs exit 0. This is the real proof: if any file outside github/ imported either type, tsc fails. Run under `flock /tmp/fleet-gate.lock` (one heavy gate at a time — another studio may hold it; if so, wait for the lock, don't skip).
- grep proof: `grep -rn "PullRequestInfo\|RepoMatch" apps/fleet/src apps/fleet/test` shows mentions only in api.ts / wake-events.ts themselves (plus the board.ts comment naming PullRequestInfo as a narrowing source, which stays).
