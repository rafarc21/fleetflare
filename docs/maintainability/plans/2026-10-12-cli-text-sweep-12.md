# Plan — sweep 12: CLI help + error text accuracy (#481)

Doc-only sweep, no code changes. Verified against origin/main d060ab5.

## Steps

1. Branch sweep-481-cli-text-12 off origin/main.
2. Compare cli-args.ts VERBS/CLI_USAGE, container/studio-fleet HELP, ff help, fleet.ts error strings against parsers and behavior. Verified each finding by reading the cited code.
3. Write docs/maintainability/2026-10-12-cli-text-sweep-12.md (11 findings, F1-F11, all GLM-OK; CLAUDE-ONLY items listed, nothing filed).
4. Commit both docs, push branch.
5. File one batched follow-up issue `fix(GLM-OK): S12-F1..F11 CLI help text accuracy` referencing #481, no close keywords.
6. Open doc-only PR referencing #481, no close keywords.

## Verification

- No build/test gate applies: doc-only diff, no code touched. `git diff --stat` shows only the two new .md files.
- Every file:line ref in the sweep doc re-checked against the working tree before commit.
