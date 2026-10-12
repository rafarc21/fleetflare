# Plan — type-safety sweep 10 (task #429)

Parent: https://github.com/rafarc21/fleetflare/issues/429. Doc-only, no code.

1. Survey `apps/fleet/src` + `apps/fleet/cli` at origin/main fbb61d1 for: explicit `any`, `as unknown as`, unchecked casts on untrusted JSON (fetch/D1/GitHub), non-null `!` asserts, `@ts-ignore`/`@ts-expect-error`. Skip `container/`. Verify against origin/main first. DONE — 10 findings, lines pinned at fbb61d1.
2. Write `docs/maintainability/2026-10-12-type-safety-sweep-10.md` (content drafted, written verbatim).
3. File one issue per GLM-OK finding: `deepen(GLM-OK): S10-Fn <short>`.
4. One docs-only PR: the two docs, refs #429, never closing keywords.

## Boundaries

- CLAUDE-ONLY lanes (auth/secrets/credentials/rescue/failover/accounts-routing/deploy/migrations/write-proxy/leak-gate) listed in doc, nothing filed.
- Verification: `bun run scripts/english-check.ts` (docs-only PR — that is the repo's applicable check for doc text). No bundler build, no test suite.

## Verification

- english-check clean, exit 0
- `git diff origin/main --stat` shows exactly 2 new doc files
