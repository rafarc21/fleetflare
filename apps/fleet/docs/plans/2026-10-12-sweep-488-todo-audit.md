# Sweep 16 — TODO/FIXME/XXX/HACK audit plan (#488)

Issue: https://github.com/rafarc21/fleetflare/issues/488 — sweep 16, GLM-OK lane. Doc-only outcome: lead recon found zero genuine markers.

## Scope

apps/fleet (src, cli, test, test-integration, scripts, page, docs), skills/, fleet/blueprint. Skip container/. Markers inside auth/secrets/credentials/rescue/failover/accounts-routing/deploy/migrations/write-proxy/leak-gate would be CLAUDE-ONLY — none exist.

## Method

1. `grep -rniE "\b(todo|fixme|xxx|hack)\b"` per tree, excluding mktemp `XXXXXX` templates.
2. Read every surviving hit in context; classify genuine vs prose/fixture/identifier/vendored.
3. Genuine markers → cited-issue state via `gh issue view`; verdict stale (issue closed → delete) / done (work landed → delete) / real uncited (file `chore(GLM-OK): S16-Fn` issue).
4. Deliverable doc: docs/maintainability/2026-10-12-todo-audit-sweep-16.md — per-hit table + verdicts.

## Lead recon result (each line re-runnable as grep)

- Zero genuine markers in scope. Surviving hits: 1 vendored upstream TODO (apps/fleet/page/terminal.html:102, inside the regenerated XTERM_CSS span — hand-edit forbidden by the file header), 4 prose mentions, 3 test fixtures, 1 identifier (`todo` queue variable, apps/fleet/src/github/promote-close.ts:176), mktemp `XXXXXX` template lines, and 5 plan-doc history lines about an already-deleted TODO (#210 CLOSED).
- Nothing to delete/update → PR diff = sweep doc + this plan. No S16-Fn issues to file. CLAUDE-ONLY list: empty.

## Steps

1. Backend Developer: write both docs verbatim, commit, push `audit-488-todo-sweep-16`.
2. Verify (one gate at a time): `cd apps/fleet && bun run english-check`; then `flock /tmp/fleet-gate.lock bash -c 'cd apps/fleet && bun run check'`. No source touched → no vitest lane needed; english-check + tsc prove repo integrity.
3. Code Reviewer (fresh context, ≤30m): verify doc claims against the greps.
4. QA: N/A — doc-only, nothing renders differently.
5. PR: Summary/Evidence/Merge Danger per .github/pull_request_template.md; refs #488, no closing keywords; Door: two-way; Blast Radius: none — analysis-only doc.

## Boundaries

- Doc-only diff, zero code/comment changes.
- One heavy gate: tsc `check` under /tmp/fleet-gate.lock, run alone.
- Review cap 30m. No CI polling.
