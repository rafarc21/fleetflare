import { existsSync, readFileSync } from "node:fs";
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

// A TIMEOUT must kill the whole hung process tree, not just the direct
// child: real Chromium forks zygote/renderer/crashpad children, and killing
// only the top pid orphans them. The fixture forks a background `sleep
// infinity` grandchild (same process group, no job control in a
// non-interactive sh) and then `exec`s into another `sleep infinity`; it
// writes both pids to EGO_BROWSER_TEST_HANG_PIDFILE. Both must be dead
// after the launch timeout fires. Playwright's own launch() `timeout`
// kills the process group (`kill(-pid)`), which covers both -- but only
// after first sending Browser.close over the pipe and waiting up to its
// 30000ms DEFAULT_PLAYWRIGHT_TIMEOUT for a graceful exit the hung fixture
// never makes. Hence the long wait below.
const TREE_KILL_WAIT_MS = 40000;
//
// Linux-only: the fixture relies on `sleep infinity` (GNU coreutils) and
// the liveness check reads /proc.
const IS_LINUX = process.platform === "linux";

function readHangPids(pidfile: string): number[] {
  return readFileSync(pidfile, "utf8").trim().split(/\s+/).map(Number);
}

interface ProcSignal {
  exists: boolean;
  zombie: boolean;
  fdSize: number | null;
}

function readProcSignal(pid: number): ProcSignal {
  let status: string;
  try {
    status = readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    return { exists: false, zombie: false, fdSize: null };
  }
  const lines = status.split("\n");
  const stateLine = lines.find((l) => l.startsWith("State:")) ?? "";
  const fdLine = lines.find((l) => l.startsWith("FDSize:"));
  return {
    exists: true,
    zombie: stateLine.includes("Z"),
    fdSize: fdLine ? Number(fdLine.split(/\s+/)[1]) : null,
  };
}

/** Same distinction ego-browser-idle-shutdown-container.test.ts's own
 * isGenuinelyTerminated() makes: fully reaped (gone from /proc) OR a
 * zombie holding zero file descriptors both count as "really dead" -- a
 * container whose PID1 does not promptly reap orphaned processes can leave
 * a genuinely-killed process as a zombie for a moment, and that is not the
 * bug this test guards against. */
function isGenuinelyTerminated(pid: number): boolean {
  const sig = readProcSignal(pid);
  if (!sig.exists) return true;
  return sig.zombie && sig.fdSize === 0;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

describe("ego-browser daemon: getBrowser() against a genuinely-hung chromium launch", () => {
  test.skipIf(!IS_LINUX)(
    "fails with a bounded, actionable error instead of hanging past EGO_BROWSER_LAUNCH_TIMEOUT_MS",
    async () => {
      const home = makeEgoBrowserHome();
      const pidfile = join(home, "hang-pids");
      try {
        const start = Date.now();
        const result = await runEgoBrowser({
          home,
          timeoutMs: 15000,
          env: {
            EGO_BROWSER_CHROMIUM_PATH: CHROMIUM_FIXTURE,
            EGO_BROWSER_LAUNCH_TIMEOUT_MS: String(LAUNCH_TIMEOUT_MS),
            EGO_BROWSER_TEST_HANG_PIDFILE: pidfile,
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

        // The whole hung tree must be dead, not merely abandoned: both the
        // exec'd leader and its forked grandchild.
        expect(existsSync(pidfile)).toBe(true);
        const hungPids = readHangPids(pidfile);
        expect(hungPids).toHaveLength(2);
        const allDead = await waitFor(() => hungPids.every(isGenuinelyTerminated), TREE_KILL_WAIT_MS, 250);
        expect(allDead).toBe(true);
      } finally {
        // Never leak the fixture's sleeps, even when the assertions fail.
        if (existsSync(pidfile)) {
          for (const pid of readHangPids(pidfile)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // already gone
            }
          }
        }
        cleanupEgoBrowserHome(home);
      }
    },
    60000,
  );
});
