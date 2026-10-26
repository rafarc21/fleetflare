// container/gate/browser/guard/reporter.ts
//
// The guard's reporter: per-test evidence + the DID-NOT-RUN rule. A real
// Playwright Reporter drives it by feeding onBegin/onTestEnd/onEnd; the
// concrete reporter adapts that surface to this module.
//
// DID-NOT-RUN: when zero tests ran in a browser leg, the leg is RED with
// "[guard] DID-NOT-RUN: zero tests executed" — a browser leg that ran
// nothing must never read green. The verdict is recorded via writeEvidence
// with empty buckets, so the evidence dir holds the proof.

import {
  evidencePathsFor,
  writeEvidence,
  type AllowlistRow,
  type EvidenceSink,
  type GuardResult,
} from "./evidence";
import { testKeyFor } from "./evidence";
import type { CaptureBuckets } from "./capture";
import { initScriptFromEnv, secretsFromInitScript } from "./init-script";

export const DID_NOT_RUN_FINDING = "[guard] DID-NOT-RUN: zero tests executed";

/** The secret values a reporter redacts by default, derived from the
 *  BROWSER_GUARD_INIT_SCRIPT env var itself — a caller never has to hand them
 *  in. */
export function defaultSecrets(env?: Record<string, string | undefined>): string[] {
  return secretsFromInitScript(initScriptFromEnv(env ?? (process.env as unknown as Record<string, string | undefined>)));
}

export interface ReporterHooks {
  /** Called with (testKey, buckets) as each test ends. */
  onTestEnd(testKey: string, buckets: CaptureBuckets): void;
  /** Called at the end of the run with the total test count. */
  onEnd(testCount: number): void;
}

export interface GuardReporterOpts {
  evidenceDir: string;
  sink: EvidenceSink;
  fingerprint?: string;
  at?: string;
  allowlist?: AllowlistRow[];
  /** Explicit secrets override the env-derived default; leave unset to
   *  redact by default from BROWSER_GUARD_INIT_SCRIPT. */
  secrets?: string[];
  /** Reports a screenshot for a test key: returns PNG bytes or a path. */
  screenshotFor?: (testKey: string) => Promise<Uint8Array | string | undefined>;
}

export interface ReportGuardTestOpts {
  testKey: string;
  buckets: CaptureBuckets;
  screenshot?: Uint8Array | string;
  fingerprint?: string;
  at?: string;
  evidenceDir: string;
  sink: EvidenceSink;
  allowlist?: AllowlistRow[];
  /** Leave unset to redact by default from BROWSER_GUARD_INIT_SCRIPT. */
  secrets?: string[];
}

/** One captured test -> per-test evidence + verdict. Secrets default to the
 *  env-derived values when not passed. */
export function reportGuardTest(opts: ReportGuardTestOpts): GuardResult {
  const paths = evidencePathsFor(opts.evidenceDir, opts.testKey);
  const screenshotBytes = typeof opts.screenshot === "string" ? undefined : opts.screenshot;
  const secrets = opts.secrets ?? defaultSecrets();
  const result = writeEvidence(paths, opts.buckets, screenshotBytes, opts.fingerprint, opts.at, opts.sink, {
    allowlist: opts.allowlist,
    secrets,
  });
  if (typeof opts.screenshot === "string") result.screenshotPath = opts.screenshot;
  return result;
}

/** The one place a reporter builds a test key from a file + title. */
export function guardTestKey(file: string, title: string): string {
  return testKeyFor(file, title);
}

/** The DID-NOT-RUN result: empty buckets, one RED finding. */
export function didNotRunResult(evidenceDir: string, sink: EvidenceSink, fingerprint?: string, at?: string): GuardResult {
  const buckets: CaptureBuckets = { consoleErrors: [], consoleWarnings: [], debugLogs: [], exceptions: [], badRequests: [], canceledRequests: [] };
  const paths = evidencePathsFor(evidenceDir, "did-not-run");
  const result = writeEvidence(paths, buckets, undefined, fingerprint, at, sink);
  result.failed = DID_NOT_RUN_FINDING;
  result.findings = [DID_NOT_RUN_FINDING];
  sink.writeFile(paths.guardJsonPath, JSON.stringify({ ...result, buckets }, null, 2));
  return result;
}

/** A Reporter implementing the three hooks: onTestEnd records evidence (with
 *  a screenshot the harness takes itself), onEnd records DID-NOT-RUN when the
 *  run had zero tests. */
export class GuardReporter implements ReporterHooks {
  private readonly opts: GuardReporterOpts;
  private count = 0;

  constructor(opts: GuardReporterOpts) {
    this.opts = opts;
  }

  async onTestEnd(testKey: string, buckets: CaptureBuckets): Promise<void> {
    this.count += 1;
    const screenshot = this.opts.screenshotFor ? await this.opts.screenshotFor(testKey) : undefined;
    reportGuardTest({
      testKey,
      buckets,
      screenshot,
      fingerprint: this.opts.fingerprint,
      at: this.opts.at,
      evidenceDir: this.opts.evidenceDir,
      sink: this.opts.sink,
      allowlist: this.opts.allowlist,
      secrets: this.opts.secrets ?? defaultSecrets(),
    });
  }

  onEnd(testCount?: number): void {
    const ran = testCount !== undefined ? testCount : this.count;
    if (ran === 0) didNotRunResult(this.opts.evidenceDir, this.opts.sink, this.opts.fingerprint, this.opts.at);
  }
}