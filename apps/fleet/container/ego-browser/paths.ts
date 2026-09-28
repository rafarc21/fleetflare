import { join } from "node:path";

/**
 * Single source for where the daemon's runtime state lives, so client.ts
 * and daemon.ts can never disagree on a path. Defaults to /root/.ego-
 * browser (a root-owned, long-running container -- no multi-user concern).
 * Overridable via EGO_BROWSER_HOME so tests can run fully isolated daemons
 * per test file without colliding with each other or a real studio daemon.
 */
export interface EgoBrowserPaths {
  home: string;
  pidFile: string;
  sockFile: string;
  logFile: string;
  /** Atomic (O_CREAT|O_EXCL) claim file: whoever creates it first wins the
   * right to spawn a fresh daemon in ensureDaemonAlive -- see client.ts. */
  spawnLockFile: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): EgoBrowserPaths {
  const home = env.EGO_BROWSER_HOME?.trim() || "/root/.ego-browser";
  return {
    home,
    pidFile: join(home, "daemon.pid"),
    sockFile: join(home, "daemon.sock"),
    logFile: join(home, "daemon.log"),
    spawnLockFile: join(home, "daemon.spawn.lock"),
  };
}
