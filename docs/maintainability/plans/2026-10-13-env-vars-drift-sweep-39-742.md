# Plan — Sweep 39: env var docs drift (#742)

Doc-only sweep. Compare `apps/fleet/src/env.ts`'s `Env` interface against
docs/setup.md, docs/operations.md, apps/fleet/wrangler.example.jsonc.
Names only, never values. No src/, container/ changes.

## Steps

1. Extract every env var declared in `Env` (env.ts) — done, 66 fields.
2. For each, grep docs/setup.md, docs/operations.md, wrangler.example.jsonc
   for the name. Absence from ALL = doc-missing finding.
3. Reverse: every documented var grep'd in src/ for a code read
   (incl. computed names GITHUB_TOKEN_<OWNER>, CLAUDE_ACCOUNT_<n>_LABEL).
   All resolve — direction B clean.
4. Write `docs/maintainability/2026-10-13-docs-env-vars-drift-sweep-39.md`
   (6 findings, 5 GLM-OK, 1 CLAUDE-ONLY).
5. Verify: `bun run english-check` + `bun run test-lies-check` exit 0.
6. One issue per finding on GitHub (S39-F1..F6), refs #742.
7. PR: doc-only, refs #742, never closing keywords.

## Findings summary (evidence in sweep doc)

- F1 LEAD_RATE_PER_MINUTE/LEAD_DAILY_CAP — in example jsonc comments only
- F2 LEAD_COUNT_TOKENS_RATE_PER_MINUTE — absent everywhere
- F3 LEAD_STREAM_IDLE_MS/LEAD_AI_RETRY_BASE_MS — example jsonc comments only
- F4 FLEET_BOT_*/FLEET_STUDIO_GIT_* — example jsonc only, setup.md absent
- F5 INSTALL_CACHE_REPOS/R2_* trio+R2_BUCKET_NAME — CLAUDE-ONLY (credentials)
- F6 LEAD_MODEL_POOL/LEAD_AI_GATEWAY_ID/MODEL_QUALITY_ISSUE — missing from
  example jsonc vars (present in setup.md)
