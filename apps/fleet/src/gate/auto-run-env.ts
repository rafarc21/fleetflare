// #1072 (refs #715): the webhook's auto-run with the live Worker bindings: the
// installation-token minter, the GitHub fleet.json reader and the GATE_WORKFLOW
// binding. Kept apart from auto-run.ts, which stays free of env/auth imports so
// the bun-test project can load it without pulling in cloudflare:workers.
import type { Env } from "../env";
import { autoRunPullRequest, type GateRunIndex, type GateRunRecord, type PullRequestAutoRun } from "./auto-run";
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
            + "progressed_at = excluded.progressed_at, red = 0",
        )
        .bind(repo.toLowerCase(), pr, run.headSha, run.runId, run.progressedAt ?? 0)
        .run();
    },
    async handOff(repo, pr, fromRunId, run) {
      // One conditional write: the pointer moves while it still names fromRunId, or already names
      // the run being handed to. The second case is a replayed handoff: it succeeded on its first
      // try, so it must not read as a lost one (#1148 review). A newer push's run matches neither.
      const result = await db
        .prepare(
          "UPDATE gate_pr_head SET head_sha = ?, run_id = ?, progressed_at = ?, red = 0 "
            + "WHERE repo = ? AND pr = ? AND run_id IN (?, ?)",
        )
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

/** The stall read: the pointers stamped inside the window, oldest first. Served by
 *  the progressed_at index (migration 0009). Capped, so a sweep stays bounded. A
 *  finished run is retired (progressed_at -1), so it never fills this cap. */
export const STALLED_RUNS_SQL =
  "SELECT repo, pr, head_sha AS headSha, run_id AS runId, progressed_at AS progressedAt, red FROM gate_pr_head "
  + "WHERE progressed_at > 0 AND progressed_at <= ? AND progressed_at >= ? ORDER BY progressed_at ASC LIMIT 20";

/** The watchdog's view of the same table: the stall sweep, the retirement of a
 *  finished run and the unknown-stamp adoption (#1148 item 1). */
export function d1WatchdogIndex(db: D1Database): WatchdogIndex {
  return {
    ...d1RunIndex(db),
    async adoptUnknown(at) {
      await db.prepare("UPDATE gate_pr_head SET progressed_at = ? WHERE progressed_at = 0").bind(at).run();
    },
    async retire(repo, pr, runId, progressedAt) {
      // Only while the pointer still names the run at the stamp the sweep read (#1148 review, finding 2).
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

/** Flags the pointed run as red: one of its legs reported a red verdict (#1119).
 *  A run no longer pointed at is left alone. Never throws: a failed flag must
 *  not fail the leg that reports it, and the run's own verdict still posts. */
export async function markRunRed(db: D1Database, repo: string, pr: number, runId: string): Promise<void> {
  try {
    await db
      .prepare("UPDATE gate_pr_head SET red = 1 WHERE repo = ? AND pr = ? AND run_id = ?")
      .bind(repo.toLowerCase(), pr, runId)
      .run();
  } catch (err) {
    console.error("gate: red flag failed", err);
  }
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
