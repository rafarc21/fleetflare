# S38-F7 plan — name the exact-prefix re-check, not "startsWith", issue #782

Census: sweep 38 (test names vs assertions), finding S38-F7. Spec: issue #782,
sweep doc docs/maintainability/2026-10-13-test-names-vs-assertions-sweep-38.md:86.
Test-only — no production code changes.

## Finding

state.test.ts:70 — "LIKE's `_` wildcard hands back a same-length decoy;
startsWith is what rejects it". Body proves decoy absent from output, never
isolates WHICH comparison killed it. scanStateTaskKeys (apps/fleet/src/state.ts:123)
runs an exact-prefix re-check plus digit/colon grammar — a suffix-clean decoy
that passes every other filter is what distinguishes the re-check.

## Fix (both clauses of the issue's "or")

1. Add second assertion: seed `ns:acme-org/wxbsite:8` (differs from true prefix
   `ns:acme-org/we_bsite:` only at the `_` position, inside the prefix; suffix
   is a clean bare number, so every suffix rule would ACCEPT it) — its absence
   proves the exact-prefix re-check is the killer.
2. Retitle: "LIKE's `_` wildcard hands back a same-length decoy; the exact-prefix
   re-check rejects it".

## TDD steps

1. Branch fix-782-s38f7-startswith-name from origin/main.
2. RED: probe first — scan prefix `ns:acme-org/wxbsite:` alone to pin the row's
   parsed shape (`{ repo: "", number: 8, ... }`, authz depth). Then write the
   new assertion with the decoy EXPECTED PRESENT — run, must fail.
3. GREEN: real assertion (decoy absent), run `cd apps/fleet && bun run vitest run test/state.test.ts`, must pass.
4. Commit test; push after every commit.

## Verification gates (one heavy gate at a time)

- `cd apps/fleet && bun run vitest run test/state.test.ts` (touched test only)
- `bun run test-lies-check` and `bun run english-check` from apps/fleet (cheap)
- Full `bun run test` and `bun run check`: heavy, CI owns them. Never run here.

## Risk

Test-only, door two-way. Blast radius: wrong edit could make state.test.ts
fail — caught by the touched-test run above.
