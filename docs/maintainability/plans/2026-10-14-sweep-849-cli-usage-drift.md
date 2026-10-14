# Plan — sweep 42: CLI usage drift (#849)

Doc-only PR: findings record + one follow-up issue. No code changes.

1. Commit the findings doc docs/maintainability/2026-10-14-cli-usage-drift-sweep-42.md (content settled by lead's research: main docs fully clean, one new CLAUDE-ONLY finding S42-F1, sweep-34 CLAUDE-ONLY leftovers re-recorded as still-open under #773/#774).
2. File one follow-up issue: `docs(CLAUDE-ONLY): S42-F1 docs/fleet/directus.md DIRECTUS_TOKEN put says bare wrangler secret put` — body cites docs/fleet/directus.md:139, docs/setup.md:344 + :399, refs #849, no closing keywords.
3. Verification: `bun run apps/fleet/scripts/english-check.ts` exit 0 (repo English gate); grep the new doc for any denylist-shaped private term (none expected — facts only); confirm issue filed via `gh issue view`.
4. PR: title `docs(fleet): sweep 42 — CLI usage drift findings (refs #849)`, body per .github/pull_request_template.md (Summary/Evidence/Merge Danger).

Boundaries: no src/ or container/ changes; GLM-OK lane has nothing to fix; review cap 15m; never re-dispatch a reviewer.
