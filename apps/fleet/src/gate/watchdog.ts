// #1148 item 1 (refs #1135): the gate run watchdog. The every-minute cron sweeps
// the per-PR run index. A live run with no progress for GATE_STALL_MS is hung (a
// leg attempt lost its engine, so nothing stamps its progress). A run that is
// already a rerun, or whose stored legs show a red result, takes the final
// verdict. Any other stalled first run is rerun once (infra, #1119). Pure of
// bindings: the cron glue (watchdog-env.ts) passes the real index, engine,
// status post and R2 leg-result check.
import {
  endRunOrThrow, GATE_STALL_MS, isLiveStatus, type GateRunIndex, type GateRunInstance, type GateRunRecord,
} from "./auto-run";
import {
  type InfraRerunOutcome, isRerunInstance, launchInfraRerun, recordInfraRerun, rerunInstanceId, rerunStatusArgs,
} from "./infra-rerun";

/** A row the watchdog may sweep: the run index's pointer plus the PR it belongs to. */
export interface StalledRun extends GateRunRecord { repo: string; pr: number }

/** A run whose progress is older than this is past the watchdog's window: the
 *  cron checks for two hours, far past one leg attempt. */
export const GATE_WATCHDOG_LOOKBACK_MS = 2 * 60 * 60_000;

/** A run that still cannot start its rerun this long after its last progress
 *  gets the final error verdict. Five minutes inside the window's edge, so the
 *  verdict posts before the row leaves the sweep. */
export const GATE_WATCHDOG_FINAL_AGE_MS = GATE_WATCHDOG_LOOKBACK_MS - 5 * 60_000;

/** Whether any leg's decisive stored result is red. `read` gets one stored result
 *  by key, undefined when absent. A red first try is final unless its retry
 *  passed (#1156 N1c); a red retry is always red; an infra first try's try-2
 *  result decides over it (#1150 review). */
export async function hasRedResult(
  keys: string[], read: (key: string) => Promise<{ state?: string } | undefined>,
): Promise<boolean> {
  const bases = new Set(keys.map((k) => k.replace(/(\.retry\.json|-try2\.json|\.json)$/, "")));
  for (const base of bases) {
    const retryKey = `${base}.retry.json`;
    const retry = keys.includes(retryKey) ? await read(retryKey) : undefined;
    const try2Key = `${base}-try2.json`;
    const try2 = keys.includes(try2Key) ? await read(try2Key) : undefined;
    const jsonKey = `${base}.json`;
    const json = keys.includes(jsonKey) ? await read(jsonKey) : undefined;
    // try-2 decides over the original first attempt for an infra leg; the retry
    // decides over a red first try only when it passed (#1156 N1c).
    const first = try2 ?? json;
    if (retry?.state === "failure") return true;
    if (first?.state === "failure" && retry?.state !== "success") return true;
  }
  return false;
}

/** The slice of the run index the watchdog reads and writes. */
export interface WatchdogIndex extends Pick<GateRunIndex, "latest" | "handOff" | "progress"> {
  /** Stamps the runs with no progress stamp (0) with `at`, so each gets a full stall window before it can be ended (#1148 item 3). */
  adoptUnknown(at: number): Promise<void>;
  /** The pointers whose progress is at or before `before` and no older than `notBefore`, oldest first. */
  stalled(before: number, notBefore: number): Promise<StalledRun[]>;
  /** Retires a finished run's row: its stamp becomes -1, so no later sweep lists it. Only while the row still holds `progressedAt`. */
  retire(repo: string, pr: number, runId: string, progressedAt: number): Promise<void>;
}

/** The params an infra rerun is created with: the GateWorkflow's payload for a rerun. */
export interface RerunParams { repo: string; pr: number; headSha: string; rerunOf: string }

/** The slice of the GATE_WORKFLOW binding the watchdog uses. */
export interface WatchdogWorkflow {
  create(opts: { id: string; params: RerunParams }): Promise<unknown>;
  get(id: string): Promise<GateRunInstance>;
}

export interface WatchdogDeps {
  index: WatchdogIndex;
  workflow: WatchdogWorkflow;
  /** Posts a commit status on the head: the real GitHub call in the Worker, a recorder in tests.
   *  Returns true when the post failed after its retries (postGateStatus's contract), false when it landed. */
  post: (repo: string, headSha: string, args: { state: "pending" | "error" | "failure"; description: string }) => Promise<boolean>;
  /** Whether the gate runner is on for a repo. A repo it is off for is never read past this check (#1148 review). */
  gated?: (repo: string) => boolean;
  /** Whether any leg of the run stored a red result. A red result is final, never rerun (#1119). */
  hasRedLeg: (repo: string, pr: number, runId: string) => Promise<boolean>;
  now?: () => number;
}

/** What the sweep did with one stalled run: skipped (finished, retired, or no
 *  longer the pointer), rerun (the rerun took over, the first run ended), final
 *  (ended, the final verdict posted), or failed (the sweep retries it next minute). */
export type WatchdogOutcome = "skipped" | "rerun" | "final" | "failed";

export interface WatchdogRun { runId: string; outcome: WatchdogOutcome }

/** One watchdog sweep. Handles each stalled run; a run that fails does not stop the sweep. */
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
  // A repo the gate runner is off for is retired at once, so its row never holds
  // one of the sweep's 20 slots (#1156 item 2). Retire is conditional on the
  // stamp, so a moved pointer is left alone.
  if (deps.gated !== undefined && !deps.gated(repo)) {
    await deps.index.retire(repo, pr, runId, row.progressedAt ?? 0);
    return "skipped";
  }
  // The pointer moved on: a newer run owns this head, so this row is not the one to end.
  const latest = await deps.index.latest(repo, pr);
  if (latest?.runId !== runId) return "skipped";
  // A failed read throws: the row is kept and the next sweep reads it again.
  const status = (await (await deps.workflow.get(runId)).status()).status;
  if (!isLiveStatus(status)) {
    // Only a finished run is retired. "unknown" can be a blip: the next sweep reads it again.
    if (status === "complete" || status === "errored" || status === "terminated") {
      await deps.index.retire(repo, pr, runId, row.progressedAt ?? 0);
    }
    return "skipped";
  }

  const minutes = Math.round(GATE_STALL_MS / 60_000);
  let red: boolean;
  try {
    red = await deps.hasRedLeg(repo, pr, runId);
  } catch (err) {
    // The red check resolves the canonical repo name via GitHub (#1156 item 1):
    // before the final age a failed check rethrows (the row is kept, retried next
    // minute); at the final age the run ends with the final error verdict.
    if (now - (row.progressedAt ?? 0) < GATE_WATCHDOG_FINAL_AGE_MS) throw err;
    return await endRunFinal(deps, row, now, {
      state: "error", description: `no progress for ${minutes} min; could not check leg results (run ${runId})`,
    });
  }
  if (red || isRerunInstance(runId)) {
    return await endRunFinal(deps, row, now, red
      ? { state: "failure", description: `a leg failed before the run stalled (run ${runId})` }
      : { state: "error", description: `no progress for ${minutes} min after its infra rerun (run ${runId}); a rerun is final` });
  }

  // The rerun takes the pointer before the first run is ended. An unknown start
  // throws: the first run stays live, so the next sweep retries it by id (#1150 review item 3).
  const rerunId = rerunInstanceId(runId);
  let outcome: InfraRerunOutcome;
  try {
    outcome = await launchInfraRerun({
      create: () => deps.workflow.create({ id: rerunId, params: { repo, pr, headSha, rerunOf: runId } }),
      get: () => deps.workflow.get(rerunId),
      handOff: () => recordInfraRerun(deps.index, { repo, pr, headSha, runId: rerunId, instanceId: runId, at: now }),
      terminate: async () => (await deps.workflow.get(rerunId)).terminate(),
    });
  } catch (err) {
    if (now - (row.progressedAt ?? 0) < GATE_WATCHDOG_FINAL_AGE_MS) throw err;
    return await endRunFinal(deps, row, now, {
      state: "error", description: `no progress for ${minutes} min; the infra rerun did not start (run ${runId})`,
    });
  }
  if (outcome === "superseded") {
    await endRunLogged(deps.workflow, runId);
    return "skipped";
  }
  await deps.post(repo, headSha, rerunStatusArgs(runId));
  await endRunLogged(deps.workflow, runId);
  return "rerun";
}

/** Ends a stalled run with its final verdict. The progress stamp lands first
 *  (#1156 item 3): a concurrent sweep reads a fresh stamp, so a slow post is
 *  never re-stalled. The post lands before the end and the retire (#1156 item 4):
 *  a post that failed after its retries restores the pre-stamp progress and
 *  rethrows so the next sweep retries the verdict — unless the run is at/over
 *  the final age, when the row leaves the sweep regardless, so it ends and
 *  retires, logging the lost verdict. */
async function endRunFinal(
  deps: WatchdogDeps, row: StalledRun, now: number,
  args: { state: "error" | "failure"; description: string },
): Promise<WatchdogOutcome> {
  const stamped = row.progressedAt ?? 0;
  await deps.index.progress(row.repo, row.pr, row.runId, now);
  const postFailed = await deps.post(row.repo, row.headSha, args);
  if (postFailed) {
    // At the final age the row leaves the sweep next minute regardless, so end
    // and retire it and log the lost verdict rather than restore and retry.
    if (now - stamped >= GATE_WATCHDOG_FINAL_AGE_MS) {
      console.error(`gate watchdog: final status post failed at the final age for ${row.runId}; verdict lost`);
      await endRunOrThrow(deps.workflow, row.runId);
      await deps.index.retire(row.repo, row.pr, row.runId, now);
      return "final";
    }
    await deps.index.progress(row.repo, row.pr, row.runId, stamped);
    throw new Error(`gate watchdog: final status post failed for ${row.runId}`);
  }
  await endRunOrThrow(deps.workflow, row.runId);
  await deps.index.retire(row.repo, row.pr, row.runId, now);
  return "final";
}

/** Ends the first run once its rerun has the pointer. A failed end is logged: the
 *  rerun stands, and the stalled run is no longer the pointer, so it is not swept again. */
async function endRunLogged(workflow: WatchdogWorkflow, runId: string): Promise<void> {
  try {
    await endRunOrThrow(workflow, runId);
  } catch (err) {
    console.error(`gate watchdog: run ${runId} not ended after its rerun took over`, err);
  }
}
