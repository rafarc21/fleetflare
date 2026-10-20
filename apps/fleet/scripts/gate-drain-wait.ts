#!/usr/bin/env bun
// #1232: wait for running gate instances to drain to zero before a Worker
// deploy. deploy.sh sets the `gate_drain` flag first (new starts queue as
// pending, src/gate/auto-run-env.ts); this polls
// `wrangler workflows instances list gate --json` until no live instance
// remains, capped at 15 min. Exit 0 drained, 2 timed out or unreadable.
//
// Live = the same statuses src/gate/auto-run.ts's isLiveStatus keeps
// (queued, running, paused, waiting, waitingForPause). Inlined rather than
// imported so this script stays free of src/ imports, the same reason
// deploy-target.ts imports only from wrangler. `--per-page 100` is far past
// the number of gates one fleet runs at once; a fleet beyond it undercounts,
// which the deploy-side flag still bounds (queued runs never start).
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const LIVE = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);
const CAP_MS = Number(process.env.GATE_DRAIN_CAP_MS ?? 15 * 60_000);
const POLL_MS = Number(process.env.GATE_DRAIN_POLL_MS ?? 5_000);

const [configPath] = process.argv.slice(2);
if (!configPath) {
  console.error("gate-drain-wait: no config path given");
  process.exit(2);
}

const appDir = join(import.meta.dir, "..");
const wrangler = join(appDir, "node_modules", ".bin", "wrangler");

/** One page of instances, or a throw on an unreadable/empty-but-nonempty answer. */
function list(): { status?: string }[] {
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
while (Date.now() - started < CAP_MS) {
  try {
    const live = list().filter((i) => LIVE.has(i.status ?? "")).length;
    if (live === 0) {
      drained = true;
      break;
    }
    console.error(`gate-drain-wait: ${live} gate instance(s) still running — waiting`);
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
console.error("gate-drain-wait: gate instances still running after the drain cap");
process.exit(2);