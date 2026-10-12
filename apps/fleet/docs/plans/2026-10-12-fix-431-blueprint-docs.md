# Blueprint docs fixes S7-F4..S7-F5 — plan (board issue #431)

Refs #431, refs #421 (sweep 7). Doc-only: two findings from
`docs/maintainability/2026-10-12-docs-accuracy-sweep-7.md`, both re-verified
against origin/main `4f1a21f` before planning. No code changes; scope is
`fleet/blueprint/README.md` and the two developer member files only.

## Findings → fixes

1. **S7-F4** — `fleet/blueprint/README.md:31` locates `../../skills/` as
   "(repo root, alongside `container/`)", but repo root has no `container/`
   directory — it lives at `apps/fleet/container/`
   (`apps/fleet/container/Dockerfile.studio`).
   Fix: `alongside `container/`` → `alongside `apps/fleet/container/``.

2. **S7-F5** — `fleet/blueprint/CODING_STANDARDS.md:7-9` says the developer
   blueprints (`members/frontend-developer.md`, `members/backend-developer.md`)
   "only cite it"; neither mentions CODING_STANDARDS (grep: zero hits), while
   `members/code-reviewer.md:22` does.
   Fix: add one pointer line to each developer member file rather than
   reword CODING_STANDARDS.md — its preamble already designs implementers to
   "get a one-line pointer"; the member files were the missing half. Same
   line in both, new paragraph after the TDD line:
   "Write to the bar in `fleet/blueprint/CODING_STANDARDS.md` — the Code
   Reviewer's Standards axis grades your diff against it."
   After this, the "only cite it" sentence is true as written;
   CODING_STANDARDS.md itself is not edited.

## Steps

1. Branch `docs-431-blueprint-f4-f5` off origin/main; commit this plan
   first, push immediately.
2. The two fixes above; commit, push.
3. Verification (below), one command at a time, `check` under
   `/tmp/fleet-gate.lock` and never alongside another gate.
4. Lead: fresh-context Code Reviewer (2 axes), QA, then PR + envelope.

## Verification

- `bun run bun-test` (from apps/fleet/) — parses the member files this diff
  touches and pins the gate-budget sentences (additions only; all pins stay
  green).
- `bun run english-check` → exit 0.
- `bun run test-lies-check` → exit 0.
- `bun run check` → exit 0 — the one heavy gate, run alone.
- `git diff origin/main --stat` → exactly 4 files: this plan, README.md,
  both member files. Docs-only PR: no local-ci check job to wait on.
