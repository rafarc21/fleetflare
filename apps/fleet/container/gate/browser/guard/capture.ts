// container/gate/browser/guard/capture.ts
//
// CDP console/network capture for the browser guard harness. Pure, no
// playwright-core import: it drives any structurally-compatible CDP session
// (playwright-core's CDPSession, @playwright/test's, a browser-leg shim's),
// so the same module runs in the gate image and in a consumer repo's spec
// process. Bucket names match the shared walk/gate console schema (issue
// #1344 comment 6412381014): consoleErrors, consoleWarnings, debugLogs,
// exceptions, badRequests, canceledRequests. Do not rename them.
//
// Capture rules (shared schema, measured — do not re-derive):
//   - Runtime.enable + Log.enable + Network.enable.
//   - Runtime.consoleAPICalled error|warning|assert -> consoleErrors /
//     consoleWarnings; log|info|debug whose text starts "[tag]" -> debugLogs.
//   - Runtime.exceptionThrown -> exceptions.
//   - Network.responseReceived status>=400 -> badRequests.
//   - Network.loadingFailed canceled:false -> badRequests; canceled:true ->
//     canceledRequests (ignored by the RED rule).
//   - Log.enable replays old entries, and Runtime + Log both report one
//     console line: dedupe by timestamp+type+text.

export interface CdpSessionLike {
  send(method: string, params?: unknown): Promise<unknown>;
  on(event: string, handler: (params: any) => void): void;
  off(event: string, handler: (params: any) => void): void;
}

/** The one surface capture needs from a page: a CDP session for that page. */
export interface PageLike {
  context(): { newCDPSession(page: unknown): Promise<CdpSessionLike> };
}

export interface ConsoleEntry { type: string; text: string; source: string; at: string; }
export interface DebugLogEntry { type: string; text: string; }
export interface ExceptionEntry { text: string; url: string; }
export interface BadRequestEntry { method: string; path: string; status: number; errorText: string; type: string; }
export interface CanceledRequestEntry { method: string; path: string; status: number; errorText: string; type: string; canceled: true; }

export interface CaptureBuckets {
  consoleErrors: ConsoleEntry[];
  consoleWarnings: ConsoleEntry[];
  debugLogs: DebugLogEntry[];
  exceptions: ExceptionEntry[];
  badRequests: BadRequestEntry[];
  canceledRequests: CanceledRequestEntry[];
}

export function emptyBuckets(): CaptureBuckets {
  return { consoleErrors: [], consoleWarnings: [], debugLogs: [], exceptions: [], badRequests: [], canceledRequests: [] };
}

export const DEFAULT_DEBUG_TAG = "[tag]";

export interface CaptureOpts {
  /** The debug-log prefix that flags a line as a debugLog. */
  debugTag?: string;
}

const isErrorLevel = (type: string) => type === "error" || type === "assert";
const isWarningLevel = (type: string) => type === "warning";

/** A CDP RemoteObject to display text. Primitives use their value; objects
 *  fall back to the protocol-provided description, then JSON. */
function remoteText(value: any, description: string | undefined): string {
  if (value !== undefined && value !== null && typeof value !== "object") return String(value);
  if (description) return description;
  if (value !== undefined && value !== null) {
    try { return JSON.stringify(value); } catch { /* fall through to empty */ }
  }
  return "";
}

function isoAt(ms: number | undefined): string {
  return ms === undefined ? "" : new Date(ms).toISOString();
}

/** A URL's pathname, falling back to the raw string for non-URL inputs
 *  (data:, blob:). The path only labels an entry; a parse miss is not an error. */
export function urlPath(url: string): string {
  try { return new URL(url).pathname || url; } catch { return url; }
}

export interface CaptureHandle {
  buckets: CaptureBuckets;
  /** Sends the three enable commands. Call once, before navigation. */
  enable(): Promise<void>;
  /** A deep copy of the current buckets. */
  collect(): CaptureBuckets;
  reset(): void;
  dispose(): void;
}

export function startCapture(session: CdpSessionLike, opts: CaptureOpts = {}): CaptureHandle {
  const debugTag = opts.debugTag ?? DEFAULT_DEBUG_TAG;
  const buckets = emptyBuckets();
  // Runtime + Log both report one console line; Log.enable replays old ones.
  const seen = new Set<string>();
  const seenBadRequestIds = new Set<string>();
  const requests = new Map<string, { method: string; url: string; type: string }>();

  const pushConsole = (bucket: ConsoleEntry[], type: string, text: string, source: string, at: string): void => {
    if (text === "") return;
    if (seen.has(`${source}|${at}|${type}|${text}`)) return;
    seen.add(`${source}|${at}|${type}|${text}`);
    bucket.push({ type, text, source, at });
  };

  const pushDebugLog = (type: string, text: string): void => {
    if (text === "") return;
    if (seen.has(`debug|${type}|${text}`)) return;
    seen.add(`debug|${type}|${text}`);
    buckets.debugLogs.push({ type, text });
  };

  const pushException = (text: string, url: string): void => {
    if (text === "" && url === "") return;
    if (seen.has(`exc|${text}|${url}`)) return;
    seen.add(`exc|${text}|${url}`);
    buckets.exceptions.push({ text, url });
  };

  // A request that both gets a 4xx/5xx response AND fails counts once.
  const pushBad = (entry: BadRequestEntry, requestId: string): void => {
    if (seenBadRequestIds.has(requestId)) return;
    seenBadRequestIds.add(requestId);
    buckets.badRequests.push(entry);
  };

  const onConsoleAPICalled = (e: any): void => {
    const text = (e.args ?? []).map((a: any) => remoteText(a.value, a.description)).join(" ").trim();
    const type = String(e.type ?? "");
    const at = isoAt(e.timestamp);
    const source = e.stackTrace?.callFrames?.[0]?.url ?? "";
    if (isErrorLevel(type)) pushConsole(buckets.consoleErrors, type, text, source, at);
    else if (isWarningLevel(type)) pushConsole(buckets.consoleWarnings, type, text, source, at);
    else if (text.startsWith(debugTag)) pushDebugLog(type, text);
  };

  const onLogEntryAdded = (e: any): void => {
    const entry = e.entry ?? {};
    const level = String(entry.level ?? "");
    const text = String(entry.text ?? "").trim();
    const at = isoAt(entry.timestamp);
    const source = String(entry.source ?? "");
    if (level === "error") pushConsole(buckets.consoleErrors, "error", text, source, at);
    else if (level === "warning") pushConsole(buckets.consoleWarnings, "warning", text, source, at);
    else if (text.startsWith(debugTag)) pushDebugLog(level || "log", text);
  };

  const onExceptionThrown = (e: any): void => {
    const d = e.exceptionDetails ?? {};
    const text = d.exception?.description ?? d.text ?? "";
    const url = d.url ?? "";
    pushException(String(text), String(url));
  };

  const onRequestWillBeSent = (e: any): void => {
    requests.set(e.requestId, { method: e.request?.method ?? "", url: e.request?.url ?? "", type: e.type ?? "" });
  };

  const onResponseReceived = (e: any): void => {
    const status = Number(e.response?.status ?? 0);
    if (status < 400) return;
    const r = requests.get(e.requestId) ?? { method: "", url: e.response?.url ?? "", type: e.type ?? "" };
    pushBad(
      { method: r.method, path: urlPath(r.url || e.response?.url || ""), status, errorText: "", type: e.type ?? r.type },
      e.requestId,
    );
  };

  const onLoadingFailed = (e: any): void => {
    const r = requests.get(e.requestId) ?? { method: "", url: "", type: e.type ?? "" };
    const base = { method: r.method, path: urlPath(r.url), status: 0, errorText: String(e.errorText ?? ""), type: e.type ?? r.type };
    if (e.canceled === true) {
      buckets.canceledRequests.push({ ...base, canceled: true });
    } else {
      pushBad({ ...base }, e.requestId);
    }
  };

  const handlers: Array<[string, (p: any) => void]> = [
    ["Runtime.consoleAPICalled", onConsoleAPICalled],
    ["Log.entryAdded", onLogEntryAdded],
    ["Runtime.exceptionThrown", onExceptionThrown],
    ["Network.requestWillBeSent", onRequestWillBeSent],
    ["Network.responseReceived", onResponseReceived],
    ["Network.loadingFailed", onLoadingFailed],
  ];
  for (const [event, handler] of handlers) session.on(event, handler);

  const enable = async (): Promise<void> => {
    await session.send("Runtime.enable");
    await session.send("Log.enable");
    await session.send("Network.enable");
  };

  return {
    buckets,
    enable,
    collect: () => JSON.parse(JSON.stringify(buckets)) as CaptureBuckets,
    reset: () => { Object.assign(buckets, emptyBuckets()); seen.clear(); seenBadRequestIds.clear(); requests.clear(); },
    dispose: () => { for (const [event, handler] of handlers) session.off(event, handler); },
  };
}