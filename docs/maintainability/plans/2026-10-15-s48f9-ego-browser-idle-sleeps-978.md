---
# S48-F9 ego-browser idle sleeps — IDLE_MS 400/800→100, fixed 2000→derived 8x (refs #978, refs #945, refs #715)

`apps/fleet/test/bun/ego-browser-idle-shutdown*.test.ts`, measured 12.3s across three files by sweep 48 (F9); 7.4s after the cut on this container.

Each file overrides the daemon's idle window via `EGO_BROWSER_IDLE_MS`; the simulated-load sleeps derive from it, so lowering the window shortens both the real shutdown and the simulated gaps. The base file's fixed 2000ms "well past idle" wait was 5x the old 400ms window; it only needs to be comfortably past, so it derives from the window instead of hardcoding.

## Change
- base: `IDLE_MS` "400"→"100"; fixed `setTimeout(r, 2000)`→`setTimeout(r, WELL_PAST_IDLE_MS)` with `const WELL_PAST_IDLE_MS = 8 * Number(IDLE_MS)`.
- container: `IDLE_MS` "400"→"100" (SIMULATED_LOAD_MS = 3 * Number(IDLE_MS) stays derived).
- launch-failure: `IDLE_MS` "800"→"100" (SIMULATED_LOAD_MS stays derived); stale "more headroom" comment replaced (launch cost lands before the window arms — runEgoBrowser awaits proc.exited).
- Review fix (#317 race): base positive test proved the pid from append-only daemon.log instead of live pidfile/process state, matching the launch-failure test — a loaded host can deschedule the test past the 100ms window after round1 closes its only space.

## Verify
- `cd apps/fleet && bun test test/bun/ego-browser-idle-shutdown.test.ts test/bun/ego-browser-idle-shutdown-container.test.ts test/bun/ego-browser-idle-shutdown-launch-failure.test.ts` (4 pass, ~6-7s)
- `cd apps/fleet && npx tsc --noEmit -p test`
- `cd apps/fleet && bun run english-check`

## Boundaries
- Three test files only. No container/, src/, cli/. No closing keywords for #945/#715.
- Heavy gates: these three test files only; `tsc -p test` only. No full suite, no vite build.
---