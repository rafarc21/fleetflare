import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { EgoBrowserPaths } from "./paths";

/**
 * Single owner of the daemon's pid/sock/spawn-lock FILE protocol, so
 * client.ts and daemon.ts can never disagree on it: alive detection,
 * the spawn claim, and cleanup all read/write the same paths through
 * this class alone.
 */
export class DaemonEndpoint {
  constructor(private readonly paths: EgoBrowserPaths) {}

  private processAlive(pid: number): boolean {
    try {
      // Signal 0 sends nothing -- it only probes whether the pid exists and
      // is signalable, the standard "is this process alive" check.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Quick connect-and-drop probe: does anything answer on this socket right now? */
  async probeConnect(): Promise<boolean> {
    try {
      const socket = await Bun.connect({
        unix: this.paths.sockFile,
        socket: { data() {}, open() {}, close() {}, error() {} },
      });
      socket.end();
      return true;
    } catch {
      return false;
    }
  }

  async isAlive(): Promise<boolean> {
    if (!existsSync(this.paths.pidFile)) return false;
    const pidText = readFileSync(this.paths.pidFile, "utf8").trim();
    const pid = Number(pidText);
    if (!(Number.isInteger(pid) && pid > 0 && this.processAlive(pid))) return false;
    return this.probeConnect();
  }

  /**
   * Atomically claims the right to spawn a fresh daemon: `open(..., "wx")`
   * (O_CREAT|O_EXCL) either creates the file or fails with EEXIST, with no
   * check-then-act window in between -- the OS itself is the arbiter, so this
   * is safe across both concurrent processes AND concurrent same-process
   * callers (JS execution of this synchronous call can't interleave with
   * itself). Whoever wins spawns; everyone else falls through to polling for
   * the winner's socket instead of also spawning their own daemon.
   */
  claimSpawnLock(): boolean {
    try {
      closeSync(openSync(this.paths.spawnLockFile, "wx"));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  releaseSpawnLock(): void {
    rmSync(this.paths.spawnLockFile, { force: true });
  }

  removePidAndSockFiles(): void {
    rmSync(this.paths.pidFile, { force: true });
    rmSync(this.paths.sockFile, { force: true });
  }

  writePid(pid: number): void {
    writeFileSync(this.paths.pidFile, String(pid));
  }

  removeSockFile(): void {
    rmSync(this.paths.sockFile, { force: true });
  }
}
