// Throughput fixture app: multi-page, fetches, and one 2-account spec with
// ISOLATED data per account. Serves a small in-memory store so the 50-spec
// suite has real state to assert on (list append, per-account counters) and
// real async to wait on (a fetch that populates a list).
//
// Isolation contract (what "data-isolation risk" measures): every account id
// gets its OWN counter namespace. A spec that writes as account A must never
// observe account B's writes. The harness asserts this in one 2-account spec;
// the benchmark reports whether that spec ever flaked under concurrency.
const PORT = Number(process.env.BENCH_PORT ?? "8318");
const HOST = process.env.BENCH_HOST ?? "127.0.0.1";

// state[account] = { counter: number, items: string[] }
const state = new Map<string, { counter: number; items: string[] }>();

function account(url: URL): string {
  // The 2-account spec passes ?account=a1 / ?account=a2; everything else is
  // the default "shared" account so the 48 single-account specs do not
  // collide with each other's assertions either.
  return url.searchParams.get("account") ?? "shared";
}

function store(acct: string) {
  let s = state.get(acct);
  if (!s) { s = { counter: 0, items: [] }; state.set(acct, s); }
  return s;
}

const page = (title: string, body: string, script: string) => `<!doctype html>
<html><head><title>${title}</title></head>
<body>${body}<script>${script}</script></body></html>`;

const home = page(
  "throughput home",
  `<h1 id="title">throughput fixture</h1>
   <a id="to-list" href="/list">list page</a>
   <button id="bump">bump</button>
   <span id="count">0</span>
   <input id="name"><button id="add">add item</button>
   <ul id="items"></ul>`,
  `const acct = new URLSearchParams(location.search).get("account") ?? "shared";
   let count = 0;
   document.getElementById("bump").addEventListener("click", () => {
     count += 1; document.getElementById("count").textContent = String(count);
   });
   document.getElementById("add").addEventListener("click", async () => {
     const name = document.getElementById("name").value;
     await fetch("/items?account=" + acct, { method: "POST", body: name });
     refresh();
   });
   async function refresh() {
     const r = await fetch("/items?account=" + acct);
     const items = await r.json();
     const ul = document.getElementById("items"); ul.innerHTML = "";
     for (const it of items) { const li = document.createElement("li"); li.textContent = it; ul.appendChild(li); }
   }
   refresh();`,
);

const listPage = page(
  "throughput list",
  `<h1 id="list-title">list page</h1><ul id="list-items"></ul>`,
  `const acct = new URLSearchParams(location.search).get("account") ?? "shared";
   fetch("/items?account=" + acct).then(r => r.json()).then(items => {
     const ul = document.getElementById("list-items");
     for (const it of items) { const li = document.createElement("li"); li.textContent = it; ul.appendChild(li); }
   });`,
);

export function createServer(port: number = PORT, host: string = HOST) {
  return Bun.serve({
  hostname: host,
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const acct = account(url);
    const s = store(acct);

    if (url.pathname === "/reset" && req.method === "POST") {
      state.clear();
      return new Response(JSON.stringify({ reset: true }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/items" && req.method === "POST") {
      const name = (await req.text()) || "item";
      s.items.push(name);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/items") {
      return new Response(JSON.stringify(s.items), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/counter" && req.method === "POST") {
      s.counter += 1;
      return new Response(JSON.stringify({ counter: s.counter }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/counter") {
      return new Response(JSON.stringify({ counter: s.counter }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/list") {
      return new Response(listPage, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response(home, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  });
}

export const server = createServer();

console.log(`BENCH_READY http://${HOST}:${server.port}`);
process.on("SIGTERM", () => process.exit(0));