# Deepen ego-browser daemon endpoint + idle: `DaemonEndpoint` + `IdleShutdown.track(fn)` (#325)

Issue: https://github.com/rafarc21/fleetflare/issues/325. From deep-modules
sweep 2 (F10): https://github.com/rafarc21/fleetflare/blob/main/docs/maintainability/2026-10-10-deep-modules-sweep-2.md
Tier **GLM-OK**. Behavior-preserving. Characterization tests at interface
first. One module per PR. Refs #259, never closes. PR merges at image window
(container code) — flag to maestro in envelope; this studio never deploys.

Verified not already on main: no `DaemonEndpoint`, no `.track(` anywhere;
protocol spread + caller-owned counter exactly as the sweep describes.

## Problem

Two siblings in daemon.ts's hot path:

1. Pid/sock file protocol spread across 5 places, 2 files:
   client.ts:39-45 (isAliveNow), :110-111 (stale cleanup in spawn-winner),
   daemon.ts:516 (rm sock before listen), :568 (write pid after listen),
   :208-209 (rm both on shutdown). Whoever edits one must know all 5.
2. IdleShutdown takes an `inFlightZero` predicate, but the caller
   (daemon.ts) owns the counter (:152, :521, :535), the schedule call in
   every finally (:536), the startup grace (:581), and a pass-through
   wrapper scheduleIdleCheck (:220-222). The module hid nothing: the
   knowledge "how to drive the idle window" is smeared into daemon.ts.

Skill step: deep-modules ICA §1 (shallow siblings callers must sequence) +
CD deletion test — delete DaemonEndpoint and the protocol reappears across
client.ts+daemon.ts; that is a deep module earning its keep.

## Solution (behavior-preserving)

### A. `container/ego-browser/endpoint.ts` — class `DaemonEndpoint`

Owns the pid/sock/spawn-lock file protocol behind one constructor
`new DaemonEndpoint(paths: EgoBrowserPaths)`. Methods (all move verbatim
logic, same node:fs calls, same order, no behavior change):

- `probeConnect(): Promise<boolean>` — client.ts:26-37 verbatim.
- `isAlive(): Promise<boolean>` — client.ts:39-45 (was isAliveNow).
- `claimSpawnLock(): boolean` — client.ts:56-64.
- `removePidAndSockFiles(): void` — the two rmSync force:true lines now in
  client.ts:110-111 AND daemon.ts:208-209 (same body both places today).
- `writePid(pid: number): void` — daemon.ts:568's writeFileSync.
- `removeSockFile(): void` — daemon.ts:516's rmSync (pre-listen cleanup).

client.ts builds one module-level `endpoint = new DaemonEndpoint(resolvePaths())`-
shaped seam: `ensureDaemonAlive` keeps its exact loop structure, calling
endpoint methods. `call()` keeps `resolvePaths()` per call (paths must stay
per-call for EGO_BROWSER_HOME isolation in tests) — so client.ts
constructs `const endpoint = new DaemonEndpoint(paths)` locally inside
ensureDaemonAlive; daemon.ts constructs one at top level. Client exports
unchanged: `ensureDaemonAlive`, `call` (api.ts imports `call` only).

### B. `IdleShutdown.track(fn)` — counter moves inside the class

- `IdleShutdownOptions.inFlightZero` DELETED. Class gains private
  `inFlight = 0`.
- New method `track<T>(fn: () => Promise<T>): Promise<T>`: increments,
  runs fn, finally decrements + calls `this.schedule()`. First call may
  pass `overrideMs` — no: track(fn) always uses plain schedule(); the
  startup call keeps using `schedule(graceMs)` directly. track() re-arms
  with the steady-state idleMs — identical to today's finally-schedule().
- daemon.ts: delete `inFlightRequests` (:152), the `+=`/`-=` lines
  (:521, :535), `scheduleIdleCheck` wrapper (:220-222, keep the two
  remaining call sites' comments trimmed accordingly); handleRequest
  body becomes `return this`-less plain `await this`-free:
  `idleShutdown.track(async () => { ...existing body minus counter/finally
  schedule... })`. Startup call :581 becomes `idleShutdown.schedule(Math.max(IDLE_MS, STARTUP_GRACE_MS))`.
- `schedule(overrideMs?)` stays public (startup grace + tests use it).

### C. What deliberately does NOT move

- `processAlive`/Bun.connect details move INTO DaemonEndpoint (they are
  the protocol). DAEMON_STARTUP_TIMEOUT_MS/poll loop stay in client.ts —
  spawn-retry POLICY, not file protocol.
- Log lines byte-identical: `daemon started, pid N, socket S`,
  `shutting down: ...`, `browser launched, pid N` untouched. Live tests
  grep them (launch-failure.test.ts:93,105, spawn-race.test.ts:45-47,
  container.test.ts:46-50).

## Tests first (TDD, characterization at the interface)

Extend `test/bun/ego-browser-idle-shutdown-scheduler.test.ts` (already
fake-clock driven) with a `describe("IdleShutdown.track")`:

1. request in flight blocks shutdown: track(() => never-resolving-promise)
   armed timer before, fireAll → idleFired 0.
2. idle after last request fires once: track resolves → timer re-armed
   with configured idleMs (pendingDelays [400]); fireAll → fired once,
   not twice (track's finally-schedule replaced the manual one).
3. track with throwing fn: counter released, schedule still called
   (pendingCount 1), rejection propagates to caller.
4. concurrent tracks: 2 pending → fireAll → blocked (in-flight not zero);
  both resolve → next fireAll fires once.
5. track ignores no override: armed delay is always plain idleMs.

New `test/bun/ego-browser-endpoint.test.ts` (bun lane, real temp dirs via
`mkdtempSync` like cli-helpers' makeEgoBrowserHome, real node:fs):

1. isAlive false on empty home (no pidFile).
2. isAlive false on stale pidFile (pid of a dead process: spawn `sleep 0`,
   await exit, write its pid).
3. isAlive true needs pid ALIVE AND socket connectable — write own live
   pid + no socket → false (proves probeConnect is part of isAlive).
4. claimSpawnLock: first call true, second EEXIST false, release (rm)
   makes it claimable again.
5. removePidAndSockFiles removes both, force:true (absent files no-throw).
6. writePid writes pidFile readable back.
7. removeSockFile removes sock only, leaves pidFile.

RED: these reference DaemonEndpoint/track before they exist (compile
fail). GREEN: refactor lands, all pass; scheduler's OLD 7 schedule tests
keep passing UNCHANGED except the inFlightZero predicate lines — they are
deleted with the option, so those tests construct without it (mechanical,
not behavioral). Live log-grep tests unchanged, must stay green.

## Steps

1. Backend Dev: RED — scheduler track block + endpoint.test.ts. Commit,
   push branch `deepen-325-ego-browser-endpoint-idle`.
2. Backend Dev: GREEN — endpoint.ts, client.ts, daemon.ts, idle-shutdown.ts
   per above. `bun test test/bun/ego-browser-endpoint.test.ts
   test/bun/ego-browser-idle-shutdown-scheduler.test.ts` then
   `bun test test/bun/ego-browser-idle-shutdown.test.ts
   test/bun/ego-browser-idle-shutdown-launch-failure.test.ts
   test/bun/ego-browser-daemon-spawn-race.test.ts
   test/bun/ego-browser-idle-shutdown-container.test.ts
   test/bun/ego-browser-launch-self-heal.test.ts
   test/bun/ego-browser-launch-timeout.test.ts
   test/bun/ego-browser-smoke.test.ts test/bun/ego-browser-rpc.test.ts
   test/bun/ego-browser-persistence.test.ts
   test/bun/ego-browser-registry.test.ts
   test/bun/ego-browser-unimplemented.test.ts` (real Chromium needed for
   some — run in apps/fleet, watch ceiling: one bun test at a time, never
   parallel with another gate). Commit, push.
3. Gates one at a time, flock /tmp/fleet-gate.lock: `bun run check`
   (includes container tsc -p container), `bun run english-check`,
   `bun run test-lies-check` (0 findings).
4. Code Reviewer fresh context (reads git diff itself). Route findings per
   delivery-standards review-fix loop; max 2 rounds.
5. QA Engineer: no browser surface for a library refactor — verify via
   bun test evidence + smoke test output; browser gate N/A, say so.
6. PR: two-way (pure refactor; no ONE_WAY_GLOBS path — note in PR body
   that apps/fleet/container/** IS a one-way glob path by merge-danger.ts,
   classifier will mark one-way: door per classifier = one-way, correct,
   note it). Envelope comment on issue, done record
   /workspace/.fleet/done/325.json.

## Boundaries

Files: apps/fleet/container/ego-browser/{endpoint.ts (new), client.ts,
daemon.ts, idle-shutdown.ts}, apps/fleet/test/bun/{ego-browser-endpoint.test.ts
(new), ego-browser-idle-shutdown-scheduler.test.ts}. cli.ts, api.ts,
paths.ts, registry.ts, process-reap.ts, rpc.ts: untouched.
Behavior-preserving: every log line, file operation order, wire format
byte-identical; interface change is additive (track method, new class).
EGO_BROWSER_HOME test isolation must survive (client.ts keeps per-call
resolvePaths → per-call DaemonEndpoint).

Out of scope: F11 (BrowserProcess) — do not touch getBrowser/shutdown
internals; F12 (TaskSpaceRecord.finish).
