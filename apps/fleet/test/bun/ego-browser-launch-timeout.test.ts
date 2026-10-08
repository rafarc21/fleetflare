import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cleanupEgoBrowserHome, makeEgoBrowserHome, runEgoBrowser } from "./ego-browser-cli-helpers";

// Board issue #276's own acceptance criterion: "No hang ever: bounded
// timeout + clear error if browser cannot start." getBrowser()'s sibling
// call, shutdown()'s browser.close(), already has a bounded wait
// (CLOSE_TIMEOUT_MS via raceWithTimeout() in process-reap.ts) -- added
// specifically because a hung close() must never block shutdown forever.
// chromium.launch() itself had no such bound: a Chrome process that starts
// but never completes its CDP handshake (a real-world failure mode under
// container resource/memory pressure) would hang getBrowser() indefinitely.
//
// /bin/cat and /usr/bin/yes were tried first as a fake chromium binary and
// both actually REJECT quickly in this environment -- they validate their
// own args and error on chromium's own unrecognized flags, which only
// reproduces a FAST launch failure (already handled correctly, see
// ego-browser-idle-shutdown-launch-failure.test.ts), not a hang. This test
// uses test/fixtures/ego-browser/hang-forever-chromium.sh instead: a tiny
// shell script that ignores every argv and `exec`s a process that never
// exits and never errors, genuinely reproducing a hung launch.

const CHROMIUM_FIXTURE = join(import.meta.dir, "../fixtures/ego-browser/hang-forever-chromium.sh");

// Short override so this test doesn't have to wait out the real production
// LAUNCH_TIMEOUT_MS -- same override-via-env convention as
// EGO_BROWSER_CHROMIUM_PATH itself.
const LAUNCH_TIMEOUT_MS = 500;

describe("ego-browser daemon: getBrowser() against a genuinely-hung chromium launch", () => {
  test(
    "fails with a bounded, actionable error instead of hanging past EGO_BROWSER_LAUNCH_TIMEOUT_MS",
    async () => {
      const home = makeEgoBrowserHome();
      try {
        const start = Date.now();
        const result = await runEgoBrowser({
          home,
          timeoutMs: 15000,
          env: {
            EGO_BROWSER_CHROMIUM_PATH: CHROMIUM_FIXTURE,
            EGO_BROWSER_LAUNCH_TIMEOUT_MS: String(LAUNCH_TIMEOUT_MS),
          },
          code: `
            try {
              await taskSpace(1);
              console.log("unexpectedly succeeded");
            } catch (err) {
              console.log("failed: " + (err instanceof Error ? err.message : String(err)));
            }
          `,
        });
        const elapsed = Date.now() - start;

        expect(result.stdout).toContain("failed:");
        // Named, actionable -- not a bare "timed out". Must point at the
        // bound itself and suggest a container resource/memory check, the
        // same information a wedged daemon's operator actually needs.
        expect(result.stdout).toContain(`${LAUNCH_TIMEOUT_MS}ms`);
        expect(result.stdout.toLowerCase()).toMatch(/memory|resource/);

        // Comfortably above LAUNCH_TIMEOUT_MS (daemon spawn/connect
        // overhead, scheduling jitter under a loaded container) but nowhere
        // near runEgoBrowser's own 15s external kill -- the real proof this
        // is OUR bound firing, not the external timeoutMs backstop.
        expect(elapsed).toBeLessThan(5000);
      } finally {
        cleanupEgoBrowserHome(home);
      }
    },
    20000,
  );
});
