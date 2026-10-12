# Sweep 17 — docs/ accuracy vs code on origin/main (#536)

Issue: https://github.com/rafarc21/fleetflare/issues/536 — GLM-OK lane. Doc-only sweep: docs/*.md (4 files) + docs/fleet/*.md (5 files) vs code at 39dda2b. apps/fleet/docs root has no loose .md (only maintainability/ + plans/, both out of scope per task). docs/superpowers/ (133 files, ~35k lines) is plans/specs/evidence — archived by convention, same as sweep 7 treated it.

## Method

1. Read all 9 files in full.
2. Grep every command/flag/path/file/env-var/behavior claim against code; run `gh run list`/`gh pr checks` for the live-CI claims.
3. Each finding: doc file:line, says X, code does Y (file:line), proposed fix. Cap 15.
4. CLAUDE-ONLY (auth/secrets/credentials/rescue/failover/accounts/deploy): threat-model.md is credentials wholesale — all its findings are CLAUDE-ONLY; also ops.md "dead claude account" section, setup.md Claude-accounts/failover/creds/leak-gate/write-proxy/rescue/deploy-token sections.

## Findings (9 filed, all GLM-OK)

S17-F1 ops.md one-way-door "not yet added" — workflow exists and runs (2026-10-11, 1db884b). S17-F2 ops.md "three workflows" — four (sensors.yml). S17-F3 setup.md migrations "0001+0002 today" — six. S17-F4 spike-lead-tools.md "shipped matcher Edit|Write|NotebookEdit|Bash" — matcher now `.*` shape-based. S17-F5 firstmate-analysis.md ROLE_EFFORT quote says `maestro` — code says `cto`. S17-F6 firstmate-analysis.md §2.1 "No consumer reads artifacts" — Worker verifies PRs (getPullRequest). S17-F7 skipperm-effort-report.md "three keys"/"fixed triple" — four keys now (ROLE_MCP). S17-F8 ops.md CI section predates native-Actions flip (localci para reads as current). S17-F9 threat-model.md "three Durable Object classes" — four (StudioBigDO #107); CLAUDE-ONLY tier, listed not filed.

## Steps

1) This doc + sweep doc on branch audit-536-docs-sweep-17, one commit, push. 2) File per-file-batch `docs(GLM-OK): S17-Fn` issues (lead does via gh). 3) Gates one at a time: english-check, then flock tsc check. 4) Reviewer fresh-context ≤30m. 5) PR refs #536, no closing keywords, Door two-way.

## Boundaries

Doc-only diff, zero code changes. One heavy gate (tsc check) under /tmp/fleet-gate.lock, alone. Review cap 30m. No CI polling.
