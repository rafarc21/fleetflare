# Plan — S39-F1: LEAD_* throttle pair docs (task #760, refs #742)

Verdict: no-op. Sweep-39 finding 1 (docs/maintainability/2026-10-13-docs-env-vars-drift-sweep-39.md, branch docs-742-env-vars-drift-sweep-39, unmerged) was filed against origin/main `0cd438f`, where setup.md had zero LEAD_* mentions. PR #784 (commit df6f549, merged 2026-10-13, AFTER that base) landed the coverage this finding asks for:

- docs/setup.md:44 — FLEET_JUNIOR flag-table row's "Also needs" cell names LEAD_RATE_PER_MINUTE and LEAD_DAILY_CAP (plus the other three glm-lead tune vars) and links docs/env-vars.md.
- docs/setup.md:330-331 — vars paragraph lists the pair alongside the JUNIOR_* pair.
- docs/env-vars.md:52-53 — one row per var: defaults 60/min and 2000/UTC-day, reader `src/llm/ratelimit.ts`.
- wrangler.example.jsonc:122-123 — commented entries (pre-existing).

Defaults verified against apps/fleet/src/llm/ratelimit.ts:22,:31 (60, 2000) — docs match code.

The finding's own proposed fix (a standalone flag-table row) would be wrong anyway: LEAD_RATE_PER_MINUTE/LEAD_DAILY_CAP are throttle vars, not feature flags — the flag-table row FLEET_JUNIOR is their correct home, which now exists.

## Steps

1. This plan doc (the only change).
2. Run gates: `bun run english-check`, `bun run test-lies-check` (both from apps/fleet).
3. Open PR: doc-only, two-way door, closes #760. Envelope on the issue states no-op verdict + evidence.

## Verification

- `cd apps/fleet && bun run english-check` — clean
- `cd apps/fleet && bun run test-lies-check` — 0/0/0
