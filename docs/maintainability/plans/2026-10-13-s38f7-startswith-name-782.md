# S38-F7 plan — name the exact-prefix re-check, not "startsWith", issue #782

Census: sweep 38 (test names vs assertions), finding S38-F7. Spec: issue #782,
sweep doc docs/maintainability/2026-10-13-test-names-vs-assertions-sweep-38.md:86.
Test-only — no production code changes.

## Finding

state.test.ts:70 — it("LIKE's `_` wildcard hands back a same-length decoy;
startsWith is what rejects it"). The body proves the decoy is absent from the
output, but never isolates WHICH comparison killed it. The name promises a
mechanism ("startsWith") the body does not exercise: another digit/suffix
filter could produce the same output. scanStateTaskKeys's impl
(apps/fleet/src/state.ts:123) is an exact-prefix `startsWith` re-check plus
digit/colon grammar — the name should claim only what the assertions show.

## Fix (both clauses of the issue's "or", one is cheap)

1. Add a second assertion that isolates the prefix compare: seed a row that
   PASSES the LIKE (same length, `_` matches) but differs from the prefix at
   a position INSIDE the prefix — e.g. true prefix `ns:acme-org/we_bsite:`
   with decoy `ns:acme-org/wxbsite:8`. Note: that decoy has same length and
   the `x` sits under the pattern's `_`, so LIKE returns it; the exact-prefix
   re-check kills it while every suffix rule (digits after last colon) would
   ACCEPT it — proving the re-check is what rejects.
2. Retitle to name the mechanism actually exercised:
   "LIKE's `_` wildcard hands back a same-length decoy; the exact-prefix
   re-check rejects it".

## TDD steps

1. Branch from origin/main: fix-782-s38f7-startswith-name.
2. RED: add assertion `expect(rows).toEqual(...)` expected to include the
   new decoy-rejected shape BEFORE writing it — run the new test file,
   confirm the decoy-rejection assertion actually runs (it asserts absence,
   so RED = verify with a seeded decoy that the scan WOULD keep if the
   re-check were missing — assert via a control: seed decoy with prefix
   `ns:acme-org/wxbsite:` scan and see it returned). Simplest honest RED:
   temporarily assert `rows` contains the decoy (it must fail), then write
   the real assertion.
3. GREEN: real test code (title, comment, assertions) as in Fix above.
4. Run: `cd apps/fleet && bun run vitest run test/state.test.ts` — expect pass.
5. Commit plan doc + test together? No — plan doc first commit, test second.
   Push after EVERY commit: `LEFTHOOK=0 git push -u origin fix-782-s38f7-startswith-name`.

## Verification gates (one heavy gate at a time)

- `cd apps/fleet && bun run vitest run test/state.test.ts` (touched test only)
- `bun run test-lies-check` (repo check, cheap)
- `bun run english-check` (repo check, cheap)
- Do NOT run full `bun run test` (full vitest suite = heavy gate; CI owns it).
- Do NOT run `bun run check` (repo-wide tsc = heavy gate; test file has no
  type changes but CI owns it).

## Risk

Test-only, door two-way. Blast radius: a wrong edit could make state.test.ts
fail or over-claim in the other direction — caught by the run above.
