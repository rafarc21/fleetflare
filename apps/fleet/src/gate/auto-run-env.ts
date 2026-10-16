// #1072 (refs #715): the webhook's auto-run with the live Worker bindings: the
// installation-token minter, the GitHub fleet.json reader and the GATE_WORKFLOW
// binding. Kept apart from auto-run.ts, which stays free of env/auth imports so
// the bun-test project can load it without pulling in cloudflare:workers.
import type { Env } from "../env";
import { autoRunPullRequest, type GateRunIndex, type GateRunRecord, type PullRequestAutoRun } from "./auto-run";

/** The per-PR gate run pointer on the D1 gate_pr_head table (migration 0007).
 *  Keyed by lowercased repo, the way gateRunId keys a run (#1082). */
export function d1RunIndex(db: D1Database): GateRunIndex {
  return {
    async latest(repo, pr) {
      const row = await db
        .prepare("SELECT head_sha AS headSha, run_id AS runId FROM gate_pr_head WHERE repo = ? AND pr = ?")
        .bind(repo.toLowerCase(), pr)
        .first<GateRunRecord>();
      return row ?? null;
    },
    async record(repo, pr, run) {
      await db
        .prepare(
          "INSERT INTO gate_pr_head (repo, pr, head_sha, run_id) VALUES (?, ?, ?, ?) "
            + "ON CONFLICT (repo, pr) DO UPDATE SET head_sha = excluded.head_sha, run_id = excluded.run_id",
        )
        .bind(repo.toLowerCase(), pr, run.headSha, run.runId)
        .run();
    },
  };
}

/** Starts the gate run for one gated PR. Logs and never throws: GitHub gets 200
 *  whatever a run did. */
export async function autoRunFromEnv(env: Env, pr: PullRequestAutoRun): Promise<void> {
  try {
    const outcome = await autoRunPullRequest(pr, {
      workflow: env.GATE_WORKFLOW,
      index: d1RunIndex(env.DB),
    });
    console.log(`gate auto-run ${pr.repo}#${pr.pr} ${pr.headSha.slice(0, 8)}: ${outcome}`);
  } catch (err) {
    console.error(`gate auto-run ${pr.repo}#${pr.pr} ${pr.headSha.slice(0, 8)} failed`, err);
  }
}
