// #1148 item 1: the gate run watchdog with the live Worker bindings: the GATE_WORKFLOW
// binding, the D1 run index and the installation-token status post. Kept apart from
// watchdog.ts, which stays free of env and auth imports so the bun-test project loads it.
import type { Env } from "../env";
import { postCommitStatus } from "../github/api";
import { repoTokenMinter } from "../github/auth";
import { isGateRunnerRepo } from "./config";
import { d1WatchdogIndex } from "./auto-run-env";
import { postGateStatus, type StatusPort } from "./status-post";
import { sweepStalledRuns, type WatchdogRun } from "./watchdog";

/** One watchdog sweep, run by the every-minute cron. Its errors reach the caller;
 *  the cron keeps its other work regardless (src/index.ts). */
export async function sweepGateRunsFromEnv(env: Env): Promise<WatchdogRun[]> {
  // The gate runner's off switch stops the sweep before any read or write (#1148 review, LOW 5).
  if (env.FLEET_GATE_RUNNER !== "on") return [];
  const port: StatusPort = { mintToken: repoTokenMinter(env), postCommitStatus };
  return sweepStalledRuns({
    index: d1WatchdogIndex(env.DB),
    workflow: env.GATE_WORKFLOW,
    post: (repo, headSha, args) => postGateStatus(port, repo, headSha, args),
    gated: (repo) => isGateRunnerRepo(env.GATE_RUNNER_REPOS, repo),
  });
}
