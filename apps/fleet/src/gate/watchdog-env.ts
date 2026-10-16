// #1148 item 1: the gate run watchdog with the live Worker bindings: the GATE_WORKFLOW
// binding, the D1 run index and the installation-token status post. Kept apart from
// watchdog.ts, which stays free of env and auth imports so the bun-test project loads it.
import type { Env } from "../env";
import { postCommitStatus } from "../github/api";
import { repoTokenMinter } from "../github/auth";
import { d1WatchdogIndex } from "./auto-run-env";
import { postGateStatus, type StatusPort } from "./status-post";
import { sweepStalledRuns, type WatchdogRun } from "./watchdog";

/** One watchdog sweep, run by the every-minute cron. Its errors reach the caller;
 *  the cron keeps its other work regardless (src/index.ts). */
export async function sweepGateRunsFromEnv(env: Env): Promise<WatchdogRun[]> {
  const port: StatusPort = { mintToken: repoTokenMinter(env), postCommitStatus };
  return sweepStalledRuns({
    index: d1WatchdogIndex(env.DB),
    workflow: env.GATE_WORKFLOW,
    post: (repo, headSha, args) => postGateStatus(port, repo, headSha, args),
  });
}
