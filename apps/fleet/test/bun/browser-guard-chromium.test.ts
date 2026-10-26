import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchGuarded } from "./browser-guard-helper";
import { guardFindings, isGreen, writeEvidence, evidencePathsFor } from "../../container/gate/browser/guard/evidence";
import { initScriptFromEnv, redact } from "../../container/gate/browser/guard/init-script";
import type { EvidenceSink } from "../../container/gate/browser/guard/evidence";

// Real-Chromium integration: the RED triggers and the aborted-fetch
// exclusion, each against a live CDP session rather than the fake one.
// The fake session proves the rule in browser-guard-unit.test.ts; this
// file proves the rule against Chromium's actual event stream.

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
  test("console.error flips the guard RED", async () => {
    const g = await launchGuarded({});
    await g.page.goto("data:text/html,<script>console.error('boom')</script>");
    await wait(300);
    const buckets = g.fixture.capture.collect();
    expect(buckets.consoleErrors.length).toBeGreaterThan(0);
    expect(guardFindings(buckets).length).toBeGreaterThan(0);
    await g.close();
  }, 30000);

  test("console.warning flips the guard RED", async () => {
    const g = await launchGuarded({});
    await g.page.goto("data:text/html,<script>console.warn('warn')</script>");
    await wait(300);
    const buckets = g.fixture.capture.collect();
    expect(buckets.consoleWarnings.length).toBeGreaterThan(0);
    expect(isGreen({ findings: guardFindings(buckets), buckets })).toBe(false);
    await g.close();
  }, 30000);

  test("a [tag] debug-log line flips the guard RED", async () => {
    const g = await launchGuarded({});
    await g.page.goto("data:text/html,<script>console.log('[tag] noisy')</script>");
    await wait(300);
    const buckets = g.fixture.capture.collect();
    expect(buckets.debugLogs.length).toBeGreaterThan(0);
    expect(guardFindings(buckets).length).toBeGreaterThan(0);
    await g.close();
  }, 30000);

  test("an uncaught exception flips the guard RED", async () => {
    const g = await launchGuarded({});
    await g.page.goto("data:text/html,<script>throw new Error('kaboom')</script>");
    await wait(300);
    const buckets = g.fixture.capture.collect();
    expect(buckets.exceptions.length).toBeGreaterThan(0);
    expect(guardFindings(buckets).length).toBeGreaterThan(0);
    await g.close();
  }, 30000);

  test("a non-2xx response flips the guard RED", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    const g = await launchGuarded({});
    await g.page.goto(`http://127.0.0.1:${server.port}/`);
    await wait(300);
    const buckets = g.fixture.capture.collect();
    expect(buckets.badRequests.length).toBeGreaterThan(0);
    expect(buckets.badRequests[0].status).toBe(500);
    expect(guardFindings(buckets).length).toBeGreaterThan(0);
    await g.close();
    server.stop(true);
  }, 30000);

  test("a failed request (connection refused) flips the guard RED", async () => {
    const g = await launchGuarded({});
    await g.page.goto("data:text/html,<h1>refused host</h1>");
    await (g.page as any).evaluate("fetch('http://127.0.0.1:39999/definitely-not-there').catch(()=>{})");
    await wait(400);
    const buckets = g.fixture.capture.collect();
    // A refused connection is a loadingFailed with canceled:false -> badRequests.
    expect(buckets.badRequests.length).toBeGreaterThan(0);
    expect(guardFindings(buckets).length).toBeGreaterThan(0);
    await g.close();
  }, 30000);

  test("an aborted fetch stays GREEN", async () => {
    const g = await launchGuarded({});
    await g.page.goto(
      "data:text/html,<script>const c=new AbortController();fetch('http://127.0.0.1:1/x',{signal:c.signal}).catch(()=>{});c.abort()</script>",
    );
    await wait(400);
    const buckets = g.fixture.capture.collect();
    // The abort is a canceled loadingFailed -> canceledRequests, never a badRequest.
    expect(buckets.canceledRequests.length).toBeGreaterThan(0);
    expect(buckets.badRequests).toEqual([]);
    expect(guardFindings(buckets)).toEqual([]);
    expect(isGreen({ findings: guardFindings(buckets), buckets })).toBe(true);
    await g.close();
  }, 30000);

  test("a clean page stays GREEN", async () => {
    const g = await launchGuarded({});
    await g.page.goto("data:text/html,<h1>clean</h1>");
    await wait(300);
    const buckets = g.fixture.capture.collect();
    expect(guardFindings(buckets)).toEqual([]);
    expect(isGreen({ findings: guardFindings(buckets), buckets })).toBe(true);
    await g.close();
  }, 30000);
});

describe("per-test evidence", () => {
  test("writes console JSON + guard JSON + screenshot; a RED page's guard JSON says failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-guard-evidence-"));
    const g = await launchGuarded({});
    const screenshot = (await (g.page as any).screenshot({ type: "png" })) as Uint8Array;
    await g.page.goto("data:text/html,<script>console.error('evidence-boom')</script>");
    await wait(300);
    const buckets = g.fixture.capture.collect();
    const paths = evidencePathsFor(dir, "evidence-red");
    const { files, sink } = memSink();
    const result = writeEvidence(paths, buckets, screenshot, "fp-1", "2026-01-01T00:00:00.000Z", sink);
    expect(result.failed).toBe("[console] error evidence-boom");
    expect(files.get(paths.consoleJsonPath)).toBeDefined();
    expect(files.get(paths.guardJsonPath)).toBeDefined();
    expect(files.get(paths.screenshotPath)).toBe(screenshot);
    const consoleJson = JSON.parse(files.get(paths.consoleJsonPath) as string);
    expect(consoleJson.consoleErrors.length).toBeGreaterThan(0);
    expect(consoleJson.fingerprint).toBe("fp-1");
    await g.close();
    rmSync(dir, { recursive: true, force: true });
  }, 30000);

  test("init-script hook injects, and its env value is absent from every harness write", async () => {
    const source = "window.__appcheck='TOPSECRETTOKEN123'";
    const dir = mkdtempSync(join(tmpdir(), "browser-guard-redact-"));
    const g = await launchGuarded({ BROWSER_GUARD_INIT_SCRIPT: source });
    await g.page.goto("data:text/html,<h1>secret page</h1>");
    await wait(300);
    // The hook took effect: the page sees the injected global.
    const seen = await (g.page as any).evaluate("window.__appcheck");
    expect(seen).toBe("TOPSECRETTOKEN123");
    const buckets = g.fixture.capture.collect();
    const paths = evidencePathsFor(dir, "redact");
    const screenshot = (await (g.page as any).screenshot({ type: "png" })) as Uint8Array;
    const { files, sink } = memSink();
    writeEvidence(paths, buckets, screenshot, undefined, undefined, sink);
    const consoleJson = files.get(paths.consoleJsonPath) as string;
    const guardJson = files.get(paths.guardJsonPath) as string;
    // The harness's own writes never echo the init-script env value.
    expect(consoleJson).not.toContain(source);
    expect(guardJson).not.toContain(source);
    // And the one redaction seam the fixture uses scrubs the whole source.
    const init = initScriptFromEnv({ BROWSER_GUARD_INIT_SCRIPT: source });
    expect(redact(`browser-guard: failed: ${source}`, [init!.source])).toBe("browser-guard: failed: <redacted>");
    await g.close();
    rmSync(dir, { recursive: true, force: true });
  }, 30000);
});