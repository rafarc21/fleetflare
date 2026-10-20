// #1072 (refs #715): the webhook's auto-run with the live Worker bindings:
// GATE_WORKFLOW and the D1 run index. Kept apart from auto-run.ts, which stays
// free of env/auth imports so the bun-test project can load it without pulling
// in cloudflare:workers. Only the GATE_RUNNER_REPOS / FLEET_GATE_RUNNER switch
// (not a gate block) turns a repo off: a gated repo with no valid gate config
// fails red (#1132).
import type { Env } from "../env";
import { autoRunPullRequest, type GateRunIndex, type GateRunRecord, type PullRequestAutoRun } from "./auto-run";
import { postGateStatus, realStatusPort } from "./status-post";
import type { StalledRun, WatchdogIndex } from "./watchdog";

/** The per-PR gate run pointer on the D1 gate_pr_head table (migrations 0007, 0008).
 *  Keyed by lowercased repo, the way gateRunId keys a run (#1082). */
export function d1RunIndex(db: D1Database): GateRunIndex {
  return {
    async latest(repo, pr) {
      const row = await db
        .prepare("SELECT head_sha AS headSha, run_id AS runId, progressed_at AS progressedAt FROM gate_pr_head WHERE repo = ? AND pr = ?")
        .bind(repo.toLowerCase(), pr)
        .first<GateRunRecord>();
      return row ?? null;
    },
    async record(repo, pr, run) {
      await db
        .prepare(
          "INSERT INTO gate_pr_head (repo, pr, head_sha, run_id, progressed_at) VALUES (?, ?, ?, ?, ?) "
            + "ON CONFLICT (repo, pr) DO UPDATE SET head_sha = excluded.head_sha, run_id = excluded.run_id, "
            + "progressed_at = excluded.progressed_at",
        )
        .bind(repo.toLowerCase(), pr, run.headSha, run.runId, run.progressedAt ?? 0)
        .run();
    },
    async handOff(repo, pr, fromRunId, run) {
      // One conditional write: the pointer moves only while it still names fromRunId (#1135), or
      // already names run.runId: a replayed start whose handoff landed is success, not a superseded rerun (#1150).
      const result = await db
        .prepare("UPDATE gate_pr_head SET head_sha = ?, run_id = ?, progressed_at = ? WHERE repo = ? AND pr = ? AND run_id IN (?, ?)")
        .bind(run.headSha, run.runId, run.progressedAt ?? 0, repo.toLowerCase(), pr, fromRunId, run.runId)
        .run();
      return result.meta.changes > 0;
    },
    async progress(repo, pr, runId, at) {
      await db
        .prepare("UPDATE gate_pr_head SET progressed_at = ? WHERE repo = ? AND pr = ? AND run_id = ?")
        .bind(at, repo.toLowerCase(), pr, runId)
        .run();
    },
  };
}

/** The stall read: the pointers stamped inside the window, oldest first. Served by the
 *  progressed_at index (migration 0009). Capped, so a sweep stays bounded however many PRs were gated. */
export const STALLED_RUNS_SQL =
  "SELECT repo, pr, head_sha AS headSha, run_id AS runId, progressed_at AS progressedAt FROM gate_pr_head "
  + "WHERE progressed_at > 0 AND progressed_at <= ? AND progressed_at >= ? ORDER BY progressed_at ASC LIMIT 20";

/** The watchdog's view of the same table: the stall sweep and the unknown-stamp
 *  adoption (#1148 item 1). Capped, so a sweep stays bounded however many PRs were gated. */
export function d1WatchdogIndex(db: D1Database): WatchdogIndex {
  return {
    ...d1RunIndex(db),
    async adoptUnknown(at) {
      await db.prepare("UPDATE gate_pr_head SET progressed_at = ? WHERE progressed_at = 0").bind(at).run();
    },
    async retire(repo, pr, runId, progressedAt) {
      await db
        .prepare("UPDATE gate_pr_head SET progressed_at = -1 WHERE repo = ? AND pr = ? AND run_id = ? AND progressed_at = ?")
        .bind(repo.toLowerCase(), pr, runId, progressedAt)
        .run();
    },
    async stalled(before, notBefore) {
      const rows = await db.prepare(STALLED_RUNS_SQL).bind(before, notBefore).all<StalledRun>();
      return rows.results;
    },
  };
}

/** #1191/#1214: the pending-status post a fresh run puts up before it is created,
 *  so GitHub never sees the head without a pending gate/verdict. #1226: postGateStatus
 *  now throws on a failed post (no step.do/Workflow retry wraps this call site — it
 *  runs before the Workflow instance even exists) — caught and logged here, same as
 *  before: a pending post must never block the run that follows it. */
function pendingPost(env: Env, description: string) {
  return async (repo: string, headSha: string): Promise<void> => {
    await postGateStatus(realStatusPort(env), repo, headSha, { state: "pending", description }).catch((err: unknown) => {
      console.error(`gate auto-run ${repo} ${headSha.slice(0, 8)}: pending status post failed`, err);
    });
  };
}

/** Starts the gate run for one gated PR. Logs and never throws: GitHub gets 200
 *  whatever a run did. */
export async function autoRunFromEnv(env: Env, pr: PullRequestAutoRun): Promise<void> {
  try {
    const outcome = await autoRunPullRequest(pr, {
      workflow: env.GATE_WORKFLOW,
      index: d1RunIndex(env.DB),
      postPending: pendingPost(env, pr.edited === true ? "running (edited title/body recheck)" : "running (fresh gate run)"),
    });
    console.log(`gate auto-run ${pr.repo}#${pr.pr} ${pr.headSha.slice(0, 8)}: ${outcome}`);
  } catch (err) {
    console.error(`gate auto-run ${pr.repo}#${pr.pr} ${pr.headSha.slice(0, 8)} failed`, err);
  }
}
