import { describe, expect, test } from "bun:test";
import {
  Collector,
  consoleRawKey,
  exceptionRawKey,
  guardFindings,
  normalizeConsoleAPICalled,
  normalizeExceptionThrown,
  normalizeLoadingFailed,
  normalizeLogEntry,
  normalizeRequestWillBeSent,
  normalizeResponseReceived,
  urlPath,
  type CaptureBuckets,
} from "../../container/gate/browser/guard/capture";
import {
  applyInitScript,
  extractSecretValues,
  initScriptFromEnv,
  redact,
  secretsFromInitScript,
  INIT_SCRIPT_ENV,
} from "../../container/gate/browser/guard/init-script";
import {
  allowlistMatches,
  findingsWithAllowlist,
  isGreen,
  redactBuckets,
  verdictFromBuckets,
  type AllowlistRow,
  type GuardResult,
} from "../../container/gate/browser/guard/evidence";
import { isAuthForced, mailhogBase, multiUserEnv, AUTH_FORCE_ENV, MAILHOG_ENV } from "../../container/gate/browser/guard/multi-user";
import { DID_NOT_RUN_FINDING, GuardReporter } from "../../container/gate/browser/guard/reporter";
import type { EvidenceSink } from "../../container/gate/browser/guard/evidence";

function bucketsWith(b: Partial<CaptureBuckets>): CaptureBuckets {
  return { consoleErrors: [], consoleWarnings: [], debugLogs: [], exceptions: [], badRequests: [], canceledRequests: [], ...b };
}

const ERR = (type: string, text: string, ts?: number) => ({ type, text, source: "", at: ts === undefined ? "" : new Date(ts).toISOString() });

describe("Collector bucket rules", () => {
  test("console.error -> consoleErrors; warning -> consoleWarnings; assert -> errors", () => {
    const c = new Collector();
    c.consoleEvent("error", "e", "", "", "k1");
    c.consoleEvent("warning", "w", "", "", "k2");
    c.consoleEvent("assert", "a", "", "", "k3");
    expect(c.buckets.consoleErrors).toEqual([ERR("error", "e"), ERR("assert", "a")]);
    expect(c.buckets.consoleWarnings).toEqual([ERR("warning", "w")]);
  });

  test("[tag] log -> debugLogs; non-tagged log ignored", () => {
    const c = new Collector();
    c.consoleEvent("log", "[tag] ctx", "", "", "k1");
    c.consoleEvent("log", "ordinary", "", "", "k2");
    expect(c.buckets.debugLogs).toEqual([{ type: "log", text: "[tag] ctx" }]);
  });

  test("two identical lines at distinct raw timestamps are NOT merged", () => {
    const c = new Collector();
    c.consoleEvent("error", "dup", "", "", consoleRawKey(1000.1, "error", "dup", ""));
    c.consoleEvent("error", "dup", "", "", consoleRawKey(1000.2, "error", "dup", ""));
    expect(c.buckets.consoleErrors.length).toBe(2);
  });

  test("Runtime + Log reporting one line dedupes on the same raw key", () => {
    const c = new Collector();
    c.consoleEvent("error", "dup", "", "", consoleRawKey(1000.1, "error", "dup", ""));
    c.consoleEvent("error", "dup", "", "", consoleRawKey(1000.1, "error", "dup", ""));
    expect(c.buckets.consoleErrors.length).toBe(1);
  });

  test("debug + exception keys include raw timestamp", () => {
    const c = new Collector();
    c.debugLog("log", "[tag] x", "1000.3|[tag] x");
    c.debugLog("log", "[tag] x", "1000.3|[tag] x");
    expect(c.buckets.debugLogs.length).toBe(1);
    c.exception("err", "", exceptionRawKey(1000.4, "err", ""));
    c.exception("err", "", exceptionRawKey(1000.5, "err", ""));
    expect(c.buckets.exceptions.length).toBe(2);
  });

  test("a 404 and a 500 are two distinct badRequests", () => {
    const c = new Collector();
    c.badRequest({ method: "GET", path: "/a", status: 404, errorText: "", type: "Fetch" }, "r1");
    c.badRequest({ method: "GET", path: "/b", status: 500, errorText: "", type: "Fetch" }, "r2");
    expect(c.buckets.badRequests.length).toBe(2);
  });

  test("same requestId counts once across a >=400 response + non-canceled failure", () => {
    const c = new Collector();
    c.badRequest({ method: "GET", path: "/a", status: 503, errorText: "", type: "Fetch" }, "r1");
    c.badRequest({ method: "GET", path: "/a", status: 0, errorText: "aborted", type: "Fetch" }, "r1");
    expect(c.buckets.badRequests.length).toBe(1);
  });

  test("canceled loadingFailed -> canceledRequests, never badRequests", () => {
    const c = new Collector();
    const n = normalizeLoadingFailed({ errorText: "net::ERR_ABORTED", canceled: true, type: "Fetch" }, "GET", "http://a/y", "Fetch");
    if ("canceled" in n) c.canceledRequest(n); else c.badRequest(n, "r");
    expect(c.buckets.canceledRequests).toEqual([{ method: "GET", path: "/y", status: 0, errorText: "net::ERR_ABORTED", type: "Fetch", canceled: true }]);
    expect(c.buckets.badRequests).toEqual([]);
  });
});

describe("normalizers", () => {
  test("consoleAPICalled normalizes + non-empty text only", () => {
    expect(normalizeConsoleAPICalled({ type: "error", args: [{ value: "boom" }], timestamp: 1000 })?.text).toBe("boom");
    expect(normalizeConsoleAPICalled({ type: "error", args: [], timestamp: 1000 })).toBeNull();
  });

  test("Log network-source entry is dropped (HTTP faults from Network only)", () => {
    expect(normalizeLogEntry({ entry: { level: "error", source: "network", text: "Failed to load resource", timestamp: 1000 } })).toBeNull();
    expect(normalizeLogEntry({ entry: { level: "error", source: "javascript", text: "x", timestamp: 1000 }})?.type).toBe("error");
  });

  test("exceptionThrown normalizes + skips empty", () => {
    expect(normalizeExceptionThrown({ exceptionDetails: { exception: { description: "TypeError" }, url: "http://a/" } })?.text).toBe("TypeError");
    expect(normalizeExceptionThrown({})).toBeNull();
  });

  test("responseReceived >= 400 -> bad; 404 and 500 both bad", () => {
    expect(normalizeResponseReceived({ response: { status: 404 } }, "GET", "http://a/x", "Fetch")?.status).toBe(404);
    expect(normalizeResponseReceived({ response: { status: 500 } }, "GET", "http://a/x", "Fetch")?.status).toBe(500);
    expect(normalizeResponseReceived({ response: { status: 200 } }, "GET", "http://a/x", "Fetch")).toBeNull();
  });

  test("requestWillBeSent keeps method/url for later events", () => {
    expect(normalizeRequestWillBeSent({ requestId: "r1", request: { method: "POST", url: "http://a/z" }, type: "XHR" })).toEqual({ requestId: "r1", method: "POST", url: "http://a/z", type: "XHR" });
  });
});

describe("RED rule (guardFindings)", () => {
  test("each RED trigger has a finding; canceled never flags", () => {
    const b = bucketsWith({
      consoleErrors: [ERR("error", "e")],
      consoleWarnings: [ERR("warning", "w")],
      debugLogs: [{ type: "log", text: "[tag] d" }],
      exceptions: [{ text: "x", url: "" }],
      badRequests: [{ method: "GET", path: "/p", status: 500, errorText: "", type: "Fetch" }],
      canceledRequests: [{ method: "GET", path: "/c", status: 0, errorText: "aborted", type: "Fetch", canceled: true }],
    });
    const findings = guardFindings(b);
    expect(findings.length).toBe(5);
    expect(findings).toContain("[console] error e");
    expect(findings).toContain("[console] warning w");
    expect(findings).toContain("[debug-log] [tag] d");
    expect(findings).toContain("[exception] x");
    expect(findings).toContain("[network] 500 /p");
  });

  test("verdictFromBuckets sets failed to the first finding", () => {
    const b = bucketsWith({ consoleErrors: [ERR("error", "first")] });
    const r: GuardResult = verdictFromBuckets(b, { fingerprint: "fp", at: "2026-01-01T00:00:00.000Z" });
    expect(r.failed).toBe("[console] error first");
    expect(isGreen(r)).toBe(false);
  });
});

describe("allowlist", () => {
  const rows: AllowlistRow[] = [{ pattern: "/analytics-ping", why: "third-party telemetry beacon", issue: "#1" }];

  test("a row requires pattern + why + issue and matches by literal substring", () => {
    expect(allowlistMatches("[network] 404 /analytics-ping", rows)).toBe(true);
    expect(allowlistMatches("[network] 404 /api", rows)).toBe(false);
  });

  test("allowlist filters a finding out of the verdict but buckets keep it", () => {
    const b = bucketsWith({ badRequests: [{ method: "GET", path: "/analytics-ping", status: 404, errorText: "", type: "Fetch" }] });
    const r = verdictFromBuckets(b, { allowlist: rows });
    expect(r.findings).toEqual([]);
    expect(r.buckets.badRequests.length).toBe(1);
    expect(isGreen(r)).toBe(true);
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

describe("init-script env + redaction", () => {
  test("absent/blank env -> null; set env -> source", () => {
    expect(initScriptFromEnv({})).toBeNull();
    expect(initScriptFromEnv({ [INIT_SCRIPT_ENV]: "  " })).toBeNull();
    expect(initScriptFromEnv({ [INIT_SCRIPT_ENV]: "window.__t='abc'" })?.source).toBe("window.__t='abc'");
  });

  test("applyInitScript sends Page.addScriptToEvaluateOnNewDocument", async () => {
    const sent: Array<{ method: string; params?: unknown }> = [];
    await applyInitScript({ send: (m, p) => { sent.push({ method: m, params: p }); return Promise.resolve(undefined); } }, "window.__x=1");
    expect(sent).toEqual([{ method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "window.__x=1" } }]);
  });

  test("extractSecretValues picks string literals, not the whole script", () => {
    expect(extractSecretValues("window.__a='TOKEN1'; window.__b=\"TOKEN2\"")).toEqual(["TOKEN1", "TOKEN2"]);
    expect(extractSecretValues("window.__a=1")).toEqual([]);
  });

  test("secretsFromInitScript returns the literal values", () => {
    const r = initScriptFromEnv({ [INIT_SCRIPT_ENV]: "window.__t='s3cr3t'" });
    expect(secretsFromInitScript(r)).toEqual(["s3cr3t"]);
  });

  test("redact removes every secret occurrence", () => {
    expect(redact("tok=SECRET and SECRET again", ["SECRET"])).toBe("tok=<redacted> and <redacted> again");
  });

  test("redactBuckets scrubs token values in every bucket text field", () => {
    const b = bucketsWith({
      consoleErrors: [ERR("error", "boom TOKEN1")],
      consoleWarnings: [ERR("warning", "TOKEN2 w")],
      debugLogs: [{ type: "log", text: "TOKEN1 d" }],
      exceptions: [{ text: "TOKEN2 x", url: "http://a/TOKEN1" }],
      badRequests: [{ method: "GET", path: "/TOKEN1", status: 500, errorText: "TOKEN2", type: "Fetch" }],
      canceledRequests: [{ method: "GET", path: "/TOKEN1", status: 0, errorText: "TOKEN2", type: "Fetch", canceled: true }],
    });
    redactBuckets(b, ["TOKEN1", "TOKEN2"]);
    expect(b.consoleErrors[0].text).toBe("boom <redacted>");
    expect(b.consoleWarnings[0].text).toBe("<redacted> w");
    expect(b.debugLogs[0].text).toBe("<redacted> d");
    expect(b.exceptions[0].text).toBe("<redacted> x");
    expect(b.exceptions[0].url).toBe("http://a/<redacted>");
    expect(b.badRequests[0].path).toBe("/<redacted>");
    expect(b.badRequests[0].errorText).toBe("<redacted>");
    expect(b.canceledRequests[0].path).toBe("/<redacted>");
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
describe("reporter DID-NOT-RUN", () => {
  const memFiles = new Map<string, string | Uint8Array>();
  const sink: EvidenceSink = { mkdir: () => {}, writeFile: (p, d) => memFiles.set(p, d) };

  test("GuardReporter.onEnd(0) writes a RED DID-NOT-RUN result", () => {
    const r = new GuardReporter({ evidenceDir: "/tmp/ev", sink });
    r.onEnd(0);
    const guardJson = [...memFiles.values()].find((v) => typeof v === "string" && v.includes(DID_NOT_RUN_FINDING));
    expect(guardJson).toBeDefined();
  });

  test("GuardReporter.onEnd(>0) writes no DID-NOT-RUN", () => {
    memFiles.clear();
    const r = new GuardReporter({ evidenceDir: "/tmp/ev", sink });
    r.onEnd(3);
    const guardJson = [...memFiles.values()].find((v) => typeof v === "string" && v.includes(DID_NOT_RUN_FINDING));
    expect(guardJson).toBeUndefined();
  });
});

describe("guard UA", () => {
  test("guardUserAgent derives from the browser's own version", async () => {
    const { guardUserAgent } = await import("../../container/gate/browser/guard/fixture");
    const ua = await guardUserAgent({ version: async () => "131.0.6778.85" });
    expect(ua).toContain("Chrome/131.0.6778.85");
    expect(ua).not.toContain("Chrome/124");
  });
});
