---
# fix #1254: gate protect + completed-gate follow-ups (refs #1247)

## What

Four gaps left by #1247 gate enforcement.

1. `fleet gate protect` on an existing branch rule with NO
   required_status_checks: the contexts POST 404s. Fix: PATCH the whole
   required_status_checks block instead.
2. An existing rule keeps enforce_admins. Issue wanted it false. Fix: DELETE
   the enforce_admins sub-resource when the rule still enforces admins.
3. PR #1251 body says "PUT always"; code appends/PATCHes. Fix wording only.
4. Operator autopilot scripts run `task state N completed` with output to
   /dev/null, then log "completed" even when the completed-gate refuses (409).
   Scripts live outside the repo: describe the needed change in the PR body.

Comment item: the completed gate reads the PR from the latest result envelope
only. When the envelope names no PR, fall back to PRs that reference the task
(GitHub search: `is:pr <N>` matches the title "(#N)" and "Refs #N"). Keep the
guard: a fallback PR must still be merged AND green on its head.

## Fix

1. github/api.ts: `getBranchProtection` -> `BranchProtectionState`
   {contexts, hasRequiredStatusChecks, enforceAdmins}; new
   `setBranchProtectionRequiredStatusChecks` (PATCH) and
   `disableBranchProtectionEnforceAdmins` (DELETE); new
   `findPullRequestsReferencingTask` (search).
2. gate/protect.ts: widen `ProtectPort` with the two new methods; runGateProtect
   PATCHes when hasRequiredStatusChecks is false and disables enforce_admins
   when true.
3. board/completed-gate.ts: add `findTaskPrs` to the port; new
   `fallbackTaskPr` returns the first candidate PR that clears the existing
   merged+green gate.
4. board/routes.ts: wire `findTaskPrs`; the completed transition falls back to
   `fallbackTaskPr` when latestResultPr is null.

## TDD

- test/bun/gate-protect.test.ts: no-rule PUT; existing rule appends+re-pins;
  no-required-status PATCHes; enforce-admins disabled; idempotent.
- test/github.api-queries.test.ts: getBranchProtection new shape; PATCH and
  DELETE helpers.
- test/board.completed-gate.test.ts: fallbackTaskPr no-candidates 409, first
  green, skip-unmerged, all-fail 409.
- test/board.routes.test.ts: no-PR envelope falls back to a referencing PR;
  no referencing PR stays 409 with the --no-pr guidance.
- test/gate-routes.test.ts: widened ProtectPort fakes.

## Boundaries

apps/fleet/src/{github,gate,board}, apps/fleet/test. No deploy. No change to
the completed-gate policy itself. No operator autopilot scripts in the repo.

## Verify

`bun run check`; `bun test test/bun/gate-protect.test.ts`;
`npx vitest run test/github.api-queries.test.ts test/board.completed-gate.test.ts
test/board.routes.test.ts test/gate-routes.test.ts`.
---