# Plan — sweep 24: unused exports (#588)

Doc-only sweep, no code changes. Findings verified against origin/main 30bceb7 by scripted export/import cross-reference (every candidate re-grepped by hand for importers in src, cli, test, test-integration, scripts, page, container).

## Steps

1. Branch sweep-588-unused-exports-24 off origin/main 30bceb7 (done).
2. Scripted inventory: 1691 named exports across apps/fleet/src + apps/fleet/cli (container/ excluded); importer map built over src, cli, test, test-integration, scripts, page. Excluded lanes: auth, secrets, rescue, failover, accounts routing, deploy, migrations, write-proxy, leak-gate, approvals.
3. Classify: zero-importer exports (imported by nothing outside their own file) and sole-test-importer exports (imported only by the test file that exists to test that module).
4. Hand-verify every finding with grep: rule out comment mentions, container/ local mirrors, re-export chains, wrangler-config-required exports.
5. Write docs/maintainability/2026-10-12-unused-exports-sweep-24.md (15 findings max, each file:line + grep evidence + proposed action).
6. Commit both docs, push branch (`LEFTHOOK=0 git push -u origin sweep-588-unused-exports-24`).
7. File follow-up issues per batch, `deepen(GLM-OK): S24-Fn <short>`, refs #588, never closing keywords.
8. Open doc-only PR referencing #588, no closing keywords.

## Verification

- No build/test gate applies: doc-only diff, no code touched. `git diff origin/main --stat` shows only the two new .md files.
- Every file:line ref re-checked against the working tree before commit.
