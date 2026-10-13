# Plan — sweep 37: broken doc links (#740)

Doc-only sweep, no code changes. Scan of docs/**, apps/fleet/docs/**, README.md, skills/**/*.md at origin/main 0cd438f: every relative markdown link resolved against its file (8 raw misses, all false positives — qa SKILL.md template placeholders and one fenced code block); every file:line cite (~1660 unique tokens) resolved against repo roots, then line vs EOF; every backtick path cite resolved. firstmate-analysis external-repo cites, operator-machine paths, and dated-plan history cites excluded as by-design; threat-model line drift already filed as S17-F9 (CLAUDE-ONLY), not repeated.

## Steps

1. Branch sweep-740-broken-doc-links-37 off origin/main 0cd438f (done).
2. Scripted scan: relative links, file:line cites, backtick cites; hand-verify each candidate against the working tree and git history (git show at the citing doc's own pinned commit when it names one).
3. Write docs/maintainability/2026-10-13-broken-doc-links-sweep-37.md — 7 findings, each doc file:line + broken target + correct target.
4. Commit both docs, push branch.
5. File follow-up issues per batch: `docs(GLM-OK): S37-Fn <short>`, refs #740, no closing keywords.
6. Open doc-only PR referencing #740, no closing keywords.

## Verification

- No build/test gate applies: doc-only diff; `git diff origin/main --stat` shows only the two new .md files.
- Every doc file:line ref and corrected target re-checked against the working tree before commit.
