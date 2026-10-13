# Plan — sweep 30: undocumented env vars (#648)

Doc-only sweep, no code changes. Findings cross-referenced by hand: every
env.X / process.env.X read in apps/fleet/src + apps/fleet/cli (minus
container/) against docs/setup.md, docs/operations.md, apps/fleet/wrangler.example.jsonc.

## Steps

1. Branch sweep-648-env-var-docs-30 off origin/main (done).
2. Inventory every env read (79 distinct env.X names + 2 process.env reads); rule out bindings (DB, AI, AGENT, DEPLOY, STUDIO, STUDIO_BIG, STUDIO_ARCHIVE), documented vars, and computed-name families already covered by setup.md (GITHUB_TOKEN_<OWNER>, CLAUDE_CODE_OAUTH_TOKEN_<n>, GITHUB_READ_TOKEN_<OWNER>, GITHUB_INSTALLATION_ID_<OWNER>).
3. Write docs/maintainability/2026-10-13-env-var-docs-sweep-30.md — 11 findings, each: read site, default, doc coverage found, proposed doc line, GLM-OK/CLAUDE-ONLY lane.
4. Commit both docs, push branch (LEFTHOOK=0 git push -u origin sweep-648-env-var-docs-30).
5. File follow-up issues per finding: deepen(GLM-OK)/deepen(CLAUDE-ONLY): S30-Fn <short>, refs #648, never closing keywords.
6. Open doc-only PR referencing #648, no closing keywords.

## Verification

- No build/test gate: doc-only diff, no code touched. git diff origin/main --stat = 2 new .md files only.
- Every file:line ref re-checked against working tree before commit.
- cd apps/fleet && bun run scripts/english-check.ts exit 0.
- Follow-up issues filed: every finding must name its issue number in the sweep doc.
