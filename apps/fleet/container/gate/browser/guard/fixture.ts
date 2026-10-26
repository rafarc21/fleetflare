// container/gate/browser/guard/fixture.ts
//
// The guard's own fixture: a guarded page whose console/network events — its
// own, plus every dedicated/service worker it auto-attaches, plus every
// window.open popup — feed ONE Collector, and whose every new document
// evaluates the init-script env var. The value is never logged: error paths
// are redacted against the extracted secret values.
//
// Network is context-level: context.on('response') + context.on('requestfailed')
// cover the main page, its iframes, popups from their first page-load, and
// workers, so a popup's page-load 503 is never missed (measured — CDP
// auto-attach alone misses it).
//
// The fixture returns the extracted secrets so a reporter redacts evidence by
// default without the caller re-deriving them.
//
// Structure-only — no hard import of playwright-core / @playwright/test.
// A consumer repo mounts the same file under either runner by supplying the
// shapes each runner actually provides.

import {
  Collector,
  normalizeContextFailure,
  normalizeContextResponse,
  type ContextRequestFailedLike,
  type ContextResponseLike,
} from "./capture";
import { wireAutoAttach, type CdpSessionLike } from "./attach";
import { applyInitScript, initScriptFromEnv, redact, secretsFromInitScript } from "./init-script";

export interface FixtureBrowserLike {
  version(): Promise<string>;
  newContext(opts?: { userAgent?: string; extraHTTPHeaders?: Record<string, string> }): Promise<FixtureContextLike>;
}
export interface FixtureContextLike {
  newPage(): Promise<FixturePageLike>;
  newCDPSession(page: unknown): Promise<CdpSessionLike>;
  addInitScript(source: string): Promise<void>;
  on(event: "page", listener: (page: FixturePageLike) => void): void;
  on(event: "response", listener: (response: ContextResponseLike) => void): void;
  on(event: "requestfailed", listener: (request: ContextRequestFailedLike) => void): void;
}
export interface FixturePageLike {
  goto(url: string): Promise<unknown>;
  screenshot(opts?: { type?: string }): Promise<Uint8Array | { path?: string }>;
  context(): FixtureContextLike;
  evaluate(pageFunction: string): Promise<unknown>;
}

export interface GuardFixture {
  /** The shared collector every attached target feeds. */
  collector: Collector;
  /** The init-script secret values, for redacting evidence by default. */
  secrets: string[];
  dispose(): Promise<void>;
}

export interface BuildGuardFixtureOpts {
  browser: FixtureBrowserLike;
  /** Env to read BROWSER_GUARD_INIT_SCRIPT from; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** Real UA derived from the browser's own version, so Sec-CH-UA stays
 *  consistent with navigator.userAgentData instead of a hardcoded Chrome. */
export async function guardUserAgent(browser: { version(): Promise<string> }): Promise<string> {
  const version = await browser.version();
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/** The popup path: window.open is never auto-attached, so a popup gets its
 *  own console session wired into the same collector. */
function wirePopup(context: FixtureContextLike, collector: Collector, page: FixturePageLike): void {
  context.newCDPSession(page as unknown)
    .then((session) => {
      const attach = wireAutoAttach(collector, session);
      attach.enable().catch(() => {});
    })
    .catch(() => {});
}

export interface BuiltGuardFixture {
  fixture: GuardFixture;
  page: FixturePageLike;
  context: FixtureContextLike;
}

/** Builds the guarded context + page in one step. */
export async function buildGuardFixture(opts: BuildGuardFixtureOpts): Promise<BuiltGuardFixture> {
  const env = opts.env ?? (process.env as unknown as Record<string, string | undefined>);
  const init = initScriptFromEnv(env);
  const secrets = secretsFromInitScript(init);
  const userAgent = await guardUserAgent(opts.browser);
  const context = await opts.browser.newContext({ userAgent });

  // Mask the headless tell the same way a real consumer walk does.
  await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => false });");
  if (init !== null) await context.addInitScript(init.source);
  const page = await context.newPage();

  // The CDP-level init hook, per the task: Page.addScriptToEvaluateOnNewDocument.
  if (init !== null) {
    try {
      const cdp = await context.newCDPSession(page as unknown);
      await applyInitScript(cdp, init.source);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(redact(`browser-guard: init-script hook failed: ${raw}`, secrets));
    }
  }

  const collector = new Collector();

  // Context-level network: popups/workers/iframes from their first load.
  context.on("response", (response: ContextResponseLike) => {
    const n = normalizeContextResponse(response);
    if (n) collector.networkResponse(n.status, n.method, n.path, n.type);
  });
  context.on("requestfailed", (request: ContextRequestFailedLike) => {
    const n = normalizeContextFailure(request);
    collector.networkFailure(n.method, n.path, n.errorText, n.type);
  });

  let rootSession: CdpSessionLike;
  try {
    rootSession = await context.newCDPSession(page as unknown);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(redact(`browser-guard: CDP session failed: ${raw}`, secrets));
  }
  const attach = wireAutoAttach(collector, rootSession);
  await attach.enable();

  // Popups (window.open) are never auto-attached; attach each on creation.
  context.on("page", (popup: FixturePageLike) => wirePopup(context, collector, popup));

  return {
    page,
    context,
    fixture: {
      collector,
      secrets,
      dispose: async () => { attach.dispose(); },
    },
  };
}