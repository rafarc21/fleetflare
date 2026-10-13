# Plan — sweep 32: long positional parameter lists (#663)

Doc-only sweep, no code changes. Findings from a scripted signature scan (all .ts under apps/fleet/src + apps/fleet/cli, container/ and test/ excluded; comments and template strings stripped before parsing) plus hand re-verification of every signature and call-site count with grep.

## Steps

1. Branch sweep-663-long-params-32 off origin/main b1e5b9c (done).
2. Scripted scan: every function/method/const-arrow signature; flag >5 positional params (typed params count, rest/destructured excluded) or boolean positionals among ≥3 positionals. Reserved words filtered; banned lanes (auth, secrets, rescue, failover, accounts routing, deploy, migrations, write-proxy, leak-gate, approvals) listed CLAUDE-ONLY, excluded from findings.
3. Hand-verify each hit: read the signature in the file, count call sites across src, cli, test, test-integration.
4. Write docs/maintainability/2026-10-13-long-params-sweep-32.md (15 findings max, each file:line + signature + call-site count + proposed options-object shape).
5. Commit both docs, push branch.
6. File follow-up issues per batch, `deepen(GLM-OK): S32-Fn <short>`, refs #663, never closing keywords.
7. Open doc-only PR referencing #663, no closing keywords.

## Verification

- No build/test gate applies: doc-only diff. `git diff origin/main --stat` shows only the two new .md files.
- Every file:line ref re-checked against the working tree before commit.
