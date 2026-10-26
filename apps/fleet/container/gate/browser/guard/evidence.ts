// container/gate/browser/guard/evidence.ts
//
// Per-test evidence + the RED verdict. Pure — writes go through an injected
// sink. Every write is redacted against the init-script's secret values, so a
// token that lands in a console bucket never reaches disk.
//
// Allowlist: known-safe console/network rows a guard may tolerate. Each row
// needs all three fields — {pattern, why, issue} — and a pattern is a literal
// substring match, never a wildcard. A finding that matches an allowlist row
// is dropped from the verdict; the raw buckets still carry the entry.

import { guardFindings, type CaptureBuckets } from "./capture";
import { redact } from "./init-script";

export interface AllowlistRow {
  /** Literal substring a finding's text must contain. No wildcard. */
  pattern: string;
  /** Why this row is safe to allow. */
  why: string;
  /** The issue tracking the eventual fix. */
  issue: string;
}

export const ALLOWLIST_MIN_PATTERN = 4;
export const ALLOWLIST_MIN_WHY = 8;
export const ALLOWLIST_ISSUE = /^#\d+$/;

/** A row is valid only when its pattern is at least ALLOWLIST_MIN_PATTERN
 *  chars, its why is at least ALLOWLIST_MIN_WHY chars, and its issue is a
 *  "#<number>" reference. A blank or trivially-short pattern, or a "[" that
 *  would match every prefixed finding, is refused. */
export function isAllowlistRowValid(row: AllowlistRow): boolean {
  return (
    row.pattern.trim().length >= ALLOWLIST_MIN_PATTERN &&
    row.why.trim().length >= ALLOWLIST_MIN_WHY &&
    ALLOWLIST_ISSUE.test(row.issue.trim())
  );
}

export interface GuardResult {
  /** Which guard failed, if any; absent when green. */
  failed?: string;
  /** One line per failed guard after allowlist filtering. */
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

/** True when a validated row's pattern is a literal substring of the entry
 *  text. Invalid rows never match. */
export function allowlistMatchesEntry(text: string, rows: AllowlistRow[]): boolean {
  return rows.some((r) => isAllowlistRowValid(r) && text.includes(r.pattern));
}

/** The buckets with allowlisted console/network entries removed, so the RED
 *  rule runs on the filtered set. */
export function bucketsWithAllowlist(buckets: CaptureBuckets, allowlist: AllowlistRow[] = []): CaptureBuckets {
  return {
    consoleErrors: buckets.consoleErrors.filter((e) => !allowlistMatchesEntry(e.text, allowlist)),
    consoleWarnings: buckets.consoleWarnings.filter((e) => !allowlistMatchesEntry(e.text, allowlist)),
    debugLogs: buckets.debugLogs.filter((d) => !allowlistMatchesEntry(d.text, allowlist)),
    exceptions: buckets.exceptions.filter((e) => !allowlistMatchesEntry(e.text, allowlist)),
    badRequests: buckets.badRequests.filter((b) => !allowlistMatchesEntry(b.path, allowlist) && !allowlistMatchesEntry(b.errorText, allowlist)),
    canceledRequests: buckets.canceledRequests.filter((c) => !allowlistMatchesEntry(c.path, allowlist) && !allowlistMatchesEntry(c.errorText, allowlist)),
  };
}

/** The RED rule with allowlist filtering: findings run on the filtered set. */
export function findingsWithAllowlist(buckets: CaptureBuckets, allowlist: AllowlistRow[] = []): string[] {
  return guardFindings(bucketsWithAllowlist(buckets, allowlist));
}

/** Guard verdict from buckets + allowlist: RED when any finding survives. */
export function verdictFromBuckets(
  buckets: CaptureBuckets,
  opts: { fingerprint?: string; at?: string; allowlist?: AllowlistRow[] } = {},
): GuardResult {
  const findings = findingsWithAllowlist(buckets, opts.allowlist);
  return {
    ...(findings.length > 0 ? { failed: findings[0] } : {}),
    findings,
    buckets,
    fingerprint: opts.fingerprint,
    at: opts.at,
  };
}

/** Redacts the buckets' own text fields in place against the secret values. */
export function redactBuckets(buckets: CaptureBuckets, secrets: string[]): CaptureBuckets {
  if (secrets.length === 0) return buckets;
  for (const e of buckets.consoleErrors) { e.text = redact(e.text, secrets); e.source = redact(e.source, secrets); }
  for (const e of buckets.consoleWarnings) { e.text = redact(e.text, secrets); e.source = redact(e.source, secrets); }
  for (const d of buckets.debugLogs) d.text = redact(d.text, secrets);
  for (const e of buckets.exceptions) { e.text = redact(e.text, secrets); e.url = redact(e.url, secrets); }
  for (const b of buckets.badRequests) { b.path = redact(b.path, secrets); b.errorText = redact(b.errorText, secrets); }
  for (const c of buckets.canceledRequests) { c.path = redact(c.path, secrets); c.errorText = redact(c.errorText, secrets); }
  return buckets;
}

export interface EvidenceSink {
  mkdir(path: string): void;
  writeFile(path: string, data: string | Uint8Array): void;
}

/** Writes the console JSON, the guard JSON, and the screenshot into the
 *  evidence dir, and returns the GuardResult with paths attached. Both the
 *  on-disk buckets and the verdict are redacted against `secrets`. */
export function writeEvidence(
  paths: EvidencePaths,
  buckets: CaptureBuckets,
  screenshot: Uint8Array | undefined,
  fingerprint: string | undefined,
  at: string | undefined,
  sink: EvidenceSink,
  opts: { allowlist?: AllowlistRow[]; secrets?: string[] } = {},
): GuardResult {
  sink.mkdir(paths.evidenceDir);
  const secrets = opts.secrets ?? [];
  const onDisk = redactBuckets(JSON.parse(JSON.stringify(buckets)) as CaptureBuckets, secrets);
  sink.writeFile(paths.consoleJsonPath, JSON.stringify({ fingerprint, at, ...onDisk }, null, 2));
  if (screenshot !== undefined && screenshot.length > 0) sink.writeFile(paths.screenshotPath, screenshot);
  const result = verdictFromBuckets(onDisk, { fingerprint, at, allowlist: opts.allowlist });
  result.consoleJsonPath = paths.consoleJsonPath;
  if (screenshot !== undefined && screenshot.length > 0) result.screenshotPath = paths.screenshotPath;
  sink.writeFile(paths.guardJsonPath, JSON.stringify({ ...result, buckets: onDisk }, null, 2));
  return result;
}

/** True when every bucket a RED rule reads is empty. */
export function isGreen(result: GuardResult): boolean {
  return result.findings.length === 0;
}