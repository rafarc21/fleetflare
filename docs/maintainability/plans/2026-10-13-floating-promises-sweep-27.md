# Plan — sweep 27: floating promises in apps/fleet src+cli (#641)

Doc-only sweep, no code changes. Scan at origin/main 8dd1778.

## Steps

1. Branch 641-floating-promises-sweep-27 off origin/main (done).
2. Scan every promise-dropping position in apps/fleet/src + cli (container excluded) via TS compiler API: 11 passes — expression-statement, void-operand, logical/comma/ternary arms, condition position, stored-then-unconsumed, async callbacks under forEach/map/on/addEventListener/setTimeout, promise-as-arg, template spans, object props, dep-interface members, name-driven statement calls; hand-read the any-typed residue. Result: zero floating promises.
3. Write docs/maintainability/2026-10-13-floating-promises-sweep-27.md — method, the zero, evidence trail, annotated-not-findings.
4. Commit both docs, push branch (LEFTHOOK=0).
5. No follow-up issues: nothing to fix. File none.
6. Open doc-only PR referencing #641, no closing keywords.

## Verification

- No build/test gate: doc-only diff. git diff origin/main --stat = 2 new .md files only.
- Every file:line ref re-checked against working tree before commit.
- cd apps/fleet && bun run scripts/english-check.ts exit 0 (CI gate on repo).
