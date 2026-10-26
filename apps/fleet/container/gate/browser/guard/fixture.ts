// container/gate/browser/guard/fixture.ts
//
// The guard's own Playwright fixture adapter. It builds a page whose CDP
// console/network events feed the guard's capture, and whose every new
// document evaluates the init-script env var. The value is never logged:
// on an error path it is redacted before being surfaced.
//
// Structure-only — the concrete playwright surface is passed in as a shape,
// so this module has no hard import of playwright-core / @playwright/test.
// A consumer repo mounts the same file under either runner by supplying the
// shapes each runner actually provides.

import { startCapture, type CaptureHandle, type CdpSessionLike } from "./capture";
import { applyInitScript, initScriptFromEnv, redact } from "./init-script";

export interface FixtureBrowserLike {
  newContext(opts?: { userAgent?: string; extraHTTPHeaders?: Record<string, string> }): Promise<FixtureContextLike>;
}
export interface FixtureContextLike {
  newPage(): Promise<FixturePageLike>;
  newCDPSession(page: unknown): Promise<CdpSessionLike>;
  addInitScript(source: string): Promise<void>;
}
export interface FixturePageLike {
  goto(url: string): Promise<unknown>;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Uint8Array | { path?: string }>;
  context(): FixtureContextLike;
}

export interface GuardFixture {
  /** The live capture handle; buckets populate as the page runs. */
  capture: CaptureHandle;
  dispose(): Promise<void>;
}

export interface BuildGuardFixtureOpts {
  browser: FixtureBrowserLike;
  /** Env to read BROWSER_GUARD_INIT_SCRIPT from; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Real UA + webdriver override, the shared schema's headless requirement. */
  userAgent?: string;
}

export const DEFAULT_GUARD_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface BuiltGuardFixture {
  fixture: GuardFixture;
  page: FixturePageLike;
  context: FixtureContextLike;
}

/** Builds the guarded context + page in one step. */
export async function buildGuardFixture(opts: BuildGuardFixtureOpts): Promise<BuiltGuardFixture> {
  const env = opts.env ?? (process.env as unknown as Record<string, string | undefined>);
  const init = initScriptFromEnv(env);
  const context = await opts.browser.newContext({
    userAgent: opts.userAgent ?? DEFAULT_GUARD_USER_AGENT,
    // The shared schema's headless facts: navigator.webdriver must read false.
    extraHTTPHeaders: { "Sec-CH-UA": `"Chromium";v="124"` },
  });
  // Mask the headless tell the same way a real consumer walk does.
  await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => false });");
  if (init !== null) await context.addInitScript(init.source);
  const page = await context.newPage();

  let cdp: CdpSessionLike;
  try {
    cdp = await context.newCDPSession(page as unknown);
  } catch (err) {
    // The secret never escapes: the message is redacted against the raw env value.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(redact(`browser-guard: CDP session failed: ${raw}`, init === null ? [] : [init.source]));
  }

  const capture = startCapture(cdp);
  await capture.enable();

  // The CDP-level init hook, per the task: Page.addScriptToEvaluateOnNewDocument.
  if (init !== null) await applyInitScript(cdp, init.source).catch(async (err) => {
    capture.dispose();
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(redact(`browser-guard: init-script hook failed: ${raw}`, [init.source]));
  });

  return {
    page,
    context,
    fixture: {
      capture,
      dispose: async () => { capture.dispose(); },
    },
  };
}