import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import type { BuiltGuardFixture } from "../../container/gate/browser/guard/fixture";
import type { EvidenceSink } from "../../container/gate/browser/guard/evidence";

// No ".test." in this filename — same precedent as ego-browser-cli-helpers.ts:
// a plain helper sits beside the suites and `bun test test/bun ...` never
// picks it up as a test.

export const CHROMIUM_PATH = "/usr/local/bin/chromium";

export interface GuardedBrowser extends BuiltGuardFixture {
  close(): Promise<void>;
}

/** Launches real Chromium and builds the guarded page through the guard
 *  fixture, casting the playwright-core surface (which already has the
 *  methods the fixture's structural shapes describe) rather than wrapping it. */
export async function launchGuarded(
  env?: Record<string, string | undefined>,
): Promise<GuardedBrowser> {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });
  const { buildGuardFixture } = await import("../../container/gate/browser/guard/fixture");
  // Omit env when unset so the fixture falls back to process.env (the real
  // gate's shape); only pass it through when the caller overrides.
  const built = await buildGuardFixture({ browser: browser as never, ...(env === undefined ? {} : { env }) });
  return { ...built, close: () => browser.close() };
}

/** A real filesystem sink for the evidence writer, into a test's scratch dir. */
export function realSink(_dir: string): EvidenceSink {
  return {
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    writeFile: (p, d) => writeFileSync(p, d),
  };
}