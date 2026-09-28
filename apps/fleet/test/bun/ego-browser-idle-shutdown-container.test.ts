import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cleanupEgoBrowserHome, makeEgoBrowserHome, runEgoBrowser } from "./ego-browser-cli-helpers";

// Board issue #36: fresh, from-first-principles container reproduction (see
// docs/plans/2026-09-23-ego-browser-idle-shutdown-container.md) found that
// idle-shutdown.ts/daemon.ts's OWN scheduling and shutdown() logic are
// correct -- "shutting down" logs at the right time, the daemon process
// itself genuinely exits -- but the real Chromium OS process it launched
// can be left behind as a permanent, unreaped zombie in a container whose
// PID1 does not reap orphaned grandchildren (confirmed live: chrome/
// chrome_crashpad processes from an idle-shut-down daemon sat as `Z
// <defunct>` in `ps` for minutes with zero further activity, matching the
// operator's own "chrome=4 daemon=1, completely flat" production
// measurement).
//
// `ps`/`pgrep` cannot tell a harmless zombie (already dead, nothing left
// but the process-table entry, holding zero real resources) apart from a
// process that is still genuinely doing work -- POSIX kill(2)/ps semantics
// list both identically (see ego-browser-idle-shutdown.test.ts's own
// processAlive() making the same point for the daemon's own pid). This
// file makes the SAME distinction, one level deeper: on the underlying
// Chromium process itself, not just the daemon's.
//
// This is the container-level test board #36 explicitly asks for, applied
// to the actual root cause found rather than the hypothesis that opened
// the issue: proof the daemon's shutdown() genuinely terminates the real
// Chromium OS process (a hung/slow close is a real resource cost
// regardless of whether this container's own zombie-reaping gap makes an
// already-dead process's lingering process-table entry harmless), read via
// the one signal that tells "genuinely dead, just not yet reaped" apart
// from "still alive and running": /proc's FDSize (a zombie holds zero file
// descriptors -- every fd it owned was released at exit; a live process
// doing anything at all holds at least a few).

const IDLE_MS = "400";

// Board #317: a loaded host (full native bun-test lane) can put more than
// the idle window between round1's last request and this test's next
// check — the daemon then legitimately shuts down first. Every check must
// hold with that gap, so the gap is simulated here on purpose: 3 x IDLE_MS.
const SIMULATED_LOAD_MS = 3 * Number(IDLE_MS);

function readBrowserPid(home: string): number {
  const log = readFileSync(join(home, "daemon.log"), "utf8");
  const match = log.match(/browser launched, pid (\d+)/);
  if (!match) {
    throw new Error(
      `ego-browser: daemon.log has no "browser launched, pid <n>" line -- daemon.ts does not expose the ` +
        `underlying Chromium OS pid, so this test cannot check whether it was genuinely terminated. Full log:\n${log}`,
    );
  }
  return Number(match[1]);
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

/**
 * The honest distinguishing signal: a process that genuinely terminated is
 * EITHER fully reaped (gone from /proc entirely -- the ideal case, and what
 * happens on a container whose PID1 reaps promptly) OR sitting as a zombie
 * with FDSize 0 (every file descriptor it held was released at exit; only
 * the exit code is still pending pickup by a parent that never calls
 * wait()). A process still doing real work would show a non-zombie state
 * (R/S/D/...) and a non-zero FDSize -- that combination is the actual,
 * real problem this function exists to catch, as distinct from a harmless
 * lingering zombie.
 */
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

describe("ego-browser daemon idle shutdown -- the real Chromium OS process (board #36)", () => {
  test(
    "the underlying Chromium process is genuinely terminated once the daemon shuts down idle, not merely absent from ps/pgrep",
    async () => {
      const home = makeEgoBrowserHome();
      try {
        // Round 1 leaves its space OPEN: with a space open the daemon cannot
        // idle out, so the sanity check below is deterministic however long
        // a loaded host takes to get there (#317 — with the space closed in
        // round 1, the idle window raced this check and lost under load).
        const round1 = await runEgoBrowser({
          home,
          env: { EGO_BROWSER_IDLE_MS: IDLE_MS },
          code: `
            const t = await taskSpace("verify36");
            await t.page("p1").goto("about:blank");
            console.log("open");
          `,
        });
        expect(round1.stderr).toBe("");
        expect(round1.code).toBe(0);
        expect(round1.stdout.trim()).toBe("open");

        await Bun.sleep(SIMULATED_LOAD_MS);
        const browserPid = readBrowserPid(home);
        // Sanity check: the browser is genuinely running real work. If this
        // ever fails, the termination assertion below would be meaningless
        // -- proving nothing died because nothing was ever alive.
        expect(isGenuinelyTerminated(browserPid)).toBe(false);

        // Round 2, a separate process, closes the last space: only now does
        // the idle window start.
        const round2 = await runEgoBrowser({
          home,
          env: { EGO_BROWSER_IDLE_MS: IDLE_MS },
          code: `
            const t = await taskSpace("verify36");
            console.log(JSON.stringify(await t.finish({ keep: [] })));
          `,
        });
        expect(round2.stderr).toBe("");
        expect(round2.code).toBe(0);
        expect(round2.stdout.trim()).toBe('{"retained":[],"closed":["p1"]}');
        await Bun.sleep(SIMULATED_LOAD_MS);

        const pidFile = join(home, "daemon.pid");
        const daemonGone = await waitFor(() => !existsSync(pidFile), 10000);
        expect(daemonGone).toBe(true);

        // shutdown()'s own SIGKILL backstop is not synchronous with the
        // daemon's process.exit() -- give the OS a moment to settle the
        // Chromium process into its final state, same shape as the
        // existing idle-shutdown test's own waitFor.
        const terminated = await waitFor(() => isGenuinelyTerminated(browserPid), 5000);
        expect(terminated).toBe(true);
      } finally {
        cleanupEgoBrowserHome(home);
      }
    },
    30000,
  );
});
