// #1148 item 1 (refs #1135): the gate run watchdog. The every-minute cron sweeps
// the per-PR run index. A live run with no progress for GATE_STALL_MS is hung (a
// leg attempt lost its engine, so nothing stamps its progress). It is ended. Its
// first run is rerun once as an infra error (#1119). A run that is already a
// rerun takes the final error verdict. Pure of bindings: the cron glue
// (watchdog-env.ts) passes the real index, engine and status post.
import {
  endRunOrThrow, GATE_STALL_MS, isLiveStatus, statusOf, type GateRunIndex, type GateRunInstance, type GateRunRecord,
} from "./auto-run";
import {
  isRerunInstance, launchInfraRerun, recordInfraRerun, rerunInstanceId, rerunStatusArgs, type InfraRerunOutcome,
} from "./infra-rerun";

/** A row the watchdog may sweep: the run index's pointer plus the PR it belongs to. `red` is 1
 *  when a leg of the run reported red (migration 0010): a red run is final, never rerun. */
export interface StalledRun extends GateRunRecord { repo: string; pr: number; red?: number }

/** A run whose progress is older than this is past the watchdog's window: the
 *  cron checks for two hours, far past one leg attempt. */
export const GATE_WATCHDOG_LOOKBACK_MS = 2 * 60 * 60_000;

/** The age at which a run whose rerun never started takes the final error verdict. The sweep
 *  stops reading a run at LOOKBACK, so the verdict posts five minutes before it leaves the sweep. */
export const GATE_WATCHDOG_FINAL_MS = GATE_WATCHDOG_LOOKBACK_MS - 5 * 60_000;

/** The slice of the run index the watchdog reads and writes. */
export interface WatchdogIndex extends Pick<GateRunIndex, "latest" | "handOff"> {
  /** Stamps the runs with no progress stamp (0) with `at`, so each gets a full stall window before it can be ended (#1148 item 3). */
  adoptUnknown(at: number): Promise<void>;
  /** The pointers whose progress is at or before `before` and no older than `notBefore`, oldest first (stalled, as isStalled reads it). */
  stalled(before: number, notBefore: number): Promise<StalledRun[]>;
  /** Takes a finished run out of the sweep: its stamp becomes -1, only while the pointer still
   *  names runId at `progressedAt`. Without it, finished rows fill the sweep's cap (#1148 review). */
  retire(repo: string, pr: number, runId: string, progressedAt: number): Promise<void>;
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
  /** Whether the gate runner is on for a repo. A repo it is off for is never read past the check (#1148 review). */
  gated?: (repo: string) => boolean;
  now?: () => number;
}

/** What the sweep did with one stalled run: skipped (finished, not live, not the
 *  pointer, or a superseded rerun), rerun (ended, and its one rerun started),
 *  final (ended or unstarted at the window's edge, the final error verdict
 *  posted), or failed (an end or a rerun start did not land; the next sweep retries). */
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
  if (deps.gated !== undefined && !deps.gated(repo)) return "skipped";
  // The pointer moved on: a newer run owns this head, so this row is not the one to end.
  const latest = await deps.index.latest(repo, pr);
  if (latest?.runId !== runId) return "skipped";
  const status = await statusOf(deps.workflow, runId);
  const retire = () => deps.index.retire(repo, pr, runId, row.progressedAt ?? 0);
  const minutes = Math.round(GATE_STALL_MS / 60_000);
  // A finished run needs no watch: it is retired, so it never holds a sweep slot (#1148 review).
  if (status === "complete" || status === "errored") { await retire(); return "skipped"; }
  if (isRerunInstance(runId)) {
    if (status === "terminated") { await retire(); return "skipped"; }
    if (!isLiveStatus(status)) return "skipped";
    await endRunOrThrow(deps.workflow, runId);
    await deps.post(repo, headSha, { state: "error", description: `no progress for ${minutes} min after its infra rerun (run ${runId}); a rerun is final` });
    await retire();
    return "final";
  }
  // Red stays final (#1119): a run whose leg went red is never rerun, even when it then stalls.
  if (row.red === 1) {
    await endRunOrThrow(deps.workflow, runId);
    await deps.post(repo, headSha, { state: "error", description: `no progress for ${minutes} min after a red leg (run ${runId}); a red verdict is final` });
    await retire();
    return "final";
  }
  if (status !== "terminated" && !isLiveStatus(status)) return "skipped";
  if (isLiveStatus(status)) {
    await endRunOrThrow(deps.workflow, runId);
    await deps.post(repo, headSha, rerunStatusArgs(runId));
  }
  // The first run's infra rerun, the same one a failed-leg run starts (#1119). A run ended on an
  // earlier sweep whose launch did not land is retried here: the launch is idempotent (create by
  // id, handoff to the same rerun), so a retry never starts a second rerun.
  const rerunId = rerunInstanceId(runId);
  let outcome: InfraRerunOutcome | "failed";
  try {
    outcome = await launchInfraRerun({
      create: () => deps.workflow.create({ id: rerunId, params: { repo, pr, headSha, rerunOf: runId } }),
      get: () => deps.workflow.get(rerunId),
      handOff: () => recordInfraRerun(deps.index, { repo, pr, headSha, runId: rerunId, instanceId: runId, at: now }),
      terminate: async () => (await deps.workflow.get(rerunId)).terminate(),
    });
  } catch (err) {
    // The rerun's state is unknown (a create or a read or a handoff failed). It is not a verdict:
    // the next sweep retries it, and the final error posts only at the window's edge (#1148 review).
    console.error(`gate watchdog: ${repo}#${pr} run ${runId}: infra rerun did not land, retried next sweep`, err);
    outcome = "failed";
  }
  if (outcome === "started") return "rerun";
  // A newer push took the pointer: its run owns the head now, and no verdict is posted for this one.
  if (outcome === "superseded") return "skipped";
  if (now - (row.progressedAt ?? 0) < GATE_WATCHDOG_FINAL_MS) return "failed";
  await deps.post(repo, headSha, { state: "error", description: `no progress for ${minutes} min; the infra rerun did not start (run ${runId})` });
  await retire();
  return "final";
}
