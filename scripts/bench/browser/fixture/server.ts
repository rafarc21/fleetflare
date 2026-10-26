// Benchmark fixture app: a tiny HTTP server that serves one page with enough
// DOM to exercise a representative gate e2e leg (load, assert, click, fill,
// wait-for-async). Pure Bun stdlib — no deps — so it runs in the gate
// container image exactly as it runs here.
//
// Reachability: it binds 127.0.0.1 by default. The in-container Chromium
// driver hits it directly. A remote engine (CF Browser Run) cannot reach
// container localhost, so a reachability bridge (cloudflared tunnel or a
// per-PR preview deploy) must expose this same port — the benchmark treats
// that bridge as part of the remote engine's leg wall, measured separately
// (see run.ts --target and README.md "reachability cost").
const PORT = Number(process.env.BENCH_PORT ?? "8317");
const HOST = process.env.BENCH_HOST ?? "127.0.0.1";

const page = `<!doctype html>
<html>
<head><title>bench fixture</title></head>
<body>
  <h1 id="title">fixture ready</h1>
  <button id="inc">increment</button>
  <span id="count">0</span>
  <input id="name" type="text">
  <ul id="items"></ul>
  <script>
    let n = 0;
    document.getElementById("inc").addEventListener("click", () => {
      n += 1;
      document.getElementById("count").textContent = String(n);
    });
    // Async population: a real gate page often waits on a fetch before the
    // assertions can run. This forces waitForFunction / waitForSelector, not
    // just a static DOM read.
    fetch("/items").then(r => r.json()).then(items => {
      const ul = document.getElementById("items");
      for (const it of items) {
        const li = document.createElement("li");
        li.textContent = it;
        ul.appendChild(li);
      }
    });
  </script>
</body>
</html>`;

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/items") {
      return new Response(JSON.stringify(["alpha", "beta", "gamma"]), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

// The benchmark's driver (run.ts) spawns this as a child and reads this line
// to learn the URL before starting its timed runs.
console.log(`BENCH_READY http://${HOST}:${server.port}`);

// Exit cleanly on SIGTERM (the driver sends it on teardown).
process.on("SIGTERM", () => process.exit(0));