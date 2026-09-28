# ego-browser idle shutdown: the real Chromium process outlives the daemon (board issue #36)

## Starting point: do not trust the prior hypothesis, reproduce fresh

Board #36 opened with a production measurement (image `d494bcca`): a real
script ran (`taskSpace` -> `goto` -> `finish({keep: []})`), Chrome went
0 -> 7 -> 4 processes, then 120 seconds passed with zero further invocations
and `chrome=4 daemon=1` stayed completely flat -- despite the default
60000ms idle window having two full chances to fire, and despite
`listTaskSpaces()` confirming `[]` (the zero-spaces gate was satisfied).
Setting `EGO_BROWSER_IDLE_MS=3000` changed nothing.

PR #44 (merged before this task started) fixed a real, separate bug:
`shutdown()` used to `await browserPromise` unguarded, which threw if
`chromium.launch()` had EVER failed, permanently blocking shutdown in that
one launch-failure edge case. The operator's own follow-up comment on #36
is explicit that this is NOT what they measured: their browser genuinely
started (7 processes), `goto` succeeded, `finish` returned a clean receipt
-- `browserPromise` resolved fine, so that `await` would never have thrown.
The comment's own instruction: reproduce the healthy-browser case first,
from first principles, before fixing anything.

A stray scratch-notes hypothesis from an earlier, interrupted attempt (not
trusted blindly, per the brief) proposed that this container's PID1 never
reaps zombie children, and that the daemon's own scheduler/shutdown logic
is fine. Treated as a hypothesis to test, not a given -- see below for how
it was actually confirmed, live, together with a second, independent bug
this same investigation surfaced.

## Reproduction 1 -- the healthy round trip, exactly as instructed

```
export EGO_BROWSER_HOME=/tmp/verify-36-b
EGO_BROWSER_IDLE_MS=2000 EGO_BROWSER_HOME=$EGO_BROWSER_HOME ego-browser nodejs -e '
  const t = await taskSpace("verify36b");
  await t.page("p1").goto("about:blank");
  console.log("FINISH:" + JSON.stringify(await t.finish({keep: []})));
'
```

Real daemon.log:

```
[2026-09-23T16:31:27.967Z] daemon started, pid 2438, socket /tmp/verify-36-b/daemon.sock
[2026-09-23T16:31:35.819Z] shutting down: idle for 2000ms with zero task spaces open
```

`daemon.log` DOES get a "shutting down" line, at the right time (idle
window fully respected). This alone already rules out outcome (a) for this
run -- the scheduler armed correctly and fired correctly. Watching the
daemon pid and its child Chromium pids at 0.5-1s resolution through and
past that point:

```
[16:31:35.515] daemon_pid=2438 state=S (sleeping)   chrome pid 2547 (main), 2550/2552 (crashpad), 2555/2556 (renderers) all alive
[16:31:36.141] daemon_pid=2438 state=Z (zombie)      2547 already gone; 2550/2552/2555/2556 now orphaned, reparented to PID 1, all state Z <defunct>
[16:31:36.761] daemon_pid=  (pidfile already rm'd)   same zombie chrome pids persist
...through 16:31:59.877 (24s later, last sample)      still `Z <defunct>`, never reaped
```

Checked again, independently, minutes later and against an EARLIER run's
own chrome zombies (from a completely separate invocation at 16:28):

```
$ ps -eo pid,ppid,stat,comm | grep -i 'chrome\|defunct'
    196       1 Zs   tmux: server <defunct>      <- unrelated, same container
   1699       1 Zs   bun <defunct>               <- the FIRST run's daemon, still zombied
   1752       1 Z    chrome_crashpad <defunct>   <- from the FIRST run, minutes old
   1754       1 Z    chrome_crashpad <defunct>
   1757       1 Z    chrome <defunct>
   1758       1 Z    chrome <defunct>
   2438       1 Zs   bun <defunct>               <- the SECOND run's daemon
   2550       1 Z    chrome_crashpad <defunct>
   2552       1 Z    chrome_crashpad <defunct>
   2555       1 Z    chrome <defunct>
   2556       1 Z    chrome <defunct>
```

And the honest distinguishing signal itself:

```
$ grep -E '^(State|FDSize|Threads):' /proc/2438/status /proc/2555/status /proc/1699/status
=== 2438 (daemon bun) ===   State: Z (zombie)   FDSize: 0   Threads: 1
=== 2555 (chrome renderer) === State: Z (zombie)   FDSize: 0   Threads: 1
=== 1699 (daemon bun, first run) === State: Z (zombie)   FDSize: 0   Threads: 1
```

**This is outcome (b), confirmed, not assumed.** `idle-shutdown.ts`'s
scheduler and `daemon.ts`'s `shutdown()` both ran correctly and on time.
The daemon process itself and every Chromium process it spawned genuinely
exited (state Z, `FDSize: 0`, no `VmRSS` line at all -- zero real resources
held, only the exit code pending pickup by a parent that never calls
`wait()`). `ps`/`pgrep` list a zombie identically to a live process (POSIX
`kill(2)`/`ps` semantics, not a bug) -- which is exactly what misled the
original production measurement into reading "chrome=4 daemon=1,
completely flat" as "still running" when it was actually "already dead,
just not yet reaped." This container's own PID1
(`/container-server/sandbox`, the same base image family --
`docker.io/cloudflare/sandbox:0.12.7` -- as the deployed studio image) does
not reap orphaned grandchildren. That reaping gap is a real base-image
concern, outside `apps/fleet/container/ego-browser/`'s reach (cannot touch
this container's PID1, per the task's own boundary), and, on its own,
harmless: a zombie holds nothing.

Evidence that this MERGED file's own author already knew this exact
distinction: `ego-browser-idle-shutdown.test.ts`'s `processAlive()` (from
#35, unchanged by this task) already treats `State: Z` as "not alive" for
precisely this reason, with a comment naming "some sandboxes (including
this one) don't reap promptly." That check only ever covered the DAEMON's
own pid, never the Chromium process underneath it -- see "the actual fix"
below.

## Reproduction 2 -- a second, independent, genuinely broken scheduler bug

Re-running the exact same style of reproduction at a SHORT idle window
(`EGO_BROWSER_IDLE_MS=400`, the value the pre-existing, merged
`ego-browser-idle-shutdown.test.ts` itself uses) surfaced something
different: the client's own FIRST request never got a response at all.

```
$ EGO_BROWSER_IDLE_MS=400 EGO_BROWSER_HOME=$EGO_BROWSER_HOME bun cli.ts nodejs -e '
    console.log("t0=" + Date.now());
    const t = await taskSpace(1);
    console.log("t1(taskSpace done)=" + Date.now());   // <- never printed
    ...
  '
t0=1790181558425
Error: ego-browser: daemon connection closed
    at close (.../client.ts:196:36)

daemon.log:
[2026-09-23T16:39:21.291Z] daemon started, pid 5776, socket .../daemon.sock
[2026-09-23T16:39:21.291Z] DEBUG scheduleIdleCheck called inFlight=0 spacesEmpty=true
[2026-09-23T16:39:21.959Z] shutting down: idle for 400ms with zero task spaces open
```

(temporary debug logging, reverted before committing -- shown here for the
record). No `taskSpace` request was ever received by the daemon before it
self-destructed. Root cause: `daemon.ts`'s ONE startup call to
`scheduleIdleCheck()` (right after `Bun.listen()`) armed with the same
`IDLE_MS` a short test/config sets, with no allowance for the real
spawn+connect overhead every caller pays -- `ensureDaemonAlive` (client.ts)
always spawns a fresh daemon and then IMMEDIATELY starts polling/connecting
to it, so "nobody has connected within `IDLE_MS` of boot" is not reliable
evidence "nobody ever will" the way it is once a real request has actually
been served at least once. At `IDLE_MS=400` in this loaded sandbox
(running a live claude agent concurrently), that overhead routinely
exceeds 400ms, so the pre-armed timer fires and kills the daemon out from
under the very client that spawned it.

This independently explains why the pre-existing, MERGED container-level
test (`ego-browser-idle-shutdown.test.ts`, from #35) was failing on
`origin/main` in this environment before any of this task's changes:

```
$ bun test test/bun/ego-browser-idle-shutdown.test.ts   # on origin/main, unmodified
 0 pass
 2 fail
error: expect(received).toBe(expected)
- ""
+ "Error: ego-browser: daemon connection closed\n    at close (.../client.ts:196:36)\n"
```

This is a real, separate defect (call it "bug 1"), squarely inside this
task's own file boundary (`idle-shutdown.ts`/`daemon.ts`), and it does NOT
match #36's own production narrative -- the operator's measured round trip
DID complete successfully (finish() returned a clean receipt), which bug 1
cannot produce (bug 1 kills the daemon BEFORE the first request is even
received). Fixed anyway, separately from #36's own root cause, because (i)
it is a genuine correctness gap and (ii) leaving it unfixed meant
`bun run bun-test` could not honestly be reported green.

## Root cause, precisely

- **#36's own root cause is outcome (b).** The scheduler
  (`idle-shutdown.ts`) and `daemon.ts`'s wiring of it are correct: the
  timer arms, the fire-time re-check is sound, `shutdown()` runs at the
  right time, and both the daemon process and the Chromium process it
  launched genuinely terminate. The apparent "still alive" the operator
  measured was `ps`/`pgrep` reading a harmless, already-dead zombie as if
  it were live -- a real base-image reaping gap, not a bug in this file
  boundary's own code, and, taken alone, not a real resource cost (a
  zombie holds `FDSize: 0`, no memory).
- **A second, independent defect ("bug 1")** exists in the SAME files: the
  startup call to `scheduleIdleCheck()` arms with the full, possibly very
  short `IDLE_MS`, racing the daemon's own first client under load. Fixed
  because it made the pre-existing container-level test fail in this
  environment and is a genuine correctness gap regardless of #36's own
  narrative.
- **A real, if narrow, resource-cost gap** does exist even under outcome
  (b): `shutdown()` trusted `browser.close()` blindly (per the task's own
  framing of what's worth hardening) -- a hung/slow close would be a real
  cost independent of whether the eventual zombie state is harmless. Fixed
  with a backstop (below), verified with a new, honest, container-level
  test.

## The fixes

### 1. Startup-race fix (`idle-shutdown.ts`, `daemon.ts`)

`IdleShutdown.schedule()` now takes an optional `overrideMs` used ONLY by
`daemon.ts`'s one startup call site:

```ts
scheduleIdleCheck(Math.max(IDLE_MS, STARTUP_GRACE_MS));   // at daemon boot
scheduleIdleCheck();                                       // every other call (handleRequest's finally)
```

`STARTUP_GRACE_MS = 5000` -- comfortably above the spawn+connect overhead
measured live in this loaded container (~1.2s worst case observed), and
comfortably below `client.ts`'s own `DAEMON_STARTUP_TIMEOUT_MS` (20000ms,
the ceiling a caller already accepts as reasonable for "spawn a fresh
daemon and connect to it"). The steady-state idle window (every re-arm
after a real request settles) is completely unaffected -- still exactly
the configured `IDLE_MS`, including a deliberately tiny test override.

TDD: two new unit tests in `ego-browser-idle-shutdown-scheduler.test.ts`
(`schedule(overrideMs)` arms with `overrideMs`; `schedule()` with no
argument is unaffected), watched red (`schedule(5000)` armed with 400, the
configured `idleMs`, instead) then green. The pre-existing, UNCHANGED
`ego-browser-idle-shutdown.test.ts` (from #35) also now passes reliably --
re-run 3 times in a row, all green (was 0/2 on `origin/main` beforehand).

### 2. The actual #36 fix: a real backstop + an honest test (`daemon.ts`)

`chromium.launch()`'s returned `Browser` has no public way to reach the OS
process it spawned (`browser.process` does not exist on that class --
confirmed against playwright-core's own `types.d.ts`, and live:
`browser.process is not a function`; that method only exists on
`BrowserServer`, from `launchServer()`). Tried `launchServer()` +
`chromium.connect()` back to its own `wsEndpoint()` first -- it hung
indefinitely in this exact container (confirmed live, three separate
attempts, always stuck immediately after `browser launched` with no
further progress) and adds a websocket hop this daemon has never needed
for anything else, so it was abandoned in favor of a simpler, purely
OS-observable approach that fits the same "honest signal" spirit as the
rest of this fix: scan `/proc` for the one process whose `PPid` is this
daemon's own pid. Confirmed live that Chromium's main browser process is
always a direct child of whatever spawned it (crashpad's own handler
process is the one exception -- it deliberately double-forks/reparents
itself to PID 1 so it survives the browser crashing; that is an
intentional, independent, near-zero-cost helper, not the resource this
backstop cares about).

`shutdown()` now runs `browser.close()` (bounded by `raceWithTimeout()`,
see the follow-up review section below), then -- unconditionally, so it
backstops the launch-failure path too (`browserPid` stays `undefined`
there, so it is a no-op) -- sends `SIGKILL` to the captured pid regardless
of whether `close()` reports success. `SIGKILL` on an already-exited
process throws `ESRCH`, but a zombie (exited but not yet reaped by its
parent) still occupies a valid PID table entry, so `kill(2)` on a zombie
succeeds as a no-op -- `ESRCH` is only thrown once the pid is fully reaped
and its slot recycled. Either way this is the expected, common case once
`close()` already did its job, not an error.

### Follow-up: post-merge review findings on this fix (board #36)

A fresh-context review of the merged fix found two real gaps, fixed in a
follow-up commit:

1. **No actual timeout on `browser.close()`.** The `.finally()` gating the
   SIGKILL backstop and the `rmSync`/`process.exit()` cleanup only ran once
   `close()`'s promise SETTLED -- a hung `close()` (unresponsive CDP
   connection, wedged renderer, anything short of an outright rejection)
   meant that `await` never returned, so none of that cleanup ever ran:
   the daemon sat resident forever, reproducing the original bug via the
   fix meant to close it. Fixed with a `raceWithTimeout()` helper
   (`process-reap.ts`) that bounds the wait to `CLOSE_TIMEOUT_MS` (5000ms)
   regardless of whether `close()` ever settles; the SIGKILL backstop and
   cleanup now run unconditionally afterwards either way.
2. **`findDirectChildPid()` had no process-identity check.** It returned
   the first `/proc` entry (arbitrary `readdirSync` order) whose `PPid`
   matched the daemon's own pid, with no check of the process's actual
   name -- if the scan ran during crashpad's brief window as a direct
   child (before it double-forks/reparents to PID 1), this could return
   crashpad's pid instead of the real browser's. Fixed by filtering every
   candidate through its real `/proc/<pid>/comm`, excluding anything with
   "crashpad" in the name, and preferring a candidate whose comm contains
   the configured chromium binary's basename when more than one survives;
   any remaining tie breaks on lowest pid (earliest-spawned direct child).

New container-level test,
`test/bun/ego-browser-idle-shutdown-container.test.ts`: runs a real daemon
+ real Chromium (`taskSpace` -> `goto` -> `finish({keep:[]})`), reads the
real OS pid off a new `daemon.log` line (`browser launched, pid <n>`),
waits for idle shutdown, then asserts the REAL distinguishing signal board
#36 asked for -- `/proc/<pid>/status`'s `FDSize` (a zombie holds `FDSize:
0`; a process still doing real work holds a non-zero `FDSize`) combined
with the `State` field, not "gone from `ps`" (which this container cannot
reliably produce, and which is the exact measurement that misled the
original production report). Genuinely red-first: before this fix, the
test cannot even locate a pid to check (`daemon.log` never had a "browser
launched, pid" line, and `browser.process` did not exist as a fallback
either) -- a real, structural RED, not a contrived one.

Also caught mid-implementation by this same TDD test: an early version of
the startup-race fix (fix 1) referenced `STARTUP_GRACE_MS` before it was
defined, crashing the daemon's own startup call with a silent
`uncaughtException` that every OTHER existing test happened not to cover
(a request-triggered `scheduleIdleCheck()` call never touches that
constant). The new test caught it immediately.

## Why this doesn't touch `ego-browser-persistence.test.ts`

Confirmed: `git diff origin/main -- apps/fleet/test/bun/ego-browser-persistence.test.ts`
is empty on this branch. Nothing about either fix changes when a space is
considered open/closed, what `finish()` returns, or how a context/page is
resolved -- `daemon.ts`'s own browser-acquisition and shutdown internals
changed; the RPC surface, the registry, and the persistence contract did
not.

## Does this close #36?

**Yes, for the root cause actually measured and reproduced**: the
scheduler and shutdown logic are proven correct (fresh reproduction,
timestamps above), and the real Chromium OS process is now proven to
genuinely terminate via an honest, container-level, `/proc`-based signal
that survives this container's own zombie-reaping gap -- the exact thing
the operator's own `ps`/`pgrep`-based measurement could not distinguish.

**What remains, honestly, and is explicitly out of this task's file
boundary**: the underlying reaping gap in this base image's PID1
(`docker.io/cloudflare/sandbox:0.12.7`, same family as the deployed studio
image) is not fixed and cannot be from
`apps/fleet/container/ego-browser/` -- zombie process-table entries will
still accumulate over a studio's lifetime. On their own they are close to
free (`FDSize: 0`, no memory), but a long-lived studio doing many
browser sessions will still slowly consume PIDs from the container's PID
space, which is a real, separate, base-image-level concern worth a future,
narrowly-scoped task against `Dockerfile.studio`/the base image choice --
not something this file boundary can address.

## Verification, run fresh on this branch (see PR for the exact tail)

```
bun run check      tsc --noEmit x5
bun run test        vitest run
bun run bun-test    bun test test/bun test/studio.files.test.ts test/studio.studio-blueprint.test.ts
```
