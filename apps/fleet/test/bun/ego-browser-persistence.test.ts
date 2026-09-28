import { describe, expect, test } from "bun:test";
import {
  cleanupEgoBrowserHome,
  makeEgoBrowserHome,
  runEgoBrowser,
} from "./ego-browser-cli-helpers";

// THE mandatory proof (board issue #30 explicitly requires this one): a
// shim that only proves itself within a single process has not been
// tested. Process 1 spawns `ego-browser nodejs -e '<code>'` as a REAL
// child process, creates/resumes a fixed spaceId, navigates page "p1" to a
// real local HTTP server, and exits. A SEPARATE spawned process then
// resumes taskSpace(<same id>) and reads task.page("p1").url() -- if that
// matches the URL process 1 navigated to, process 2 found process 1's
// LIVE page (same daemon, same registry, same browser tab), not a fresh
// one. A shim with no persistent daemon would either error ("no such
// space") or report about:blank here, not the real navigated URL.
describe("ego-browser cross-process persistence", () => {
  test(
    "a second, separate ego-browser process finds the first process's page, still on the same URL",
    async () => {
      const home = makeEgoBrowserHome();
      const server = Bun.serve({
        port: 0,
        fetch: () => new Response("<html><body><h1>persisted</h1></body></html>", {
          headers: { "content-type": "text/html" },
        }),
      });
      const url = `http://127.0.0.1:${server.port}/`;
      const spaceId = 424242;

      try {
        const round1 = await runEgoBrowser({
          home,
          code: `
            const t = await taskSpace(${spaceId});
            const p1 = t.page("p1");
            await p1.goto(${JSON.stringify(url)});
            console.log(await p1.url());
          `,
        });
        expect(round1.stderr).toBe("");
        expect(round1.code).toBe(0);
        expect(round1.stdout.trim()).toBe(url);

        // A genuinely separate process -- no shared JS variables, no
        // shared module state, only the daemon this first invocation
        // caused to be spawned (or resumed).
        const round2 = await runEgoBrowser({
          home,
          code: `
            const t = await taskSpace(${spaceId});
            console.log(t.spaceId);
            console.log(await t.page("p1").url());
          `,
        });
        expect(round2.stderr).toBe("");
        expect(round2.code).toBe(0);
        const lines = round2.stdout.trim().split("\n");
        expect(lines[0]).toBe(String(spaceId));
        expect(lines[1]).toBe(url);
      } finally {
        server.stop(true);
        cleanupEgoBrowserHome(home);
      }
    },
    60000,
  );

  test(
    "the stdin heredoc entry point produces identical behavior to -e",
    async () => {
      const home = makeEgoBrowserHome();
      try {
        const result = await runEgoBrowser({
          home,
          stdin: true,
          code: `
            const t = await taskSpace("stdin-entry");
            const p1 = t.page("p1");
            await p1.goto("about:blank");
            console.log(await p1.url());
          `,
        });
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe("about:blank");
      } finally {
        cleanupEgoBrowserHome(home);
      }
    },
    30000,
  );
});
