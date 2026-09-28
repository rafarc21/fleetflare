# ego-browser daemon idle shutdown (board issue #32)

## The bug, as measured

`apps/fleet/container/ego-browser/daemon.ts` never exits on its own. Measured
2026-09-22 in `demosite-life--maestro`: closing the only open task space
(`finish({keep: []})`, returning `{"retained":[],"closed":["p1"]}` — the space
really did close) left `pgrep -fc chrome` reporting 9 resident processes
minutes later. There is no idle timer, no `unref`, nothing in the file that
ever calls `process.exit`. A headless Chrome sits resident in a `standard-2`
container for the rest of that studio's life after a single browser call,
forever, even with zero open task spaces.

## The tension, and the shape chosen

The daemon exists specifically so task spaces survive across separate
`ego-browser nodejs` invocations (`registry.ts` + `client.ts`'s
`ensureDaemonAlive`, proved by `test/bun/ego-browser-persistence.test.ts`). A
naive "exit N ms after the last request, full stop" timer would kill an open
space mid-use: a later `taskSpace(7)` would find nothing and silently break
the entire reason this shim's daemon exists.

Issue #32 offers two acceptable shapes:

1. Shut down only when **zero task spaces remain open**, after an idle window
   with no invocation.
2. Persist space/page state to disk and restore it on the next invocation, so
   shutdown is transparent even with spaces open.

This change takes **option 1**. Option 2 is strictly more work for a benefit
this codebase doesn't need: nothing about the ego-browser contract (or any
known caller) requires a space to survive the daemon itself exiting, and
restoring a live page's URL is not the same as restoring its session (cookies
survive via context storage state at best; in-page JS state, open
websockets, in-flight uploads, etc. do not) — option 2 would need to be
honest about that loss and this issue doesn't need to take it on. Option 1
has a clean invariant instead: **finished means nothing left to preserve**,
so shutting down at that point loses nothing a caller could have observed
staying around.

## Design

- `idle-shutdown.ts` (new, no Playwright import — pure, same spirit as
  `registry.ts`): exports `resolveIdleMs(env)` (mirrors `paths.ts`'s
  `EGO_BROWSER_HOME` parsing style: `env.EGO_BROWSER_IDLE_MS?.trim()`, parsed
  as a number, default `60000`) and an `IdleShutdown` class holding the
  re-armable timer, injectable `setTimeout`/`clearTimeout` plus the two state
  predicates (`spacesEmpty`, `inFlightZero`) and the `onIdle` callback — kept
  free of `Bun`/`playwright-core` so it's fast/deterministic unit-testable
  without spinning up a daemon or browser.
- `daemon.ts` wires it up: `registry.list().length === 0` is `spacesEmpty`,
  a new in-flight request counter (incremented at the top of
  `handleRequest`, decremented in a `finally`) backs `inFlightZero`, and
  `onIdle` does the actual shutdown (close the browser if one was ever
  launched, `rmSync` both `paths.pidFile` and `paths.sockFile` — matching the
  existing `rmSync(paths.sockFile, { force: true })` style already at the
  top of the file — log the reason, `process.exit(0)`).
- `scheduleIdleCheck()` is called in exactly two places: once right after
  the daemon finishes its own startup (covers "spawned but never actually
  used"), and at the end of every `handleRequest`, wrapped so it runs whether
  the handler resolved or the existing catch-and-report-over-RPC path fired
  — any request can be the one that took the space count to zero
  (`space.finish`) or away from zero (`taskSpace`), so every request needs to
  re-arm.
- `IdleShutdown.schedule()`: clears any pending timer first. Only arms a new
  one if `spacesEmpty()` reads true **right now** (a request that leaves
  spaces open never needs a live timer at all). The timer's fire-time
  callback re-checks `spacesEmpty()` again (state may have changed in the
  idle window) — if spaces reappeared, it's a no-op; a later
  `scheduleIdleCheck()` call already will have rescheduled correctly for the
  new state.

### The race this guards against

A request that's going to land on a nonzero space count (e.g. `taskSpace`
creating a brand new space) is asynchronous — `await browser.newContext()`
alone is a real await point. A previously-armed idle timer can fire in that
window: after `registry.list().length` still reads 0 (nothing committed to
the registry yet) but before the in-flight `taskSpace` call finishes and
pushes the count to 1. Checking `spacesEmpty()` alone at fire time is not
enough to close this — it can still read `0` truthfully at that instant.

Fix: an in-flight request counter, incremented at the very start of
`handleRequest` and decremented in a `finally` at the very end (so it's
accurate whether the handler throws or resolves). The fire-time check
requires **both** `spacesEmpty()` and `inFlightZero()`. If either is
nonzero, the fired timer just returns — no shutdown, and deliberately no
reschedule from inside that callback either: the in-flight request's own
`handleRequest` will call `scheduleIdleCheck()` in its own `finally` once it
completes, and by then the registry reflects the real, settled state.

## Test plan — both directions, mandatory

1. **Fast/deterministic unit test** (`test/bun/ego-browser-idle-shutdown-scheduler.test.ts`):
   drives `IdleShutdown` directly with fake timers and fake state predicates
   — no daemon, no browser, no real socket. Covers: schedules when spaces
   are empty; does not schedule when spaces are non-empty; fire-time re-check
   suppresses shutdown if spaces became non-empty since scheduling; fire-time
   re-check suppresses shutdown if a request is still in-flight even with
   zero spaces (the exact race above); `resolveIdleMs` default + override
   parsing, matching `paths.ts`'s own env-parsing tests in spirit.
2. **End-to-end, direction 1 (does shut down)**
   (`test/bun/ego-browser-idle-shutdown.test.ts`): spawn a real daemon via
   the CLI with a tiny `EGO_BROWSER_IDLE_MS` (300-500ms) and an isolated
   `EGO_BROWSER_HOME`, create a task space, `finish({keep: []})` it (zero
   spaces left), wait past the idle window, then assert the daemon process is
   actually gone: pidfile removed and the pid no longer signalable
   (`process.kill(pid, 0)` throws).
3. **End-to-end, direction 2 (does NOT shut down)**: same tiny idle window,
   create a task space, do **not** finish it, wait well past the idle window,
   then assert the daemon is still alive and reachable — a subsequent RPC
   call through it (e.g. `listTaskSpaces()` still reporting the open space)
   succeeds. This is the test that would catch a naive "always exit after N
   ms" regression that direction 1 alone can't distinguish from the real fix.

`test/bun/ego-browser-persistence.test.ts` is left completely unedited. It
never calls `finish()` between its two rounds, so the space stays open for
the whole test and the zero-spaces gate never arms regardless of idle
duration — this is exactly the invariant that makes option 1 safe for that
test.

## client.ts

Read `ensureDaemonAlive`/`isAliveNow`/`probeConnect` in `client.ts`: they
already treat a missing pidfile or an unreachable socket as "not alive" and
spawn a fresh daemon on the next call. A graceful self-exit that removes its
own pidfile and sockfile before `process.exit(0)` produces exactly that
state — no changes needed there, confirmed by reading the code and by the
new end-to-end tests reusing `ensureDaemonAlive` unmodified (via `call()`/the
CLI) to reconnect after a shutdown.
