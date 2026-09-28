import { describe, expect, test } from "bun:test";
import { cleanupEgoBrowserHome, makeEgoBrowserHome, runEgoBrowser } from "./ego-browser-cli-helpers";

// Live end-to-end Tier-1 pass: goto -> fill -> click -> waitForSelector ->
// snapshot, against a real local test page served by an in-process
// Bun.serve. Proves the RPC-to-Playwright plumbing actually drives a real
// browser (real Chrome-for-Testing at /usr/local/bin/chromium), not a
// mock -- a snapshot() result this specific can only come from a real
// accessibility-tree walk of real rendered DOM.
describe("ego-browser Tier-1 smoke test (real browser, real page)", () => {
  test(
    "goto, fill, click, waitForSelector, snapshot all drive a real page",
    async () => {
      const home = makeEgoBrowserHome();
      const server = Bun.serve({
        port: 0,
        fetch: () =>
          new Response(
            `<!doctype html>
             <html>
               <body>
                 <h1>Smoke test page</h1>
                 <input id="name" placeholder="your name">
                 <button id="go" onclick="document.getElementById('result').textContent = 'Hello, ' + document.getElementById('name').value">Submit</button>
                 <p id="result"></p>
               </body>
             </html>`,
            { headers: { "content-type": "text/html" } },
          ),
      });
      const url = `http://127.0.0.1:${server.port}/`;

      try {
        const result = await runEgoBrowser({
          home,
          code: `
            const t = await taskSpace("smoke");
            const p1 = t.page("p1");
            await p1.goto(${JSON.stringify(url)});
            await p1.fill("#name", "ego-browser");
            await p1.click("#go");
            await p1.waitForSelector("#result", { state: "visible" });
            const resultText = await p1.evaluate(() => document.getElementById("result").textContent);
            console.log("RESULT:" + resultText);
            const snap = await p1.snapshot();
            console.log("SNAPSHOT:" + JSON.stringify(snap));
          `,
        });

        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("RESULT:Hello, ego-browser");

        const snapshotLine = result.stdout.split("\n").find((l) => l.startsWith("SNAPSHOT:"));
        expect(snapshotLine).toBeDefined();
        const snap = JSON.parse(snapshotLine!.slice("SNAPSHOT:".length)) as { scope: string; snapshot: string };
        expect(snap.scope).toBe("only_within_viewport");
        // Real ariaSnapshot(mode:"ai") output: ref-annotated ([ref=eN]),
        // and it must actually reflect the DOM state AFTER the click (the
        // filled-in result text), not a stale pre-interaction snapshot.
        expect(snap.snapshot).toContain("[ref=");
        expect(snap.snapshot).toContain("Hello, ego-browser");
      } finally {
        server.stop(true);
        cleanupEgoBrowserHome(home);
      }
    },
    45000,
  );
});
