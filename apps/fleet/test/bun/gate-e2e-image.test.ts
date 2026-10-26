import { describe, expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

// #1342: the gate's `e2e` image variant is the browser-capable leg image.
// It maps to the SAME Dockerfile.gate (wrangler.example.jsonc), which bakes
// Chromium + Playwright at /usr/local/bin/chromium. This test is the fixture
// acceptance: a local dev server boots in-process, one Playwright spec runs
// headless against it through playwright-core + that exact chromium binary,
// and it must pass. It never uses ego-browser (no shim on the gate image)
// and never @playwright/test (not installed) — the leg's own spec is the
// plain playwright-core launch the gate image actually supports.

const CHROMIUM_PATH = "/usr/local/bin/chromium";

/** The one spec: navigate, assert the dev server's real rendered DOM. */
const SPEC_HTML = `<!doctype html><html><body>
  <h1 id="title">gate e2e fixture</h1>
  <p id="count">0</p>
  <button id="bump" onclick="document.getElementById('count').textContent = String(1 + Number(document.getElementById('count').textContent))">bump</button>
</body></html>`;

describe("gate e2e image: Chromium + Playwright browser leg (#1342)", () => {
  test("the chromium binary the gate image bakes is present at the executablePath a leg uses", () => {
    expect(existsSync(CHROMIUM_PATH)).toBe(true);
  });

  test("a local dev server + one Playwright spec run headless and pass", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(SPEC_HTML, { headers: { "content-type": "text/html" } }),
    });
    try {
      const browser = await chromium.launch({
        executablePath: CHROMIUM_PATH,
        headless: true,
        args: ["--no-sandbox"],
      });
      try {
        const page = await browser.newPage();
        await page.goto(server.url.toString());
        // The spec's assertions: the dev server's own DOM, driven end to end.
        expect(await page.textContent("#title")).toBe("gate e2e fixture");
        await page.click("#bump");
        await page.click("#bump");
        expect(await page.textContent("#count")).toBe("2");
      } finally {
        await browser.close();
      }
    } finally {
      await server.stop(true);
    }
  });
});