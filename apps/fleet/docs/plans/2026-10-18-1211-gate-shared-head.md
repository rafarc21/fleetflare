# 1211 — one verdict per sha, red wins across PRs sharing a head (#1172)

Gate posts one `gate/verdict` commit status per head sha. Two open PRs with the
same head sha but different bases share that status: the last writer wins, so a
gated PR's green can overwrite an ungated PR's red, or reuse can hand a later PR
an earlier green. Fix has two halves, TDD failing-first.

## 1. Shared-head guard before every success post (config.ts + workflow.ts)

Pure helpers in config.ts:

`sharedHeadFailure(headSha, baseRef, pr, open[])` -> `head <sha8> shared with PR #N`
for the first sibling open PR (number != current, different base), else null. Different
base = baseRef differs (the PR list's base branch, not a second getBranchSha call).
`guardSuccessStatus(...)` wraps a success post: a lookup error or a shared head
downgrades to failure ("gate: cannot list shared-head PRs" / the shared-head text).
`openPullsForHead(headSha, pulls)` keeps only the head's PRs, as `{ number, baseRef }`.

workflow.ts: before post-skip-status and before post-verdict, list open PRs via the
new github/api `listOpenPulls` (paged, `truncated` flagged), keep the head's via
`openPullsForHead`, and run the guard. A lookup error OR a truncated list posts
failure (fail closed), never success. Failure/error verdicts post as-is.

## 2. Per-PR fresh run (auto-run.ts)

Run id stays `gateRunId(repo, headSha)`; a second PR sharing a sha starts a fresh
`-p<pr>` run in startGateRun's catch (existing-id path), only when
`index.latest(repo, pr).headSha !== headSha`. The `-p<pr>` id is deterministic, so
create-idempotency dedupes concurrent first-starts: one live run per (pr, sha). A
second start of the SAME (pr, sha) still reuses; only a DIFFERENT pr sharing the sha
starts fresh.

## Tests (failing first)

- config.test.ts: sharedHeadFailure / guardSuccessStatus / openPullsForHead.
- auto-run.test.ts: PR A red-then-PR B green ends red; B green-then-A red ends red
  (fresh run, distinct id); same-base pair reuses (green); one live run per (pr, sha).
- api-queries.test.ts: listOpenPulls maps number + head/base, pages, flags truncation,
  throws on non-2xx.

## Verification

- `apps/fleet`: `bun test test/bun/gate-config.test.ts test/bun/gate-auto-run.test.ts`
- `apps/fleet`: `npx vitest run test/github.api-queries.test.ts test/gate-routes.test.ts`
- `apps/fleet`: `npx tsc --noEmit`

refs #1172. No closing keyword.