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
// #1275: on cap expiry the refusal names the run ids still blocking the drain
// (with PR # when the gate_pr_head pointer resolves one), so the operator sees
// WHAT is blocking, not just "still running".
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

/** One live instance, with whatever id the list reports. */
interface Instance { id?: string; status?: string }

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

/** The PR number a run id currently gates, or null when the pointer does not
 *  resolve one (a run that already handed off, a pre-insert row, or no D1). */
function prOf(runId: string): number | null {
  const r = spawnSync(
    wrangler,
    ["d1", "execute", "fleet", "--remote", "--command", `SELECT pr FROM gate_pr_head WHERE run_id = '${runId}'`, "-c", configPath],
    { cwd: appDir, encoding: "utf8", timeout: 30_000 },
  );
  if (r.status !== 0) return null;
  // d1 execute --command prints a results table; the PR is the first bare
  // integer after the header/separator. A null answer or a D1 hiccup reads null.
  const m = /(\d+)/.exec(r.stdout ?? "");
  return m === null ? null : Number(m[1]);
}

const started = Date.now();
let drained = false;
let liveIds: string[] = [];
while (Date.now() - started < CAP_MS) {
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
// #1275: name what is blocking the drain, with the PR where the pointer
// resolves one, so the operator can see a specific hung run, not just a count.
const named = liveIds.map((id) => {
  const pr = prOf(id);
  return pr === null ? id : `${id} (PR #${pr})`;
});
console.error(`gate-drain-wait: gate instances still running after the drain cap${named.length > 0 ? `: ${named.join(", ")}` : ""}`);
process.exit(2);