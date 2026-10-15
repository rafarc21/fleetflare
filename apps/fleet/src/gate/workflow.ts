// #715 Phase 1: the Workflow `gate`. Resolves PR head + base -> reads
// fleet.json from the FLEET's repo -> fans one GateRunnerDO leg per container
// out -> fans in to one gate/verdict commit status. The ONLY file in the gate
// runner that mints a GitHub token and posts a real commit status; every
// decision it makes (leg plan, status mapping, leg-result normalisation) lives
// in fanout.ts / leg-run.ts / verdict.ts / config.ts, unit-tested under bun test.
//
// Fan-out is one step per leg, and the step's return value is the leg's
// result. GateRunnerDO answers /run-leg synchronously with the LegResult, so
// the start-<leg> step is the whole leg. A red test is data (state "failure")
// and never throws. Any non-2xx from the DO is infra: the step throws, Workflows
// retries it once, and a second failure becomes that leg's "error". Other legs
// still finish either way.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env";
import {
  compareFiles, fetchRepoFile, getBranchSha, getPullRequest, getPullRequestHeadSha, listRepoTree, postCommitStatus,
} from "../github/api";
import { repoTokenMinter } from "../github/auth";
import { laneFilesFromTree, planBunShards } from "./bun-lane";
import BUN_SHARD_TIMINGS from "./bun-shard-timings.json";
import { matchesPathRules, parseGateConfig } from "./config";
import { planLegs, verdictToStatusArgs, type PlannedLeg } from "./fanout";
import { runLegStep } from "./leg-run";
import { aggregateVerdict, type LegResult, type Verdict } from "./verdict";

export interface GateWorkflowParams { repo: string; pr: number }

const GATE_STATUS_CONTEXT = "gate/verdict";
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

/** One leg, one start-<leg> step. The step's return value is the DO's LegResult. */
function runLeg(
  env: Env, step: WorkflowStep, instanceId: string,
  owner: string, repoName: string, planned: PlannedLeg,
): Promise<LegResult> {
  return runLegStep(
    { do: (name, config, fn) => step.do(name, config, fn) },
    async (leg) => {
      // Scoped by run instance: two PRs gating the same leg name must never
      // share one container, and "one leg per container" is the DO's contract.
      const stub = env.GATE_RUNNER.get(env.GATE_RUNNER.idFromName(`${instanceId}/${leg.leg}`));
      return stub.fetch("https://gate-runner/run-leg", {
        method: "POST",
        body: JSON.stringify({
          owner, repo: repoName, commit: leg.commit, leg: leg.leg,
          installCmd: leg.installCmd, legCmd: leg.legCmd,
          resultKey: leg.resultKey, baselineKeys: leg.baselineKeys,
        }),
      });
    },
    planned,
  );
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
