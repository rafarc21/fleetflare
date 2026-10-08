#!/usr/bin/env bun
/**
 * The long-lived process that makes ego-browser's persistence contract
 * possible: it owns the real playwright-core Browser/BrowserContext/Page
 * objects and the spaceId+label registry, and outlives every individual
 * `ego-browser nodejs` invocation. Spawned on demand by client.ts
 * (ensureDaemonAlive) -- never run directly by a user script.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page as PwPage } from "playwright-core";
import { resolvePaths } from "./paths";
import { encodeMessage, MessageFramer, type RpcRequest } from "./rpc";
import { Registry, type FinishKeep, type TaskSpaceRecord } from "./registry";
import { IdleShutdown, resolveIdleMs } from "./idle-shutdown";
import { findDirectChildPid, raceWithTimeout } from "./process-reap";
import type { FnOrStringWire, SnapshotOpts, UrlMatcherWire } from "./wire";

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
      })
      .then((browser) => {
        browserPid = findDirectChildPid(process.pid, { chromiumBinaryName: basename(CHROMIUM_PATH) });
        log(`browser launched, pid ${browserPid ?? "unknown"}`);
        return browser;
      });
  }
  return browserPromise;
}

const registry = new Registry<PwPage, BrowserContext>();

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

async function resolveSpace(spaceId: number): Promise<TaskSpaceRecord<PwPage, BrowserContext>> {
  const space = registry.get(spaceId);
  if (!space) throw new Error(`ego-browser: no task space ${spaceId} (finished, or never created)`);
  return space;
}

/**
 * Materializes label's real Page the first time anything actually acts on
 * it. Delegates the actual get-or-create to TaskSpaceRecord.resolveTarget,
 * which de-dupes concurrent callers racing to materialize the SAME
 * still-lazy label (see registry.ts) -- without that, two concurrent RPCs
 * against a page never touched yet (e.g. `Promise.all([p1.goto(url),
 * p1.evaluate(fn)])`) would each create their own real Page, silently
 * orphaning one.
 */
async function resolvePage(spaceId: number, label: string): Promise<PwPage> {
  const space = await resolveSpace(spaceId);
  return space.resolveTarget(label, (context) => context.newPage());
}

// ---------------------------------------------------------------------------
// evaluate / waitForFunction / waitForURL marshaling. JSON-RPC only carries
// JSON, so a function argument crosses the wire as its own source text
// (`fn.toString()`, done client-side in api.ts) and is reconstructed here
// with `new Function(...)`. This is the one deliberately non-obvious wire
// hop in the whole shim -- see api.ts's marshalFnOrString for the other
// half.
// ---------------------------------------------------------------------------
function reconstructFunction(code: string): (...args: unknown[]) => unknown {
  // eslint-disable-next-line no-new-func -- documented, deliberate: this is
  // exactly how a function argument survives a JSON-RPC hop (see header
  // comment above).
  return new Function(`return (${code});`)() as (...args: unknown[]) => unknown;
}

function toEvaluateArg(wire: FnOrStringWire): ((...args: unknown[]) => unknown) | string {
  return wire.isFunction ? reconstructFunction(wire.code) : wire.code;
}

function toUrlMatcher(wire: UrlMatcherWire): string | RegExp | ((url: URL) => boolean) {
  if (wire.kind === "string") return wire.value;
  if (wire.kind === "regexp") return new RegExp(wire.source, wire.flags);
  return reconstructFunction(wire.code) as (url: URL) => boolean;
}

// ---------------------------------------------------------------------------
// page.snapshot() -- reuses playwright-core's own public page.ariaSnapshot
// ({mode:"ai"}), which produces the same ref-annotated ([ref=e2]) shape
// @playwright/mcp's own snapshot tool does (same underlying accessibility-
// tree serializer). See docs/plans/2026-09-22-ego-browser-shim.md for the
// full reasoning, including the documented viewport-vs-full_page
// limitation (ariaSnapshot has no native notion of "viewport" -- it walks
// the accessibility tree, not the rendered pixels).
// ---------------------------------------------------------------------------
async function pageSnapshot(pwPage: PwPage, opts: SnapshotOpts = {}): Promise<{ scope: string; root?: string; snapshot: string }> {
  const scope = opts.scope ?? "only_within_viewport";
  const ariaOpts = { mode: "ai" as const, boxes: !!opts.includeActionMarks };

  if (scope === "subtree") {
    if (!opts.root) throw new Error('ego-browser: page.snapshot({scope:"subtree"}) requires opts.root');
    const snapshot = await pwPage.locator(`aria-ref=${opts.root}`).ariaSnapshot(ariaOpts);
    return { scope, root: opts.root, snapshot };
  }
  if (scope === "full_page") {
    const snapshot = await pwPage.locator("body").ariaSnapshot(ariaOpts);
    return { scope, snapshot };
  }
  const snapshot = await pwPage.ariaSnapshot(ariaOpts);
  return { scope: "only_within_viewport", snapshot };
}

// ---------------------------------------------------------------------------
// RPC method dispatch table.
// ---------------------------------------------------------------------------
type Handler = (params: any) => Promise<unknown> | unknown;

const methods: Record<string, Handler> = {
  async taskSpace(params: { nameOrId: string | number; profileId?: string }) {
    // profileId is accepted (per the contract, "applies only when creating
    // a new space") but has no effect here -- browser profile selection is
    // a genuinely separate feature from profiles() (loud-fail, not Tier1),
    // not a silent partial implementation of it.
    const browser = await getBrowser();
    const space = await registry.resolve(params.nameOrId, () => browser.newContext());
    return { spaceId: space.spaceId, name: space.name };
  },

  async listTaskSpaces() {
    return registry.list().map((s) => ({ spaceId: s.spaceId, name: s.name }));
  },

  async "space.pages"(params: { spaceId: number }) {
    const space = await resolveSpace(params.spaceId);
    // Eager, per the contract: materializes every currently-lazy label.
    // Goes through the same resolveTarget de-dupe as resolvePage, so this
    // racing against a concurrent page.* call on one of these same labels
    // (e.g. `Promise.all([t.pages(), p1.goto(url)])`) also converges on one
    // real Page, not two.
    await Promise.all(
      space
        .listLabels()
        .filter((state) => !state.target)
        .map((state) => space.resolveTarget(state.label, (context) => context.newPage())),
    );
    return space.listLabels().map((s) => ({ label: s.label }));
  },

  async "space.newPage"(params: { spaceId: number }) {
    const space = await resolveSpace(params.spaceId);
    const label = space.nextAutoLabel();
    const page = await space.context.newPage();
    space.setTarget(label, page);
    return { label };
  },

  async "space.finish"(params: { spaceId: number; keep: FinishKeep }) {
    const space = await resolveSpace(params.spaceId);
    const receipt = space.finish(params.keep);
    for (const label of receipt.closed) {
      const target = space.getTarget(label);
      if (target) await target.close().catch(() => {});
      space.removeLabel(label);
    }
    if (receipt.spaceClosed) {
      await space.context.close().catch(() => {});
      registry.remove(space.spaceId);
    }
    return { retained: receipt.retained, closed: receipt.closed };
  },

  async "page.goto"(params: { spaceId: number; label: string; url: string; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.goto(params.url, params.opts as never);
    return null;
  },

  async "page.reload"(params: { spaceId: number; label: string; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.reload(params.opts as never);
    return null;
  },

  async "page.url"(params: { spaceId: number; label: string }) {
    const page = await resolvePage(params.spaceId, params.label);
    return page.url();
  },

  async "page.title"(params: { spaceId: number; label: string }) {
    const page = await resolvePage(params.spaceId, params.label);
    return page.title();
  },

  async "page.info"(params: { spaceId: number; label: string }) {
    const page = await resolvePage(params.spaceId, params.label);
    const [url, title, viewport, scroll] = await Promise.all([
      page.url(),
      page.title(),
      page.viewportSize(),
      // Passed as a string (evaluated as browser JS, never compiled by our
      // own tsc) rather than a real function literal -- this file's own
      // tsconfig has no DOM lib, so a literal `window.scrollX` reference
      // here would not type-check even though it is perfectly valid inside
      // the page it actually runs in.
      page.evaluate("({ x: window.scrollX, y: window.scrollY })"),
    ]);
    return { url, title, viewport, scroll };
  },

  async "page.screenshot"(
    params: { spaceId: number; label: string; opts?: { path?: string; fullPage?: boolean; clip?: unknown; scale?: unknown; raw?: boolean } },
  ) {
    const page = await resolvePage(params.spaceId, params.label);
    const opts = params.opts ?? {};
    const buffer = await page.screenshot({
      fullPage: opts.fullPage,
      clip: opts.clip as never,
      scale: opts.scale as never,
      type: "png",
    });
    if (opts.path) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(opts.path), { recursive: true });
      await writeFile(opts.path, buffer);
      return { path: opts.path };
    }
    return { base64: buffer.toString("base64") };
  },

  async "page.evaluate"(params: { spaceId: number; label: string; fn: FnOrStringWire; arg?: unknown }) {
    const page = await resolvePage(params.spaceId, params.label);
    const arg = toEvaluateArg(params.fn);
    return params.fn.isFunction ? page.evaluate(arg as never, params.arg) : page.evaluate(arg as unknown as string);
  },

  async "page.click"(params: { spaceId: number; label: string; selector: string; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.click(params.selector, params.opts as never);
    return null;
  },

  async "page.dblclick"(params: { spaceId: number; label: string; selector: string; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.dblclick(params.selector, params.opts as never);
    return null;
  },

  async "page.hover"(params: { spaceId: number; label: string; selector: string; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.hover(params.selector, params.opts as never);
    return null;
  },

  async "page.fill"(params: { spaceId: number; label: string; selector: string; value: string; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.fill(params.selector, params.value, params.opts as never);
    return null;
  },

  async "page.press"(params: { spaceId: number; label: string; selector: string; chord: string; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.press(params.selector, params.chord, params.opts as never);
    return null;
  },

  async "page.focus"(params: { spaceId: number; label: string; selector: string; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.focus(params.selector, params.opts as never);
    return null;
  },

  async "page.selectOption"(
    params: { spaceId: number; label: string; selector: string; valueOrValues: unknown; opts?: Record<string, unknown> },
  ) {
    const page = await resolvePage(params.spaceId, params.label);
    return page.selectOption(params.selector, params.valueOrValues as never, params.opts as never);
  },

  async "page.setInputFiles"(params: { spaceId: number; label: string; selector: string; pathOrPaths: string | string[] }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.setInputFiles(params.selector, params.pathOrPaths);
    return null;
  },

  async "page.waitForSelector"(params: { spaceId: number; label: string; selector: string; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.waitForSelector(params.selector, params.opts as never);
    return null;
  },

  async "page.waitForLoadState"(params: { spaceId: number; label: string; state?: string; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.waitForLoadState(params.state as never, params.opts as never);
    return null;
  },

  async "page.waitForURL"(params: { spaceId: number; label: string; urlMatcher: UrlMatcherWire; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.waitForURL(toUrlMatcher(params.urlMatcher) as never, params.opts as never);
    return null;
  },

  async "page.waitForFunction"(params: { spaceId: number; label: string; fn: FnOrStringWire; arg?: unknown; opts?: Record<string, unknown> }) {
    const page = await resolvePage(params.spaceId, params.label);
    const target = toEvaluateArg(params.fn);
    const handle = await page.waitForFunction(target as never, params.arg, params.opts as never);
    return handle.jsonValue();
  },

  async "page.waitForTimeout"(params: { spaceId: number; label: string; ms: number }) {
    const page = await resolvePage(params.spaceId, params.label);
    await page.waitForTimeout(params.ms);
    return null;
  },

  async "page.close"(params: { spaceId: number; label: string }) {
    const space = await resolveSpace(params.spaceId);
    const target = space.getTarget(params.label);
    if (target) await target.close();
    space.removeLabel(params.label);
    return null;
  },

  async "page.snapshot"(params: { spaceId: number; label: string; opts?: SnapshotOpts }) {
    const page = await resolvePage(params.spaceId, params.label);
    return pageSnapshot(page, params.opts);
  },
};

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
