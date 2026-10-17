# Gate merge prechecks — closing keyword + leak scan before auto-merge arm

Issue: https://github.com/rafarc21/fleetflare/issues/1169
Refs #1168 (auto-merge), piece (a) of (a)-(d). TDD, targeted tests only.

## Change

1. merge-precheck.ts — pure precheck rules. Two refusals:
   - closing keyword regex `(^|[^a-z])(close[sd]?|fix(es|ed)?|resolve[sd]?) #[0-9]`
     over PR title + body. Cruder than promote-close.ts on purpose: asks
     "is arming --auto safe", not "does it close issue N".
   - denylist scan over title, body, every file patch, rename old names,
     commit author/committer identities. Fail closed: zero patterns or
     scanner error refuses, never passes. Hit names pattern index only.
2. api.ts — `comparePrecheckData`: compare call reading patches + commit
   identities. Pure `precheckSummary` maps response. Separate from
   compareFiles: precheck reads text bodies, gate path rules read names.
3. workflow.ts — `precheck` step after decision, after `fail` branch, before
   `skip` branch. Docs-only PR with closing keyword still goes red. Bad head
   config keeps own more specific description. Step throws -> caught ->
   "gate precheck failed closed", red verdict.
4. Runbook gate-auto-merge.md: arm invocation + audit boundary.

## Invocation

`gh pr merge --auto --squash --match-head-commit <head-sha> --author-email 'fleet-studio@users.noreply.github.com'` — gate must be green on that head first.

## Audit boundary

Pre-merge gate cannot read merge commit identity (exists only at merge time). Identity check lives post-merge: monitor (#1168 piece d) reads merge commit author email, alerts when not noreply.

## Test files

- apps/fleet/test/bun/gate-merge-precheck.test.ts
- apps/fleet/test/bun/gate-precheck-data.test.ts

## Verify

- cd apps/fleet && bun test test/bun/gate-merge-precheck.test.ts test/bun/gate-precheck-data.test.ts test/bun/leak-gate.test.ts
