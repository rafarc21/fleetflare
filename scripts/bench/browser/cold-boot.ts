// Cold-boot measurement: the wall a gate leg pays from a fresh container
// process to a usable browser. Unlike run.ts (which imports playwright-core at
// module load and then times only chromium.launch), this script times the
// WHOLE thing — bun spawn, playwright-core import, chromium.launch — because
// that is the real first-leg cost in a container where the browser image is
// not already resident.
//
//   bun scripts/bench/browser/cold-boot.ts [engine]
//
// chrome      (default) imports playwright-core and launches chromium, prints
//             one line: {"engine":"chrome","coldBootMs":<ms>}
// browser-run connects to the remote engine instead (needs the CF env vars).
const t0 = Date.now();

const engine = process.argv[2] ?? "chrome";

if (engine === "chrome") {
  const { chromium } = await import("/opt/fleet/ego-browser/node_modules/playwright-core/index.mjs");
  const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium", headless: true, args: ["--no-sandbox"] });
  console.log(JSON.stringify({ engine, coldBootMs: Date.now() - t0 }));
  await browser.close();
} else if (engine === "browser-run") {
  const { chromium } = await import("/opt/fleet/ego-browser/node_modules/playwright-core/index.mjs");
  const accountId = process.env.CF_BROWSER_ACCOUNT_ID;
  const token = process.env.CF_BROWSER_TOKEN;
  if (!accountId || !token) throw new Error("browser-run cold boot needs CF_BROWSER_ACCOUNT_ID + CF_BROWSER_TOKEN");
  const endpoint = `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-run/devtools/browser?keep_alive=1200000`;
  const browser = await chromium.connectOverCDP(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  console.log(JSON.stringify({ engine, coldBootMs: Date.now() - t0 }));
  await browser.close();
} else {
  throw new Error("usage: cold-boot.ts [chrome|browser-run]");
}