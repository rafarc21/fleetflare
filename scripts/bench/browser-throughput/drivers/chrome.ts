// Config A driver: one in-container Chromium browser, k browser contexts, one
// page per worker (page is reused across the specs its worker is assigned).
// Boot is measured as chromium.launch (import is module-level, so the
// per-invocation launch is the honest container boot this config pays once).
import { chromium, type Browser, type BrowserContext, type Page } from "/opt/fleet/ego-browser/node_modules/playwright-core/index.mjs";
import type { SpecPage, SpecPageFactory } from "../harness.ts";

const REAL = Symbol("real page/context");

interface Wrapped extends SpecPage {
  [REAL]: { context: BrowserContext; page: Page };
}

export function createChromeFactory(): SpecPageFactory {
  let browser: Browser | undefined;
  let bootMs = 0;
  // Shared launch promise: k workers open() concurrently on the first run of
  // a k, and without it both see `!browser` and race chromium.launch (two
  // browsers, one lost handle, a hung context). Serialize the launch.
  let launchPromise: Promise<Browser> | undefined;

  function launch(): Promise<Browser> {
    if (!launchPromise) {
      const t0 = performance.now();
      launchPromise = chromium
        .launch({
          executablePath: process.env.BENCH_CHROMIUM_PATH || "/usr/local/bin/chromium",
          headless: true,
          args: ["--no-sandbox"],
        })
        .then((b) => {
          bootMs = performance.now() - t0;
          browser = b;
          return b;
        });
    }
    return launchPromise;
  }

  return {
    bootMs: () => bootMs,
    async open() {
      if (!browser) await launch();
      const context = await browser.newContext();
      const page = await context.newPage();
      const wrapped: Wrapped = {
        goto: (url) => page.goto(url).then(() => undefined),
        click: (sel) => page.locator(sel).click(),
        fill: (sel, v) => page.locator(sel).fill(v),
        valueText: (sel) => page.locator(sel).first().textContent(),
        count: (sel) => page.locator(sel).count(),
        waitForSelector: (sel) => page.locator(sel).first().waitFor().then(() => undefined),
        [REAL]: { context, page },
      };
      return wrapped;
    },
    async close(page) {
      const { context } = (page as Wrapped)[REAL];
      await context.close().catch(() => {});
    },
    async dispose() {
      await browser?.close().catch(() => {});
      browser = undefined;
      launchPromise = undefined;
    },
  };
}