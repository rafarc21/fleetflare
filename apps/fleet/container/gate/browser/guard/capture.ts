// container/gate/browser/guard/capture.ts
//
// Console/network RED rule + the collector every capture source feeds. Pure —
// no playwright-core import — so the gate image needs no node_modules and the
// same module runs in a consumer repo's spec process.
//
// Bucket names match the shared walk/gate console schema (issue #1344 comment
// 6412381014): consoleErrors, consoleWarnings, debugLogs, exceptions,
// badRequests, canceledRequests. Do not rename them.
//
// Capture rules (measured, do not re-derive):
//   - consoleAPICalled error|warning|assert -> consoleErrors / consoleWarnings;
//     log|info|debug whose text starts "[tag]" -> debugLogs.
//   - exceptionThrown -> exceptions.
//   - responseReceived status >= 400 -> badRequests.
//   - loadingFailed canceled:false -> badRequests; canceled:true ->
//     canceledRequests (ignored by the RED rule).
//   - Log.enable replays old entries and Runtime + Log both report one line:
//     dedupe by raw float timestamp + text + type in every bucket.
//   - HTTP faults count from Network events only: a Log entry with
//     source "network" (Chromium's "Failed to load resource") is dropped here;
//     the request stays in badRequests via the Network path.

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

/** The collector: one set of buckets every CDP source (main page, workers,
 *  service workers, popups) feeds. Each push is deduped on a caller-supplied
 *  raw key (raw float timestamp + text + type), never an ms-truncated ISO. */
export class Collector {
  readonly buckets: CaptureBuckets = emptyBuckets();
  private readonly debugTag: string;
  private readonly seenConsole = new Set<string>();
  private readonly seenDebug = new Set<string>();
  private readonly seenException = new Set<string>();
  private readonly seenBad = new Set<string>();

  constructor(opts: CaptureOpts = {}) {
    this.debugTag = opts.debugTag ?? DEFAULT_DEBUG_TAG;
  }

  private pushConsole(bucket: ConsoleEntry[], type: string, text: string, source: string, at: string, rawKey: string): void {
    if (text === "") return;
    if (this.seenConsole.has(rawKey)) return;
    this.seenConsole.add(rawKey);
    bucket.push({ type, text, source, at });
  }

  consoleEvent(type: string, text: string, source: string, at: string, rawKey: string): void {
    if (type === "error" || type === "assert") this.pushConsole(this.buckets.consoleErrors, type, text, source, at, rawKey);
    else if (type === "warning") this.pushConsole(this.buckets.consoleWarnings, type, text, source, at, rawKey);
    else if (text.startsWith(this.debugTag)) this.debugLog(type, text, rawKey);
  }

  debugLog(type: string, text: string, rawKey: string): void {
    if (text === "") return;
    if (this.seenDebug.has(rawKey)) return;
    this.seenDebug.add(rawKey);
    this.buckets.debugLogs.push({ type, text });
  }

  exception(text: string, url: string, rawKey: string): void {
    if (text === "" && url === "") return;
    if (this.seenException.has(rawKey)) return;
    this.seenException.add(rawKey);
    this.buckets.exceptions.push({ text, url });
  }

  /** A bad HTTP request. `rawKey` is the requestId: one request that gets
   *  both a >=400 response and a non-canceled loadingFailed counts once, and
   *  N distinct requests count N times. */
  badRequest(entry: BadRequestEntry, rawKey: string): void {
    if (this.seenBad.has(rawKey)) return;
    this.seenBad.add(rawKey);
    this.buckets.badRequests.push(entry);
  }

  canceledRequest(entry: CanceledRequestEntry): void {
    this.buckets.canceledRequests.push(entry);
  }

  collect(): CaptureBuckets {
    return JSON.parse(JSON.stringify(this.buckets)) as CaptureBuckets;
  }

  reset(): void {
    Object.assign(this.buckets, emptyBuckets());
    this.seenConsole.clear();
    this.seenDebug.clear();
    this.seenException.clear();
    this.seenBad.clear();
  }
}

/** A URL's pathname, falling back to the raw string for non-URL inputs
 *  (data:, blob:). A parse miss labels the entry; it is not an error. */
export function urlPath(url: string): string {
  try { return new URL(url).pathname || url; } catch { return url; }
}

/** A CDP RemoteObject to display text: primitives use their value, objects
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

/** The raw-float-timestamp dedupe key for a console line. Runtime and Log
 *  both report one line; the raw timestamp distinguishes truly distinct
 *  events that an ms-truncated ISO would merge. */
export function consoleRawKey(timestamp: number | undefined, type: string, text: string, source: string): string {
  return `${timestamp ?? ""}|${type}|${text}|${source}`;
}

export function exceptionRawKey(timestamp: number | undefined, text: string, url: string): string {
  return `${timestamp ?? ""}|${text}|${url}`;
}

/** Normalizes one Runtime.consoleAPICalled (or Log.entryAdded) payload into a
 *  collector push. `textForLog` is the entry.text path; both shapes land in
 *  the same buckets. */
export interface NormalizedConsole {
  type: string;
  text: string;
  source: string;
  at: string;
  rawKey: string;
}

export function normalizeConsoleAPICalled(e: any): NormalizedConsole | null {
  const text = (e.args ?? []).map((a: any) => remoteText(a.value, a.description)).join(" ").trim();
  if (text === "") return null;
  const type = String(e.type ?? "");
  const source = e.stackTrace?.callFrames?.[0]?.url ?? "";
  const at = isoAt(e.timestamp);
  return { type, text, source, at, rawKey: consoleRawKey(e.timestamp, type, text, source) };
}

/** Normalizes a Log.entryAdded payload. A network-source entry is dropped:
 *  HTTP faults count from Network events only (see file header). */
export function normalizeLogEntry(e: any): NormalizedConsole | null {
  const entry = e.entry ?? {};
  const source = String(entry.source ?? "");
  if (source === "network") return null;
  const text = String(entry.text ?? "").trim();
  if (text === "") return null;
  const type = String(entry.level ?? "log");
  // Log carries level "error"/"warning"/"verbose"/"info", not console's own
  // type set; map the RED-relevant levels and leave the rest as log-ish.
  const mapped = type === "error" || type === "warning" ? type : "log";
  const at = isoAt(entry.timestamp);
  return { type: mapped, text, source, at, rawKey: consoleRawKey(entry.timestamp, mapped, text, source) };
}

export interface NormalizedException { text: string; url: string; rawKey: string; }

export function normalizeExceptionThrown(e: any): NormalizedException | null {
  const d = e.exceptionDetails ?? {};
  const text = String(d.exception?.description ?? d.text ?? "");
  const url = String(d.url ?? "");
  if (text === "" && url === "") return null;
  return { text, url, rawKey: exceptionRawKey(e.timestamp, text, url) };
}

/** Network.requestWillBeSent -> the request context later response/failure
 *  events need (method + url). */
export function normalizeRequestWillBeSent(e: any): { requestId: string; method: string; url: string; type: string } | null {
  const requestId = e.requestId;
  if (requestId === undefined) return null;
  return { requestId, method: e.request?.method ?? "", url: e.request?.url ?? "", type: e.type ?? "" };
}

export function normalizeResponseReceived(e: any, method: string, url: string, type: string): BadRequestEntry | null {
  const status = Number(e.response?.status ?? 0);
  if (status < 400) return null;
  return { method, path: urlPath(url || e.response?.url || ""), status, errorText: "", type: e.type ?? type };
}

export function normalizeLoadingFailed(e: any, method: string, url: string, type: string): BadRequestEntry | CanceledRequestEntry {
  const base = { method, path: urlPath(url), status: 0, errorText: String(e.errorText ?? ""), type: e.type ?? type };
  return e.canceled === true ? { ...base, canceled: true as const } : base;
}

/** The RED rule: one finding per failed guard. Canceled requests never flag. */
export function guardFindings(buckets: CaptureBuckets): string[] {
  const findings: string[] = [];
  for (const e of buckets.consoleErrors) findings.push(`[console] error ${e.text}`);
  for (const e of buckets.consoleWarnings) findings.push(`[console] warning ${e.text}`);
  for (const d of buckets.debugLogs) findings.push(`[debug-log] ${d.text}`);
  for (const e of buckets.exceptions) findings.push(`[exception] ${e.text}`);
  for (const b of buckets.badRequests) findings.push(`[network] ${b.status} ${b.path} ${b.errorText}`.trim());
  return findings;
}