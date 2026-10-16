// #1072 (refs #715): the gate's auto-run. A pull_request delivery for a gated
// repo (GATE_RUNNER_REPOS, FLEET_GATE_RUNNER on, not a draft) starts one gate
// run per head sha, before the PR is final. The manual start route
// (/studio/gate/start) keys its run the same way, so a `fleet gate run` of a
// sha with a LIVE run reattaches to it. A finished run is not reused by the
// manual start (#1085): it starts a fresh run instead (startManualGateRun).
//
// Run identity is the Workflows instance id: a hash of the repo plus the head
// sha. Creating an instance under an id that already exists is the dedupe.
import { isGateRunnerRepo } from "./config";

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
export interface GateRunRecord {
  headSha: string;
  runId: string;
  /** When the run last progressed (ms): a leg attempt started or an infra handoff (#1135). 0 when never. */
  progressedAt?: number;
}

/** The per-PR pointer to the latest gate run. Workflows cannot list instances,
 *  so this is how a new head sha finds the run it supersedes (#1082). */
export interface GateRunIndex {
  latest(repo: string, pr: number): Promise<GateRunRecord | null>;
  record(repo: string, pr: number, run: GateRunRecord): Promise<void>;
  /** One conditional write: the pointer moves to `run` only while it still names
   *  `fromRunId`. False when a newer run holds it (#1135). */
  handOff(repo: string, pr: number, fromRunId: string, run: GateRunRecord): Promise<boolean>;
  /** Stamps `at` as the progress time of the pointed run. A run no longer
   *  pointed at is left alone (#1135). */
  progress(repo: string, pr: number, runId: string, at: number): Promise<void>;
}

/** A live run with no progress for this long is hung (#1135). Longer than one
 *  leg attempt: the 28 min attempt deadline plus the step's 15 s retry delay. */
export const GATE_STALL_MS = 35 * 60_000;

/** Stamps a leg's progress on the run's index row. Never throws: a failed stamp
 *  must not fail the leg that reports it. */
export async function markRunProgress(
  index: GateRunIndex, repo: string, pr: number, runId: string, at: number,
): Promise<void> {
  try {
    await index.progress(repo, pr, runId, at);
  } catch (err) {
    console.error("gate: progress stamp failed", err);
  }
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

export function isLiveStatus(status: string | null): boolean {
  return status !== null && LIVE_STATUSES.has(status);
}

/** A live run whose progress is at least GATE_STALL_MS old. A progress stamp of
 *  0 is unknown, never stalled: a run from before the stamp existed gets its
 *  stamp on its next leg (#1148 item 3). */
export function isStalled(run: GateRunRecord, now: number): boolean {
  return run.progressedAt !== undefined && run.progressedAt > 0 && now - run.progressedAt >= GATE_STALL_MS;
}

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

/** Ends a run when it is still live, and throws when the end fails. A stalled
 *  run that stays live must never be followed by a second live run of its head
 *  (#1148 item 2). */
export async function endRunOrThrow(wf: Pick<GateRunStarter, "get">, runId: string): Promise<void> {
  const instance = await wf.get(runId);
  if (isLiveStatus((await instance.status()).status)) await instance.terminate();
}

/** The status of one instance, or null when no such instance exists. */
export async function statusOf(wf: Pick<GateRunStarter, "get">, runId: string): Promise<string | null> {
  try {
    return (await (await wf.get(runId)).status()).status;
  } catch {
    return null;
  }
}

/** Records a newly created run as the PR's latest, and ends the previous sha's
 *  run if that one is still live (#1082). */
async function recordRun(
  wf: GateRunStarter, input: { repo: string; pr: number; headSha: string }, index: GateRunIndex, runId: string,
  now: () => number,
): Promise<{ runId: string; reused: boolean; supersededRunId?: string }> {
  const previous = await index.latest(input.repo, input.pr);
  await index.record(input.repo, input.pr, { headSha: input.headSha, runId, progressedAt: now() });
  if (previous === null || previous.runId === runId) return { runId, reused: false };
  const superseded = await endIfLive(wf, previous.runId);
  return { runId, reused: false, supersededRunId: superseded ? previous.runId : undefined };
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
  return recordRun(wf, input, index, runId, Date.now);
}

/** #1085 (refs #715): the manual start (`fleet gate run`, /studio/gate/start).
 *  Reattaches ONLY to a live run of the sha (LIVE_STATUSES) that progressed
 *  within GATE_STALL_MS (#1135). A finished run of the sha is not reused: a fresh
 *  run starts under `<baseId>-r<base36 time>`, so a rerun after base drift or an
 *  infra flake needs no new push. A live run with no progress in the window is
 *  hung: it is ended first, and the fresh run is the only live one. The first
 *  start of a sha still uses the sha's own id, the one the auto-run dedupes on. */
export async function startManualGateRun(
  wf: GateRunStarter, input: { repo: string; pr: number; headSha: string }, index: GateRunIndex,
  now: () => number = Date.now,
): Promise<{ runId: string; reused: boolean; supersededRunId?: string }> {
  const baseId = await gateRunId(input.repo, input.headSha);
  const latest = await index.latest(input.repo, input.pr);
  const params = { repo: input.repo, pr: input.pr };
  const startFresh = async () => {
    const runId = `${baseId}-r${now().toString(36)}`;
    await wf.create({ id: runId, params });
    return recordRun(wf, input, index, runId, now);
  };
  if (latest?.headSha === input.headSha && isLiveStatus(await statusOf(wf, latest.runId))) {
    if (!isStalled(latest, now())) return { runId: latest.runId, reused: true };
    await endRunOrThrow(wf, latest.runId);
    // The stalled run's own infra rerun may have taken the pointer while it was
    // ending. The head is gated by that rerun: reattach, never a second live run (#1148 race).
    const moved = await index.latest(input.repo, input.pr);
    if (
      moved?.headSha === input.headSha && moved.runId !== latest.runId
      && isLiveStatus(await statusOf(wf, moved.runId)) && !isStalled(moved, now())
    ) {
      return { runId: moved.runId, reused: true };
    }
    return startFresh();
  }
  try {
    await wf.create({ id: baseId, params });
  } catch (err) {
    const status = await statusOf(wf, baseId);
    if (status === null) throw err;
    if (isLiveStatus(status)) {
      // The pointer's own run, read again after a transient status failure (#1150 item 4): healthy, reattach.
      if (latest?.runId === baseId && !isStalled(latest, now())) return { runId: baseId, reused: true };
      // A live run the pointer does not name has no progress stamp anywhere, so it
      // cannot be told from a hung run: it is ended, then a fresh run starts (#1148 item 2).
      await endRunOrThrow(wf, baseId);
    }
    return startFresh();
  }
  return recordRun(wf, input, index, baseId, now);
}

export type AutoRunOutcome = "started" | "reused";

export interface AutoRunDeps {
  workflow: GateRunStarter;
  index: GateRunIndex;
}

/** Starts the gate run for a gated PR. No precheck of the base's gate config
 *  (#1132): the Workflow decides, the one place that reads both the base block
 *  and the #1091 head path. A base with no block gets a visible failure on the
 *  head from that run, never silence. */
export async function autoRunPullRequest(pr: PullRequestAutoRun, deps: AutoRunDeps): Promise<AutoRunOutcome> {
  const { reused } = await startGateRun(
    deps.workflow, { repo: pr.repo, pr: pr.pr, headSha: pr.headSha }, deps.index,
  );
  return reused ? "reused" : "started";
}
