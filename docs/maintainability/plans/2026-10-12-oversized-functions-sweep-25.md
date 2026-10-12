# Plan — sweep 25: oversized functions in apps/fleet/cli (#589)

Doc-only sweep, no code changes. Findings measured by TS AST at origin/main 30bceb7.

## Steps

1. Branch sweep-589-oversized-functions off origin/main (done).
2. Measure all 257 top-level functions in apps/fleet/cli via TS compiler API (AST, not brace-count). Threshold: body >120 lines. Found 4: cmdAttach fleet.ts:2729 (232), runReap reap.ts:250 (179), ensure orca-workspace.ts:620 (155), main ff.ts:448 (135). All GLM-OK lane.
3. Write docs/maintainability/2026-10-12-oversized-functions-sweep-25.md — 4 findings, each: file:line, length, natural seams, proposed split with names, test coverage of each seam.
4. Commit both docs, push branch (`LEFTHOOK=0 git push -u origin sweep-589-oversized-functions`).
5. File follow-up issues per batch, `deepen(GLM-OK): S25-Fn <short>`, refs #589, never closing keywords.
6. Open doc-only PR referencing #589, no closing keywords.

## Verification

- No build/test gate: doc-only diff. `git diff origin/main --stat` = 2 new .md files only.
- Every file:line ref re-checked against working tree before commit.
- `cd apps/fleet && bun run scripts/english-check.ts` exit 0 (CI gate on repo).
