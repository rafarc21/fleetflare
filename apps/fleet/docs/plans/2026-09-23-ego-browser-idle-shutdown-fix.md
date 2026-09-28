# ego-browser idle shutdown: launch-failure gap in #35's fix (board issue #32)

## The bug (found by review, after #35 already merged)

`daemon.ts`'s `shutdown(reason)` did `const b = await browserPromise; await
b.close().catch(() => {})`. If `chromium.launch()` ever fails (broken/missing
binary, sandbox denial, etc.), `getBrowser()`'s `browserPromise` stays
permanently rejected. `shutdown()` only runs once idle with zero task spaces
open, which means any earlier `getBrowser()` call has already settled by
then — so a previously-failed launch is exactly the settled-but-rejected
case `await browserPromise` hits, and it throws straight out of `shutdown()`.
`idle-shutdown.ts` calls `onIdle` as `void this.onIdle()` (fire-and-forget),
so that rejection is never awaited — it becomes an unhandled rejection,
logged and dropped by daemon.ts's own top-level handler, and execution never
reaches `rmSync(pidFile)`, `rmSync(sockFile)`, or `process.exit(0)`. Net
effect: a daemon whose browser failed to launch even once sits resident
forever once idle, reproducing #32's own "daemon never exits" bug in exactly
the one edge case #35's fix didn't cover.

## The fix

```ts
await browserPromise.then((b) => b.close()).catch(() => {});
```
`.then(close)` only runs on a successful launch; `.catch(() => {})` swallows
either a launch failure or a close failure either way, so `shutdown()` always
reaches the `rmSync` calls and `process.exit(0)` regardless of browser state.

Also added: `chromium.launch()`'s `executablePath` is now overridable via
`EGO_BROWSER_CHROMIUM_PATH` (same override-via-env style as `paths.ts`'s
`EGO_BROWSER_HOME`), purely so the regression test below can force a
deterministic launch failure without needing a genuinely broken Chromium
install.

## Regression test

`test/bun/ego-browser-idle-shutdown-launch-failure.test.ts`, same real-daemon
e2e style as `ego-browser-idle-shutdown.test.ts`: points
`EGO_BROWSER_CHROMIUM_PATH` at a nonexistent binary, calls `taskSpace(1)`
(which awaits the now-rejected `browserPromise` and throws before touching
the registry, so the space count stays zero), then asserts the daemon still
removes its pidfile/sockfile and exits within the idle window. Confirmed red
against the pre-fix `shutdown()` (daemon never exits, test times out waiting
for the pidfile to disappear) and green after the fix.

`test/bun/ego-browser-persistence.test.ts` is untouched by this change.
