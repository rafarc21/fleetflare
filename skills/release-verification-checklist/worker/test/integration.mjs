// End-to-end: rendered checklist page (write token) -> wrangler dev worker -> DO/R2,
// then read back as Claude would (read token). See the plan Task 6 for the harness.
import { chromium } from "playwright";

const WORKER = process.env.WORKER_URL;               // e.g. http://127.0.0.1:8787
const PAGE = process.env.PAGE_URL;                   // e.g. http://localhost:40129/rv-live.html
const READ = process.env.READ_TOKEN || "read-tok";
const IMG = process.env.IMG_PATH;                    // small png on disk
const RELEASE = "2026-07-29-fixround";

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));

await p.goto(PAGE, { waitUntil: "networkidle" });
await p.evaluate(() => document.querySelectorAll("details.role").forEach((d) => (d.open = true)));
await p.evaluate(() => document.querySelector('.revbtn[data-rev="rejected"]').click());
await p.evaluate(() => { const ta = document.querySelector("textarea:not(.modal-ta)"); ta.value = "e2e note"; ta.dispatchEvent(new Event("input", { bubbles: true })); });
if (IMG) await p.setInputFiles('input[type="file"]', IMG);  // -> rvUploadMedia
await p.waitForTimeout(1600); // debounce (600) + network

const state = await (await fetch(`${WORKER}/r/${RELEASE}`, { headers: { authorization: "Bearer " + READ } })).json();
const items = Object.values(state.items || {});
const noteHit = items.some((i) => i.status === "rejected" && i.note === "e2e note");
const mediaItem = items.find((i) => (i.media || []).length > 0);

let mediaBytesOk = false, mkey = "";
if (mediaItem) {
  mkey = mediaItem.media[0].key;
  const mr = await fetch(`${WORKER}/m/${encodeURIComponent(mkey)}`, { headers: { authorization: "Bearer " + READ } });
  mediaBytesOk = mr.status === 200 && (await mr.arrayBuffer()).byteLength > 0;
}

console.log("pageerrors:", errs.length, errs.slice(0, 3));
console.log("worker received status+note:", noteHit);
console.log("worker received media ref:", !!mediaItem, "key:", mkey);
console.log("GET /m returns bytes (read token):", mediaBytesOk);

await b.close();
const ok = noteHit && (!IMG || (mediaItem && mediaBytesOk)) && errs.length === 0;
process.exit(ok ? 0 : 1);
