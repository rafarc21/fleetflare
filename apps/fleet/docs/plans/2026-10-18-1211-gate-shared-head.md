# 1211 — one verdict per sha, red wins across PRs sharing a head (#1172)

Gate posts one `gate/verdict` commit status per head sha. Two open PRs with the
same head sha but different bases share that status: the last writer wins, so a
gated PR's green can overwrite an ungated PR's red, or reuse can hand a later PR
an earlier green. Fix has two halves, TDD failing-first.

## 1. Shared-head guard before every success post (config.ts + workflow.ts)

Pure helper in config.ts:

`sharedHeadFailure(headSha, open: { number: number; baseSha: string }[], baseSha)` ->
`head <sha8> shared with PR #N` for the first sibling open PR (number != current,
different base), else null. Different base = baseSha differs. Lookup error is not
a helper input: the caller fails closed.

workflow.ts: before post-skip-status (line 126) and before post-verdict (line 233),
list open PRs whose head.sha equals the resolved head (new github/api `listOpenPulls`,
refs not shas), map each to `{ number, baseSha }` via `getBranchSha`. A helper error
posts failure "gate: cannot list shared-head PRs" (fail closed), never success.

## 2. Per-PR fresh run (auto-run.ts)

Run id becomes `gateRunId(repo, pr, headSha)`: repo hash + pr + sha, so PR A and PR B
sharing a sha get distinct instances. In startGateRun's catch (existing-id path), when
`index.latest(repo, pr).headSha !== headSha`, start a fresh `-r<base36time>` run like the
#1170-reverted code, else reuse. One live run per (pr, sha): a second start of the SAME
(pr, sha) still reuses; only a DIFFERENT pr sharing the sha starts fresh.

## Tests (failing first)

- config.test.ts: sharedHeadFailure — sibling different base -> text; same base / self / empty -> null.
- auto-run.test.ts: PR A red-then-PR B green ends red; B green-then-A red ends red (fresh run,
  distinct id); same-base pair reuses (green); one live run per (pr, sha).
- api-queries.test.ts: listOpenPulls maps number + head/base refs; throws on non-2xx.

## Verification

- `apps/fleet`: `bun test test/bun/gate-config.test.ts test/bun/gate-auto-run.test.ts`
- `apps/fleet`: `npx vitest run test/github.api-queries.test.ts test/gate-routes.test.ts`
- `apps/fleet`: `npx tsc --noEmit`

refs #1172. No closing keyword.