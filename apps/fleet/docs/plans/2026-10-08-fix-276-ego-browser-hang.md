# Fix ego-browser's permanent wedge after one launch failure (board issue #276)

## The bug (confirmed by reading the real code)

`daemon.ts`'s `getBrowser()`:

```ts
let browserPromise: Promise<Browser> | undefined;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({...}).then((browser) => {...; return browser;});
  }
  return browserPromise;
}
```

If `chromium.launch()` ever REJECTS (bad binary, container resource/memory
pressure mid-startup, anything), `browserPromise` becomes a REJECTED promise
— which is still truthy. A rejected `Promise` object is not `undefined`, so
`if (!browserPromise)` never fires again: every later call to `getBrowser()`,
for the rest of that daemon process's life, immediately returns the SAME
stale rejected promise, replaying the identical old failure forever. No
retry, no self-healing. This exactly matches the issue's reported symptom:
once one launch attempt fails (e.g. during a moment of container memory
pressure), the daemon is permanently wedged for browser use until something
kills it (a full container recycle) — which nobody realizes is the fix,
since every subsequent `ego-browser` call just repeats "could not verify"
forever, with no visible sign a fresh attempt was ever tried.

Separately, there is no bounded timeout on `chromium.launch()` itself. Its
sibling call, `shutdown()`'s `browser.close()`, already has one
(`CLOSE_TIMEOUT_MS`, via `raceWithTimeout()` in `process-reap.ts`) — added
specifically because a hung `close()` must never block shutdown forever. The
same risk exists on the launch side: a Chrome process that starts but never
completes its CDP handshake (a real-world failure mode under container
resource pressure) would hang `getBrowser()` indefinitely, with no bound and
no clear error. This directly matches the issue's own acceptance criterion:
"No hang ever: bounded timeout + clear error if browser cannot start."

## The two fixes

1. **Self-healing reset.** In `getBrowser()`, attach a `.catch()` to the
   launch promise that resets `browserPromise` back to `undefined` before
   re-throwing. The NEXT call then gets a fresh attempt instead of replaying
   a stale failure; the CURRENT call's own awaiter still sees the real
   error, unchanged. A new log line (`"getBrowser: attempting chromium
   launch"`), emitted once per actual re-entry into the `if (!browserPromise)`
   branch, makes the fix externally provable: a launch failure's error
   message is textually identical whether it's a genuinely fresh attempt or
   a stale replay (same bad path, same `ENOENT`), so only an independent log
   line distinguishes "a second real attempt happened" from "the same
   rejection got handed back twice."

2. **Bounded launch timeout.** `process-reap.ts` gets a sibling to
   `raceWithTimeout()` — `raceWithTimeoutOrReject()` — that races a promise
   against a timer the same way, but REJECTS with a clear, actionable
   message on timeout instead of silently resolving (the existing
   `raceWithTimeout()` deliberately only bounds `close()`'s wait and doesn't
   care about success/failure; a hung `launch()` must become an honest
   failure the caller can act on, not a silent "assume it worked"). `getBrowser()`
   wraps `chromium.launch()` in this, bounded by `LAUNCH_TIMEOUT_MS`
   (default 30000ms, the same order of magnitude as `CLOSE_TIMEOUT_MS` and
   Playwright's own documented default launch timeout), overridable via
   `EGO_BROWSER_LAUNCH_TIMEOUT_MS` (same override-via-env convention as
   `EGO_BROWSER_CHROMIUM_PATH`, so tests don't have to wait out 30+ real
   seconds). On timeout, the error names the bound and points at a container
   resource/memory check; `browserPromise` resets the same way as fix 1 so a
   future call can retry.

## Memory measured

`free -h` in this container: ~11Gi total, ~900Mi used, ~9.8Gi free — matches
the documented ~11.6 GiB ceiling. A real `taskSpace()` + `page.goto()` call
against the real `/usr/local/bin/chromium` spawned 6 live processes under
the daemon's own child (1 main browser process, 2 crashpad handlers, 1
zygote renderer helper, 1 gpu-process, 1 network-service utility process, 1
storage-service utility process, plus 2 renderer processes for the single
open page — see the RPC method table in `daemon.ts` for what a single
`taskSpace`+`goto` actually spins up). Measured combined RSS across that
whole process tree (main browser + every direct/indirect child, via `ps -eo
pid,ppid,rss,comm`): **~536 MB** for one browser with one task space and one
open page. This is a small fraction of the ~9.8 GiB free in this container,
and nowhere near the documented wedge-causing ceiling on its own — the
historical wedge risk here is a daemon that never retries after one bad
launch (fix 1) or one that hangs forever waiting on a launch that will never
complete (fix 2), not steady-state Chromium RSS itself.

## Out of scope: the "Playwright MCP fallback" claim

The issue's acceptance bullet "House rules / blueprint text match reality
(remove fallback claim if not real)" refers to language ("Playwright MCP is
registered as ego-browser's fallback") that does not exist anywhere in this
repo — a full-repo grep for "Chrome for Testing", "Playwright MCP", and
"agent-browser" finds only `skills/qa/SKILL.md`, which documents a different,
generic `agent-browser`-based QA skill unrelated to this specific claim. The
claim itself lives in the maestro's own private brief-template tail text
(outside `rafarc21/fleetflare`), so there is nothing in this repo to fix for
that bullet — it needs a private ops-repo correction, not a code change here.

## Image change

`apps/fleet/container/ego-browser/daemon.ts` and `process-reap.ts` ship
inside the studio container image (`Dockerfile.studio` bakes
`/opt/fleet/ego-browser/` from this source). `apps/fleet/container/**` is a
one-way-door glob in `merge-danger.ts`'s `ONE_WAY_GLOBS` — this PR is an
image change; the maestro batches the rollout window.

## Review

Per the maestro's own dispatch on issue #276: TDD (RED test proving the
stale-replay bug first, then green), narrow `bun test` runs only while
iterating, full suite + gate left to the lead.
