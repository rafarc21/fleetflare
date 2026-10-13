# Plan — S38-F6: retitle the stopped-studio rateLimited test (task #781, refs #741)

One-line-rename task. Sweep-38 finding (docs/maintainability/2026-10-13-test-names-vs-assertions-sweep-38.md, S38-F6): the test at apps/fleet/test/cli.fleet.test.ts:1285 is titled "#403 table: a stopped studio ignores a rateLimited record entirely", but "entirely" claims more than the single assertion proves — only `formatActivity(s, NOW)` returning "—" for the stopped studio's activity cell. The record's absence from other fields is proven by the row-level twin at :1504 (lead/leadSince/limitResetsAt), not by this test. The row-level twin's identical title stays: there the three-field assertion earns "entirely".

Fix: retitle to the sweep's proposed name — "#403 table: a stopped studio renders — for its activity regardless of a rateLimited record". Assertion unchanged. No production code touched.

## Steps

1. Plan doc (this file).
2. Retitle the `it(...)` at apps/fleet/test/cli.fleet.test.ts:1285 (the only content change).
3. Gates, one at a time: `cd apps/fleet && bun test test/cli.fleet.test.ts`, then `bun run english-check`.
4. PR: one test-file rename, two-way door, closes #781.

## Verification

- The `it` title at :1285 contains no "entirely"; assertion line `expect(formatActivity(s, NOW)).toBe("—")` unchanged.
- Row-level twin at :1504 keeps its original title and its three-field assertion.
- `cd apps/fleet && bun test test/cli.fleet.test.ts` — all pass.
