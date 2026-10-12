# Atomic rearm counter (refs #452)

Sweep-6 F6 (docs/maintainability/2026-10-12-deep-modules-sweep-6.md, branch sweep-415-glm-maintainability-6). Tier GLM-OK, bounded. Pure call-site swap, two-way door (src/index.ts is not in scripts/merge-danger.ts ONE_WAY_GLOBS).

## Problem
src/index.ts:203-204 increments rearmKey via `Number((await getFlag(...)) ?? "0") + 1` then `setFlag` — the read-then-write shape src/state.ts's incrementCounter (state.ts:42-56) was built to replace. Its doc comment (:25-41) documents the measured race (PR #9 BLOCKER F1: 20 concurrent calls vs cap of 3 all succeeded). Only reader: shouldAlert's `attempts >= 2`.

## Change
1. `apps/fleet/src/index.ts`:
   - import: `import { getFlag, setFlag, incrementCounter } from "./state";`
   - :203-204 becomes `const attempts = await incrementCounter(env.DB, key, now);`
   - clearRearm (watchdog.ts:79) untouched — still setFlag "0". alertedKey set at :227 untouched.
2. New characterization test in `apps/fleet/test/index.test.ts` scheduled() watchdog describe:
   - two concurrent `worker.scheduled()` ticks with same stale task → rearmKey flag "2"
   - old shape loses (both read "0", both write "1"); incrementCounter guarantees distinct totals
3. RED first: test added before the swap; run; watch fail; commit; push.

## Boundaries
- ~5 changed lines + 1 test. Key names, value encoding, alert policy untouched.
- Heavy gates: `bun run check` (full tsc, 5 tsconfigs), `bun run english-check` — once each, end, one at a time, never alongside test run (11.65 GiB ceiling).
- Targeted suites: test/index.test.ts + test/watchdog.test.ts + test/state.test.ts.
- Two-way door: revert restores read-then-write pair.

## Check
cd apps/fleet && ./node_modules/.bin/vitest run test/index.test.ts test/watchdog.test.ts test/state.test.ts; bun run check; bun run english-check — each exit 0.

## Steps
1. Branch `rearm-atomic-counter-452` off origin/main; commit this plan; push (LEFTHOOK=0)
2. RED concurrent-tick test → run → fail → commit → push
3. Swap index.ts call site → suites green → commit → push
4. check + english-check one at a time → commit any fixes → push
