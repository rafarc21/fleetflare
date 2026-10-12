# Docs accuracy sweep 7 — plan (board issue #421)

Ref #421. Read-only analysis of `skills/**/SKILL.md`,
`fleet/blueprint/**/*.md`, `apps/fleet/README*` (no such file exists —
verified, noted in the findings doc preamble). No code changes.
Deliverables: findings doc
`docs/maintainability/2026-10-12-docs-accuracy-sweep-7.md` (max 15
findings, 3-5 lines each, tier GLM-OK), one board issue per batch of
related findings (grouped by doc file), title `docs(GLM-OK): S7-Fn
<short>`, one PR with the doc only, refs #421.

## Steps

1. Analysis (done by lead, read-only): grep + read across all 21
   skills/**/SKILL.md, all 12 fleet/blueprint/**/*.md; every candidate
   claim verified against code on origin/main ec85d08.
2. Findings doc: one file, findings S7-F1..S7-F9, each with doc
   file:line, what the doc says, what the code does (file:line),
   proposed fix. All tiers GLM-OK (doc-only edits).
3. Board issues: one per batch, grouped by doc file, title
   `docs(GLM-OK): S7-Fn <short>`, body links the doc section. Filed
   by lead via `fleet task new` after the doc lands.
4. PR: doc-only diff (findings doc + this plan doc), refs #421
   (never "closes").

## Constraints

- No code or doc edits in this PR beyond the sweep doc and this plan.
- No completion record in the repo (gate refuses it).

## Verification

- `bun run english-check` (from apps/fleet/) → exit 0 (doc-only diff).
- `bun run test-lies-check` (from apps/fleet/) → exit 0 (doc-only diff).
- `git diff origin/main --stat` shows only the two new doc files.
