// #1148 item 1: the gate run watchdog with the live Worker bindings: the GATE_WORKFLOW
// binding, the D1 run index, the installation-token status post and the R2 leg
// results. Kept apart from watchdog.ts, which stays free of env and auth imports so
// the bun-test project loads it.
import type { Env } from "../env";
import { getCommitContextStatus, getPullRequest, postCommitStatus } from "../github/api";
import { repoTokenMinter } from "../github/auth";
import { isGateRunnerRepo } from "./config";
import { d1WatchdogIndex } from "./auto-run-env";
import { GATE_STATUS_CONTEXT, postGateStatus, type StatusPort } from "./status-post";
import { hasRedResult, sweepStalledRuns, type WatchdogRun } from "./watchdog";

/** Whether any leg of the run stored a red result. The leg result keys are
 *  gate/<owner>/<repo>/runs/<pr>/<runId>/... with the repo's canonical case: R2
 *  keys are case-sensitive, so the name comes from GitHub, not the lowercased index (#1119). */
async function hasRedLeg(env: Env, repo: string, pr: number, runId: string): Promise<boolean> {
  const token = await repoTokenMinter(env)(repo);
  const canonical = (await getPullRequest(token, repo, pr)).repoFullName;
  const listed = await env.STUDIO_ARCHIVE.list({ prefix: `gate/${canonical}/runs/${pr}/${runId}/` });
  return hasRedResult(listed.objects.map((o) => o.key), async (key) => {
    const obj = await env.STUDIO_ARCHIVE.get(key);
    return obj === null ? undefined : obj.json<{ state?: string }>();
  });
}

/** One watchdog sweep, run by the every-minute cron. Its errors reach the caller;
 *  the cron keeps its other work regardless (src/index.ts). */
export async function sweepGateRunsFromEnv(env: Env): Promise<WatchdogRun[]> {
  // The gate runner's off switch stops the sweep before any read or write (#1148 review, LOW 5).
  if (env.FLEET_GATE_RUNNER !== "on") return [];
  const port: StatusPort = {
    mintToken: repoTokenMinter(env), postCommitStatus,
    getCommitStatus: (token, repo, sha) => getCommitContextStatus(token, repo, sha, GATE_STATUS_CONTEXT),
  };
  return sweepStalledRuns({
    index: d1WatchdogIndex(env.DB),
    workflow: env.GATE_WORKFLOW,
    post: (repo, headSha, args) => postGateStatus(port, repo, headSha, args),
    headStatus: async (repo, headSha) => {
      const token = await port.mintToken(repo);
      return port.getCommitStatus(token, repo, headSha);
    },
    hasRedLeg: (repo, pr, runId) => hasRedLeg(env, repo, pr, runId),
    gated: (repo) => isGateRunnerRepo(env.GATE_RUNNER_REPOS, repo),
  });
}
