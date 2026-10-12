# Dead-code sweep 9 — plan (board issue #428)

Ref #428. Read-only analysis of `apps/fleet/src/**`, `apps/fleet/cli/**`,
`apps/fleet/test/helpers/**` for dead code; skip `container/` (image changes
held) and the CLAUDE-ONLY lanes (auth, secrets, credentials, rescue,
failover, accounts routing, deploy, migrations, write-proxy, leak-gate).
Deliverables: findings doc `docs/maintainability/2026-10-12-dead-code-sweep-9.md`
(max 15 findings, file:line, grep evidence, proposed removal), one board
issue per related GLM-OK batch (`deepen(GLM-OK): S9-Fn <short>`), one PR
with the doc only (refs #428, never closing keywords).

## Steps

1. Sweep for unused exports, orphan files, unreachable branches,
   commented-out code, stale TODOs. Explorer agent extracted all export
   names repo-wide and grep-verified each candidate (~1800 exports
   checked); 8 findings survive, zero false positives preferred.
2. Lead hand-verified every reported finding's grep evidence at exact
   file:line before writing the doc.
3. Write `docs/maintainability/2026-10-12-dead-code-sweep-9.md`: one
   file, S9-F1..S9-F8, each with Files / Evidence / Problem / Proposed
   removal, tier marked. Line refs = physical lines at `origin/main`
   `c2cc15f`, paths relative to `apps/fleet/`.
4. File one deepen(GLM-OK): S9-Fn issue per related batch via gh.
5. One PR, doc only, refs #428, no closing keywords. local-ci gate,
   completion record, envelope.

## Constraints

- No code changes anywhere. Two new doc files only.
- CLAUDE-ONLY findings (F4 + the do.ts/accounts.ts/rescue/auth/write-proxy/
  failover/deploy/creds entries inside F5-F7) are listed in the doc, filed
  by nobody — maestro owns that lane.
- No completion record in the repo (gate refuses it) — it lives under
  /workspace/.fleet/done/428.json, like sweep-6's.

## Verification

- No heavy gates — docs-only diff. `bun run scripts/english-check.ts`
  (from apps/fleet/) + `tsc --noEmit -p test` only. Full suite belongs to CI.
