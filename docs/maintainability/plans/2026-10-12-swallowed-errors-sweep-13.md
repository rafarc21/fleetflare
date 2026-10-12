# Plan — sweep 13: swallowed errors (#482)

Scope: `apps/fleet/src/**` + `apps/fleet/cli/**`, minus `container/`. Analysis only.
Method: grep all catch blocks and `.catch()` handlers, read each body, classify
deliberate (comment + correct posture) vs silent swallow. ~300 sites reviewed.
Skip zones (auth, secrets, credentials, rescue, failover, accounts routing,
deploy, migrations, write-proxy, leak-gate) only listed as CLAUDE-ONLY, nothing filed.

## Steps

1. Commit sweep doc `docs/maintainability/2026-10-12-swallowed-errors-sweep-13.md`
   with 15 findings (content provided by lead), same shape as sweep-10 doc.
2. File follow-up issues, one per batch, titled `fix(GLM-OK): S13-Fn <short>`
   — batches: F1 authz-false log, F2 orca-json-empty, F3 wake-route-null-lookups,
   F4 rescue-log-line, F5 authz-malformed-sweep-log. Each refs #482, never
   closing keywords.
3. Open one doc-only PR (doc + plan doc only), refs #482, never closing keywords.

## Verification

- `bun run test -- docs` does not exist; doc-only change → run the repo's
  english check only: `bunx tsx apps/fleet/scripts/english-check.ts`.
- `git diff origin/main --stat` shows only the two docs files.

## Boundaries

- No code changes. No new deps. Review cap 30m. No CI polling.
