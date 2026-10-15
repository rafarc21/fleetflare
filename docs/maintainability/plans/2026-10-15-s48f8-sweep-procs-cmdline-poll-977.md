# S48-F8 sweep-procs — 200ms settle sleeps -> poll /proc/<pid>/cmdline (refs #977, refs #945, refs #715)

`apps/fleet/test/bun/sweep-procs.test.ts`, measured 4.6s by sweep 48 (F8); 10.0s on this container (2026-10-15, real /proc walk + two sweep-script spawns).

Two `Bun.sleep(200)` settle waits (:86, :134) give the decoy processes time to exec so their argv/cwd/environ are readable before the sweep runs. Sweep's default was "record as acceptable"; the optional fix — poll `/proc/<pid>/cmdline` until non-empty — removes both fixed sleeps without flake risk.

## Change
- `apps/fleet/test/bun/sweep-procs.test.ts:86`: `await Bun.sleep(200)` -> per-decoy `waitFor(cmdline non-empty, 2000, 20)` asserted true.
- `:134`: same poll for the sibling/exact decoys.
- Add `import { waitFor } from "./helpers/poll";` (codebase's own shared poll helper).

## Why not "acceptable, no action"
The fixed 200ms is kernel-settle insurance; a decoy that hasn't exec'd yet is a flaky miss. Polling cmdline bounds the wait at "actually readable" instead of "200ms elapsed", so the same proof (argv/cwd/environ readable) holds with no fixed sleep.

## Steps
1. Plan doc commit + push.
2. Edit + run the suite. No writable RED test (fixed-sleep constant, not a branch); the 2-test suite is the guard.

## Verify (sequential, one gate at a time)
- `cd apps/fleet && bun test test/bun/sweep-procs.test.ts` (expect ~10s, 2 pass)
- `cd apps/fleet && npx tsc --noEmit -p test`
- `cd apps/fleet && bun run english-check`

## Boundaries
- One file: two sleep sites -> polls, one import. No container/, src/, cli/.
- No closing keywords for #945/#715.
- Heavy gates: this one test file only; `tsc -p test` only. No full suite, no vite build.