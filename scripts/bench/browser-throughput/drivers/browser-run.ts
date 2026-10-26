// Config C driver: N parallel Browser Run sessions, one per worker, each a
// separate connectOverCDP browser (a remote session). Committed with exact
// repro steps for the maestro — a studio holds no CF credential. Limits that
// bind fan-out: 200 concurrent sessions, 3 new/s acquisition, 60s idle close
// (keep_alive up to 20 min).
//
// Each worker opens its OWN session on demand (lazy), so boot per worker is
// the connect wall, paid in parallel — the fan-out cost this config exists to
// measure.
import { chromium } from "/opt/fleet/ego-browser/node_modules/playwright-core/index.mjs";
import type { SpecPage, SpecPageFactory } from "../harness.ts";

export interface BrowserRunEnv {
  accountId: string;
  token: string;
  keepAliveMs?: number;
}

const REAL = Symbol("real browser");

interface Wrapped extends SpecPage {
  [REAL]: { close(): Promise<void> };
}

export function browserRunEndpoint(env: BrowserRunEnv): string {
  return `wss://api.cloudflare.com/client/v4/accounts/${env.accountId}/browser-run/devtools/browser?keep_alive=${env.keepAliveMs ?? 1_200_000}`;
}

export function createBrowserRunFactory(env: BrowserRunEnv): SpecPageFactory {
  let bootMs = 0;

  return {
    bootMs: () => bootMs,
    async open() {
      const t0 = performance.now();
      const browser = await chromium.connectOverCDP(browserRunEndpoint(env), {
        headers: { Authorization: `Bearer ${env.token}` },
      });
      if (bootMs === 0) bootMs = performance.now() - t0;
      const page = await browser.newPage();
      const wrapped: Wrapped = {
        goto: (url) => page.goto(url).then(() => undefined),
        click: (sel) => page.locator(sel).click(),
        fill: (sel, v) => page.locator(sel).fill(v),
        valueText: (sel) => page.locator(sel).first().textContent(),
        count: (sel) => page.locator(sel).count(),
        waitForSelector: (sel) => page.locator(sel).first().waitFor().then(() => undefined),
        [REAL]: { close: () => browser.close() },
      };
      return wrapped;
    },
    async close(page) {
      await (page as Wrapped)[REAL].close().catch(() => {});
    },
  };
}