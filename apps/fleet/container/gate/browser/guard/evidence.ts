// container/gate/browser/guard/evidence.ts
//
// Per-test evidence: one JSON file with the shared console/network buckets,
// one PNG screenshot, one combined guard JSON with a RED flag. Pure — writes
// go through an injected sink so tests point it at a scratch dir without a
// real filesystem.
//
// Output shape is the shared walk/gate console schema (issue #1344 comment
// 6412381014). The item file's "console" object is the buckets verbatim;
// guard.json is the harness's own verdict summary. Both carry the same
// bucket names — consoleErrors, consoleWarnings, debugLogs, exceptions,
// badRequests, canceledRequests.

import type { CaptureBuckets } from "./capture";

export interface GuardResult {
  /** Which guard failed, if any; absent when green. */
  failed?: string;
  /** One line per failed guard: "[console] error ...", "[network] 500 ...". */
  findings: string[];
  buckets: CaptureBuckets;
  screenshotPath?: string;
  consoleJsonPath?: string;
  fingerprint?: string;
  at?: string;
}

export interface EvidencePaths {
  evidenceDir: string;
  consoleJsonPath: string;
  screenshotPath: string;
  guardJsonPath: string;
}

export interface EvidenceSink {
  mkdir(path: string): void;
  writeFile(path: string, data: string | Uint8Array): void;
}

/** The per-test names, keyed to the guard's own directory. */
export function evidencePathsFor(dir: string, testKey: string): EvidencePaths {
  const safe = testKey.replace(/[^A-Za-z0-9._-]+/g, "_");
  return {
    evidenceDir: dir,
    consoleJsonPath: `${dir}/${safe}.console.json`,
    screenshotPath: `${dir}/${safe}.png`,
    guardJsonPath: `${dir}/${safe}.guard.json`,
  };
}

/** A test key that is safe for a filename: task + location + title. */
export function testKeyFor(file: string, title: string): string {
  return `${file.replace(/[^A-Za-z0-9]+/g, "-")}--${title.replace(/[^A-Za-z0-9]+/g, "-")}`.slice(0, 200);
}

/** The RED rule: which guard failed, or null when green. Every guard a
 *  browser leg relies on lives here, so a mutation of one rule flips it. */
export function guardFindings(buckets: CaptureBuckets): string[] {
  const findings: string[] = [];
  for (const e of buckets.consoleErrors) findings.push(`[console] error ${e.text}`);
  for (const e of buckets.consoleWarnings) findings.push(`[console] warning ${e.text}`);
  for (const d of buckets.debugLogs) findings.push(`[debug-log] ${d.text}`);
  for (const e of buckets.exceptions) findings.push(`[exception] ${e.text}`);
  for (const b of buckets.badRequests) findings.push(`[network] ${b.status} ${b.path} ${b.errorText}`.trim());
  return findings;
}

/** Guard verdict from buckets alone: RED when any finding exists. Canceled
 *  requests never flag. */
export function verdictFromBuckets(buckets: CaptureBuckets, fingerprint?: string, at?: string): GuardResult {
  const findings = guardFindings(buckets);
  return {
    ...(findings.length > 0 ? { failed: findings[0] } : {}),
    findings,
    buckets,
    fingerprint,
    at,
  };
}

/** Writes the console JSON, the guard JSON, and the screenshot into the
 *  evidence dir, and returns the GuardResult with paths attached. */
export function writeEvidence(
  paths: EvidencePaths,
  buckets: CaptureBuckets,
  screenshot: Uint8Array | undefined,
  fingerprint: string | undefined,
  at: string | undefined,
  sink: EvidenceSink,
): GuardResult {
  sink.mkdir(paths.evidenceDir);
  const consoleJson = JSON.stringify({ fingerprint, at, ...buckets }, null, 2);
  sink.writeFile(paths.consoleJsonPath, consoleJson);
  if (screenshot !== undefined && screenshot.length > 0) sink.writeFile(paths.screenshotPath, screenshot);
  const result = verdictFromBuckets(buckets, fingerprint, at);
  result.consoleJsonPath = paths.consoleJsonPath;
  if (screenshot !== undefined && screenshot.length > 0) result.screenshotPath = paths.screenshotPath;
  sink.writeFile(paths.guardJsonPath, JSON.stringify({ ...result, buckets }, null, 2));
  return result;
}

/** True when every bucket a RED rule reads is empty. */
export function isGreen(result: GuardResult): boolean {
  return result.findings.length === 0;
}