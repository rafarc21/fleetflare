# One Link rel="next" parser: `github/next-link.ts` (board issue #362)

Issue: https://github.com/rafrc21/fleetflare/issues/362. Deep-modules
sweep 4 finding F2 (parent #361). Tier GLM-OK. Refs #361, never closes.
Behavior-preserving on every real GitHub Link header; two-way door
(diff touches no ONE_WAY_GLOBS path in scripts/merge-danger.ts).
Verified not already on main @ 234a3b1: `nextPageUrl` at src/board/api.ts:101,
`parseNextLink` at src/github/api.ts:1031, no next-link module anywhere.

## Problem
Two hand-rolled `rel="next"` Link-header parsers implement one RFC 8288
parsing rule twice — same regex (one copy `[^>]*`, other `[^>]+`), same
comma-split loop, same null-on-last-page; a fix must land in both.

## Characterization (golden table, run against both old copies 2026-10-11)
15 cases; all agree except `<>; rel="next"`: the board copy returned "",
github's returned null. GitHub never sends an empty URL; unified pick =
`[^>]+` → null (fail closed — same posture as listIssues' off-host
check). The table lives in test/github.next-link.test.ts.

## Steps
1. RED: golden table in test/github.next-link.test.ts (module absent).
2. GREEN: src/github/next-link.ts — pure, no Env, no I/O.
3. Swap callers: both api.ts files drop their copies + twin comments.
4. Gates one at a time under flock /tmp/fleet-gate.lock; full test once, alone.
5. Done record /workspace/.fleet/done/362.json (outside the repo).

## Files
- Create: apps/fleet/src/github/next-link.ts,
  apps/fleet/test/github.next-link.test.ts, this plan doc.
- Modify: apps/fleet/src/github/api.ts, apps/fleet/src/board/api.ts.
- Untouched: everything else.

## Boundaries
Behavior-preserving; the unified divergence (`<>` → null) is fail-closed,
pinned by its own test case. board/api.ts importing a pure helper from
src/github/ is existing precedent (wake-events.ts oneLine, read-repos) —
the two API clients stay separate, as that file's header documents.
