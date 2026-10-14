# Plan — sweep 43: duplicated test fixtures (#850)

Doc-only sweep. Bar lowered to 2+ files (sweep 33 used 3+): pairs and
new arrivals since 2026-10-13. Census scripted (brace-matched bodies,
whitespace-normalized, md5-grouped, two passes: same-name and body-only)
at origin/main 9b1d144, every copy re-read by hand. Excludes sweep-18/33
filed clusters, sweep-36 findings, open S33 issues (747/751/756/758), and
sweep-33's not-filed list.
## Steps

1. Branch sweep-850-dup-fixtures off origin/main 9b1d144 (done).
2. Scripted census + hand verification (done — findings in the sweep doc).
3. Write docs/maintainability/2026-10-14-dup-fixtures-sweep-43.md, max 15 findings, each: copies (file:line), what differs, proposed helper name + home.
4. Commit both docs, push branch (LEFTHOOK=0 git push -u origin sweep-850-dup-fixtures).
5. File one issue per batch: test(GLM-OK)|test(CLAUDE-ONLY): S43-Fn <short>, refs #850, never closing keywords.
6. Open doc-only PR referencing #850, no closing keywords.
## Verification
- Doc-only diff: git diff origin/main --stat shows only the two new .md files.
- bun run english-check on the two docs (run from apps/fleet).
- Every file:line ref re-checked against working tree before commit.
