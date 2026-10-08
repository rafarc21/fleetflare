import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cleanupEgoBrowserHome, makeEgoBrowserHome, runEgoBrowser } from "./ego-browser-cli-helpers";

// Board issue #276: getBrowser()'s `if (!browserPromise)` guard treats a
// REJECTED promise as truthy -- a rejected Promise object is not
// `undefined`. Once chromium.launch() rejects once (bad binary, container
// resource pressure mid-startup, anything), the guard never fires again:
// every later call for the rest of the daemon's life replays that SAME
// stale rejected promise, with no new launch attempt ever made. This
// matches the issue's own symptom: once one launch attempt fails, the
// daemon is permanently wedged for browser use until something kills it.
// See docs/plans/2026-10-08-fix-276-ego-browser-hang.md.
//
// Proof signal: "getBrowser: attempting chromium launch" in daemon.log,
// logged once per actual re-entry into getBrowser()'s `if (!browserPromise)`
// branch -- NOT a comparison of error message text. A fresh launch attempt
// against the SAME bad path produces a textually-identical ENOENT message
// to the cached one, so message content alone cannot distinguish a genuine
// retry from a stale replay; only an independent log line proves a second
// real attempt happened.

const IDLE_MS = "60000"; // generous default -- this test must not race the idle shutdown window.

function countAttempts(log: string): number {
  return (log.match(/getBrowser: attempting chromium launch/g) ?? []).length;
}

describe("ego-browser daemon: getBrowser() after a launch failure", () => {
  test(
    "a second call against the same wedged daemon makes its own independent launch attempt, not a stale replay",
    async () => {
      const home = makeEgoBrowserHome();
      try {
        const env = { EGO_BROWSER_IDLE_MS: IDLE_MS, EGO_BROWSER_CHROMIUM_PATH: "/nonexistent/no-such-chromium-binary" };
        const code = `
          try {
            await taskSpace(1);
            console.log("unexpectedly succeeded");
          } catch (err) {
            console.log("failed: " + (err instanceof Error ? err.message !== "" : false));
          }
        `;

        const round1 = await runEgoBrowser({ home, env, code });
        expect(round1.stdout.trim()).toBe("failed: true");

        // Same home -> same persistent daemon (ensureDaemonAlive reuses it
        // since its pidfile/socket are still alive) -- this is deliberately
        // NOT a fresh daemon.
        const round2 = await runEgoBrowser({ home, env, code });
        expect(round2.stdout.trim()).toBe("failed: true");

        const log = readFileSync(join(home, "daemon.log"), "utf8");
        // Pre-fix: 1 (the guard short-circuits round2 onto the same stale
        // rejected promise, no new attempt). Post-fix: 2 -- each call gets
        // its own fresh attempt, independently failing against the same
        // still-bad path.
        expect(countAttempts(log)).toBe(2);
      } finally {
        cleanupEgoBrowserHome(home);
      }
    },
    30000,
  );
});
