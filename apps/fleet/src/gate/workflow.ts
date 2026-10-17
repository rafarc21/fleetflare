// #715 Phase 1: the Workflow `gate`. Resolves PR head + base -> reads the gate
// config (load-config.ts: the fleet repo's `gates` map, else the PR repo's own
// fleet.json at the base sha) -> fans one GateRunnerDO leg per container out ->
// fans in to one gate/verdict commit status. The ONLY file in the gate
// runner that mints a GitHub token and posts a real commit status; every
// decision it makes (leg plan, status mapping, leg-result normalisation) lives
// in fanout.ts / leg-run.ts / verdict.ts / config.ts, unit-tested under bun test.
//
// Fan-out is one step per leg, and the step's return value is the leg's
// result. GateRunnerDO answers /run-leg synchronously with the LegResult, so
// the start-<leg> step is the whole leg, and a red leg runs once more as retry-<leg>. A red test is data (state "failure")
// and never throws. Any non-2xx from the DO is infra: the step throws, Workflows
// retries it once, and a second failure becomes that leg's "error". Other legs
// still finish either way.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env";
import {
  compareFiles, comparePrecheckData, fetchRepoFile, getBranchSha, getPullRequest, getPullRequestHeadSha, listRepoTree, postCommitStatus,
} from "../github/api";
import { mintRepoToken, repoTokenMinter } from "../github/auth";
import { OPS_DENYLIST_PATH, parseDenylist } from "../leak-gate";
import { resolveOpsRepo } from "../ops-repo";
import { mergePrecheckFailures, precheckBlobs } from "./merge-precheck";
import { laneFilesFromTree, planBunShards } from "./bun-lane";
import BUN_SHARD_TIMINGS from "./bun-shard-timings.json";
import { bundleOptedIn, decideGateRun, gateMapHasInvalidEntry, type GateConfig } from "./config";
import { fleetJsonReader } from "./fleet-json";
import {
  bundleKeyFor, outcomeLegs, pendingStatusArgs, planBundleLeg, planUnionLegs, verdictToStatusArgs,
  type OutcomeLeg, type PlanInput, type PlannedLeg,
} from "./fanout";
import { isFleetRepo, loadGateConfig, prConfigChanged } from "./load-config";
import { bundleStepEnabled, gateRunnerName, legRequest, legResultReader, runBundleStep, runLegStep, type LegRunResult } from "./leg-run";
import { markRunProgress } from "./auto-run";
import { d1RunIndex } from "./auto-run-env";
import {
  announceInfraRerun, infraRerunDecision, launchInfraRerun, recordInfraRerun, rerunInstanceId, rerunStarted, rerunStatusArgs,
} from "./infra-rerun";
import { postGateStatus, type StatusPort } from "./status-post";
import { aggregateVerdict, type LegResult, type Verdict } from "./verdict";

export interface GateWorkflowParams {
  repo: string;
  pr: number;
  /** Set on an auto-rerun (#1119): the run it re-runs. A rerun is never re-run again. */
  rerunOf?: string;
  /** Set on an auto-rerun (#1119): the head the first run gated. A moved head ends the rerun. */
  headSha?: string;
}

// Vitest shard count comes from the fleet.json gate block (default 8, capped by
// planLegs at MAX_LEGS_PER_PR). vitestCmd's {i}/{n} renders as i/n per shard.

export type GateRunOutcome =
  | { state: "success" | "failure" | "error"; description?: string; statusPostFailed: boolean; legs: OutcomeLeg[] }
  | { rerun: string; statusPostFailed: boolean; legs: OutcomeLeg[] }
  | { skipped: string; statusPostFailed: boolean };

export class GateWorkflow extends WorkflowEntrypoint<Env, GateWorkflowParams> {
  /** The real GitHub calls behind every gate/verdict post in this run. */
  private statusPort(): StatusPort {
    const mintToken = repoTokenMinter(this.env);
    return { mintToken, postCommitStatus };
  }

  async run(event: WorkflowEvent<GateWorkflowParams>, step: WorkflowStep): Promise<GateRunOutcome> {
    const { repo, pr } = event.payload;
    const [owner, repoName] = repo.split("/");
    const mintToken = repoTokenMinter(this.env);

    // Only the SHAs, file list and private flag leave the resolve step. The token
    // is minted inside each step and never returned, because step results persist
    // in Workflow state.
    const resolved = await step.do("resolve-pr", async () => {
      const token = await mintToken(repo);
      const pull = await getPullRequest(token, repo, pr);
      const headSha = await getPullRequestHeadSha(token, repo, pr);
      // The PR's own base branch, not the default branch: a PR into a
      // non-default branch must be gated against that branch.
      const baseSha = await getBranchSha(token, repo, pull.baseRef);
      const compare = await compareFiles(token, repo, baseSha, headSha);
      // A private base repo clones through the git proxy in its leg.
      return {
        headSha, baseSha, mergeBaseSha: compare.mergeBaseSha, baseRef: pull.baseRef,
        changedFiles: compare.files, truncated: compare.truncated, private: pull.baseRepoPrivate,
        title: pull.title, body: pull.body,
      };
    });

    // Whether the repo's own fleet.json changed is decided on CONTENT (#1091
    // review round 2), never on the file list: a rename shows only its new path.
    // It is compared between the PR's MERGE-BASE and its head (#1095 round 3),
    // not the base tip, so a base-only change since the PR branched does not put
    // a PR that never touched fleet.json on the union path. The gate config is
    // read at the PR's BASE sha (never the head), so a PR cannot edit its own
    // gate. The fleet repo's `gates` map is read at HEAD, and at the config sha
    // too for the fleet repo itself. A changed config is also read at its HEAD:
    // the run gates on base legs in full, plus the head's legs that differ from
    // them. A head config that is absent or invalid, or a head gates map with an
    // invalid entry, fails the run, never skips.
    const readFleetJson = fleetJsonReader(mintToken);
    const configChanged = await step.do("fleet-json-changed", async () =>
      prConfigChanged(readFleetJson, repo, resolved.mergeBaseSha, resolved.headSha));
    const base = await step.do("load-config", async () =>
      loadGateConfig({ repo, fleetRepo: this.env.AGENT_REPO, configSha: resolved.baseSha }, readFleetJson));
    const head: GateConfig | null | undefined = configChanged ? await step.do("load-head-config", async () =>
      loadGateConfig({ repo, fleetRepo: this.env.AGENT_REPO, configSha: resolved.headSha }, readFleetJson)) : undefined;
    const headGatesInvalid = configChanged && isFleetRepo(repo, this.env.AGENT_REPO)
      ? await step.do("head-gates-map", async () => gateMapHasInvalidEntry(await readFleetJson(repo, resolved.headSha)))
      : false;

    // An auto-rerun gates the head its first run gated (#1119). A head that moved
    // since then is gated by its own push's run, so this rerun stops here.
    if (event.payload.headSha !== undefined && event.payload.headSha !== resolved.headSha) {
      return { skipped: "head moved since the infra error", statusPostFailed: false };
    }

    const decision = decideGateRun({
      baseSha: resolved.baseSha, changedFiles: resolved.changedFiles, fleetJsonChanged: configChanged, base, head,
      truncated: resolved.truncated, headGatesInvalid,
    });
    // A failure posts on the head: a bad head config, or a base with no gate block (#1132).
    if (decision.action === "fail") {
      const statusPostFailed = await step.do("post-head-invalid", async () =>
        postGateStatus(this.statusPort(), repo, resolved.headSha, { state: "failure", description: decision.description }));
      return { state: "failure", description: decision.description, statusPostFailed, legs: [] };
    }
    // #1169: the merge prechecks GitHub auto-merge would otherwise skip —
    // closing keyword + leak scan on title/body/diff/commit identities. Runs
    // before the skip return so a docs-only PR with a keyword still goes red.
    // Fail closed: a missing denylist or scanner error is a red verdict, never
    // a silent pass (leak-gate.ts's own rule).
    const precheckFailure = await step.do("precheck", async () => {
      const token = await mintToken(repo);
      const compare = await comparePrecheckData(token, repo, resolved.baseSha, resolved.headSha);
      const opsRepo = resolveOpsRepo(this.env);
      // #1176: a confirmed-private repo never reads the ops denylist — leaks
      // cannot leave it (board/leak.ts's own skip), so the fetch is pure waste.
      const patterns = resolved.private ? [] : opsRepo === null ? [] : parseDenylist(
        await fetchRepoFile(await mintRepoToken(this.env, opsRepo, { permissions: { contents: "read" } }), opsRepo, OPS_DENYLIST_PATH, "HEAD"));
      return mergePrecheckFailures({
        title: resolved.title, body: resolved.body, patterns,
        blobs: precheckBlobs({ title: resolved.title, body: resolved.body, files: compare.files, commits: compare.commits }),
        private: resolved.private, truncated: compare.truncated,
        commitMessages: compare.commits.map((c) => c.message),
        files: compare.files,
      });
    }).catch(() => ["gate precheck failed closed"] as string[]);

    if (precheckFailure.length > 0) {
      const description = precheckFailure[0];
      const statusPostFailed = await step.do("post-precheck-failure", async () =>
        postGateStatus(this.statusPort(), repo, resolved.headSha, { state: "failure", description }));
      return { state: "failure", description, statusPostFailed, legs: [] };
    }

    if (decision.action === "skip") {
      // Post success so the required context is not left pending forever. (A guess: localci.sh's own skip path is the model.)
      const statusPostFailed = await step.do("post-skip-status", async () =>
        postGateStatus(this.statusPort(), repo, resolved.headSha,
          { state: "success", description: "no gated paths changed" }));
      return { skipped: decision.reason, statusPostFailed };
    }

    // The bun-test lane is the head's own test files under each block's root,
    // not a list baked into this Worker, so a new test file is picked up on
    // its next run. A block with no bun lane lists nothing.
    const wantsBun = base?.bunLaneRoot !== undefined || head?.bunLaneRoot !== undefined;
    const bunFiles = wantsBun ? await step.do("list-bun-lane", async () => {
      const token = await mintToken(repo);
      const tree = await listRepoTree(token, repo, resolved.headSha);
      return { base: bunLaneFiles(tree, base), head: bunLaneFiles(tree, head) };
    }) : { base: [], head: [] };

    const planFor = (cfg: GateConfig, files: string[]): PlanInput => ({
      owner, repo: repoName, pr, runId: event.instanceId,
      headSha: resolved.headSha, baseSha: resolved.baseSha,
      install: cfg.install, legs: cfg.legs,
      bunShards: planBunShards(files, BUN_SHARD_TIMINGS.timings, cfg.bunShards),
      bunLaneRoot: cfg.bunLaneRoot ?? "",
      vitestCmd: cfg.vitestCmd, vitestShards: cfg.vitestShards, image: cfg.image,
      baselineKeys: [], // lockfile baseline keys are not wired yet; each leg installs from scratch
    });
    const legs = planUnionLegs(
      base === null ? null : planFor(base, bunFiles.base),
      head ? planFor(head, bunFiles.head) : null,
    );

    // Promise.all over step-backed legs: each leg's own steps are independent,
    // and aggregateVerdict reads results in configured leg order either way.
    // The run has a leg plan, so say it is running before any leg starts (#1088).
    // A reattach starts no instance and never reaches here, so it posts nothing.
    // A failed POST is reported to the log only and never blocks the run.
    await step.do("post-pending", async () =>
      postGateStatus(this.statusPort(), repo, resolved.headSha, pendingStatusArgs(event.instanceId, legs.length)));

    // #1080: one bundle for the run, built by one leg before the others start,
    // so the legs read it instead of each cloning (the clone 429 burst). A bundle
    // that does not build is not a run failure: the legs get no bundle key and
    // clone, as before. Off unless GATE_BUNDLE is on AND every block that runs legs
    // opts in (`bundle: true`): a repo whose legs read git history never gets a snapshot.
    const bundleKey = bundleKeyFor(owner, repoName, event.instanceId, resolved.headSha);
    const bundled = bundleStepEnabled(this.env.GATE_BUNDLE, bundleOptedIn([base, head])) && await runBundleStep(
      { do: (name, config, fn) => step.do(name, config, fn) },
      (planned) => {
        const stub = this.env.GATE_RUNNER.get(this.env.GATE_RUNNER.idFromName(gateRunnerName(event.instanceId, planned.leg, crypto.randomUUID())));
        return stub.fetch("https://gate-runner/run-leg", {
          method: "POST",
          body: JSON.stringify(legRequest(owner, repoName, planned, {
            baseRef: resolved.baseRef, pr: String(pr), private: resolved.private, bundleKey, mergeBase: resolved.mergeBaseSha,
          })),
        });
      },
      planBundleLeg({ owner, repo: repoName, pr, runId: event.instanceId, headSha: resolved.headSha, baseSha: resolved.baseSha }),
    );

    // Every leg attempt stamps the run's progress, so a live run that stops
    // progressing is hung to a manual start (#1135). A failed stamp never fails the leg.
    const touch = (): Promise<void> =>
      markRunProgress(d1RunIndex(this.env.DB), repo, pr, event.instanceId, Date.now());
    const results = await Promise.all(
      legs.map((planned) => runLeg(this.env, step, event.instanceId, owner, repoName,
        {
          baseRef: resolved.baseRef, pr: String(pr), private: resolved.private,
          bundleKey: bundled ? bundleKey : undefined, mergeBase: bundled ? resolved.mergeBaseSha : undefined,
        }, planned, touch)),
    );

    const verdict = aggregateVerdict(legs.map((l) => l.leg), results);
    const final: Exclude<Verdict, { state: "pending" }> =
      verdict.state === "pending" ? { state: "error", description: "no legs reported" } : verdict;

    // #1119: an all-infra run re-runs itself once, on the same head, instead of
    // ending red. Its pending status goes up first, so the rerun's own status
    // cannot be overwritten by this run's. A failed start falls through to the
    // final error verdict below.
    if (final.state === "error" && infraRerunDecision(results, event.payload.rerunOf)) {
      const rerunId = rerunInstanceId(event.instanceId);
      // The progress stamp goes first, so the watchdog never reads this run as stalled mid-start (#1148 review).
      const statusPostFailed = await step.do("post-infra-rerun", async () => announceInfraRerun({
        touch,
        post: () => postGateStatus(this.statusPort(), repo, resolved.headSha, rerunStatusArgs(event.instanceId)),
      }));
      // The start retries its step while the rerun's state is unknown (#1148 item 4). Once the retries
      // run out, the outcome is "failed" and the final error verdict posts below.
      const started = await step.do("start-infra-rerun", async () => launchInfraRerun({
        create: () => this.env.GATE_WORKFLOW.create({
          id: rerunId, params: { repo, pr, headSha: resolved.headSha, rerunOf: event.instanceId },
        }),
        get: () => this.env.GATE_WORKFLOW.get(rerunId),
        // The rerun takes the PR's run pointer, so a manual start finds it (#1084).
        // One conditional handoff: a newer push's pointer is never taken back (#1135).
        handOff: () => recordInfraRerun(d1RunIndex(this.env.DB), {
          repo, pr, headSha: resolved.headSha, runId: rerunId, instanceId: event.instanceId, at: Date.now(),
        }),
        terminate: async () => (await this.env.GATE_WORKFLOW.get(rerunId)).terminate(),
      })).catch((err: unknown) => {
        console.error("gate: infra rerun start failed", err);
        return "failed" as const;
      });
      // A step result cached before the outcome became a string replays as `true` (#1150 review).
      if (rerunStarted(started)) return { rerun: rerunId, statusPostFailed, legs: outcomeLegs(results) };
    }

    // Wrapped in a step so a Workflow replay never posts the status twice.
    const statusPostFailed = await step.do("post-verdict", async () =>
      postGateStatus(this.statusPort(), repo, resolved.headSha, verdictToStatusArgs(final, {
        expected: legs.map((l) => l.leg), results, runId: event.instanceId,
      })));
    // Per-leg output (#1049) rides in the final result, in plan order.
    return { ...final, statusPostFailed, legs: outcomeLegs(results) };
  }
}

/** The lane files for one gate block, from the run's head tree. None when the block has no bun lane. */
function bunLaneFiles(tree: Parameters<typeof laneFilesFromTree>[0], cfg: GateConfig | null | undefined): string[] {
  if (cfg?.bunLaneRoot === undefined) return [];
  return laneFilesFromTree(tree, cfg.bunLaneRoot, cfg.bunLaneGlobs);
}

/** One leg: a start-<leg> step, and a retry-<leg> step when it fails red. The step's return value is the DO's LegResult. */
function runLeg(
  env: Env, step: WorkflowStep, instanceId: string,
  owner: string, repoName: string, pr: { baseRef: string; pr: string; private: boolean; bundleKey?: string; mergeBase?: string }, planned: PlannedLeg,
  touch: () => Promise<void>,
): Promise<LegRunResult> {
  return runLegStep(
    { do: (name, config, fn) => step.do(name, config, fn) },
    async (leg, attemptId, signal) => {
      // Scoped by run instance, leg AND attempt: two PRs gating the same leg name
      // must never share one container, one leg per container is the DO's
      // contract, and a retry must never reuse a DO a prior attempt is tearing down (#1068).
      const stub = env.GATE_RUNNER.get(env.GATE_RUNNER.idFromName(gateRunnerName(instanceId, leg.leg, attemptId)));
      await touch();
      // The signal ends a hung DO call at the attempt deadline, so it cannot hold the step open (#1135).
      return stub.fetch("https://gate-runner/run-leg", {
        method: "POST",
        body: JSON.stringify(legRequest(owner, repoName, leg, { ...pr, image: leg.image })),
        signal,
      });
    },
    planned,
    // The container writes its R2 result before it stops; a lost transport reads it back (#1094).
    { readResult: legResultReader(env.STUDIO_ARCHIVE) },
  );
}
