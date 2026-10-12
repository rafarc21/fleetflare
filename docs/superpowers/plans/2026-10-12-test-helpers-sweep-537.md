# Plan — sweep 18: duplicated test helpers (#537)

Doc-only sweep, no code changes. Census verified against origin/main 13f445f.

## Steps

1. Branch sweep-537-test-helpers-18 at origin/main 13f445f — done.
2. Grep census + md5 body-hash grouping across apps/fleet/test — done, findings F1-F12 (8 GLM-OK, 3 CLAUDE-ONLY, 1 below-bar).
3. Write docs/maintainability/2026-10-12-test-helpers-sweep-18.md.
4. Commit + push branch.
5. File GLM-OK batch issues `test(GLM-OK): S18-Fn <short>` refs #537, no close keywords.
6. Open doc-only PR refs #537.

## Verification

- Doc-only diff, no test/src touched, so no test gate. From apps/fleet: `bun run english-check` and `bun run test-lies-check`, both exit 0.
