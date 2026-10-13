# Plan — S39-F3: LEAD_* stream/retry timing pair docs (task #762, refs #742)

Verdict: no-op. Sweep-39 finding 3 (docs/maintainability/2026-10-13-docs-env-vars-drift-sweep-39.md, branch docs-742-env-vars-drift-sweep-39, unmerged) was filed against origin/main `0cd438f` (2026-10-13 13:48 +0200), where setup.md had zero `LEAD_STREAM_IDLE_MS`/`LEAD_AI_RETRY_BASE_MS` mentions. PR #784 (S30 batch, commit df6f549, merged 2026-10-13 15:22Z — after that base; its finding 5 was exactly this pair) landed the coverage:

- docs/setup.md:44 — the FLEET_JUNIOR flag-table row's "Also needs" cell names both vars (plus the other three glm-lead tune vars) and links docs/env-vars.md.
- docs/setup.md:330-332 — the vars paragraph lists both.
- docs/env-vars.md:55-56 — one row per var: defaults 90000 and 500, reader `src/llm/anthropic-route.ts`.
- docs/operations.md:8-12 — deliberately carries no per-var rows since #784's finding 2: it points to docs/env-vars.md as the single env-var reference page, so "operations.md is silent on both" is the design, not a gap.
- wrangler.example.jsonc:129,:132 — commented entries (pre-existing).

Defaults verified against apps/fleet/src/llm/anthropic-route.ts:135 (`LEAD_STREAM_IDLE_MS_DEFAULT = 90_000`), :157 (`LEAD_AI_RETRY_BASE_MS_DEFAULT = 500`) — docs match code.

The finding's own proposed fix (a standalone flag-table row) would be wrong anyway: both are timing-tuning vars, not feature flags — the FLEET_JUNIOR row is their correct home, which exists.

## Steps

1. This plan doc (the only change).
2. Gates: `bun run english-check`, `bun run test-lies-check` (both from apps/fleet).
3. PR: doc-only, two-way door, closes #762. Envelope on the issue states the no-op verdict + evidence.

## Verification

- `cd apps/fleet && bun run english-check` — clean
- `cd apps/fleet && bun run test-lies-check` — 0 tautological, 0 source-reading, 0 own-module-mock
