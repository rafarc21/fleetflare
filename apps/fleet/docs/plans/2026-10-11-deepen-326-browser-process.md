# Deepen #326: browser process ownership behind `BrowserProcess`

Refs https://github.com/rafarc21/fleetflare/issues/326
(F11, docs/maintainability/2026-10-10-deep-modules-sweep-2.md)

## Problem
daemon.ts owns the launch -> record pid -> bounded close -> SIGKILL
sequence inline. Helpers (findDirectChildPid, raceWithTimeout) live in
process-reap.ts "so they are unit-testable", but the sequence that calls
them is untestable in the entrypoint -- verified only by log-grepping
live tests. Files split by testability, not by knowledge.

## Design
New class `BrowserProcess` in process-reap.ts (exported factory
`createBrowserProcess`), owning:
- lazy `get()`: single-flight promise; on rejection resets so the next
  `get()` launches again; logs `getBrowser: attempting chromium launch`
  once per real attempt; on success records pid via injected
  `findPid(parentPid, {chromiumBinaryName})` and logs
  `browser launched, pid <n>|unknown`.
- `close(budgetMs)`: if a launch ever happened, awaits
  `browserPromise.then(b => b.close()).catch(() => {})` bounded by
  raceWithTimeout(promise, budgetMs); then SIGKILLs the recorded pid via
  injected `killFn` (try/catch, ESRCH fine). Never throws.

Injected deps (constructor opts): `launch()` (returns Promise<Browser>),
`log()` (line string -> void), `findPid`, `killFn`, plus optional
`setTimeoutFn` for raceWithTimeout. daemon.ts wires real chromium.launch,
its own log(), real findDirectChildPid, process.kill.

daemon.ts keeps: CHROMIUM_PATH / LAUNCH_TIMEOUT_MS env reads, the
`browser = await browserProcess.get()` call sites, `shutdown()` calls
`await browserProcess.close(CLOSE_TIMEOUT_MS)`. Same log lines, byte for
byte -- live tests grep them (ego-browser-launch-self-heal.test.ts,
ego-browser-idle-shutdown-container.test.ts).

## Characterization tests first (test/bun/ego-browser-process.test.ts)
1. launch rejects -> get() rejects; SECOND get() calls launch again
   (attempts counter = 2). Log line per attempt.
2. concurrent get() x2 while first launch pending -> ONE launch call.
3. close(budget) with fake launch-resolved browser whose close() never
   settles -> returns within budget (fake setTimeout fired), then killFn
   called with recorded pid.
4. close() with launch never called -> no launch, no kill.
5. get() success -> pid recorded via findPid and logged.
All with fake launcher/kill/log; no real browser, no /proc, real timers
only where bounded.

## Steps
1. RED: new test file, all 5 tests fail (module missing).
2. GREEN: BrowserProcess in process-reap.ts; daemon.ts rewired;
   live suites still green.
3. Full bun ego-browser suite + tsc -p container.

## Verification (record)
- bun test test/bun/ego-browser-process.test.ts (new, 5 pass)
- bun test test/bun/ego-browser-launch-self-heal.test.ts
  test/bun/ego-browser-idle-shutdown-container.test.ts
  test/bun/ego-browser-idle-shutdown-launch-failure.test.ts
  test/bun/ego-browser-launch-timeout.test.ts (4 live pass)
- bun test test/bun/ego-browser-process-reap.test.ts (12 pass, existing)
- bun run check (one heavy gate, run alone)
- bun run english-check
