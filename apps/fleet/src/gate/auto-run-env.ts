// #1072 (refs #715): the webhook's auto-run with the live Worker bindings: the
// installation-token minter, the GitHub fleet.json reader and the GATE_WORKFLOW
// binding. Kept apart from auto-run.ts, which stays free of env/auth imports so
// the bun-test project can load it without pulling in cloudflare:workers.
import type { Env } from "../env";
import { repoTokenMinter } from "../github/auth";
import { fleetJsonReader } from "./fleet-json";
import { autoRunPullRequest, type PullRequestAutoRun } from "./auto-run";

/** Starts the gate run for one gated PR. Logs and never throws: GitHub gets 200
 *  whatever a run did. */
export async function autoRunFromEnv(env: Env, pr: PullRequestAutoRun): Promise<void> {
  try {
    const outcome = await autoRunPullRequest(pr, {
      fleetRepo: env.AGENT_REPO,
      readFleetJson: fleetJsonReader(repoTokenMinter(env)),
      workflow: env.GATE_WORKFLOW,
    });
    console.log(`gate auto-run ${pr.repo}#${pr.pr} ${pr.headSha.slice(0, 8)}: ${outcome}`);
  } catch (err) {
    console.error(`gate auto-run ${pr.repo}#${pr.pr} ${pr.headSha.slice(0, 8)} failed`, err);
  }
}
