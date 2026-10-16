// #1072 (refs #715): the gate's auto-run. A pull_request delivery for a gated
// repo (GATE_RUNNER_REPOS, FLEET_GATE_RUNNER on, not a draft) starts one gate
// run per head sha, before the PR is final. The manual start route
// (/studio/gate/start) keys its run the same way, so a `fleet gate run` of a
// sha that already has a run reuses that run instead of starting a second.
//
// Run identity is the Workflows instance id: a hash of the repo plus the head
// sha. Creating an instance under an id that already exists is the dedupe.
import { isGateRunnerRepo } from "./config";
import { loadGateConfig, type FleetJsonReader } from "./load-config";

/** The params a gate run is created with: the GateWorkflow's own payload shape
 *  (workflow.ts GateWorkflowParams), restated here so this module never imports
 *  workflow.ts, which pulls cloudflare:workers into the bun-test project. */
export interface GateRunParams { repo: string; pr: number }

/** One Workflows instance handle: its status, and terminate() to end it. */
export interface GateRunInstance {
  status(): Promise<{ status: string }>;
  terminate(): Promise<void>;
}

/** The slice of the GATE_WORKFLOW binding this module uses. */
export interface GateRunStarter {
  create(opts: { id?: string; params: GateRunParams }): Promise<{ id: string }>;
  get(id: string): Promise<GateRunInstance>;
}

/** The latest gate run recorded for one PR: the head sha it gates and its
 *  Workflows instance id. */
export interface GateRunRecord { headSha: string; runId: string }

/** The per-PR pointer to the latest gate run. Workflows cannot list instances,
 *  so this is how a new head sha finds the run it supersedes (#1082). */
export interface GateRunIndex {
  latest(repo: string, pr: number): Promise<GateRunRecord | null>;
  record(repo: string, pr: number, run: GateRunRecord): Promise<void>;
}

export interface PullRequestAutoRun {
  repo: string;
  pr: number;
  headSha: string;
  baseSha: string;
}

const AUTO_RUN_ACTIONS: ReadonlySet<string> = new Set(["opened", "synchronize", "ready_for_review"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** The gate-runner switches a pull_request decision reads. */
export interface GateRunnerSwitches { FLEET_GATE_RUNNER?: string; GATE_RUNNER_REPOS?: string }

/** The gated PR a pull_request delivery should auto-run, or null when it should
 *  start nothing: an action other than opened / synchronize / ready_for_review,
 *  a draft, a repo outside GATE_RUNNER_REPOS, the gate runner off, or a body
 *  that is not a PR delivery with both shas. Pure: no GitHub call. */
export function pullRequestAutoRun(body: string, env: GateRunnerSwitches): PullRequestAutoRun | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const e = parsed as {
    action?: unknown;
    repository?: { full_name?: unknown };
    pull_request?: { number?: unknown; draft?: unknown; head?: { sha?: unknown }; base?: { sha?: unknown } };
  };
  if (typeof e.action !== "string" || !AUTO_RUN_ACTIONS.has(e.action)) return null;
  const pr = e.pull_request;
  const repo = e.repository?.full_name;
  if (pr === undefined || typeof repo !== "string" || typeof pr.number !== "number") return null;
  if (pr.draft === true) return null;
  const headSha = pr.head?.sha;
  const baseSha = pr.base?.sha;
  if (typeof headSha !== "string" || !SHA_PATTERN.test(headSha) || typeof baseSha !== "string") return null;
  if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, repo)) return null;
  return { repo, pr: pr.number, headSha, baseSha };
}

/** The Workflows instance id for one repo and head sha: deterministic, so a
 *  second start for the same sha names the same instance. The repo is hashed
 *  because owner/repo can exceed the id length and contains "/". */
export async function gateRunId(repo: string, headSha: string): Promise<string> {
  if (!SHA_PATTERN.test(headSha)) throw new Error(`gate run needs a 40-hex head sha, got "${headSha}"`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(repo.toLowerCase())));
  const repoKey = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `gate-${repoKey}-${headSha}`;
}

/** Instance statuses that still do work. Anything else (complete, errored,
 *  terminated, unknown) is left alone. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);

/** Ends the run when it is still live. Returns true only when it was ended: a
 *  run already finished, or a terminate that fails, is not a superseded run and
 *  never blocks the start of the new one. */
async function endIfLive(wf: GateRunStarter, runId: string): Promise<boolean> {
  try {
    const instance = await wf.get(runId);
    if (!LIVE_STATUSES.has((await instance.status()).status)) return false;
    await instance.terminate();
    return true;
  } catch {
    return false;
  }
}

/** Starts the gate run for one head sha, or reuses the run already started for
 *  it. Only a create that fails because the id exists reuses; any other create
 *  failure is rethrown. A new run records itself as the PR's latest and ends the
 *  previous sha's run if that one is still live (#1082). A reuse changes nothing. */
export async function startGateRun(
  wf: GateRunStarter, input: { repo: string; pr: number; headSha: string }, index: GateRunIndex,
): Promise<{ runId: string; reused: boolean; supersededRunId?: string }> {
  const runId = await gateRunId(input.repo, input.headSha);
  try {
    await wf.create({ id: runId, params: { repo: input.repo, pr: input.pr } });
  } catch (err) {
    try {
      await wf.get(runId);
    } catch {
      throw err;
    }
    return { runId, reused: true };
  }
  const previous = await index.latest(input.repo, input.pr);
  await index.record(input.repo, input.pr, { headSha: input.headSha, runId });
  if (previous === null || previous.runId === runId) return { runId, reused: false };
  const superseded = await endIfLive(wf, previous.runId);
  return { runId, reused: false, supersededRunId: superseded ? previous.runId : undefined };
}

export type AutoRunOutcome = "started" | "reused" | "no-gate-block";

export interface AutoRunDeps {
  fleetRepo: string;
  readFleetJson: FleetJsonReader;
  workflow: GateRunStarter;
  index: GateRunIndex;
}

/** Starts the gate run for a gated PR, but only when its base carries a gate
 *  block (the same lookup the Workflow does, at the PR's base sha). A repo with
 *  no gate block starts nothing. */
export async function autoRunPullRequest(pr: PullRequestAutoRun, deps: AutoRunDeps): Promise<AutoRunOutcome> {
  const config = await loadGateConfig({ repo: pr.repo, fleetRepo: deps.fleetRepo, baseSha: pr.baseSha }, deps.readFleetJson);
  if (config === null) return "no-gate-block";
  const { reused } = await startGateRun(
    deps.workflow, { repo: pr.repo, pr: pr.pr, headSha: pr.headSha }, deps.index,
  );
  return reused ? "reused" : "started";
}
