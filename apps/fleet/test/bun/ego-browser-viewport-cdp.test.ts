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
          await p1.cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
          await p1.cdp("Emulation.clearDeviceMetricsOverride");
          console.log("CHAINED:ok");
          await t.finish({ keep: [] });
        `,
      });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const after = result.stdout.split("\n").find((l) => l.startsWith("AFTER:"));
      expect(after).toBeDefined();
      expect(JSON.parse(after!.slice("AFTER:".length))).toEqual({ width: 390, height: 844 });
      expect(result.stdout).toContain("CDP:5");
      expect(result.stdout).toContain("CHAINED:ok");
    } finally {
      server.stop(true);
      cleanupEgoBrowserHome(home);
    }
  });
});
