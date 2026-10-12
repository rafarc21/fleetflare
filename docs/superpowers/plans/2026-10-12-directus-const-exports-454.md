# Plan — S6-F8 directus const exports: un-export the five test-only caps (task #454)

Parent: https://github.com/rafarc21/fleetflare/issues/454. Sweep: docs/maintainability/2026-10-12-deep-modules-sweep-6.md §F8. Branch `fix-454-directus-const-exports` off origin/main. Option (a) per issue recommendation + #407 precedent (commit 0a42747): un-export the five caps whose only external importer is a test. Cap VALUES, schema, fetch behavior unchanged. Two-way door.

## Sites (verified: only src/directus/{client,card}.ts and their two test files reference any of the five)

1. apps/fleet/src/directus/client.ts:52 `export const DIRECTUS_MAX_BYTES` → `const`
2. client.ts:68 `export const REQUIREMENTS_PAGE_LIMIT` → `const`
3. apps/fleet/src/directus/card.ts:47 `export const CARD_MAX_LINES` → `const`
4. card.ts:56 `export const CARD_DECISION_LIMIT` → `const`
5. card.ts:65 `export const CARD_DECISION_FETCH_LIMIT` → `const`
DIRECTUS_TIMEOUT_MS (client.ts:62) stays exported — prod-used control case (client.ts:121).

## Test edits (RED-first: tests first, they must still pass by asserting behavior, not imports)

test/directus.client.test.ts:
- Line 5: drop `DIRECTUS_MAX_BYTES, REQUIREMENTS_PAGE_LIMIT` from the import.
- :147 `expect(q().get("limit")).toBe(String(REQUIREMENTS_PAGE_LIMIT));` → `.toBe("200")` (behavior: wire limit is 200).
- :152 `Array.from({ length: REQUIREMENTS_PAGE_LIMIT }, ...)` → `{ length: 200 }` — truncation reported at 200 rows.
- :199 `"x".repeat(DIRECTUS_MAX_BYTES)` → `"x".repeat(262_144)` (oversized body → the documented throw at :200 `/exceeds the 262144-byte cap/`).

test/directus.card.test.ts:
- Lines 3-4: drop `CARD_MAX_LINES, CARD_DECISION_LIMIT, CARD_DECISION_FETCH_LIMIT` from the import.
- :51, :177, :262 `toBeLessThanOrEqual(CARD_MAX_LINES)` → `toBeLessThanOrEqual(20)` (§7 budget is the literal 20).
- :86 `` `OPEN DECISIONS (${CARD_DECISION_LIMIT} of 4` `` → `` `OPEN DECISIONS (3 of 4` `` (renders 3).
- :254 `expect(seen[0]).toBe(CARD_DECISION_FETCH_LIMIT);` → `.toBe(20)` (read pulls 20).
- :255 `expect(CARD_DECISION_FETCH_LIMIT).toBeGreaterThan(CARD_DECISION_LIMIT);` → DELETE — it asserted a relation between two private values; the honest-overflow behavior is already covered by the "3 of 4" case at :86.
- card.ts:41-47 doc comment on CARD_MAX_LINES says "Asserted by test against the fullest card" — still true (test counts lines), no comment change needed beyond the un-export.

## TDD order

Commit 1 (RED): test edits above only. Tests must still PASS at commit 1 — they assert behavior via literals, which the still-exported consts also satisfy. This is a characterization-first sweep task (F8's own rule), so "RED" here = the suites green on test-literal form, proving the tests no longer need the exports.
Commit 2 (GREEN): the five un-exports in src. Same suites + provision test stay green; `bun run check` proves no other file imported them (tsc fails on any stray import).

## Verify (one heavy gate at a time, flock)

From apps/fleet:
- `bun run vitest run test/directus.client.test.ts test/directus.card.test.ts test/directus.provision.test.ts`
- `flock /tmp/fleet-gate.lock bun run check`
- `flock /tmp/fleet-gate.lock bun run english-check`

## Boundaries

- Touch ONLY: src/directus/client.ts, src/directus/card.ts, test/directus.client.test.ts, test/directus.card.test.ts, the plan doc.
- No new files, no new deps, no value changes, no schema/fetch changes.
- Comments 1-2 lines WHY only. Push after every commit (`LEFTHOOK=0 git push -u origin fix-454-directus-const-exports`).
