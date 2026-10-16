// #1148 item 1 (refs #1135): the gate run watchdog. The every-minute cron sweeps
// the per-PR run index. A live run with no progress for GATE_STALL_MS is hung (a
// leg attempt lost its engine, so nothing stamps its progress). It is ended. Its
// first run is rerun once as an infra error (#1119). A run that is already a
// rerun takes the final error verdict. Pure of bindings: the cron glue
// (watchdog-env.ts) passes the real index, engine and status post.
import {
  endRunOrThrow, GATE_STALL_MS, isLiveStatus, statusOf, type GateRunIndex, type GateRunInstance, type GateRunRecord,
} from "./auto-run";
import { isRerunInstance, launchInfraRerun, recordInfraRerun, rerunInstanceId, rerunStatusArgs } from "./infra-rerun";

/** A row the watchdog may sweep: the run index's pointer plus the PR it belongs to. */
export interface StalledRun extends GateRunRecord { repo: string; pr: number }

/** A run whose progress is older than this is past the watchdog's window: the
 *  cron checks for two hours, far past one leg attempt. */
export const GATE_WATCHDOG_LOOKBACK_MS = 2 * 60 * 60_000;

/** The slice of the run index the watchdog reads and writes. */
export interface WatchdogIndex extends Pick<GateRunIndex, "latest" | "handOff"> {
  /** Stamps the runs with no progress stamp (0) with `at`, so each gets a full stall window before it can be ended (#1148 item 3). */
  adoptUnknown(at: number): Promise<void>;
  /** The pointers whose progress is at or before `before` and no older than `notBefore`, oldest first (stalled, as isStalled reads it). */
  stalled(before: number, notBefore: number): Promise<StalledRun[]>;
}

/** The params an infra rerun is created with: the GateWorkflow's payload (workflow.ts) for a rerun. */
export interface RerunParams { repo: string; pr: number; headSha: string; rerunOf: string }

/** The slice of the GATE_WORKFLOW binding the watchdog uses. */
export interface WatchdogWorkflow {
  create(opts: { id: string; params: RerunParams }): Promise<unknown>;
  get(id: string): Promise<GateRunInstance>;
}

export interface WatchdogDeps {
  index: WatchdogIndex;
  workflow: WatchdogWorkflow;
  /** Posts a commit status on the head: the real GitHub call in the Worker, a recorder in tests. */
  post: (repo: string, headSha: string, args: { state: "pending" | "error"; description: string }) => Promise<unknown>;
  now?: () => number;
}

/** What the sweep did with one stalled run: skipped (not live, or no longer the
 *  pointer), rerun (ended, and its one rerun started), final (ended, the final
 *  error verdict posted), or failed (its end failed; the next sweep retries). */
export type WatchdogOutcome = "skipped" | "rerun" | "final" | "failed";

export interface WatchdogRun { runId: string; outcome: WatchdogOutcome }

/** One watchdog sweep. Adopts unknown stamps, then handles each stalled run. A
 *  run that fails does not stop the sweep: it is reported and the next sweep retries it. */
export async function sweepStalledRuns(deps: WatchdogDeps): Promise<WatchdogRun[]> {
  const now = (deps.now ?? Date.now)();
  await deps.index.adoptUnknown(now);
  const rows = await deps.index.stalled(now - GATE_STALL_MS, now - GATE_WATCHDOG_LOOKBACK_MS);
  const runs: WatchdogRun[] = [];
  for (const row of rows) {
    try {
      runs.push({ runId: row.runId, outcome: await sweepRun(deps, row, now) });
    } catch (err) {
      console.error(`gate watchdog: ${row.repo}#${row.pr} run ${row.runId} failed`, err);
      runs.push({ runId: row.runId, outcome: "failed" });
    }
  }
  return runs;
}

async function sweepRun(deps: WatchdogDeps, row: StalledRun, now: number): Promise<WatchdogOutcome> {
  const { repo, pr, headSha, runId } = row;
  // The pointer moved on: a newer run owns this head, so this row is not the one to end.
  const latest = await deps.index.latest(repo, pr);
  if (latest?.runId !== runId) return "skipped";
  if (!isLiveStatus(await statusOf(deps.workflow, runId))) return "skipped";
  await endRunOrThrow(deps.workflow, runId);

  const minutes = Math.round(GATE_STALL_MS / 60_000);
  if (isRerunInstance(runId)) {
    await deps.post(repo, headSha, { state: "error", description: `no progress for ${minutes} min after its infra rerun (run ${runId}); a rerun is final` });
    return "final";
  }

  // The first run's infra rerun, the same one a failed-leg run starts (#1119).
  const rerunId = rerunInstanceId(runId);
  await deps.post(repo, headSha, rerunStatusArgs(runId));
  const outcome = await launchInfraRerun({
    create: () => deps.workflow.create({ id: rerunId, params: { repo, pr, headSha, rerunOf: runId } }),
    get: () => deps.workflow.get(rerunId),
    handOff: () => recordInfraRerun(deps.index, { repo, pr, headSha, runId: rerunId, instanceId: runId, at: now }),
    terminate: async () => (await deps.workflow.get(rerunId)).terminate(),
  }).catch(() => "failed" as const);
  if (outcome === "started") return "rerun";
  await deps.post(repo, headSha, { state: "error", description: `no progress for ${minutes} min; the infra rerun did not start (run ${runId})` });
  return "final";
}
