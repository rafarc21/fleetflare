import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cleanupEgoBrowserHome, makeEgoBrowserHome, runEgoBrowser } from "./ego-browser-cli-helpers";

// Board issue #32: the daemon never exited on its own, so a single browser
// call left a headless Chrome resident for the rest of the studio's life.
// The fix must shut the daemon down once idle with ZERO task spaces open --
// but must NEVER shut down while a space is still open and resumable, since
// that is the entire contract ego-browser-persistence.test.ts proves. Both
// directions are asserted here; direction 2 is the one that would catch a
// naive "always exit after N ms" regression that direction 1 alone cannot
// distinguish from the real fix.

const IDLE_MS = "400";

function readPid(home: string): number {
  const pidFile = join(home, "daemon.pid");
  return Number(readFileSync(pidFile, "utf8").trim());
}

/**
 * "Alive" here means genuinely still running, not merely present in the
 * process table. `process.kill(pid, 0)` succeeds for a zombie (exited,
 * awaiting reap by its parent) as much as for a live process -- POSIX
 * kill(2) semantics, not a bug. A detached daemon whose immediate parent
 * (the short-lived `ego-browser nodejs` CLI process) has already exited is
 * reparented to whatever subreaper the sandbox provides; some sandboxes
 * (including this one) don't reap promptly, so a plain kill(pid, 0) probe
 * would report a definitely-exited daemon as "alive" forever and this test
 * could never pass anywhere such a subreaper is slow/absent. /proc's own
 * State field distinguishes the two cases directly on the one platform this
 * daemon ever runs on (Linux containers) and on CI (ubuntu-latest, also
 * Linux) -- state Z means process.exit() already ran and every resource
 * (browser, sockets, fds) is already released; only the exit code is still
 * pending pickup.
 */
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

describe("ego-browser daemon idle shutdown", () => {
  test(
    "shuts itself down after the idle window once the last task space is finished",
    async () => {
      const home = makeEgoBrowserHome();
      try {
        const round1 = await runEgoBrowser({
          home,
          env: { EGO_BROWSER_IDLE_MS: IDLE_MS },
          code: `
            const t = await taskSpace(1);
            console.log(JSON.stringify(await t.finish({ keep: [] })));
          `,
        });
        expect(round1.stderr).toBe("");
        expect(round1.code).toBe(0);
        expect(round1.stdout.trim()).toBe('{"retained":[],"closed":["p1"]}');

        const pidFile = join(home, "daemon.pid");
        expect(existsSync(pidFile)).toBe(true);
        const pid = readPid(home);
        expect(processAlive(pid)).toBe(true);

        // Wait comfortably past the idle window (400ms) for the daemon's
        // own timer to fire and exit.
        const gone = await waitFor(() => !existsSync(pidFile) && !processAlive(pid), 10000);
        expect(gone).toBe(true);
        expect(existsSync(pidFile)).toBe(false);
        expect(existsSync(join(home, "daemon.sock"))).toBe(false);
      } finally {
        cleanupEgoBrowserHome(home);
      }
    },
    30000,
  );

  test(
    "does NOT shut down while a task space is still open, even well past the idle window",
    async () => {
      const home = makeEgoBrowserHome();
      try {
        const round1 = await runEgoBrowser({
          home,
          env: { EGO_BROWSER_IDLE_MS: IDLE_MS },
          code: `
            const t = await taskSpace(2);
            const p1 = t.page("p1");
            await p1.goto("about:blank");
            console.log("ready");
          `,
        });
        expect(round1.stderr).toBe("");
        expect(round1.code).toBe(0);
        expect(round1.stdout.trim()).toBe("ready");

        const pidFile = join(home, "daemon.pid");
        const pid = readPid(home);

        // Well past the 400ms idle window -- a naive unconditional timer
        // would have killed the daemon by now.
        await new Promise((r) => setTimeout(r, 2000));
        expect(existsSync(pidFile)).toBe(true);
        expect(processAlive(pid)).toBe(true);

        // Prove it's not just "the process happens to still exist" but
        // genuinely reachable and still holding the same open space.
        const round2 = await runEgoBrowser({
          home,
          env: { EGO_BROWSER_IDLE_MS: IDLE_MS },
          code: `
            const spaces = await listTaskSpaces();
            console.log(JSON.stringify(spaces.map((s) => s.spaceId)));
            const t = await taskSpace(2);
            console.log(await t.page("p1").url());
          `,
        });
        expect(round2.stderr).toBe("");
        expect(round2.code).toBe(0);
        const lines = round2.stdout.trim().split("\n");
        expect(JSON.parse(lines[0]!)).toContain(2);
        expect(lines[1]).toBe("about:blank");
      } finally {
        cleanupEgoBrowserHome(home);
      }
    },
    30000,
  );
});
