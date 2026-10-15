// #715 Phase 1: the Workflow `gate`. Resolves PR head + base -> reads
// fleet.json from the FLEET's repo -> fans one GateRunnerDO leg per container
// out -> fans in to one gate/verdict commit status. The ONLY file in the gate
// runner that mints a GitHub token and posts a real commit status; every
// decision it makes (leg plan, status mapping, event normalisation) lives in
// fanout.ts / verdict.ts / config.ts, unit-tested under bun test.
//
// Fan-out is event fan-in, not one step.do per leg. Workflows retries a step
// that THROWS (5x, backoff, 10-minute attempt timeout), so a red test inside
// one big step would be retried as if it were an infra blip. Each leg is
// therefore a short, idempotent start-<leg> step (kick the container off) and
// a waitForEvent with its own timeout. GateRunnerDO sends the LegResult back
// to this instance by sendEvent, carrying a red test's state:"failure" as
// data. Only a leg whose event never arrives (infra) becomes "error".
//
// Requires Task 16 (GateRunnerDO's /run-leg ACKs with 202 and sendEvents
// back). Until then the start step waits on the container's full run.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env";
import {
  compareFiles, fetchRepoFile, getBranchSha, getPullRequest, getPullRequestHeadSha, listRepoTree, postCommitStatus,
} from "../github/api";
import { repoTokenMinter } from "../github/auth";
import { laneFilesFromTree, planBunShards } from "./bun-lane";
import BUN_SHARD_TIMINGS from "./bun-shard-timings.json";
import { matchesPathRules, parseGateConfig } from "./config";
import {
  legEventType, normalizeLegResult, planLegs, verdictToStatusArgs, type PlannedLeg,
} from "./fanout";
import { aggregateVerdict, type LegResult, type Verdict } from "./verdict";

export interface GateWorkflowParams { repo: string; pr: number }

const GATE_STATUS_CONTEXT = "gate/verdict";
const LEG_TIMEOUT = "10 minutes"; // one ceiling per leg, not one for the whole fan-out
// Vitest shard count comes from the fleet.json gate block (default 8, capped by
// planLegs at MAX_LEGS_PER_PR). vitestCmd's {i}/{n} renders as i/n per shard.

export type GateRunOutcome =
  | { state: "success" | "failure" | "error"; description?: string; statusPostFailed: boolean }
  | { skipped: string; statusPostFailed: boolean };

export class GateWorkflow extends WorkflowEntrypoint<Env, GateWorkflowParams> {
  async run(event: WorkflowEvent<GateWorkflowParams>, step: WorkflowStep): Promise<GateRunOutcome> {
    const { repo, pr } = event.payload;
    const [owner, repoName] = repo.split("/");
    const mintToken = repoTokenMinter(this.env);

    // Only the SHAs and file list leave this step. The token is minted inside
    // each step and never returned, because step results persist in Workflow state.
    // fleet.json is read from the FLEET's own repo (env.AGENT_REPO), never
    // from `repo`: a gated repo must not be able to weaken its own gate. The
    // config is loaded first: its bun lane root decides which tree to list.
    const config = await step.do("load-config", async () => {
      const agentRepo = this.env.AGENT_REPO;
      const token = await mintToken(agentRepo);
      const text = await fetchRepoFile(token, agentRepo, "fleet.json", "HEAD");
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { return null; }
      // The PR's repo picks its `gates` entry; the `gate` block is the
      // fallback for the fleet's own repo only.
      return parseGateConfig(parsed, repo, agentRepo);
    });

    if (config === null) {
      // No gate block for this repo: not a repo this gate runs for. Post
      // nothing; the route layer (Task 12) already filters on GATE_RUNNER_REPOS.
      return { skipped: "no gate config for this repo", statusPostFailed: false };
    }

    const resolved = await step.do("resolve-pr", async () => {
      const token = await mintToken(repo);
      const pull = await getPullRequest(token, repo, pr);
      const headSha = await getPullRequestHeadSha(token, repo, pr);
      // The PR's own base branch, not the default branch: a PR into a
      // non-default branch must be gated against that branch.
      const baseSha = await getBranchSha(token, repo, pull.baseRef);
      const { files } = await compareFiles(token, repo, baseSha, headSha);
      // The bun-test lane is the head's own test files under the block's root,
      // not a list baked into this Worker, so a new test file is picked up on
      // its next run. A block with no bun lane lists nothing.
      const bunFiles = config.bunLaneRoot === undefined
        ? []
        : laneFilesFromTree(await listRepoTree(token, repo, headSha), config.bunLaneRoot, config.bunLaneGlobs);
      return { headSha, baseSha, changedFiles: files, bunFiles };
    });

    if (!matchesPathRules(resolved.changedFiles, config.pathRules)) {
      // Nothing gated changed. Post success so the required context is not
      // left pending forever. (A guess: localci.sh's own skip path is the model.)
      const statusPostFailed = await step.do("post-skip-status", async () =>
        postWithRetry(mintToken, repo, resolved.headSha,
          { state: "success", description: "no gated paths changed" }));
      return { skipped: "no gated paths changed", statusPostFailed };
    }

    const legs = planLegs({
      owner, repo: repoName, pr, runId: event.instanceId,
      headSha: resolved.headSha, baseSha: resolved.baseSha,
      install: config.install, legs: config.legs,
      bunShards: planBunShards(resolved.bunFiles, BUN_SHARD_TIMINGS.timings, config.bunShards),
      bunLaneRoot: config.bunLaneRoot ?? "",
      vitestCmd: config.vitestCmd, vitestShards: config.vitestShards,
      baselineKeys: [], // lockfile baseline keys are not wired yet; each leg installs from scratch
    });

    // Promise.all over step-backed legs: each leg's own steps are independent,
    // and aggregateVerdict reads results in configured leg order either way.
    const results = await Promise.all(
      legs.map((planned) => runLeg(this.env, step, event.instanceId, owner, repoName, planned)),
    );

    const verdict = aggregateVerdict(legs.map((l) => l.leg), results);
    const final: Exclude<Verdict, { state: "pending" }> =
      verdict.state === "pending" ? { state: "error", description: "no legs reported" } : verdict;

    // Wrapped in a step so a Workflow replay never posts the status twice.
    const statusPostFailed = await step.do("post-verdict", async () =>
      postWithRetry(mintToken, repo, resolved.headSha, verdictToStatusArgs(final)));
    return { ...final, statusPostFailed };
  }
}

/** One leg: a short kick-off step, then a waitForEvent with its own timeout.
 *  Neither a red test nor a missing event throws out of runLeg. Any failure
 *  becomes this leg's LegResult, so the other legs still finish. */
async function runLeg(
  env: Env, step: WorkflowStep, instanceId: string,
  owner: string, repoName: string, planned: PlannedLeg,
): Promise<LegResult> {
  try {
    await step.do(`start-${planned.leg}`, async () => {
      // Scoped by run instance: two PRs gating the same leg name must never
      // share one container, and "one leg per container" is the DO's contract.
      const stub = env.GATE_RUNNER.get(env.GATE_RUNNER.idFromName(`${instanceId}/${planned.leg}`));
      // GateRunnerDO ACKs 202 and sends the result back by event (Task 16). Any
      // non-2xx is an infra failure: throw so Workflows retries this kick-off.
      const res = await stub.fetch("https://gate-runner/run-leg", {
        method: "POST",
        body: JSON.stringify({
          owner, repo: repoName, commit: planned.commit, leg: planned.leg,
          installCmd: planned.installCmd, legCmd: planned.legCmd,
          resultKey: planned.resultKey, baselineKeys: planned.baselineKeys,
          instanceId, eventType: planned.eventType,
        }),
      });
      if (!res.ok) throw new Error(`start ${planned.leg} failed (${res.status})`);
    });
    const received = await step.waitForEvent<LegResult>(`wait-${planned.leg}`, {
      type: legEventType(planned.leg), timeout: LEG_TIMEOUT,
    });
    return normalizeLegResult(planned.leg, received.payload);
  } catch {
    // waitForEvent throws on timeout; a kick-off that failed past its retries
    // lands here too. Both are infra: error, never a silent pass.
    return { leg: planned.leg, state: "error", description: `${planned.leg} timed out or missing report` };
  }
}

/** Posts the terminal status with two attempts. Returns true when both fail,
 *  kept apart from the verdict state so a failed POST is never read as a
 *  red leg. Callers wrap this in step.do; the attempt loop sits inside the
 *  step, so a failed POST is not retried by Workflows' own infra retry. */
async function postWithRetry(
  mintToken: (repo: string) => Promise<string>, repo: string, sha: string,
  args: { state: "success" | "failure" | "error"; description: string },
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const token = await mintToken(repo);
      await postCommitStatus(token, repo, sha, args.state, GATE_STATUS_CONTEXT, args.description);
      return false;
    } catch (err) {
      console.error(`gate/verdict POST attempt ${attempt} failed`, err);
    }
  }
  return true;
}
