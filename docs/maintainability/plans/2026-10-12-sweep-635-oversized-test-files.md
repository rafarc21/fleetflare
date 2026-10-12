# Plan — sweep 26: oversized test files (#635)

Doc-only sweep, no code changes, no splits in this PR. Scope apps/fleet/test only (vitest root + test/bun). Census by wc -l at origin/main f558821: 34 files >800 lines; top 15 filed, the rest listed as context.

## Steps

1. Branch sweep-635-oversized-test-files off origin/main f558821 (done).
2. Line census: find apps/fleet/test -name '*.test.ts' | xargs wc -l, threshold strictly >800.
3. For each top-15 file: read top-level describe()/test() block map (grep -n '^describe(' + divider comments for describe-less bun files), identify seams by src module under test, proposed split file names, shared setup needed per half (test/helpers, test/bun/helpers, test/bun/exec-snippet, test/fixtures/rate-limit-panes, plus in-file fakes).
4. Write docs/maintainability/2026-10-13-oversized-test-files-sweep-26.md (15 findings, sweep-25 doc shape: Method, findings table, per-finding sections).
5. Commit both docs, push branch (LEFTHOOK=0 git push -u origin sweep-635-oversized-test-files).
6. File one issue per batch: test(GLM-OK): S26-Fn <short>, refs #635, never closing keywords.
7. Open doc-only PR referencing #635, no closing keywords.

## Verification

- Doc-only: no build/test gate applies. git diff origin/main --stat shows only the two new .md files.
- Every line ref re-checked against working tree before commit.
- bun run english-check on the two docs (sweep docs are in its scope).
