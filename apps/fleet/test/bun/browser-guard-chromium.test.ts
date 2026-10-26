import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchGuarded } from "./browser-guard-helper";
import {
  findingsWithAllowlist,
  isGreen,
  evidencePathsFor,
  type AllowlistRow,
} from "../../container/gate/browser/guard/evidence";
import { guardFindings } from "../../container/gate/browser/guard/capture";
import { initScriptFromEnv, redact } from "../../container/gate/browser/guard/init-script";
import { didNotRunResult, reportGuardTest } from "../../container/gate/browser/guard/reporter";
import type { EvidenceSink } from "../../container/gate/browser/guard/evidence";

// Real-Chromium integration: the RED triggers and the aborted-fetch
// exclusion, plus the r1 items (worker/popup/service-worker capture, 503 x3,
// allowlist, token-value redaction, DID-NOT-RUN). Each against Chromium's
// actual CDP stream.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memSink(): { sink: EvidenceSink; files: Map<string, string | Uint8Array> } {
  const files = new Map<string, string | Uint8Array>();
  return {
    files,
    sink: {
      mkdir: () => {},
      writeFile: (p, d) => files.set(p, d),
    },
  };
}

describe("browser guard RED triggers (real Chromium)", () => {
  test("console.error flips RED", async () => {
    const g = await launchGuarded({});
    await g.page.goto("data:text/html,<script>console.error('boom')</script>");
    await wait(300);
    const buckets = g.fixture.collector.collect();
    expect(buckets.consoleErrors.length).toBeGreaterThan(0);
    expect(guardFindings(buckets).length).toBeGreaterThan(0);
    await g.close();
  }, 30000);

  test("console.warning flips RED", async () => {
    const g = await launchGuarded({});
    await g.page.goto("data:text/html,<script>console.warn('warn')</script>");
    await wait(300);
    const buckets = g.fixture.collector.collect();
    expect(buckets.consoleWarnings.length).toBeGreaterThan(0);
    expect(isGreen({ findings: guardFindings(buckets), buckets })).toBe(false);
    await g.close();
  }, 30000);

  test("[tag] debug-log flips RED", async () => {
    const g = await launchGuarded({});
    await g.page.goto("data:text/html,<script>console.log('[tag] noisy')</script>");
    await wait(300);
    const buckets = g.fixture.collector.collect();
    expect(buckets.debugLogs.length).toBeGreaterThan(0);
    expect(guardFindings(buckets).length).toBeGreaterThan(0);
    await g.close();
  }, 30000);

  test("uncaught exception flips RED", async () => {
    const g = await launchGuarded({});
    await g.page.goto("data:text/html,<script>throw new Error('kaboom')</script>");
    await wait(300);
    const buckets = g.fixture.collector.collect();
    expect(buckets.exceptions.length).toBeGreaterThan(0);
    expect(guardFindings(buckets).length).toBeGreaterThan(0);
    await g.close();
  }, 30000);

  test("non-2xx response flips RED (500)", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    const g = await launchGuarded({});
    await g.page.goto(`http://127.0.0.1:${server.port}/`);
    await wait(300);
    const buckets = g.fixture.collector.collect();
    expect(buckets.badRequests.length).toBeGreaterThan(0);
    expect(buckets.badRequests[0].status).toBe(500);
    expect(guardFindings(buckets).length).toBeGreaterThan(0);
    await g.close();
    server.stop(true);
  }, 30000);

  test("aborted fetch stays GREEN", async () => {
    const g = await launchGuarded({});
    await g.page.goto(
      "data:text/html,<script>const c=new AbortController();fetch('http://127.0.0.1:39999/x',{signal:c.signal}).catch(()=>{});c.abort()</script>",
    );
    await wait(400);
    const buckets = g.fixture.collector.collect();
    expect(buckets.canceledRequests.length).toBeGreaterThan(0);
    expect(buckets.badRequests).toEqual([]);
    expect(guardFindings(buckets)).toEqual([]);
    await g.close();
  }, 30000);
});

describe("r1: worker / popup / service-worker capture", () => {
  test("dedicated worker console error flips RED", async () => {
    const g = await launchGuarded({});
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/w.js") return new Response("console.error('WORKER_ERR')", { headers: { "content-type": "application/javascript" } });
      return new Response(`<html><body><script>new Worker('/w.js')</script></body></html>`, { headers: { "content-type": "text/html" } });
    }});
    await g.page.goto(`http://127.0.0.1:${server.port}/`);
    await wait(1200);
    const buckets = g.fixture.collector.collect();
    expect(buckets.consoleErrors.some((e) => e.text.includes("WORKER_ERR"))).toBe(true);
    await g.close();
    server.stop(true);
  }, 30000);

  test("dedicated worker fetch 500 flips RED (network)", async () => {
    const g = await launchGuarded({});
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/w.js") return new Response("setTimeout(()=>fetch('/w500').then(()=>{}).catch(()=>{}), 400)", { headers: { "content-type": "application/javascript" } });
      if (u.pathname === "/w500") return new Response("boom", { status: 500 });
      return new Response(`<html><body><script>new Worker('/w.js')</script></body></html>`, { headers: { "content-type": "text/html" } });
    }});
    await g.page.goto(`http://127.0.0.1:${server.port}/`);
    await wait(1200);
    const buckets = g.fixture.collector.collect();
    expect(buckets.badRequests.some((b) => b.path === "/w500" && b.status === 500)).toBe(true);
    await g.close();
    server.stop(true);
  }, 30000);

  test("popup (window.open) console error + fetch 500 flips RED", async () => {
    const g = await launchGuarded({});
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/popup") return new Response("<script>console.error('POPUP_ERR')</script><script>fetch('/p500').then(()=>{}).catch(()=>{})</script>", { headers: { "content-type": "text/html" } });
      if (u.pathname === "/p500") return new Response("boom", { status: 500 });
      return new Response(`<html><body><script>window.open('/popup')</script></body></html>`, { headers: { "content-type": "text/html" } });
    }});
    await g.page.goto(`http://127.0.0.1:${server.port}/`);
    await wait(1500);
    const buckets = g.fixture.collector.collect();
    expect(buckets.consoleErrors.some((e) => e.text.includes("POPUP_ERR"))).toBe(true);
    expect(buckets.badRequests.some((b) => b.path === "/p500" && b.status === 500)).toBe(true);
    await g.close();
    server.stop(true);
  }, 30000);

  test("popup page-load 503 is captured (no fetch delay)", async () => {
    const g = await launchGuarded({});
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/popup") return new Response("boom", { status: 503 });
      return new Response(`<html><body><script>window.open('/popup')</script></body></html>`, { headers: { "content-type": "text/html" } });
    }});
    await g.page.goto(`http://127.0.0.1:${server.port}/`);
    await wait(1500);
    const buckets = g.fixture.collector.collect();
    expect(buckets.badRequests.some((b) => b.path === "/popup" && b.status === 503)).toBe(true);
    await g.close();
    server.stop(true);
  }, 30000);

  test("service worker console error flips RED", async () => {
    const g = await launchGuarded({});
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/sw.js") return new Response("console.error('SW_ERR')", { headers: { "content-type": "application/javascript" } });
      return new Response(`<html><body><script>navigator.serviceWorker.register('/sw.js')</script></body></html>`, { headers: { "content-type": "text/html" } });
    }});
    await g.page.goto(`http://127.0.0.1:${server.port}/`);
    await wait(1500);
    const buckets = g.fixture.collector.collect();
    expect(buckets.consoleErrors.some((e) => e.text.includes("SW_ERR"))).toBe(true);
    await g.close();
    server.stop(true);
  }, 30000);

  test("cross-origin iframe console error + 500 flips RED", async () => {
    const g = await launchGuarded({});
    const s2 = Bun.serve({ port: 0, fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/xiframe") return new Response("<script>console.error('X_IFRAME_ERR')</script><script>fetch('/x500').then(()=>{}).catch(()=>{})</script>", { headers: { "content-type": "text/html" } });
      if (u.pathname === "/x500") return new Response("boom", { status: 500 });
      return new Response("x", { headers: { "content-type": "text/html" } });
    }});
    const s1 = Bun.serve({ port: 0, fetch: () => new Response(`<html><body><iframe src="http://127.0.0.1:${s2.port}/xiframe"></iframe></body></html>`, { headers: { "content-type": "text/html" } }) });
    await g.page.goto(`http://127.0.0.1:${s1.port}/`);
    await wait(1500);
    const buckets = g.fixture.collector.collect();
    expect(buckets.consoleErrors.some((e) => e.text.includes("X_IFRAME_ERR"))).toBe(true);
    expect(buckets.badRequests.some((b) => b.path === "/x500" && b.status === 500)).toBe(true);
    await g.close();
    s1.stop(true); s2.stop(true);
  }, 30000);
});

describe("r1: dedupe, 503 x3, allowlist, redaction, DID-NOT-RUN", () => {
  test("same URL 503 x3 -> 3 distinct badRequests", async () => {
    const g = await launchGuarded({});
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/srv500") return new Response("boom", { status: 503 });
      return new Response("<html><body>root</body></html>", { headers: { "content-type": "text/html" } });
    }});
    await g.page.goto(`http://127.0.0.1:${server.port}/`);
    await g.page.evaluate("fetch('/srv500').catch(()=>{});fetch('/srv500').catch(()=>{});fetch('/srv500').catch(()=>{})");
    await wait(600);
    const buckets = g.fixture.collector.collect();
    const threes = buckets.badRequests.filter((b) => b.path === "/srv500" && b.status === 503);
    expect(threes.length).toBe(3);
    await g.close();
    server.stop(true);
  }, 30000);

  test("allowlist drops a known-safe finding; buckets keep it", async () => {
    const g = await launchGuarded({});
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const u = new URL(req.url);
      // Data icon: no automatic icon request; the only 404 is the one fetched.
      if (u.pathname === "/") return new Response("<html><head><link rel='icon' href='data:,'></head><body>root</body></html>", { headers: { "content-type": "text/html" } });
      if (u.pathname === "/missing") return new Response("boom", { status: 404 });
      return new Response("", { status: 200 });
    }});
    await g.page.goto(`http://127.0.0.1:${server.port}/`);
    await g.page.evaluate("fetch('/missing').catch(()=>{})");
    await wait(500);
    const buckets = g.fixture.collector.collect();
    const rows: AllowlistRow[] = [{ pattern: "/missing", why: "test fixture route", issue: "#0" }];
    expect(buckets.badRequests.some((b) => b.path === "/missing" && b.status === 404)).toBe(true);
    expect(guardFindings(buckets).length).toBeGreaterThan(0);
    expect(findingsWithAllowlist(buckets, rows)).toEqual([]);
    await g.close();
    server.stop(true);
  }, 30000);

  test("init-script token value redacted from evidence by default, whole script not treated as secret", async () => {
    const source = "window.__appcheck='TOPSECRETTOKEN123'";
    const dir = mkdtempSync(join(tmpdir(), "browser-guard-redact-"));
    // The real gate sets BROWSER_GUARD_INIT_SCRIPT in the spec process env; the
    // fixture (defaults to process.env) and the reporter (defaultSecrets) both
    // read that same source, so no secrets are passed by hand.
    const prev = process.env.BROWSER_GUARD_INIT_SCRIPT;
    process.env.BROWSER_GUARD_INIT_SCRIPT = source;
    try {
      const g = await launchGuarded();
      await g.page.goto("data:text/html,<script>console.error(window.__appcheck)</script>");
      await wait(400);
      const buckets = g.fixture.collector.collect();
      // The token value the page logged is present in the raw bucket text...
      expect(JSON.stringify(buckets)).toContain("TOPSECRETTOKEN123");
      const screenshot = (await (g.page as any).screenshot({ type: "png" })) as Uint8Array;
      const { files, sink } = memSink();
      // ...but reportGuardTest redacts it before it lands on disk, with no secrets
      // passed by hand — the default derives them from the env var.
      reportGuardTest({ testKey: "redact", buckets, screenshot, evidenceDir: dir, sink });
      const paths = evidencePathsFor(dir, "redact");
      const consoleJson = files.get(paths.consoleJsonPath) as string;
      const guardJson = files.get(paths.guardJsonPath) as string;
      expect(consoleJson).not.toContain("TOPSECRETTOKEN123");
      expect(guardJson).not.toContain("TOPSECRETTOKEN123");
      expect(consoleJson).toContain("<redacted>");
      // The init-script source itself is NOT the secret; only its literal values are.
      const init = initScriptFromEnv({ BROWSER_GUARD_INIT_SCRIPT: source });
      expect(redact(`hook failed: ${source}`, ["TOPSECRETTOKEN123"])).toBe("hook failed: window.__appcheck='<redacted>'");
      expect(init?.source).toBe(source);
      await g.close();
    } finally {
      if (prev === undefined) delete process.env.BROWSER_GUARD_INIT_SCRIPT;
      else process.env.BROWSER_GUARD_INIT_SCRIPT = prev;
    }
    rmSync(dir, { recursive: true, force: true });
  }, 30000);

  test("DID-NOT-RUN result is RED with empty buckets", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-guard-dnr-"));
    const { files, sink } = memSink();
    const result = didNotRunResult(dir, sink, "fp", "2026-01-01T00:00:00.000Z");
    expect(result.failed).toBe("[guard] DID-NOT-RUN: zero tests executed");
    expect(result.findings).toEqual(["[guard] DID-NOT-RUN: zero tests executed"]);
    expect(result.buckets.badRequests).toEqual([]);
    expect(files.size).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});