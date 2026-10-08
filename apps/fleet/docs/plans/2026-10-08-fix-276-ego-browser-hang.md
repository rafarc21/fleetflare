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

## Addendum (fresh-context review round, same day): two blocking findings

A fresh-context review of the two fixes above found one blocking issue per
axis (Standards, Spec). Both are now fixed on this same branch.

### Fix 3: launch-timeout branch now kills the real OS process it abandons

Fix 2 above bounds `chromium.launch()` with a timeout, but on a genuine
TIMEOUT (not a plain launch rejection), `raceWithTimeoutOrReject()` only
abandons the JS *promise* — it has no way to touch the real OS process,
since (per its own doc comment) "there is no such thing as cancelling a
plain Promise." `browserPid` (the variable `shutdown()`'s own SIGKILL
backstop reads) was only ever assigned inside the launch chain's SUCCESS
`.then()`, so on a timeout it stayed `undefined` forever for that attempt —
even though the real Chrome process likely *did* spawn, just stuck
mid-handshake (this issue's own root-cause framing). Confirmed live: after
a launch-timeout test run against the unfixed code, the fixture's `sleep
infinity` process (what `hang-forever-chromium.sh` `exec`s into) was still
running in `ps`, long after the RPC call had already rejected cleanly.

Since fix 1 (the self-heal reset) now makes every later call retry
automatically, repeated timeouts under real container memory pressure (the
exact scenario issue #276 is about) would leak a fresh orphaned ~536 MB
Chromium process tree on *every* retry, unbounded — reintroducing the "must
not wedge the lead" problem this whole issue exists to close, through the
timeout path instead of the original hang.

Fixed in `daemon.ts`'s launch `.catch()`: on the TIMEOUT branch specifically
(distinguished from a plain launch rejection by comparing the error message
against the exact timeout message `raceWithTimeoutOrReject()` constructs —
a plain rejection means Playwright itself already knows the process
failed/exited and has presumably cleaned up after it), reuse the exact same
`findDirectChildPid(process.pid, { chromiumBinaryName: ... })` +
try/catch-wrapped `process.kill(pid, "SIGKILL")` mechanism `shutdown()`'s
own backstop already uses for this identical problem. Handles "nothing
spawned yet" gracefully (`findDirectChildPid` already returns `undefined`
for that case — no-op).

Regression test: `test/bun/ego-browser-launch-timeout.test.ts` now reads
the daemon's own pidfile after the timeout fires, scans its real direct
children via `findDirectChildPid()`, and asserts the process is genuinely
dead (fully reaped, or a zombie holding zero file descriptors — same
distinction `ego-browser-idle-shutdown-container.test.ts` already makes).
Confirmed RED against the unfixed code (the process stayed alive the whole
3s poll window, `ps` showing a live `sleep infinity` process after the test
run) and GREEN after the fix, with a live `ps` check after the targeted
test run showing zero leaked `sleep infinity` processes.

**Memory re-measurement:** the ~536 MB combined-RSS figure in the "Memory
measured" section above still describes one steady-state browser+task-space
tree; it was never wrong on its own. What this fix closes is the *compounding*
risk the original plan doc didn't yet know to re-measure: before this fix,
every retried timeout under memory pressure left its own ~536 MB orphaned
tree behind, stacking without bound across retries. That leak path is now
closed by the SIGKILL fix above — a repeated-timeout scenario now costs at
most one in-flight ~536 MB attempt at a time, the same as the already-measured
single-browser figure, not a multiple of it. No new steady-state measurement
was needed since the fix changes cleanup behavior, not what a single browser
costs while running.

### Fix 4: `skills/ego-browser/SKILL.md` DID make the inaccurate "fallback"
claim — correcting this plan doc's own earlier, wrong conclusion

The "Out of scope" section above concluded, from an earlier grep pass, that
no "Playwright MCP fallback"-shaped claim existed anywhere in this repo.
That conclusion was wrong — a more careful read of `SKILL.md` itself (not
just a grep for the literal phrase "fallback") found it directly: the
Install section asserted `ego-browser` is "backed by `playwright-core` and
the same Chrome-for-Testing binary at `/usr/local/bin/chromium` the
Playwright MCP server **already uses**" — an unconditional claim that a
Playwright MCP server is already registered and actively using that same
binary.

Checked `Dockerfile.studio` (~lines 200-238) and `studio-bringup.sh` for how
the Playwright MCP server is actually wired: it is genuinely conditional,
gated behind `STUDIO_MCP` (`studio-bringup.sh`'s known-server map wires up
`STUDIO_MCP="playwright"` → `bunx @playwright/mcp@latest`; `studio-bringup.sh`
reads `STUDIO_MCP` from the environment and only registers servers named in
it) — not always-registered. `SKILL.md`'s "already uses" phrasing claims a
coordination/shared-usage guarantee that does not hold whenever a studio's
`STUDIO_MCP` doesn't include `"playwright"`.

**Fix**: reworded that one sentence so it states the real, verified fact —
`ego-browser` uses its own Chrome-for-Testing binary directly, independent
of whether a Playwright MCP server happens to also be configured. Re-reading
the whole file afterward found one more sentence with the same shape, in the
`page.snapshot()` bullet ("since the MCP server (`bunx @playwright/mcp@latest`)
is already installed and produces this exact shape") — also reworded, since
`daemon.ts`'s `pageSnapshot()` calls playwright-core's own public
`page.ariaSnapshot()` directly and has no runtime dependency on an MCP server
being installed at all; it only happens to produce the same shape (same
underlying accessibility-tree serializer). Docs-only change, no test — verified
by re-reading the full file afterward (no other unconditional "already
uses"/"already installed" claim remains) and by `scripts/english-check.ts`
(which scans `SKILL.md` too) staying clean.
