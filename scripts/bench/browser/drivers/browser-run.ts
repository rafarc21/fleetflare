// CF Browser Run driver (remote engine). Needs an account id + Bearer token;
// a studio container holds no Cloudflare credential by design (house rule —
// no CLOUDFLARE_API_TOKEN / CLOUDFLARE_DEPLOY_TOKEN), so this runs from an
// operator/maestro session, not inside a studio. Measured end to end by the
// maestro (#1347 comment 6413360970): connectOverCDP with the browser binding
// runs the stock @playwright/test runner 12/12; only the native
// use.connectOptions path fails.
//
// Connection (task recon facts, verified against CF docs):
//   wss://api.cloudflare.com/client/v4/accounts/{accountId}/browser-run/devtools/browser
//   Authorization: Bearer <token>
//   keep_alive <= 1200000 ms (20 min)
//   playwright-core connectOverCDP works.
//
// Reachability: a remote browser cannot reach the fixture server bound to
// 127.0.0.1 inside this container. The baseUrl the runner passes must be the
// cloudflared-tunnel or per-PR-preview URL that exposes the same fixture.
// Note Browser Run rejects *.trycloudflare.com quick tunnels (403 at the CF
// edge); the maestro's bench used a Worker proxy. That bridge latency is part
// of the remote leg wall and is measured separately (see run.ts --target).
import { chromium } from "/opt/fleet/ego-browser/node_modules/playwright-core/index.mjs";
import type { SuitePage } from "../suite.ts";

export interface BrowserRunDriver {
  connect(): Promise<void>;
  newPage(): Promise<SuitePage>;
  close(): Promise<void>;
}

export interface BrowserRunEnv {
  accountId: string;
  token: string;
  /** Default 20 min (the CF max). */
  keepAliveMs?: number;
}

export function browserRunEndpoint(env: BrowserRunEnv): string {
  return `wss://api.cloudflare.com/client/v4/accounts/${env.accountId}/browser-run/devtools/browser?keep_alive=${env.keepAliveMs ?? 1_200_000}`;
}

export function createBrowserRunDriver(env: BrowserRunEnv): BrowserRunDriver {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;

  async function connect(): Promise<void> {
    // CF Browser Run expects the Bearer token as an Authorization header on
    // the CDP handshake. playwright-core's ConnectOverCDPOptions declares a
    // `headers` field for exactly this (verified in the bundled types).
    browser = await chromium.connectOverCDP(browserRunEndpoint(env), {
      headers: { Authorization: `Bearer ${env.token}` },
    });
  }

  function wrap(page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.connectOverCDP>>["newPage"]>>): SuitePage {
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
    connect,
    async newPage() {
      if (!browser) await connect();
      return wrap(await browser.newPage());
    },
    async close() {
      await browser?.close();
      browser = undefined;
    },
  };
}