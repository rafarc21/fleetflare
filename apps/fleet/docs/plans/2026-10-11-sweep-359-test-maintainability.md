# Test-suite maintainability sweep 3 — plan (board issue #359)

Ref #359. Read-only analysis of `apps/fleet/test/**`, no code changes.
Deliverables: findings doc
`docs/maintainability/2026-10-11-test-sweep-3.md` (max 10 findings, each
4-6 lines, tier GLM-OK or CLAUDE-ONLY), one board issue per GLM-OK
finding (`deepen(GLM-OK): S3-Fn <short>`), one PR with the doc only.

## Steps

1. Analysis (done by lead, read-only): grep + read across
   `apps/fleet/test/**` for the brief's four categories — duplicated
   fixture builders (3+ copies), impl-detail assertions, >1500-line
   files worth splitting, dead helpers / skipped tests without reason /
   stale issue-number comments. Every finding verified at
   `origin/main` 360570b.
2. Findings doc: one file, findings S3-F1..S3-F10, each with
   file:line evidence, proposed change, tier. Tests touching
   rescue/failover/auth/deploy/credentials = CLAUDE-ONLY.
3. Board issues: one per GLM-OK finding, title
   `deepen(GLM-OK): S3-Fn <short>`, body links the doc section. Filed
   by lead via `fleet task new` after doc lands.
4. PR: doc-only diff, refs #359.

## Constraints

- No code changes anywhere. Doc + issues + PR only.
- No completion record in the repo (gate refuses it).

## Verification

- `bun run english-check` (from apps/fleet/) → `english-check: clean`, exit 0.
- `bun run test-lies-check` (from apps/fleet/) → exit 0 (doc-only diff cannot affect it).
- `git diff origin/main --stat` shows only the two new doc files.
