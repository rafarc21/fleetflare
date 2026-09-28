import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cleanupEgoBrowserHome, makeEgoBrowserHome, runEgoBrowser } from "./ego-browser-cli-helpers";

// Reproduces the reviewer's Finding 2: `ensureDaemonAlive()` had no
// coordination between "decide to spawn" and "actually spawn" -- N cold-
// start `ego-browser` invocations racing before any daemon exists would
// each independently rmSync the stale pidfile/sockfile and spawn their own
// daemon + own headless Chromium, with whichever binds the unix socket
// LAST winning reachability and every other spawned daemon becoming an
// orphaned, unreachable process nothing ever reaps.
//
// `listTaskSpaces()` is used (not taskSpace()) so this test exercises only
// ensureDaemonAlive's spawn race, without needing a real Chromium launch --
// getBrowser() in daemon.ts is itself lazy and only invoked by taskSpace().
describe("ego-browser daemon spawn race", () => {
  test(
    "N concurrent cold-start invocations against one fresh EGO_BROWSER_HOME spawn exactly ONE daemon, not N",
    async () => {
      const home = makeEgoBrowserHome();
      const N = 5;
      try {
        const results = await Promise.all(
          Array.from({ length: N }, () =>
            runEgoBrowser({ home, code: "console.log(JSON.stringify(await listTaskSpaces()));" })),
        );

        for (const result of results) {
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
          expect(result.stdout.trim()).toBe("[]");
        }

        // All N invocations succeeded -- each reached SOME live daemon.
        // The real assertion is that only one daemon process was ever
        // spawned in the first place. daemon.ts logs exactly one "daemon
        // started" line per real daemon.ts process that reaches a live
        // listening socket; the spawn race (unfixed) reliably produces
        // more than one such process when N invocations race a genuinely
        // empty home, since each one independently observes "nothing
        // alive yet" before any of the others has finished spawning.
        const logFile = join(home, "daemon.log");
        expect(existsSync(logFile)).toBe(true);
        const startedLines = readFileSync(logFile, "utf8")
          .split("\n")
          .filter((line) => line.includes("daemon started, pid"));
        expect(startedLines.length).toBe(1);

        // The pidfile agrees with that single daemon, and it's the only
        // thing this home's daemon.pid ever recorded.
        const pidFile = join(home, "daemon.pid");
        expect(existsSync(pidFile)).toBe(true);
        const pid = readFileSync(pidFile, "utf8").trim();
        expect(startedLines[0]).toContain(`pid ${pid}`);
      } finally {
        cleanupEgoBrowserHome(home);
      }
    },
    60000,
  );
});
