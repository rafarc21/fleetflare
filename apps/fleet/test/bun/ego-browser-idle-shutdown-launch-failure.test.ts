import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cleanupEgoBrowserHome, makeEgoBrowserHome, runEgoBrowser } from "./ego-browser-cli-helpers";

// Post-merge review finding on #35 (board issue #32): shutdown() did
// `const b = await browserPromise` unconditionally. If chromium.launch()
// had ever failed (e.g. a broken/missing binary), browserPromise stayed
// permanently rejected, and that `await` threw INSIDE shutdown() -- which
// idle-shutdown.ts calls as `void this.onIdle()` (fire-and-forget), so the
// rejection was never awaited by anyone. It became an unhandled rejection,
// logged and dropped by daemon.ts's own top-level handler, and execution
// never reached the rmSync/process.exit calls. Net effect: a daemon whose
// browser failed to launch even once sat resident forever once idle --
// reproducing #32's own bug in exactly the launch-failure edge case the
// original fix didn't cover. This test forces that exact rejected-
// browserPromise state (via EGO_BROWSER_CHROMIUM_PATH pointed at a path
// that doesn't exist -- chromium.launch() then rejects, ENOENT) and proves
// the daemon still shuts down cleanly once idle with zero spaces.

// Slightly more headroom than ego-browser-idle-shutdown.test.ts's 400ms:
// this test's round1 script also pays for a real (failing) chromium.launch()
// call before the idle timer ever arms, which adds a bit more wall-clock
// variance under load than that test's plain taskSpace()+finish().
const IDLE_MS = "800";

// Board #317: same as the container test — a loaded host can put more than
// the idle window between round1's exit and the next check. Simulated here
// on purpose: every check must hold with that gap.
const SIMULATED_LOAD_MS = 3 * Number(IDLE_MS);

// Same /proc-State-based liveness probe as ego-browser-idle-shutdown.test.ts
// -- see that file's comment for why a plain kill(pid, 0) is not enough
// (succeeds for an unreaped zombie as much as for a live process).
function processAlive(pid: number): boolean {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const stateLine = status.split("\n").find((l) => l.startsWith("State:"));
    if (stateLine?.includes("Z")) return false;
  } catch {
    // /proc not available -- fall through to the signal-based probe below.
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

describe("ego-browser daemon idle shutdown after a failed browser launch", () => {
  test(
    "still shuts itself down after the idle window even though chromium.launch() rejected",
    async () => {
      const home = makeEgoBrowserHome();
      try {
        // taskSpace() calls getBrowser() first, which awaits the rejected
        // chromium.launch() promise and throws before ever touching the
        // registry -- so the space count stays at zero and the idle timer
        // arms exactly as it would for a real "never used a space" daemon.
        const round1 = await runEgoBrowser({
          home,
          env: { EGO_BROWSER_IDLE_MS: IDLE_MS, EGO_BROWSER_CHROMIUM_PATH: "/nonexistent/no-such-chromium-binary" },
          code: `
            try {
              await taskSpace(1);
              console.log("unexpectedly succeeded");
            } catch (err) {
              console.log("launch failed as expected: " + (err instanceof Error ? err.message !== "" : false));
            }
          `,
        });
        expect(round1.stderr).toBe("");
        expect(round1.code).toBe(0);
        expect(round1.stdout.trim()).toBe("launch failed as expected: true");
        await Bun.sleep(SIMULATED_LOAD_MS);

        // #317: no task space can open here (the launch fails), so nothing
        // holds the daemon up past the idle window — by the time a loaded
        // host gets here it may already be gone, legitimately. Prove it was
        // spawned from its log (append-only, survives the shutdown), never
        // from live state that the idle window is allowed to destroy.
        const pidFile = join(home, "daemon.pid");
        const started = readFileSync(join(home, "daemon.log"), "utf8").match(/daemon started, pid (\d+)/);
        expect(started).not.toBeNull();
        const pid = Number(started![1]);

        // Pre-fix, this daemon would sit here forever: shutdown() threw on
        // `await browserPromise` before ever reaching
        // rmSync(pidFile)/rmSync(sockFile)/process.exit(0).
        const gone = await waitFor(() => !existsSync(pidFile) && !processAlive(pid), 10000);
        expect(gone).toBe(true);
        expect(existsSync(pidFile)).toBe(false);
        expect(existsSync(join(home, "daemon.sock"))).toBe(false);
        // And it left by the idle path, not a crash.
        expect(readFileSync(join(home, "daemon.log"), "utf8")).toContain(`shutting down: idle for ${IDLE_MS}ms`);
      } finally {
        cleanupEgoBrowserHome(home);
      }
    },
    30000,
  );
});
