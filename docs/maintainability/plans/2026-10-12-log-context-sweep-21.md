# Plan — sweep 21: Worker log context (#543)

Doc-only sweep, no code changes. Findings verified against origin/main 44116cb.

## Steps

1. Branch sweep-543-log-context-21 off origin/main (done).
2. Read all 323 console.log/warn/error/info/debug sites in apps/fleet/src (full inventory via ripgrep + per-file reads of every multi-line and id-less candidate). Skipped per task: auth, credentials, rescue, failover, accounts routing, deploy, write-proxy, leak-gate — read anyway where adjacent, listed as CLAUDE-ONLY.
3. Write docs/maintainability/2026-10-12-log-context-sweep-21.md (15 findings max, each file:line + current text + proposed text; GLM-OK/CLAUDE-ONLY lane per finding).
4. Commit both docs, push branch (`LEFTHOOK=0 git push -u origin sweep-543-log-context-21`).
5. File follow-up issues per batch, `chore(GLM-OK): S21-Fn <short>` (or fix/test GLM-OK prefix where the fix lane demands), refs #543, never closing keywords.
6. Open doc-only PR referencing #543, no closing keywords.

## Verification

- No build/test gate applies: doc-only diff, no code touched. `git diff origin/main --stat` shows only the two new .md files.
- Every file:line ref re-checked against the working tree before commit.
