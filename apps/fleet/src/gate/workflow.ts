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
  compareFiles, comparePrecheckData, fetchRepoFile, getBranchSha, getPullRequest, getPullRequestHeadSha, listOpenPulls, listRepoTree,
} from "../github/api";
import { mintRepoToken, repoTokenMinter } from "../github/auth";
import { OPS_DENYLIST_PATH, parseDenylist } from "../leak-gate";
import { resolveOpsRepo } from "../ops-repo";
import { capStatusDescription, mergePrecheckFailures, precheckBlobs, recheckFailures } from "./merge-precheck";
import { laneFilesFromTree, planBunShards } from "./bun-lane";
import BUN_SHARD_TIMINGS from "./bun-shard-timings.json";
import {
  bundleOptedIn, decideGateRun, gateMapHasInvalidEntry, guardSuccessStatus,
  type GateConfig, type SharedHeadLookup,
} from "./config";
import { fleetJsonReader } from "./fleet-json";
import {
  bundleKeyFor, carriedGreenByLeg, greenLegsOf, outcomeLegs, pendingStatusArgs, planBundleLeg, planFingerprint, planUnionLegs, verdictToStatusArgs,
  type CarryGreen, type OutcomeLeg, type PlanInput, type PlannedLeg,
} from "./fanout";
import { isFleetRepo, loadGateConfig, prConfigChanged } from "./load-config";
import { bundleStepEnabled, gateRunnerName, legRequest, legResultReader, runBundleStep, runLegStep, type LegRunResult } from "./leg-run";
import { markRunProgress } from "./auto-run";
import { d1RunIndex } from "./auto-run-env";
import {
  announceInfraRerun, infraRerunDecision, launchInfraRerun, recordInfraRerun, rerunInstanceId, rerunStarted, rerunStatusArgs,
} from "./infra-rerun";
import { postGateStatus, STATUS_POST_STEP_CONFIG, type StatusPort } from "./status-post";
import { realStatusPort } from "./status-post-env";
import { aggregateVerdict, type LegResult, type Verdict } from "./verdict";

export interface GateWorkflowParams {
  repo: string;
  pr: number;
  /** Set on an auto-rerun (#1119): the run it re-runs. A rerun is never re-run again. */
  rerunOf?: string;
  /** Set on an auto-rerun (#1119): the head the first run gated. A moved head ends the rerun. */
  headSha?: string;
  /** #1230: the prior run's green legs. Valid only while head sha, base sha and
   *  the plan fingerprint all match this run's own resolve — any mismatch is a
   *  full replan (carriedGreenByLeg returns empty), never a stale carry. */
  carryGreen?: CarryGreen;
}

// Vitest shard count comes from the fleet.json gate block (default 8, capped by
// planLegs at MAX_LEGS_PER_PR). vitestCmd's {i}/{n} renders as i/n per shard.

// #1226: every `statusPostFailed` below is now hardcoded `false` at every
// return site that reaches it — a real post failure throws out of run()
// before any `return` executes (postGateStatus's new throw contract), so this
// field can never actually be observed `true` on a completed instance
// anymore. It stays only for the JSON shape's backward compatibility
// (routes.ts forwards it; cli/gate.ts's gateWatchExitCode still branches on
// it) — removing it is a separate, bigger decision outside this fix's scope.
export type GateRunOutcome =
  | {
      state: "success" | "failure" | "error"; description?: string; statusPostFailed: boolean; legs: OutcomeLeg[];
      /** #1230: the plan this run resolved to. Only the two post-plan returns
       *  below set these; the early-return paths (fail/precheck/skip) never
       *  reach a plan, so they carry neither. */
      baseSha?: string; planFingerprint?: string;
      /** #1230 maestro review: the sha this run actually resolved and tested
       *  (`resolved.headSha` from the live resolve-pr step), never an input
       *  echo. The D1 run index's `headSha` is only the dispatch-time label and
       *  can go stale when a run is slow to start and the index's entry is
       *  reused for a later push to the same sha (see routes.ts). */
      headSha?: string;
    }
  | { rerun: string; statusPostFailed: boolean; legs: OutcomeLeg[]; baseSha?: string; planFingerprint?: string; headSha?: string }
  | { skipped: string; statusPostFailed: boolean };

export class GateWorkflow extends WorkflowEntrypoint<Env, GateWorkflowParams> {
  /** The real GitHub calls behind every gate/verdict post in this run. */
  private statusPort(): StatusPort {
    return realStatusPort(this.env);
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
      await step.do("post-head-invalid", STATUS_POST_STEP_CONFIG, async () =>
        postGateStatus(this.statusPort(), repo, resolved.headSha, { state: "failure", description: decision.description }));
      return { state: "failure", description: decision.description, statusPostFailed: false, legs: [] };
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
      const description = capStatusDescription(precheckFailure[0]);
      await step.do("post-precheck-failure", STATUS_POST_STEP_CONFIG, async () =>
        postGateStatus(this.statusPort(), repo, resolved.headSha, { state: "failure", description }));
      return { state: "failure", description, statusPostFailed: false, legs: [] };
    }

    // #1176: a green run must not certify a title/body edited after the run
    // started — re-read them and re-run the pure precheck (keyword + leak on the
    // fresh title/body, diff not refetched) before either success post. Fail
    // closed on error. Only one of the two call sites executes per run, so the
    // shared step name replays correctly.
    const recheck = async (): Promise<string[]> => {
      const token = await mintToken(repo);
      const pull = await getPullRequest(token, repo, pr);
      const opsRepo = resolveOpsRepo(this.env);
      const patterns = resolved.private ? [] : opsRepo === null ? [] : parseDenylist(
        await fetchRepoFile(await mintRepoToken(this.env, opsRepo, { permissions: { contents: "read" } }), opsRepo, OPS_DENYLIST_PATH, "HEAD"));
      return recheckFailures({ title: pull.title, body: pull.body, patterns, private: resolved.private });
    };
    const postRecheckFailure = async (failures: string[]) => {
      const description = capStatusDescription(failures[0]);
      await step.do("post-recheck-failure", STATUS_POST_STEP_CONFIG, async () =>
        postGateStatus(this.statusPort(), repo, resolved.headSha, { state: "failure", description }));
      return { state: "failure" as const, description, statusPostFailed: false, legs: [] };
    };

    if (decision.action === "skip") {
      const recheckFailure = await step.do("precheck-recheck", recheck).catch(() => ["gate precheck failed closed"] as string[]);
      if (recheckFailure.length > 0) return postRecheckFailure(recheckFailure);
      // Post success so the required context is not left pending forever. (A guess: localci.sh's own skip path is the model.)
      // #1172: the guard runs first, so a shared head with a different base fails, never skips green.
      const shared = await step.do("shared-head-guard-skip", async () =>
        sharedHeadLookup(mintToken, repo, resolved.headSha))
        .catch(() => SHARED_HEAD_LOOKUP_FAILED);
      // #1214 round 2: return the GUARDED (state, description), so the status
      // route and CLI report the same red the downgraded skip posts to GitHub.
      const guarded = guardSuccessStatus(resolved.headSha, resolved.baseRef, pr, shared,
        { state: "success", description: "no gated paths changed" });
      await step.do("post-skip-status", STATUS_POST_STEP_CONFIG, async () =>
        postGateStatus(this.statusPort(), repo, resolved.headSha, guarded));
      return { ...guarded, statusPostFailed: false, legs: [] };
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
    // #1230: the plan's fingerprint, and the prior run's green legs it still
    // applies to (empty on any mismatch: a different head, base or plan is a
    // full replan, never a stale carry).
    const fingerprint = planFingerprint(legs);
    const carriedByLeg = carriedGreenByLeg(event.payload.carryGreen, {
      headSha: resolved.headSha, baseSha: resolved.baseSha, planFingerprint: fingerprint,
    });

    // Promise.all over step-backed legs: each leg's own steps are independent,
    // and aggregateVerdict reads results in configured leg order either way.
    // The run has a leg plan, so say it is running before any leg starts (#1088).
    // A reattach starts no instance and never reaches here, so it posts nothing.
    // Fail-closed since #1226: postGateStatus throws, this step retries 5x, and
    // exhausted retries error the run rather than leaving an unconfirmed head.
    await step.do("post-pending", STATUS_POST_STEP_CONFIG, async () =>
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
      legs.map((planned) => {
        // #1230: a leg already green in the carry rides straight into the
        // verdict; everything else dispatches to GATE_RUNNER as before.
        const carried = carriedByLeg.get(planned.leg);
        if (carried !== undefined) return Promise.resolve(carried as LegRunResult);
        return runLeg(this.env, step, event.instanceId, owner, repoName,
          {
            baseRef: resolved.baseRef, pr: String(pr), private: resolved.private,
            bundleKey: bundled ? bundleKey : undefined, mergeBase: bundled ? resolved.mergeBaseSha : undefined,
          }, planned, touch);
      }),
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
      await step.do("post-infra-rerun", STATUS_POST_STEP_CONFIG, async () => announceInfraRerun({
        touch,
        post: () => postGateStatus(this.statusPort(), repo, resolved.headSha, rerunStatusArgs(event.instanceId)),
      }));
      // The start retries its step while the rerun's state is unknown (#1148 item 4). Once the retries
      // run out, the outcome is "failed" and the final error verdict posts below.
      const started = await step.do("start-infra-rerun", async () => launchInfraRerun({
        create: () => this.env.GATE_WORKFLOW.create({
          id: rerunId,
          params: {
            repo, pr, headSha: resolved.headSha, rerunOf: event.instanceId,
            // #1230: the legs that already went green carry forward, so the
            // rerun only dispatches the infra-failed ones.
            carryGreen: {
              headSha: resolved.headSha, baseSha: resolved.baseSha, planFingerprint: fingerprint,
              legs: greenLegsOf(results),
            },
          },
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
      if (rerunStarted(started)) {
        return {
          rerun: rerunId, statusPostFailed: false, legs: outcomeLegs(results),
          baseSha: resolved.baseSha, planFingerprint: fingerprint, headSha: resolved.headSha,
        };
      }
    }

    // #1176: before the verdict post, re-read title/body once more — only a
    // GREEN verdict can certify a PR for auto-merge, so only that one is gated
    // by the recheck; a red verdict posts red either way.
    if (final.state === "success") {
      const recheckFailure = await step.do("precheck-recheck", recheck).catch(() => ["gate precheck failed closed"] as string[]);
      if (recheckFailure.length > 0) return postRecheckFailure(recheckFailure);
    }

    // Wrapped in a step so a Workflow replay never posts the status twice.
    // #1172: a success verdict still fails when a sibling PR shares the head
    // with a different base. The guard runs before the post; a failure or error
    // verdict posts as-is.
    const verdictArgs = verdictToStatusArgs(final, {
      expected: legs.map((l) => l.leg), results, runId: event.instanceId,
    });
    const shared = await step.do("shared-head-guard-verdict", async () =>
      sharedHeadLookup(mintToken, repo, resolved.headSha))
      .catch(() => SHARED_HEAD_LOOKUP_FAILED);
    const guarded = verdictArgs.state === "success"
      ? guardSuccessStatus(resolved.headSha, resolved.baseRef, pr, shared,
        { state: "success", description: verdictArgs.description })
      : verdictArgs;
    await step.do("post-verdict", STATUS_POST_STEP_CONFIG, async () =>
      postGateStatus(this.statusPort(), repo, resolved.headSha, guarded));
    // Per-leg output (#1049) rides in the final result, in plan order. #1214
    // round 2: `guarded` (not `final`) rides, so a downgraded success reports
    // failure here exactly as GitHub sees it. #1230: baseSha/planFingerprint ride
    // too, so a later `--failed-only` rerun can validate its own carry against them.
    return {
      ...guarded, statusPostFailed: false, legs: outcomeLegs(results),
      baseSha: resolved.baseSha, planFingerprint: fingerprint, headSha: resolved.headSha,
    };
  }
}

/** The shared-head guard step's fail-closed result: a lookup error becomes the
 *  "cannot list shared-head PRs" failure, never a silent green (#1172). */
const SHARED_HEAD_LOOKUP_FAILED: SharedHeadLookup = { error: "lookup failed" };

/** #1172/#1215: the shared-head guard lookup. Lists the repo's OPEN pulls via
 *  the paged listOpenPulls — the commits/{sha}/pulls endpoint never lists OPEN
 *  PRs once the sha is on the default branch, so it would false-green — and
 *  keeps the OPEN ones OF THIS HEAD as { number, baseRef }: a sibling whose tip
 *  sha differs, or that is closed, is a different head, never "shared" (#1214
 *  S3). THROWS on an error, so Workflows retries the step once (a transient 5xx
 *  ends green) and fails closed only after retries run out. A truncated page cap
 *  fails closed immediately. */
async function sharedHeadLookup(
  mintToken: (repo: string) => Promise<string>, repo: string, headSha: string,
): Promise<SharedHeadLookup> {
  const token = await mintToken(repo);
  const { pulls, truncated } = await listOpenPulls(token, repo);
  if (truncated) return { error: "open PR list truncated" };
  return {
    open: pulls.filter((p) => p.state === "open" && p.headSha === headSha).map((p) => ({ number: p.number, baseRef: p.baseRef })),
  };
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
