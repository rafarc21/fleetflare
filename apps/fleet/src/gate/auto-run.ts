// #1072 (refs #715): the gate's auto-run. A pull_request delivery for a gated
// repo (GATE_RUNNER_REPOS, FLEET_GATE_RUNNER on, not a draft) starts one gate
// run per (pr, head sha), before the PR is final. The manual start route
// (/studio/gate/start) keys its run the same way, so a `fleet gate run` of a
// sha with a LIVE run reattaches to it. A finished run is not reused by the
// manual start (#1085): it starts a fresh run instead (startManualGateRun).
//
// Run identity is the Workflows instance id: the base id is a hash of the repo
// plus the head sha, and a second PR sharing the sha starts a `-p<pr>` fresh
// run (#1172). Creating an instance under an id that already exists is the dedupe.
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
  /** #1176: an edit of the title/body/base re-runs the precheck under its own
   *  run id (the head sha is unchanged, so the plain sha id would dedupe-skip). */
  edited?: boolean;
  /** #1214 round 2: a reopen must re-gate the head, never reuse a finished run. */
  reopened?: boolean;
}

const AUTO_RUN_ACTIONS: ReadonlySet<string> = new Set(["opened", "synchronize", "ready_for_review", "edited", "reopened"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** The gate-runner switches a pull_request decision reads. */
export interface GateRunnerSwitches { FLEET_GATE_RUNNER?: string; GATE_RUNNER_REPOS?: string }

/** The gated PR a pull_request delivery should auto-run, or null when it should
 *  start nothing: an action other than opened / synchronize / ready_for_review / edited / reopened,
 *  a draft, a repo outside GATE_RUNNER_REPOS, the gate runner off, or a body
 *  that is not a PR delivery with both shas. Pure: no GitHub call. */
export function pullRequestAutoRun(body: string, env: GateRunnerSwitches): PullRequestAutoRun | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const e = parsed as {
    action?: unknown;
    changes?: { title?: unknown; body?: unknown; base?: unknown };
    repository?: { full_name?: unknown };
    pull_request?: { number?: unknown; draft?: unknown; head?: { sha?: unknown }; base?: { sha?: unknown } };
  };
  if (typeof e.action !== "string" || !AUTO_RUN_ACTIONS.has(e.action)) return null;
  // #1176: an edit fires only for a title, body or BASE change — GitHub sends a
  // `changes` object naming what moved. Any other edit (labels, ...) is the
  // dedupe case for the unchanged head sha. A base move (#1214 round 2) re-runs:
  // the gated base differs, so the prior verdict no longer applies.
  if (e.action === "edited" && e.changes?.title === undefined && e.changes?.body === undefined && e.changes?.base === undefined) return null;
  const pr = e.pull_request;
  const repo = e.repository?.full_name;
  if (pr === undefined || typeof repo !== "string" || typeof pr.number !== "number") return null;
  if (pr.draft === true) return null;
  const headSha = pr.head?.sha;
  const baseSha = pr.base?.sha;
  if (typeof headSha !== "string" || !SHA_PATTERN.test(headSha) || typeof baseSha !== "string") return null;
  if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, repo)) return null;
  return {
    repo, pr: pr.number, headSha, baseSha,
    ...(e.action === "edited" ? { edited: true } : {}),
    ...(e.action === "reopened" ? { reopened: true } : {}),
  };
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
 *  stamp on its next leg (#1148 item 3). A stamp of -1 is the retire marker:
 *  the sweep retired the row, so if the pointer still names it the run is ended,
 *  never reattached. */
export function isStalled(run: GateRunRecord, now: number): boolean {
  return run.progressedAt === -1
    || (run.progressedAt !== undefined && run.progressedAt > 0 && now - run.progressedAt >= GATE_STALL_MS);
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
 *  previous sha's run if that one is still live (#1082). A reuse changes nothing.
 *
 *  #1214 round 2: (a) `postPending` fires BEFORE the fresh -p<pr> create, so
 *  GitHub never sees the head without a pending gate/verdict; (b) a -p<pr> id
 *  already existing is reused only while it is LIVE; a finished one starts a
 *  fresh `-p<pr>-r<base36 now>` (injected `now`, like startManualGateRun). */
export async function startGateRun(
  wf: GateRunStarter, input: { repo: string; pr: number; headSha: string; reopened?: boolean }, index: GateRunIndex,
  now: () => number = Date.now,
  postPending?: (repo: string, headSha: string) => Promise<void>,
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
    // #1172: the id is (repo, head sha). A run under this id whose per-PR
    // pointer does not name this head belongs to another PR that shared the
    // sha: reuse would inherit that PR's verdict. Start a fresh run keyed
    // (repo, pr, sha), so each PR runs and posts its own decision and a
    // concurrent first-start of the same PR collides on the SAME id (Workflows
    // create-idempotency) instead of starting a second live run.
    const latest = await index.latest(input.repo, input.pr);
    // The base-id run this PR owns is reused even finished (dedupe-by-sha,
    // unchanged) — UNLESS this is a reopen, which must re-gate the head against
    // the current base, never hand back a stale verdict. A -p fresh run of a
    // shared head is likewise NOT reused finished: it falls through to the
    // fresh create below, whose collision path reuses only a LIVE one and
    // starts -p<pr>-r<time> for a finished one (#1214 round 2).
    if (latest?.headSha === input.headSha && latest.runId === runId && input.reopened !== true) {
      return { runId: latest.runId, reused: true };
    }
    // #1214 round 2: put a pending gate/verdict up BEFORE the fresh create.
    if (postPending) await postPending(input.repo, input.headSha);
    const freshId = `${runId}-p${input.pr}`;
    try {
      await wf.create({ id: freshId, params: { repo: input.repo, pr: input.pr } });
    } catch (freshErr) {
      const status = await statusOf(wf, freshId);
      if (status === null) throw freshErr;
      // Reuse only a LIVE -p run; a finished one is stale and starts a fresh
      // -p<pr>-r<time> run so the push is gated anew, never handed a dead verdict.
      // A reopen is never reused even live: it re-gates against the current base.
      if (isLiveStatus(status) && input.reopened !== true) return { runId: freshId, reused: true };
      const rerunId = `${freshId}-r${now().toString(36)}`;
      await wf.create({ id: rerunId, params: { repo: input.repo, pr: input.pr } });
      return recordRun(wf, input, index, rerunId, now);
    }
    return recordRun(wf, input, index, freshId, now);
  }
  return recordRun(wf, input, index, runId, now);
}

/** #1176/#1214: a title/body/base edit re-runs the precheck under its own id.
 *  The head sha
 *  is unchanged, so the plain sha id would dedupe-skip or reattach — an edit's
 *  recheck must be a fresh run. It records itself as the PR's latest WITHOUT
 *  ending the plain sha run through recordRun. Mirrors startManualGateRun's
 *  fresh-start shape.
 *
 *  #1191: (a) the plain-sha run of the same head is a stale gate of the pre-edit
 *  title/body — end it first if it is still live, so the edit's recheck is the
 *  only live run of the head. (b) an optional pending-status callback posts
 *  `running` BEFORE the edited run is created, so GitHub never sees the head
 *  without a pending gate/verdict. Absent = no-op: auto-run.ts stays free of
 *  cloudflare:workers / auth imports so the bun-test project can load it. */
export async function startEditedGateRun(
  wf: GateRunStarter, input: { repo: string; pr: number; headSha: string }, index: GateRunIndex,
  now: () => number = Date.now,
  postPending?: (repo: string, headSha: string) => Promise<void>,
): Promise<{ runId: string; reused: boolean }> {
  const baseId = await gateRunId(input.repo, input.headSha);
  await endIfLive(wf, baseId);
  // #1203: an earlier -e (or -r) run of the same head sha that the index still
  // records as this PR's latest is also a stale gate of the pre-edit
  // title/body — end it too. endIfLive no-ops on a non-live or missing run.
  const latest = await index.latest(input.repo, input.pr);
  if (latest !== null && latest.headSha === input.headSha) await endIfLive(wf, latest.runId);
  if (postPending) await postPending(input.repo, input.headSha);
  const runId = `${baseId}-e${now().toString(36)}`;
  await wf.create({ id: runId, params: { repo: input.repo, pr: input.pr } });
  await index.record(input.repo, input.pr, { headSha: input.headSha, runId, progressedAt: now() });
  return { runId, reused: false };
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
  /** #1191: the pending-status post for an edited run, injected by the env wiring. */
  postPending?: (repo: string, headSha: string) => Promise<void>;
}

/** Starts the gate run for a gated PR. No precheck of the base's gate config
 *  (#1132): the Workflow decides, the one place that reads both the base block
 *  and the #1091 head path. A base with no block gets a visible failure on the
 *  head from that run, never silence. */
export async function autoRunPullRequest(pr: PullRequestAutoRun, deps: AutoRunDeps): Promise<AutoRunOutcome> {
  if (pr.edited === true) {
    await startEditedGateRun(
      deps.workflow, { repo: pr.repo, pr: pr.pr, headSha: pr.headSha }, deps.index,
      Date.now, deps.postPending,
    );
    return "started";
  }
  const { reused } = await startGateRun(
    deps.workflow,
    { repo: pr.repo, pr: pr.pr, headSha: pr.headSha, ...(pr.reopened === true ? { reopened: true } : {}) },
    deps.index, Date.now, deps.postPending,
  );
  return reused ? "reused" : "started";
}
