import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No ".test." in this filename on purpose -- test/bun/exec-snippet.ts (a
// pre-existing helper in this same directory) establishes the same
// precedent: `bun test test/bun ...` only picks up files whose name
// actually matches a test pattern, so a plain helper file sits alongside
// the suites untouched.

export const EGO_BROWSER_CLI = join(import.meta.dir, "../../container/ego-browser/cli.ts");

export interface RunEgoBrowserOpts {
  /** Script body. Sent via `-e` when `stdin` is false (default), or as the
   * full content of stdin when `stdin` is true -- exercises ego-browser's
   * OTHER required entry point without duplicating every test. */
  code: string;
  home: string;
  stdin?: boolean;
  timeoutMs?: number;
  /** Extra env vars merged on top of EGO_BROWSER_HOME -- e.g.
   * EGO_BROWSER_IDLE_MS for the idle-shutdown tests, which need a tiny
   * override no other caller of this helper sets. */
  env?: Record<string, string>;
}

export interface RunEgoBrowserResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Deliberately ASYNC (Bun.spawn, not Bun.spawnSync): several of these
 * tests stand up their own in-process `Bun.serve` HTTP server for the
 * spawned ego-browser child to navigate to. `Bun.spawnSync` blocks this
 * process's whole event loop until the child exits -- which would starve
 * that same server of the ability to ever answer the child's request,
 * deadlocking the test against itself. Confirmed empirically: switching
 * this from spawnSync to spawn (with the server otherwise unchanged) is
 * what took the persistence test from a hard 30s goto-timeout failure to
 * green.
 */
export async function runEgoBrowser(opts: RunEgoBrowserOpts): Promise<RunEgoBrowserResult> {
  const cmd = opts.stdin
    ? [process.execPath, EGO_BROWSER_CLI, "nodejs"]
    : [process.execPath, EGO_BROWSER_CLI, "nodejs", "-e", opts.code];
  const proc = Bun.spawn({
    cmd,
    stdin: opts.stdin ? Buffer.from(opts.code) : "ignore",
    env: { ...process.env, EGO_BROWSER_HOME: opts.home, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = opts.timeoutMs ?? 45000;
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  return { code: exitCode, stdout, stderr };
}

export function makeEgoBrowserHome(): string {
  return mkdtempSync(join(tmpdir(), "ego-browser-home-"));
}

/** Best-effort: stops the daemon this home's tests spawned, so a test run
 * does not leak long-lived chromium/daemon processes behind it. */
export function stopEgoBrowserDaemon(home: string): void {
  const pidFile = join(home, "daemon.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0) {
    try {
      // A real `kill` subprocess rather than process.kill(pid, ...): this
      // is genuinely best-effort cleanup, not load-bearing for test
      // correctness (a leaked daemon does not affect any assertion's exit
      // code) -- these tests would still pass on their own merits even if
      // a given sandbox's signal delivery to a detached, reparented cross
      // -process daemon is unreliable. Real, unsandboxed environments
      // (this shim's actual target: a studio container, and CI's plain
      // ubuntu-latest runner) terminate a detached bun daemon on SIGTERM
      // immediately via a plain `kill`; only kept as a subprocess (rather
      // than process.kill) since it is the more portable, least
      // environment-dependent form of "send a real SIGTERM".
      Bun.spawnSync({ cmd: ["kill", "-15", String(pid)], stdout: "ignore", stderr: "ignore" });
    } catch {
      // Already gone -- fine.
    }
  }
}

export function cleanupEgoBrowserHome(home: string): void {
  stopEgoBrowserDaemon(home);
  rmSync(home, { recursive: true, force: true });
}
