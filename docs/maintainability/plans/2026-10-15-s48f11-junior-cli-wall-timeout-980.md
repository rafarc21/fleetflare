# S48-F11 — junior-cli wall-timeout test: shorten fake delay + timeout

Issue: https://github.com/rafarc21/fleetflare/issues/980
Sweep: docs/maintainability/2026-10-15-slow-tests-sweep-48.md

## Problem
`apps/fleet/test/bun/junior-cli.test.ts` "wall timeout -> exit 5" measured 3.4s.
Fake server delays 3000ms; client `--timeout 1` (1s) fires first. The delay only
needs to comfortably exceed the timeout to guarantee the timeout path is taken.

## Change
One test, two values (lines 105-106):
- `delayMs: 3000` -> `delayMs: 1500`
- `--timeout "1"` -> `--timeout "0.5"` (parses to 0.5s; `AbortSignal.timeout(500)`)

Halves the wall time. Rest of the file's time is 10 real `junior.sh` subprocess
runs (inherent, unchanged).

## Verification
- `cd apps/fleet && bun test test/bun/junior-cli.test.ts` — all tests pass, the exit-5 test stays green.
- `cd apps/fleet && npx tsc --noEmit -p test`
- `cd apps/fleet && bun run english-check`