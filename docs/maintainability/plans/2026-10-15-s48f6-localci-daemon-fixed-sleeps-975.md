# S48-F6 localci-daemon — fixed sleeps 3500ms→2000ms, 1000ms→poll (refs #975, refs #945, refs #715)

`apps/fleet/test/bun/localci-daemon.test.ts`, measured 5.3s by sweep 48 (F6).

(a) `:132` `await Bun.sleep(3_500)` proves a typo'd `LOCALCI_POLL=1` yields exactly one poll (the daemon's 30s floor). 2000ms carries the same proof: a 1s poll would log 2+ `gh pr list` lines by then, the floor keeps it 1. Cut to 2000ms.

(b) `:140` `await Bun.sleep(1_000)` waits for the first daemon instance to lock before probing a second. Poll the calls log for the first `gh pr list` instead — `poll 0` runs before the daemon's first sleep.

## Change
- `apps/fleet/test/bun/localci-daemon.test.ts:132`: `Bun.sleep(3_500)` → `Bun.sleep(2_000)`, comment updated.
- `:140`: `await Bun.sleep(1_000)` → `await waitFor(...)` on `calls.log` containing `gh pr list` (helpers/poll.ts, timeout 5000, interval 50), asserted true.
- Add `import { waitFor } from "./helpers/poll";`.

## Steps
1. Plan doc commit + push.
2. Edit + run the suite. No writable RED test (fixed-sleep constant, not a branch); the 9-test suite is the guard.

## Verify (sequential, one gate at a time)
- `cd apps/fleet && bun test test/bun/localci-daemon.test.ts`  (expect ~3s, 9 pass)
- `cd apps/fleet && npx tsc --noEmit -p test`
- `cd apps/fleet && bun run english-check`

## Boundaries
- One file: two sleep sites + one import + two WHY comments. No container/, src/, cli/.
- No closing keywords for #945/#715.
- Heavy gates: this one test file only; `tsc -p test` only. No full suite, no vite build.