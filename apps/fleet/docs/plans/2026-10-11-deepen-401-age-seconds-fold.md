# Plan — #401 S5-F3 export ageSeconds, fold 5 inline copies

Refs https://github.com/rafarc21/fleetflare/issues/401. Sweep-5 finding F3
(docs/maintainability/2026-10-11-deep-modules-sweep-5.md).

## Problem

`ageSeconds` (cli/readiness-format.ts) is private while the identical
NaN-to-0, floored arithmetic is re-derived inline in 5 more places:
formatCheckedAt (readiness-format.ts) and formatWipCell x2,
formatWipInspectLines x2 (cli/wip-format.ts). Six spellings of one rule:
unparseable reads 0/absent, never NaN, never negative.

## Steps

1. RED: direct ageSeconds tests in test/cli.fleet.test.ts (valid ISO = 7,
   unparseable = 0, future ISO = 0); import fails while helper private.
2. Export ageSeconds; fold formatCheckedAt's copy (its NaN guard stays —
   unparseable prints verbatim).
3. wip-format.ts: import it, fold all 4 copies; each site's NaN guard
   stays (verbatim line or fall-through); only the
   `Math.max(0, Math.floor((now-ms)/1000))` arithmetic is replaced.
4. Gates, serially, one at a time: vitest run test/cli.fleet.test.ts;
   bun test test/bun/fleet-ls-wip.test.ts; bun run check;
   bun run scripts/english-check.ts.

## Boundaries

- ~15 code lines + one describe block. No new module, no signature change,
  no fixture edits; existing tests pass unchanged.
- Heavy: `bun run check` (tsc x5) runs ALONE; suite runs minutes-scale,
  serial. No full vitest, no bundler build.
- Two-way door: pure code.
