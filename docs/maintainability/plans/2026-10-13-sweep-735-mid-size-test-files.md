# Plan — sweep 35: mid-size test files (#735)

Doc-only sweep, second tier of test-file size (sweep 26 covered >800).
Scope apps/fleet/test only (vitest root + test/bun). No code changes, no
splits in this PR. Census by wc -l at origin/main 5b7a234: 19 files in
600-800; top 15 filed, remaining 4 listed as context.

## Steps

1. Branch sweep-735-mid-size-test-files-35 off origin/main 5b7a234 (done).
2. Line census: find apps/fleet/test -name '*.test.ts' | xargs wc -l, 600-800 inclusive.
3. For each top-15 file: map top-level describe()/suite() blocks (grep -n), identify seams by src module under test, proposed split names per existing convention <module>.<aspect>.test.ts, shared setup per half, tier-lane verdict (CLAUDE-ONLY if any of auth, secrets, tokens, credentials, rescue, failover, accounts routing, deploy, migrations, write-proxy, leak-gate, approvals is the file's subject; GLM-OK otherwise).
4. Write docs/maintainability/2026-10-13-mid-size-test-files-sweep-35.md (15 findings, sweep-26 doc shape).
5. Commit both docs, push branch (LEFTHOOK=0 git push -u origin sweep-735-mid-size-test-files-35).
6. File one issue per batch: test(GLM-OK|CLAUDE-ONLY): S35-Fn <short>, refs #735, never closing keywords; open doc-only PR, no closing keywords.

## Verification

- Doc-only: no build/test gate applies. git diff origin/main --stat shows only the two new .md files; every line ref re-checked against working tree before commit.
- bun run english-check on the two docs.
