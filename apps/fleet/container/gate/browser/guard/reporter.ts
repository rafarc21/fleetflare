// container/gate/browser/guard/reporter.ts
//
// The guard's reporter adapter: turns one captured test into per-test evidence
// and a RED/GREEN verdict. The concrete Playwright reporter hooks into it by
// passing (testKey, buckets, screenshot, fingerprint, at, sink).
//
// Screenshot resolution differs by runner: @playwright/test hands the
// reporter a PNG buffer; a consumer walk hands an absolute path. Both are
// accepted; a path is written through unchanged.

import {
  evidencePathsFor,
  testKeyFor,
  writeEvidence,
  type EvidenceSink,
  type GuardResult,
} from "./evidence";
import type { CaptureBuckets } from "./capture";

export interface ReportGuardTestOpts {
  /** Stable per-test key (file + title). */
  testKey: string;
  buckets: CaptureBuckets;
  /** PNG bytes, or an absolute path already on disk. */
  screenshot?: Uint8Array | string;
  fingerprint?: string;
  at?: string;
  evidenceDir: string;
  sink: EvidenceSink;
}

export function reportGuardTest(opts: ReportGuardTestOpts): GuardResult {
  const paths = evidencePathsFor(opts.evidenceDir, opts.testKey);
  const screenshotBytes = typeof opts.screenshot === "string" ? undefined : opts.screenshot;
  const result = writeEvidence(paths, opts.buckets, screenshotBytes, opts.fingerprint, opts.at, opts.sink);
  if (typeof opts.screenshot === "string") {
    result.screenshotPath = opts.screenshot;
  }
  return result;
}

/** The one place a reporter builds a test key from a file + title. */
export function guardTestKey(file: string, title: string): string {
  return testKeyFor(file, title);
}