import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonEndpoint } from "../../container/ego-browser/endpoint";
import { resolvePaths } from "../../container/ego-browser/paths";

// DaemonEndpoint owns the daemon's pid/sock/spawn-lock file protocol; these
// characterization tests pin it against the real filesystem, each in its own
// isolated EGO_BROWSER_HOME-style temp home. No daemon, no browser -- fast.

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "ego-endpoint-"));
  return resolvePaths({ EGO_BROWSER_HOME: home });
}

describe("DaemonEndpoint", () => {
  test("isAlive false when no pidFile exists", async () => {
    const paths = makeHome();
    const endpoint = new DaemonEndpoint(paths);
    expect(await endpoint.isAlive()).toBe(false);
  });

  test("isAlive false on a dead pid (stale pidFile)", async () => {
    const paths = makeHome();
    const endpoint = new DaemonEndpoint(paths);
    // A pid Linux never allocates (pid_max caps at 2^22): kill(2) returns
    // ESRCH, pinning the dead-pid branch deterministically, no pid-reuse race.
    writeFileSync(paths.pidFile, "999999999");
    expect(await endpoint.isAlive()).toBe(false);
  });

  test("isAlive false when the pid is alive but nothing listens on the socket", async () => {
    const paths = makeHome();
    const endpoint = new DaemonEndpoint(paths);
    // This very test process is the "alive" pid, so only the socket probe
    // can account for the false: isAlive is more than a pid check.
    writeFileSync(paths.pidFile, String(process.pid));
    expect(await endpoint.isAlive()).toBe(false);
  });

  test("claimSpawnLock: first caller wins, second loses, release reopens", () => {
    const paths = makeHome();
    const endpoint = new DaemonEndpoint(paths);
    // Whoever wins spawns; losers poll. A released lock must be reclaimable
    // so a failed winner never strands losers behind a stale claim.
    expect(endpoint.claimSpawnLock()).toBe(true);
    expect(endpoint.claimSpawnLock()).toBe(false);
    endpoint.releaseSpawnLock();
    expect(endpoint.claimSpawnLock()).toBe(true);
  });

  test("removePidAndSockFiles removes both, tolerating absence", () => {
    const paths = makeHome();
    const endpoint = new DaemonEndpoint(paths);
    // Shutdown calls this unconditionally -- absent files must be a no-op.
    endpoint.removePidAndSockFiles();
    writeFileSync(paths.pidFile, "x");
    writeFileSync(paths.sockFile, "x");
    endpoint.removePidAndSockFiles();
    expect(existsSync(paths.pidFile)).toBe(false);
    expect(existsSync(paths.sockFile)).toBe(false);
  });

  test("writePid writes the pid file", () => {
    const paths = makeHome();
    const endpoint = new DaemonEndpoint(paths);
    endpoint.writePid(123);
    expect(readFileSync(paths.pidFile, "utf8")).toBe("123");
  });

  test("removeSockFile removes only the socket file", () => {
    const paths = makeHome();
    const endpoint = new DaemonEndpoint(paths);
    writeFileSync(paths.pidFile, "x");
    writeFileSync(paths.sockFile, "x");
    endpoint.removeSockFile();
    expect(existsSync(paths.sockFile)).toBe(false);
    expect(existsSync(paths.pidFile)).toBe(true);
  });

  test("probeConnect false when nothing listens", async () => {
    const paths = makeHome();
    const endpoint = new DaemonEndpoint(paths);
    // No socket file exists at all yet -- the probe must report false, not throw.
    expect(await endpoint.probeConnect()).toBe(false);
  });
});
