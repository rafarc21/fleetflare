# Plan — sweep 36: unused test helpers (#739)

Doc-only sweep, no code changes. Census verified against origin/main 0cd438f.

## Steps

1. Branch sweep-739-unused-test-helpers-36 at origin/main 0cd438f — done.
2. Grep cross-reference of all 19 named exports across the 10 helper modules (test/helpers: bringup-pins, datetime, do-storage, fake-namespace, http, studio-row; test/bun/helpers: credentials, poll, shell, tmux-env) against an importer map over test/, test/bun/, test-integration/; every candidate hand re-verified — done, 3 findings (all GLM-OK).
3. Write docs/maintainability/2026-10-13-unused-test-helpers-sweep-36.md.
4. Commit + push branch.
5. File follow-up issues `test(GLM-OK): S36-Fn <short>` refs #739, no close keywords.
6. Open doc-only PR refs #739.

## Verification

- Doc-only diff, no test/src touched, so no test gate. From apps/fleet: `bun run english-check` and `bun run test-lies-check`, both exit 0.
- `git diff origin/main --stat` shows only the two new .md files.
