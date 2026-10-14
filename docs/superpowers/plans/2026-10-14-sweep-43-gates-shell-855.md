# Plan — sweep 43: gates/ shell hygiene (#855)

Doc-only sweep. Scope: gates/**/*.sh (= gates/*.sh — 5 scripts, 1142 lines; gates/ has no subdirectories). Patterns: unquoted variable expansions in word-split contexts, scripts lacking set -euo pipefail, grep -q at the end of pipes under pipefail (SIGPIPE false-fail class, refs #393/#395).

## Steps

1. Branch sweep-855-gates-shell off origin/main c7407c44 (done).
2. Read all 5 scripts line-by-line; mechanical scans (unquoted-$ quote-state walk, set -e/pipefail presence, grep -q pipe membership); hand-verify every candidate. shellcheck absent from the image, so rulings are by hand.
3. Write docs/maintainability/2026-10-14-gates-shell-sweep-43.md, max 15 findings, each file:line + pattern + smallest fix; ruled-out section documents the deliberate set -e absences.
4. Commit both docs, push.
5. File one follow-up issue per batch, chore(GLM-OK): S43-Fn <short>, refs #855, no closing keywords.
6. Open doc-only PR, refs #855.

## Verification

- Doc-only diff: git diff origin/main --stat shows only the 2 new .md files.
- bun run english-check clean (run from apps/fleet).
- Every file:line ref re-checked against origin/main c7407c44 before commit.
