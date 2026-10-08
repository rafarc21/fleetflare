import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { findDirectChildPid } from "../../container/ego-browser/process-reap";
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

// Post-review finding (same branch, same issue): a TIMEOUT abandons the JS
// promise but has no way to cancel the real OS process ("there is no such
// thing as cancelling a plain Promise" -- process-reap.ts's own doc comment
// on raceWithTimeoutOrReject). The fixture above `exec`s into `sleep
// infinity`, which keeps running as a real, genuinely-alive OS process even
// after getBrowser()'s promise rejects on the timeout -- unless daemon.ts's
// timeout branch goes and kills it itself. This is the regression test for
// exactly that: proof the real process is gone, not just that the RPC call
// rejected (the original bug let the call "pass" -- i.e. reject cleanly --
// while silently leaking the process).

function readDaemonPid(home: string): number {
  return Number(readFileSync(join(home, "daemon.pid"), "utf8").trim());
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

        // The real regression test: the fixture's underlying `sleep
        // infinity` process (the OS process `hang-forever-chromium.sh`
        // `exec`s into) must actually be dead now, not merely abandoned.
        // The persistent daemon (a separate OS process from the `ego-
        // browser nodejs` CLI invocation above, by design -- it outlives
        // every individual invocation) is still alive at this point (its
        // own idle window is the real 60000ms default, nowhere close to
        // firing yet), so its pidfile is the one reliable way to find the
        // real parent pid to scan from -- same mechanism daemon.ts's own
        // shutdown() SIGKILL backstop and findDirectChildPid() rely on.
        const daemonPid = readDaemonPid(home);
        const hungPid = findDirectChildPid(daemonPid);
        const terminated =
          hungPid === undefined ? true : await waitFor(() => isGenuinelyTerminated(hungPid), 3000);
        expect(terminated).toBe(true);
      } finally {
        cleanupEgoBrowserHome(home);
      }
    },
    20000,
  );
});
