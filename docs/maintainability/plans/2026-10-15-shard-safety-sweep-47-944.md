# Plan — sweep 47: shard safety, apps/fleet tests (refs #944, refs #715)

Doc-only sweep, no code changes. Static reading of apps/fleet/test/** (vitest +
bun) for the six shard-hazard classes in the brief. Line refs at origin/main
9ee708d1. Findings cap 15; tier rule per #539 — GLM-OK vs CLAUDE-ONLY.

## Steps

1. Branch fix-944-shard-safety-sweep-47 off origin/main 9ee708d1 (done).
2. Findings doc docs/maintainability/2026-10-15-shard-safety-sweep-47.md:
   method, tier rule, findings table, one section per finding (file:line,
   shared state, failure mode sharded/alone, proposed fix), ruled-out section.
3. Commit both docs, push (LEFTHOOK=0 git push).
4. File one board issue per finding: test(GLM-OK): S47-Fn <short> — refs #944
   and #715 in body, never a closing keyword.
5. Open doc-only PR referencing #944, PR template Summary/Evidence/Merge
   Danger shape, no closing keywords.

## Verification

- Doc-only diff: git diff origin/main --stat shows only the two new .md files.
- bun run english-check — clean.
- bun run scripts/test-lies-check.ts — 0 findings.
- apps/fleet/scripts/merge-danger.ts — two-way.