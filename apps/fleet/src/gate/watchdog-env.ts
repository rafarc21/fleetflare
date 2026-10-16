// #1148 item 1: the gate run watchdog with the live Worker bindings: the GATE_WORKFLOW
// binding, the D1 run index, the installation-token status post and the R2 leg
// results. Kept apart from watchdog.ts, which stays free of env and auth imports so
// the bun-test project loads it.
import type { Env } from "../env";
import { getPullRequest, postCommitStatus } from "../github/api";
import { repoTokenMinter } from "../github/auth";
import { isGateRunnerRepo } from "./config";
import { d1WatchdogIndex } from "./auto-run-env";
import { postGateStatus, type StatusPort } from "./status-post";
import { sweepStalledRuns, type WatchdogRun } from "./watchdog";

/** The R2 archive shape the red check reads: the real R2Bucket satisfies it. */
export interface LegArchive {
  list(opts: { prefix: string }): Promise<{ objects: { key: string }[] }>;
  get(key: string): Promise<{ json<T>(): Promise<T> } | null>;
}

/** Whether any leg under `prefix` ended red on its last attempt. A first try that
 *  has a retry is superseded by it, so a flaky leg that passes on retry is not red
 *  (#1150 review item 1). A red first try with no retry on record stays red (#1119). */
export async function redLegIn(archive: LegArchive, prefix: string): Promise<boolean> {
  const listed = await archive.list({ prefix });
  const keys = new Set(listed.objects.map((o) => o.key));
  for (const key of keys) {
    if (!key.endsWith(".retry.json") && keys.has(key.replace(/(-try2)?\.json$/, ".retry.json"))) continue;
    const stored = await archive.get(key);
    if ((await stored?.json<{ state?: string }>())?.state === "failure") return true;
  }
  return false;
}

/** Whether any leg of the run stored a red result. The leg result keys are
 *  gate/<owner>/<repo>/runs/<pr>/<runId>/... with the repo's canonical case: R2
 *  keys are case-sensitive, so the name comes from GitHub, not the lowercased index (#1119). */
async function hasRedLeg(env: Env, repo: string, pr: number, runId: string): Promise<boolean> {
  const token = await repoTokenMinter(env)(repo);
  const canonical = (await getPullRequest(token, repo, pr)).repoFullName;
  return redLegIn(env.STUDIO_ARCHIVE, `gate/${canonical}/runs/${pr}/${runId}/`);
}

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
    hasRedLeg: (repo, pr, runId) => hasRedLeg(env, repo, pr, runId),
    gated: (repo) => isGateRunnerRepo(env.GATE_RUNNER_REPOS, repo),
  });
}
