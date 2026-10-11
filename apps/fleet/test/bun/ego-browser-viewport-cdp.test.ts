import { describe, expect, test } from "bun:test";
import { Page } from "../../container/ego-browser/api";
import { cleanupEgoBrowserHome, makeEgoBrowserHome, runEgoBrowser } from "./ego-browser-cli-helpers";

// Board #351: studios need mobile-viewport screenshots, which needs (a) a
// viewport RPC and (b) ego lite's documented page.cdp(). Two layers proven
// here: api.ts marshaling (fake `call`, no browser) and the real
// daemon->Playwright plumbing (runEgoBrowser spawns real chromium).

describe("Page#setViewportSize / Page#cdp marshaling (fake RPC)", () => {
  test("setViewportSize marshals method + viewportSize verbatim", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const page = new Page(7, "p1", (method, params) => {
      calls.push({ method, params: params as any });
      return Promise.resolve(null);
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(calls).toEqual([
      {
        method: "page.setViewportSize",
        params: { spaceId: 7, label: "p1", viewportSize: { width: 390, height: 844 } },
      },
    ]);
  });

  test("cdp marshals method + params; params optional; returns the send() result", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const page = new Page(7, "p1", (method, params) => {
      calls.push({ method, params: params as any });
      return Promise.resolve({ result: { value: 5 } });
    });
    const r = await page.cdp("Runtime.evaluate", { expression: "2+3" });
    expect(r).toEqual({ result: { value: 5 } });
    await page.cdp("Animation.enable");
    expect(calls).toEqual([
      {
        method: "page.cdp",
        params: { spaceId: 7, label: "p1", method: "Runtime.evaluate", params: { expression: "2+3" } },
      },
      {
        method: "page.cdp",
        params: { spaceId: 7, label: "p1", method: "Animation.enable", params: undefined },
      },
    ]);
  });
});

describe("viewport + cdp against the real daemon (real chromium)", () => {
  test("setViewportSize resizes the real page; cdp runs on a persistent session", async () => {
    const home = makeEgoBrowserHome();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(`<!doctype html><html><body><h1>viewport test</h1></body></html>`, {
          headers: { "content-type": "text/html" },
        }),
    });
    const url = `http://127.0.0.1:${server.port}/`;
    try {
      const result = await runEgoBrowser({
        home,
        code: `
          const t = await taskSpace("viewport-cdp");
          const p1 = t.page("p1");
          await p1.goto(${JSON.stringify(url)});
          await p1.setViewportSize({ width: 390, height: 844 });
          const info = await p1.info();
          console.log("AFTER:" + JSON.stringify(info.viewport));
          const evalResult = await p1.cdp("Runtime.evaluate", { expression: "2+3", returnByValue: true });
          console.log("CDP:" + evalResult.result.value);
          const widthOf = async (expr) =>
            (await p1.cdp("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
          const baseWidth = await widthOf("window.innerWidth");
          await p1.cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
          const mobileWidth = await widthOf("window.innerWidth");
          await p1.cdp("Emulation.clearDeviceMetricsOverride");
          // Settle before reading: the clear is a resize, and an immediate
          // read can observe the mid-transition value (measured raw against
          // this stack: 320 before double-rAF, stable after it).
          await p1.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
          const clearedWidth = await widthOf("window.innerWidth");
          console.log("W:" + baseWidth + "," + mobileWidth + "," + clearedWidth);
          await t.finish({ keep: [] });
        `,
      });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const after = result.stdout.split("\n").find((l) => l.startsWith("AFTER:"));
      expect(after).toBeDefined();
      expect(JSON.parse(after!.slice("AFTER:".length))).toEqual({ width: 390, height: 844 });
      expect(result.stdout).toContain("CDP:5");
      const wLine = result.stdout.split("\n").find((l) => l.startsWith("W:"));
      expect(wLine).toBeDefined();
      const [baseWidth, mobileWidth, clearedWidth] = wLine!.slice(2).split(",").map(Number);
      // Discriminating pair: the override must observably change the
      // page (per-call sessions could fake "both calls resolve"), and a
      // same-session clear must take effect -- per-call sessions would
      // leave the override stranded (cross-session clear silently
      // no-ops, clearedWidth still the mobile value). NOTE the clear
      // does NOT return to baseWidth on this stack: Playwright's own
      // viewport rides the same Emulation domain (its _updateViewport
      // sends Emulation.setDeviceMetricsOverride), so clearing also
      // drops the 390 viewport and innerWidth falls back to the raw
      // window (measured: base 390 -> mobile 980 -> cleared 1280; the
      // mobile value is a CSS-layout width, not the 320 pixel width --
      // 980 is the overflow-visible layout viewport of mobile mode).
      // The clear-took-effect signal is clearedWidth !== mobileWidth,
      // which is exactly the relation per-call sessions would fail.
      expect(mobileWidth).not.toBe(baseWidth);
      expect(clearedWidth).not.toBe(mobileWidth);
    } finally {
      server.stop(true);
      cleanupEgoBrowserHome(home);
    }
  }, 45000);
});
