---
# S48-F4 ego-browser-launch-timeout — Playwright 30s graceful-close window is the burn (refs #972, refs #945, refs #715)

`apps/fleet/test/bun/ego-browser-launch-timeout.test.ts`, measured 30.9s by sweep 48 (F4), single test, 31.77s re-measured on this branch pre-fix.

## Measured mechanism (this container, 2026-10-15)

The 500ms launch bound itself is proven fast — `elapsed < 5000` passes at ~4s wall
(daemon spawn+connect ~1.2s + 500ms bound + shutdown). The burn is Playwright-core's
own launch-timeout cleanup, re-verified line by line in
`node_modules/playwright-core/lib/coreBundle.js`:

- `_launchProcess`'s catch path runs `closeOrKill(DEFAULT_PLAYWRIGHT_TIMEOUT = 30000)`.
- `closeOrKill` races `gracefullyClose()` (sends `Browser.close` over the pipe — the
  hung fixture never answers) against a 30s timer, then falls back to `kill()`.
- `kill()`/`killProcess()` does `process.kill(-pid, "SIGKILL")` — the whole process
  group. Playwright spawns chromium `detached: true`, so the fixture shell is its own
  group leader; the fixture's forked `sleep infinity` grandchild shares that pgrp.
- Live second-by-second poll of the pidfile pids: both alive at t=29.8s, leader gone
  and grandchild a zombie at t=30.3s. The tree death is real, it just can't happen
  before ~30s, and only Playwright decides when.

Grandchild becomes a zombie (PPid 1, State Z, FDSize 0) because this container's PID1
never reaps; `isGenuinelyTerminated()` already treats zombie+FDSize 0 as dead, same
distinction the sibling `ego-browser-idle-shutdown-container.test.ts` makes.

## Fix

Only knob Playwright-core exposes for the 30s window is the undocumented-but-real
`__testHookBrowserCloseTimeout` launch option (read directly by
`closeOrKill(options.__testHookBrowserCloseTimeout || DEFAULT_PLAYWRIGHT_TIMEOUT)`;
`_validateLaunchOptions` spreads unknown keys through, so it survives validation).
Pass it from daemon.ts's `chromium.launch()` under a new env knob, same
override-via-env convention as EGO_BROWSER_LAUNCH_TIMEOUT_MS:

- `EGO_BROWSER_LAUNCH_CLOSE_KILL_MS`: when set, daemon.ts passes
  `__testHookBrowserCloseTimeout: Number(...)` into the launch options — AND the
  test also sets `PWTEST_UNDER_TEST=1` in the daemon's env (inherited through
  runEgoBrowser), because playwright-core's client→server channel validator
  (`tObject`, coreBundle.js, gated on `isUnderTest()`, which reads
  `PWTEST_UNDER_TEST` at module init) strips `__testHook*` launch options
  without it. Production behavior unchanged (env unset → Playwright's 30s
  default).
  Measured live in this container: no knob → tree dead t=30563ms; knob alone →
  t=30562ms (stripped, no effect); knob + `PWTEST_UNDER_TEST=1` → t=1533ms.
- Test sets it to 1000ms: the graceful window burns 1s instead of 30, then the tree
  still dies by the SAME group-SIGKILL path production uses. The test still proves
  the whole tree dies — via Playwright's own kill, not the finally SIGKILL.
- `TREE_KILL_WAIT_MS` 40000 → 10000: real kill is group SIGKILL (instant once
  `closeOrKill`'s fallback fires); 10s is >10x the observed post-kill reap time and
  still holds a wide margin under a loaded container.
- Per-test timeout 60000 → 20000.
- Comments in test + daemon.ts updated to say the knob shrinks Playwright's own
  graceful-close window, keeping the burn explanation for whoever reads git blame.

Expected wall: ~31s → ~5-6s.

## Change
- `apps/fleet/container/ego-browser/daemon.ts`: read
  `EGO_BROWSER_LAUNCH_CLOSE_KILL_MS`, pass `__testHookBrowserCloseTimeout` into
  `chromium.launch()` when set. ~6 lines + comment.
- `apps/fleet/test/bun/ego-browser-launch-timeout.test.ts`: set the env knob
  (1000), TREE_KILL_WAIT_MS 40000→10000, per-test timeout 60000→20000, comment
  updates.

## Steps
1. Plan doc commit + push (this commit).
2. daemon.ts knob + test updates; run the single test file; time it.
3. tsc -p container + tsc -p test (sequential).
4. english-check.

## Verify (sequential, one gate at a time)
- `cd apps/fleet && bun test test/bun/ego-browser-launch-timeout.test.ts`
  (expect 1 pass, wall ~5-6s, under 10s)
- `cd apps/fleet && npx tsc --noEmit -p container`
- `cd apps/fleet && npx tsc --noEmit -p test`
- `cd apps/fleet && bun run english-check`

## Boundaries
- Two files: daemon.ts (env knob only, no behavior change when unset) + the one test.
  No src/, no cli/, no other test files.
- No closing keywords for #972/#945/#715 anywhere (commit messages say "refs").
- Heavy gates: the single test file is a REAL browser-launch test (spawns daemon +
  fixture processes) but runs one test in ~5-6s; run it alone, never alongside the
  full suite or a build. tsc projects sequential, one at a time.
