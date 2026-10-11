# Sweep 5 plan — cli/ + scripts/ maintainability (refs #394)

Read-only analysis at origin/main 8367c19. Deliverables: one findings doc,
one deepen issue per GLM-OK finding, one PR (doc only). No code changes.

## Steps

1. Baseline: git log origin/main since sweeps 1-4; re-read sweep-1/2/4 docs
   + open deepen(*) issues; exclude everything already covered or filed.
2. Read all 27 cli/*.ts + scripts/** (test-lies, merge-danger, build-page,
   english-check, repo-check, deploy-target/changed, sensors, localci,
   summarize, shell scripts). Census dupes by grep; pin line refs at 8367c19.
3. Findings (10, tiered): S5-F1 column-table builder (4 copies); F2 CLI
   error-text fold errText + <title>/JSON/slice decode; F3 ageSeconds 6
   copies; F4 repo-segment refusal 4 sites; F5 lead-state precedence 2
   implementations; F6 ff.ts poll/ticker vs accounts --watch loop; F7
   accounts-format slot grammar vs src/studio/accounts.ts; F8
   fleet.ts:86-214 loadCredentials trio (dropped round 1: dup of open #318); F9 sweep D12 buildGridPage
   3-line pass-through; F10 dead-export WATCH_INTERVAL_MS (test-only).
   Tiers: F1,F2,F3,F4,F5,F7,F9,F10 GLM-OK; F6 GLM-OK slice (rescue/deploy
   poll wiring stays the Claude lane); F8 dropped round 1 (dup of open #318).
4. Write docs/maintainability/2026-10-11-deep-modules-sweep-5.md (10
   findings, 4-6 lines each: file:line evidence, proposed change, tier).
5. File one deepen(GLM-OK): S5-Fn issue per GLM-OK finding (lead files
   these, not you).
6. Gates serial: bun run check; bun run english-check; bun run
   test-lies-check. Push after first commit.

## Verification

All three gates exit 0 on the doc-only branch. english-check clean on the
new doc (it contains no Portuguese marker words).
