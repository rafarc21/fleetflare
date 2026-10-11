#!/usr/bin/env bun
/**
 * The long-lived process that makes ego-browser's persistence contract
 * possible: it owns the real playwright-core Browser/BrowserContext/Page
 * objects and the spaceId+label registry, and outlives every individual
 * `ego-browser nodejs` invocation. Spawned on demand by client.ts
 * (ensureDaemonAlive) -- never run directly by a user script. The RPC
 * method handlers live in handlers.ts (same extraction spirit as
 * registry.ts/idle-shutdown.ts/process-reap.ts); this file is process
 * wiring only.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { chromium, errors, type Browser, type BrowserContext, type Page as PwPage } from "playwright-core";
import { resolvePaths } from "./paths";
import { encodeMessage, MessageFramer, type RpcRequest } from "./rpc";
import { Registry } from "./registry";
import { IdleShutdown, resolveIdleMs } from "./idle-shutdown";
import { findDirectChildPid, raceWithTimeout } from "./process-reap";
import { buildMethods, type MethodDispatch } from "./handlers";

const paths = resolvePaths();
mkdirSync(paths.home, { recursive: true });

function log(line: string): void {
  try {
    appendFileSync(paths.logFile, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Logging must never be why the daemon dies.
  }
}

process.on("uncaughtException", (err) => log(`uncaughtException: ${err instanceof Error ? err.stack : err}`));
process.on("unhandledRejection", (err) => log(`unhandledRejection: ${err instanceof Error ? err.stack : err}`));

// findDirectChildPid() (board #36, and the crashpad-identity-check
// follow-up finding on the original fix) now lives in process-reap.ts --
// see its own doc comment there for the full reasoning. Kept out of
// daemon.ts so it (and shutdown()'s bounded-wait helper, raceWithTimeout())
// are unit-testable on their own with injected fakes, same spirit as
// idle-shutdown.ts/registry.ts.

// ---------------------------------------------------------------------------
// Browser: launched once, lazily, on the first call that actually needs it
// (not every daemon start needs a browser -- e.g. a bare listTaskSpaces()
// on an empty registry doesn't), and reused for the daemon's whole life.
// ---------------------------------------------------------------------------
// Overridable via EGO_BROWSER_CHROMIUM_PATH, same override-via-env style as
// paths.ts's EGO_BROWSER_HOME -- lets a test point this at a deliberately-
// bogus path to force a deterministic launch failure (see
// ego-browser-idle-shutdown-launch-failure.test.ts, board issue #32's
// launch-failure gap) without needing a real broken Chromium install. Its
// basename also doubles as findDirectChildPid()'s positive-match hint (see
// process-reap.ts) for telling the real browser process apart from a
// same-generation crashpad handler.
const CHROMIUM_PATH = process.env.EGO_BROWSER_CHROMIUM_PATH?.trim() || "/usr/local/bin/chromium";

// Board #276 hardening: bound chromium.launch() explicitly instead of
// relying on Playwright's default launch timeout (180000ms -- 3 minutes of a
// wedged getBrowser() and every RPC queued behind it). Passed straight to
// launch()'s own `timeout` option, so on expiry Playwright kills the whole
// Chromium process group itself (zygote/renderer/crashpad included) -- no
// separate race or pid hunt here. Overridable via
// EGO_BROWSER_LAUNCH_TIMEOUT_MS, same override-via-env convention as
// EGO_BROWSER_CHROMIUM_PATH, so a test can use a short bound (see
// ego-browser-launch-timeout.test.ts).
const LAUNCH_TIMEOUT_MS = Number(process.env.EGO_BROWSER_LAUNCH_TIMEOUT_MS?.trim()) || 30000;

let browserPromise: Promise<Browser> | undefined;
/** The real Chromium OS pid, once known -- see process-reap.ts's
 * findDirectChildPid(). Read by shutdown()'s SIGKILL backstop and logged
 * for ego-browser-idle-shutdown-container.test.ts (board #36) to check the
 * honest zombie-vs-alive signal against post-shutdown. */
let browserPid: number | undefined;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // Logged once per actual re-entry into this branch (never on a cache
    // hit) -- board #276's own repro signal: a launch failure's error
    // message is textually identical whether it comes from a genuinely
    // fresh attempt or a stale replayed rejection (same bad path, same
    // ENOENT), so this log line is the only externally-observable proof a
    // second real attempt ever happened. See
    // ego-browser-launch-self-heal.test.ts.
    log("getBrowser: attempting chromium launch");
    browserPromise = chromium
      .launch({
        executablePath: CHROMIUM_PATH,
        headless: true,
        // Running as root in a container with no chrome-sandbox setuid
        // helper configured -- standard for exactly this situation (same
        // reasoning Dockerfile.studio documents for the Playwright MCP
        // server's own chromium install).
        args: ["--no-sandbox"],
        timeout: LAUNCH_TIMEOUT_MS,
      })
      .then((browser) => {
        browserPid = findDirectChildPid(process.pid, { chromiumBinaryName: basename(CHROMIUM_PATH) });
        log(`browser launched, pid ${browserPid ?? "unknown"}`);
        return browser;
      })
      .catch((err) => {
        // Board #276: a rejected Promise is still truthy, so leaving
        // browserPromise set to it would wedge `if (!browserPromise)` shut
        // forever -- every later call would replay THIS SAME rejection,
        // with no new launch ever attempted again. Resetting it here lets
        // the NEXT call (not this one -- the throw below still rejects the
        // promise this specific caller is awaiting) get a fresh attempt.
        browserPromise = undefined;
        if (err instanceof errors.TimeoutError) {
          // Playwright already killed the process group; just make the
          // error actionable for whoever is staring at a wedged studio.
          throw new Error(
            `ego-browser: chromium failed to start within ${LAUNCH_TIMEOUT_MS}ms -- likely container resource/memory pressure, check ${paths.logFile} and the studio's available memory`,
            { cause: err },
          );
        }
        throw err;
      });
  }
  return browserPromise;
}

const registry = new Registry<PwPage, BrowserContext>();

// The RPC method table (its 27 handlers) lives in handlers.ts, extracted so
// tests can drive it with injected fakes -- same spirit as the
// registry.ts / idle-shutdown.ts / process-reap.ts extractions. The table's
// real type is the strictly keyed map; handleRequest indexes it by the raw
// wire string, hence the one-time cast to the dispatcher view.
const methods: MethodDispatch = buildMethods({ registry, getBrowser });

// ---------------------------------------------------------------------------
// Idle shutdown (board issue #32): the daemon must exit once idle with ZERO
// task spaces open (finished means nothing left to preserve), but must
// NEVER exit while a space is still open -- that is the entire persistence
// contract this daemon exists for (see
// docs/plans/2026-09-23-ego-browser-idle-shutdown.md). Scheduling logic
// itself lives in idle-shutdown.ts, decoupled from Bun/Playwright so it's
// unit-testable on its own; this is just the real wiring.
// ---------------------------------------------------------------------------
const IDLE_MS = resolveIdleMs();

// Startup-only grace period, separate from IDLE_MS (board #36's live
// reproduction -- see the plan doc): daemon.ts's one startup call to
// scheduleIdleCheck() used to arm with the raw, possibly very short IDLE_MS
// a test/config sets, even though "nobody has connected within IDLE_MS of
// boot" is not reliable evidence "nobody ever will" the way it is once a
// real request has actually been served at least once -- ensureDaemonAlive
// always spawns a daemon and then IMMEDIATELY starts connecting to it, so
// there is always real spawn+connect overhead to account for. 5000ms is
// comfortably above the overhead measured live in a loaded container
// (under ~1.2s) and comfortably below client.ts's own
// DAEMON_STARTUP_TIMEOUT_MS (20000ms, the ceiling a caller already accepts
// as reasonable for "spawn a fresh daemon and connect to it").
const STARTUP_GRACE_MS = 5000;

// Incremented at the very start of handleRequest, decremented in a
// `finally` at the very end -- guards the race where a request that will
// soon push registry.list().length away from zero (e.g. taskSpace creating
// a brand-new space) is genuinely in flight, past the point the registry
// still reads empty but not yet past the point it isn't. See the plan doc.
let inFlightRequests = 0;

// Follow-up review finding on the original #36 fix: the old shutdown() had
// no actual timeout on browser.close() -- `.finally()` (which gated the
// SIGKILL backstop AND the rmSync/process.exit cleanup below it) only ran
// once close()'s promise SETTLED. A hung close() (unresponsive CDP
// connection, wedged renderer -- anything short of an outright rejection)
// meant that `await` never returned, so `.finally()` never ran, the SIGKILL
// backstop never fired, and process.exit() never ran either: the daemon
// sat resident forever, reproducing board #32/#36's original bug via the
// fix meant to close it. CLOSE_TIMEOUT_MS bounds that wait unconditionally
// via raceWithTimeout() (see process-reap.ts) -- 5000ms is comfortably
// above any close() observed live in this container (well under 1s) and
// still fast enough that even the timeout-firing path is a prompt shutdown
// from a caller's perspective.
const CLOSE_TIMEOUT_MS = 5000;

async function shutdown(reason: string): Promise<void> {
  log(`shutting down: ${reason}`);
  if (browserPromise) {
    // `.then(...)` only runs on a successful launch -- the `.catch(() =>
    // {})` swallows either a launch failure OR a close failure, so this
    // never throws out of shutdown(). raceWithTimeout() then guarantees
    // this resolves within CLOSE_TIMEOUT_MS regardless of whether that
    // inner promise ever actually settles -- see its own comment in
    // process-reap.ts. Plain `await browserPromise` (no timeout at all)
    // would also throw straight out of this async function on a
    // permanently-rejected browserPromise (e.g. chromium.launch() failed
    // once, earlier in the daemon's life) -- an unhandled rejection nobody
    // awaits (onIdle calls this as `void this.onIdle()`), which left the
    // daemon resident forever: the original board issue #32 bug, reproduced
    // in the one launch-failure edge case the original fix (#35) missed
    // and #44 closed.
    await raceWithTimeout(
      browserPromise.then((b) => b.close()).catch(() => {}),
      CLOSE_TIMEOUT_MS,
    );
  }
  // Runs UNCONDITIONALLY -- regardless of whether browserPromise was ever
  // created, close() settled cleanly, or CLOSE_TIMEOUT_MS fired instead
  // because close() never returned. raceWithTimeout() only bounds the
  // WAIT; it does not know or claim the browser process actually died, so
  // this backstop still checks/kills for real every time. browserPid stays
  // undefined on the launch-failure path (no process ever spawned), so
  // this is a no-op there.
  if (browserPid !== undefined) {
    try {
      process.kill(browserPid, "SIGKILL");
    } catch {
      // Already gone -- fine, this is the expected case. Note this does
      // NOT mean "already exited" throws ESRCH: a zombie (exited but not
      // yet reaped by its parent) still occupies a valid PID table entry,
      // so kill(2) on a zombie succeeds as a no-op. ESRCH is only thrown
      // once the pid is fully reaped and its slot recycled.
    }
  }
  rmSync(paths.pidFile, { force: true });
  rmSync(paths.sockFile, { force: true });
  process.exit(0);
}

const idleShutdown = new IdleShutdown({
  idleMs: IDLE_MS,
  spacesEmpty: () => registry.list().length === 0,
  inFlightZero: () => inFlightRequests === 0,
  onIdle: () => shutdown(`idle for ${IDLE_MS}ms with zero task spaces open`),
});

function scheduleIdleCheck(overrideMs?: number): void {
  idleShutdown.schedule(overrideMs);
}

// ---------------------------------------------------------------------------
// Socket server.
// ---------------------------------------------------------------------------
rmSync(paths.sockFile, { force: true });

const framers = new WeakMap<Bun.Socket, MessageFramer<RpcRequest>>();

async function handleRequest(socket: Bun.Socket, req: RpcRequest): Promise<void> {
  inFlightRequests += 1;
  try {
    const handler = methods[req.method];
    if (!handler) throw new Error(`ego-browser: unknown RPC method "${req.method}"`);
    const result = await handler(req.params);
    socket.write(encodeMessage({ id: req.id, result: result ?? null }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`method ${req.method} failed: ${message}`);
    socket.write(encodeMessage({ id: req.id, error: { message } }));
  } finally {
    // Any request can be the one that took the space count to zero
    // (space.finish) or away from zero (taskSpace) -- every request needs
    // to re-arm/clear the idle timer, whether it resolved or threw.
    inFlightRequests -= 1;
    scheduleIdleCheck();
  }
}

Bun.listen({
  unix: paths.sockFile,
  socket: {
    open(socket) {
      framers.set(socket, new MessageFramer<RpcRequest>());
    },
    data(socket, data) {
      const framer = framers.get(socket);
      if (!framer) return;
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
      for (const req of framer.push(text)) {
        void handleRequest(socket, req);
      }
    },
    close(socket) {
      framers.delete(socket);
    },
    error(socket, err) {
      log(`socket error: ${err instanceof Error ? err.stack : err}`);
      framers.delete(socket);
    },
  },
});

// Written only once the socket is actually listening -- client.ts's
// ensureDaemonAlive treats "pidfile exists + pid alive + socket connects"
// as the alive signal, so writing this any earlier would let a client
// briefly observe a pidfile with no live socket behind it.
writeFileSync(paths.pidFile, String(process.pid));
log(`daemon started, pid ${process.pid}, socket ${paths.sockFile}`);

// Covers "spawned but never used at all" -- a daemon that comes up and
// then receives zero requests would otherwise never arm its own idle
// timer, since scheduleIdleCheck() is otherwise only called from inside
// handleRequest. Uses STARTUP_GRACE_MS (see its own comment above), not
// the raw IDLE_MS a short-window config might set -- board #36's live
// reproduction (see the plan doc) proved a short IDLE_MS here races the
// daemon's own first client: ensureDaemonAlive always spawns THEN
// immediately starts connecting, so "nobody has connected within IDLE_MS
// of boot" is not reliable evidence of "nobody ever will" the way it is
// once a real request has actually been served at least once.
scheduleIdleCheck(Math.max(IDLE_MS, STARTUP_GRACE_MS));
