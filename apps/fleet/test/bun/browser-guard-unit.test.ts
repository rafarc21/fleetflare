import { describe, expect, test } from "bun:test";
import {
  startCapture,
  urlPath,
  type CaptureBuckets,
  type CdpSessionLike,
} from "../../container/gate/browser/guard/capture";
import { applyInitScript, initScriptFromEnv, redact, secretsFromInitScript, INIT_SCRIPT_ENV } from "../../container/gate/browser/guard/init-script";
import { guardFindings, isGreen, verdictFromBuckets, type GuardResult } from "../../container/gate/browser/guard/evidence";
import { isAuthForced, mailhogBase, multiUserEnv, AUTH_FORCE_ENV, MAILHOG_ENV } from "../../container/gate/browser/guard/multi-user";

// A scriptable fake CDP session: fire(event, params) invokes every handler.
class FakeCdp implements CdpSessionLike {
  sent: Array<{ method: string; params?: unknown }> = [];
  private handlers = new Map<string, Array<(p: any) => void>>();
  send(method: string, params?: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    return Promise.resolve(undefined);
  }
  on(event: string, handler: (p: any) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  off(event: string, handler: (p: any) => void): void {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(event, list.filter((h) => h !== handler));
  }
  fire(event: string, params: any): void {
    for (const h of this.handlers.get(event) ?? []) h(params);
  }
}

function bucketsWith(b: Partial<CaptureBuckets>): CaptureBuckets {
  return { consoleErrors: [], consoleWarnings: [], debugLogs: [], exceptions: [], badRequests: [], canceledRequests: [], ...b };
}

describe("capture buckets (fake CDP)", () => {
  test("console.error -> consoleErrors", () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp);
    cdp.fire("Runtime.consoleAPICalled", { type: "error", args: [{ value: "boom" }], timestamp: 1000 });
    expect(h.buckets.consoleErrors).toEqual([{ type: "error", text: "boom", source: "", at: new Date(1000).toISOString() }]);
    expect(h.buckets.consoleWarnings).toEqual([]);
  });

  test("console.warning -> consoleWarnings", () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp);
    cdp.fire("Runtime.consoleAPICalled", { type: "warning", args: [{ value: "careful" }], timestamp: 2000 });
    expect(h.buckets.consoleWarnings).toEqual([{ type: "warning", text: "careful", source: "", at: new Date(2000).toISOString() }]);
  });

  test("console.assert -> consoleErrors (assert is an error level)", () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp);
    cdp.fire("Runtime.consoleAPICalled", { type: "assert", args: [{ value: "nope" }], timestamp: 3000 });
    expect(h.buckets.consoleErrors.length).toBe(1);
    expect(h.buckets.consoleErrors[0].type).toBe("assert");
  });

  test("[tag] debug log -> debugLogs; non-tagged log ignored", () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp);
    cdp.fire("Runtime.consoleAPICalled", { type: "log", args: [{ value: "[tag] ctx" }], timestamp: 4000 });
    cdp.fire("Runtime.consoleAPICalled", { type: "log", args: [{ value: "ordinary line" }], timestamp: 5000 });
    expect(h.buckets.debugLogs).toEqual([{ type: "log", text: "[tag] ctx" }]);
  });

  test("exceptionThrown -> exceptions", () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp);
    cdp.fire("Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "TypeError: x" }, url: "http://a/" } });
    expect(h.buckets.exceptions).toEqual([{ text: "TypeError: x", url: "http://a/" }]);
  });

  test("responseReceived >= 400 -> badRequests", () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp);
    cdp.fire("Network.requestWillBeSent", { requestId: "1", request: { method: "GET", url: "http://a/api" }, type: "Fetch" });
    cdp.fire("Network.responseReceived", { requestId: "1", type: "Fetch", response: { status: 500, url: "http://a/api" } });
    expect(h.buckets.badRequests).toEqual([{ method: "GET", path: "/api", status: 500, errorText: "", type: "Fetch" }]);
  });

  test("loadingFailed canceled:false -> badRequests", () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp);
    cdp.fire("Network.requestWillBeSent", { requestId: "2", request: { method: "POST", url: "http://a/x" }, type: "XHR" });
    cdp.fire("Network.loadingFailed", { requestId: "2", type: "XHR", errorText: "net::ERR_CONNECTION_REFUSED", canceled: false });
    expect(h.buckets.badRequests).toEqual([{ method: "POST", path: "/x", status: 0, errorText: "net::ERR_CONNECTION_REFUSED", type: "XHR" }]);
  });

  test("loadingFailed canceled:true -> canceledRequests only, never badRequests", () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp);
    cdp.fire("Network.requestWillBeSent", { requestId: "3", request: { method: "GET", url: "http://a/y" }, type: "Fetch" });
    cdp.fire("Network.loadingFailed", { requestId: "3", type: "Fetch", errorText: "net::ERR_ABORTED", canceled: true });
    expect(h.buckets.canceledRequests).toEqual([{ method: "GET", path: "/y", status: 0, errorText: "net::ERR_ABORTED", type: "Fetch", canceled: true }]);
    expect(h.buckets.badRequests).toEqual([]);
  });

  test("a 500 response followed by canceled loadingFailed counts once in badRequests", () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp);
    cdp.fire("Network.requestWillBeSent", { requestId: "4", request: { method: "GET", url: "http://a/z" }, type: "Fetch" });
    cdp.fire("Network.responseReceived", { requestId: "4", type: "Fetch", response: { status: 503, url: "http://a/z" } });
    cdp.fire("Network.loadingFailed", { requestId: "4", type: "Fetch", errorText: "net::ERR_ABORTED", canceled: true });
    expect(h.buckets.badRequests.length).toBe(1);
  });

  test("Runtime + Log both reporting one line dedupes by timestamp/type/text", () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp);
    cdp.fire("Runtime.consoleAPICalled", { type: "error", args: [{ value: "dup" }], timestamp: 6000 });
    cdp.fire("Log.entryAdded", { entry: { level: "error", text: "dup", timestamp: 6000 } });
    expect(h.buckets.consoleErrors.length).toBe(1);
  });

  test("custom debugTag", () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp, { debugTag: "DBG:" });
    cdp.fire("Runtime.consoleAPICalled", { type: "log", args: [{ value: "DBG: hello" }], timestamp: 7000 });
    expect(h.buckets.debugLogs).toEqual([{ type: "log", text: "DBG: hello" }]);
  });

  test("enable sends the three protocol enables", async () => {
    const cdp = new FakeCdp();
    const h = startCapture(cdp);
    await h.enable();
    expect(cdp.sent.map((s) => s.method)).toEqual(["Runtime.enable", "Log.enable", "Network.enable"]);
  });
});

describe("RED rule (guardFindings)", () => {
  test("each RED trigger has a finding", () => {
    const b = bucketsWith({
      consoleErrors: [{ type: "error", text: "e", source: "", at: "" }],
      consoleWarnings: [{ type: "warning", text: "w", source: "", at: "" }],
      debugLogs: [{ type: "log", text: "[tag] d" }],
      exceptions: [{ text: "x", url: "" }],
      badRequests: [{ method: "GET", path: "/p", status: 500, errorText: "", type: "Fetch" }],
    });
    const findings = guardFindings(b);
    expect(findings.length).toBe(5);
    expect(findings).toContain("[console] error e");
    expect(findings).toContain("[console] warning w");
    expect(findings).toContain("[debug-log] [tag] d");
    expect(findings).toContain("[exception] x");
    expect(findings).toContain("[network] 500 /p");
  });

  test("canceled requests never flag", () => {
    const b = bucketsWith({ canceledRequests: [{ method: "GET", path: "/c", status: 0, errorText: "aborted", type: "Fetch", canceled: true }] });
    const r = verdictFromBuckets(b);
    expect(r.findings).toEqual([]);
    expect(isGreen(r)).toBe(true);
  });

  test("verdictFromBuckets sets failed to the first finding", () => {
    const b = bucketsWith({ consoleErrors: [{ type: "error", text: "first", source: "", at: "" }] });
    const r: GuardResult = verdictFromBuckets(b, "fp", "2026-01-01T00:00:00.000Z");
    expect(r.failed).toBe("[console] error first");
    expect(r.fingerprint).toBe("fp");
    expect(r.at).toBe("2026-01-01T00:00:00.000Z");
    expect(isGreen(r)).toBe(false);
  });
});

describe("urlPath", () => {
  test("absolute http URL -> pathname", () => {
    expect(urlPath("http://a/b/c?q=1")).toBe("/b/c");
  });
  test("data: URL parses to its pathname label", () => {
    expect(urlPath("data:text/html,hi")).toBe("text/html,hi");
  });
  test("malformed URL passes through", () => {
    expect(urlPath("not a url at all")).toBe("not a url at all");
  });
});

describe("init-script env", () => {
  test("absent env -> null", () => {
    expect(initScriptFromEnv({})).toBeNull();
  });
  test("blank env -> null", () => {
    expect(initScriptFromEnv({ [INIT_SCRIPT_ENV]: "  " })).toBeNull();
  });
  test("set env -> source", () => {
    const r = initScriptFromEnv({ [INIT_SCRIPT_ENV]: "window.__tok='abc'" });
    expect(r?.source).toBe("window.__tok='abc'");
  });
  test("applyInitScript sends Page.addScriptToEvaluateOnNewDocument", async () => {
    const cdp = new FakeCdp();
    await applyInitScript(cdp, "window.__x=1");
    expect(cdp.sent).toEqual([{ method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "window.__x=1" } }]);
  });
  test("redact removes every secret occurrence", () => {
    expect(redact("tok=SECRET and SECRET again", ["SECRET"])).toBe("tok=<redacted> and <redacted> again");
  });
  test("secretsFromInitScript returns the raw source as the secret", () => {
    const r = initScriptFromEnv({ [INIT_SCRIPT_ENV]: "window.__t='s3cr3t'" });
    expect(secretsFromInitScript(r)).toEqual(["window.__t='s3cr3t'"]);
  });
});

describe("multi-user env", () => {
  test("auth force is the exact literal 'on'", () => {
    expect(isAuthForced(multiUserEnv({ [AUTH_FORCE_ENV]: "on" }))).toBe(true);
    expect(isAuthForced(multiUserEnv({ [AUTH_FORCE_ENV]: "1" }))).toBe(false);
    expect(isAuthForced(multiUserEnv({}))).toBe(false);
  });
  test("mailhog base trims the trailing slash", () => {
    expect(mailhogBase(multiUserEnv({ [MAILHOG_ENV]: "http://127.0.0.1:8025/" }))).toBe("http://127.0.0.1:8025");
    expect(mailhogBase(multiUserEnv({}))).toBe("");
  });
});