// In-container Chromium driver: playwright-core's chromium.launch against the
// image's own /usr/local/bin/chromium (same binary ego-browser drives, same
// --no-sandbox container flag). Maps the real Playwright page onto the
// engine-agnostic SuitePage surface.
//
// Timing model (what the benchmark measures):
//   boot wall  = chromium.launch() until it resolves            (cold engine)
//   warm boot  = launch + newPage with a pre-warmed browser      (reuse)
//   leg wall   = one runSuite() pass, engine already up          (the leg)
//
// The driver reports all three so the evidence doc can separate "boot
// overhead" (paid once per container) from "leg wall" (paid per PR leg).
import { chromium, type Browser, type Page } from "/opt/fleet/ego-browser/node_modules/playwright-core/index.mjs";
import type { SuitePage } from "../suite.ts";

export interface ChromeDriver {
  bootMs(): number;
  launch(): Promise<void>;
  newPage(): Promise<SuitePage>;
  close(): Promise<void>;
}

export function createChromeDriver(): ChromeDriver {
  let browser: Browser | undefined;
  let bootMs = 0;

  async function launch(): Promise<void> {
    const t0 = performance.now();
    browser = await chromium.launch({
      executablePath: process.env.BENCH_CHROMIUM_PATH || "/usr/local/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    bootMs = performance.now() - t0;
  }

  function wrap(page: Page): SuitePage {
    return {
      goto: (url) => page.goto(url).then(() => undefined),
      title: () => page.title(),
      text: (sel) => page.locator(sel).textContent(),
      click: (sel) => page.locator(sel).click(),
      fill: (sel, v) => page.locator(sel).fill(v),
      value: (sel) => page.locator(sel).inputValue(),
      waitForSelector: (sel) => page.locator(sel).first().waitFor().then(() => undefined),
      count: (sel) => page.locator(sel).count(),
      close: () => page.close(),
    };
  }

  return {
    bootMs: () => bootMs,
    launch,
    async newPage() {
      if (!browser) await launch();
      return wrap(await browser.newPage());
    },
    async close() {
      await browser?.close();
      browser = undefined;
    },
  };
}