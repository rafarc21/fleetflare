#!/usr/bin/env bun
// #1232: wait for running gate instances to drain to zero before a Worker
// deploy. deploy.sh sets the `gate_drain` flag first (new starts queue as
// pending, src/gate/auto-run-env.ts); this polls
// `wrangler workflows instances list gate --json` until no live instance
// remains. Exit 0 drained, 2 timed out or unreadable.
//
// Live = the same statuses src/gate/auto-run.ts's isLiveStatus keeps
// (queued, running, paused, waiting, waitingForPause). Inlined rather than
// imported so this script stays free of src/ imports, the same reason
// deploy-target.ts imports only from wrangler. `--per-page 100` is far past
// the number of gates one fleet runs at once; a fleet beyond it undercounts,
// which the deploy-side flag still bounds (queued runs never start).
//
// #1275: the cap is DERIVED from how long one gate run can legitimately take,
// not a fixed 15 minutes. A leg's step deadline is capped at 28 minutes
// (src/gate/leg-run.ts's LEG_STEP_TIMEOUT_MS 30 min minus its 2-min margin),
// and legs fan out in parallel, so the whole run's wall clock is bounded by
// its longest leg. The default below is that ceiling plus slack for the
// resolve/precheck steps, so a legit long run is allowed to finish. The old
// 15-min cap was SHORTER than a 25-min leg, so a deploy under sustained load
// starved behind runs it would otherwise have waited out. GATE_DRAIN_CAP_MS
// still overrides (tests, and an operator who wants a tighter bound).
//
// #1275: on cap expiry the refusal names the run ids still blocking the drain,
// so the operator sees WHAT is blocking, not just "still running".
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const LIVE = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);
/** A leg's step deadline ceiling (28 min) + resolve/precheck slack. See the
 *  header above for the derivation. */
const DEFAULT_CAP_MS = 30 * 60_000;
const CAP_MS = Number(process.env.GATE_DRAIN_CAP_MS ?? DEFAULT_CAP_MS);
const POLL_MS = Number(process.env.GATE_DRAIN_POLL_MS ?? 5_000);

const [configPath] = process.argv.slice(2);
if (!configPath) {
  console.error("gate-drain-wait: no config path given");
  process.exit(2);
}

const appDir = join(import.meta.dir, "..");
const wrangler = join(appDir, "node_modules", ".bin", "wrangler");

/** #1275: the drain flag goes stale at 20 min (src/gate/drain.ts's
 *  GATE_DRAIN_STALE_MS), but the cap can now run 30 min. Re-stamp the flag's ts
 *  this often so a long, healthy drain never reads stale and lets new runs
 *  start mid-drain. Under the TTL, with slack for one slow re-stamp. */
const RESTAMP_EVERY_MS = Number(process.env.GATE_DRAIN_RESTAMP_MS ?? 10 * 60_000);

/** One live instance, with whatever id the list reports. */
interface Instance { id?: string; status?: string }

/** Re-stamps the gate_drain flag's ts, so a drain running past the 20-min stale
 *  TTL keeps its flag fresh. A FAILED re-stamp is a hard refusal: if the flag
 *  goes stale, new runs start mid-drain and the deploy would kill them, so the
 *  drain must abort (exit 2) rather than continue past a stale flag. */
function restampDrainFlag(): boolean {
  const nowMs = Date.now();
  const r = spawnSync(
    wrangler,
    ["d1", "execute", "fleet", "--remote", "--command", `INSERT INTO fleet_state (key,value,ts) VALUES ('gate_drain','1',${nowMs}) ON CONFLICT(key) DO UPDATE SET value='1', ts=excluded.ts`, "-c", configPath],
    { cwd: appDir, encoding: "utf8", timeout: 30_000 },
  );
  if (r.status !== 0) {
    console.error(`gate-drain-wait: could not re-stamp the drain flag (${r.status})`);
    return false;
  }
  return true;
}

/** One page of instances, or a throw on an unreadable/empty-but-nonempty answer. */
function list(): Instance[] {
  const r = spawnSync(
    wrangler,
    ["workflows", "instances", "list", "gate", "--json", "--per-page", "100", "-c", configPath],
    { cwd: appDir, encoding: "utf8", timeout: 60_000 },
  );
  if (r.status !== 0) throw new Error(`wrangler workflows instances list exited ${r.status}`);
  const text = (r.stdout ?? "").trim();
  if (text === "") return [];
  const parsed = JSON.parse(text.slice(text.search(/[[{]/)));
  if (!Array.isArray(parsed)) throw new Error("unexpected list shape");
  return parsed;
}

const started = Date.now();
let drained = false;
let liveIds: string[] = [];
// Started at `started`, so the first re-stamp fires RESTAMP_EVERY_MS after the
// drain began, never immediately (deploy.sh already set the flag fresh).
let lastRestamp = started;
while (Date.now() - started < CAP_MS) {
  // #1275: keep the drain flag fresh while the wait runs past the stale TTL.
  if (Date.now() - lastRestamp >= RESTAMP_EVERY_MS) {
    if (!restampDrainFlag()) {
      console.error("gate-drain-wait: refusing — the drain flag could not be re-stamped");
      process.exit(2);
    }
    lastRestamp = Date.now();
  }
  try {
    const live = list().filter((i) => LIVE.has(i.status ?? ""));
    liveIds = live.map((i) => i.id ?? "").filter((id) => id !== "");
    if (live.length === 0) {
      drained = true;
      break;
    }
    console.error(`gate-drain-wait: ${live.length} gate instance(s) still running — waiting`);
  } catch (err) {
    // A transient list failure is not proof of zero: keep waiting until the cap.
    console.error(`gate-drain-wait: ${err instanceof Error ? err.message : String(err)}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
if (drained) {
  console.error("gate-drain-wait: no running gate instances");
  process.exit(0);
}
// #1275: name what is blocking the drain. The run id is the Workflow instance
// id (deterministic per repo+sha); it names the specific stuck run without a
// D1 reverse-lookup whose result-parsing would be brittle.
console.error(`gate-drain-wait: gate instances still running after the drain cap${liveIds.length > 0 ? `: ${liveIds.join(", ")}` : ""}`);
process.exit(2);