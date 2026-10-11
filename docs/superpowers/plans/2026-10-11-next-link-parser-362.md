# One Link rel="next" parser: `github/next-link.ts` (board issue #362)

Issue: https://github.com/rafrc21/fleetflare/issues/362. Deep-modules
sweep 4 finding F2 (parent #361). Tier GLM-OK. Refs #361, never closes.
Behavior-preserving on every real GitHub Link header; two-way door
(diff touches no ONE_WAY_GLOBS path in scripts/merge-danger.ts).

Verified not already on main @ 234a3b1: `nextPageUrl` at
apps/fleet/src/board/api.ts:101, `parseNextLink` at
apps/fleet/src/github/api.ts:1031, no next-link module anywhere.

## Problem

Two hand-rolled `rel="next"` Link-header parsers implement one RFC 8288
parsing rule twice — same regex (one copy `[^>]*`, other `[^>]+`), same
comma-split loop, same null-on-last-page. A fix to one (quoted or
multi-param rel entries) must be remembered in both.

## Characterization (golden table, run against both old copies 2026-10-11)

15 cases; all agree except `<>; rel="next"`: the board copy returned ""
(which listIssues would follow forever), github's returned null. GitHub
never sends an empty URL; unified pick = `[^>]+` → null (fail closed, no
infinite refetch). The table lives in test/github.next-link.test.ts.

## Steps

1. RED: test/github.next-link.test.ts — golden table importing
   nextPageLink from ../src/github/next-link; fails, module absent.
2. GREEN: src/github/next-link.ts — pure, no Env, no I/O.
3. Swap callers: github/api.ts drops parseNextLink (import ./next-link),
   board/api.ts drops nextPageUrl (import ../github/next-link); both
   files' twin-citing comments die with them. Targeted vitest green.
4. Gates one at a time under flock /tmp/fleet-gate.lock: bun run check,
   bun run english-check, bun run test-lies-check, then full bun run
   test once, alone, under the same lock.
5. Done record /workspace/.fleet/done/362.json (outside the repo).

## Files

- Create: apps/fleet/src/github/next-link.ts,
  apps/fleet/test/github.next-link.test.ts, this plan doc.
- Modify: apps/fleet/src/github/api.ts, apps/fleet/src/board/api.ts.
- Untouched: everything else.

## Boundaries

Behavior-preserving; the one unified divergence (`<>` → null) is
fail-closed and pinned by its own test case. board/api.ts importing a
pure helper from src/github/ is existing precedent (wake-events.ts
oneLine, read-repos) — this does not merge the two API clients, whose
separation that file's header documents.
