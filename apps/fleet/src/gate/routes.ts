// /studio/gate/start, /studio/gate/status (#715 Phase 1). Mounted inside
// src/studio/routes.ts's handleStudio, same Access-gated lane as
// /studio/models — this module carries no auth of its own, same posture
// handleModelsRoute's own header states. /start reads the PR's head sha (one
// token mint) and starts the run keyed by that sha (#1072): a manual run of a
// sha with a live run reattaches to it, and a finished one starts a fresh run
// (#1085). /status reads the Workflow
// binding's OWN native instance-status API, not a second GitHub read.
import type { Env } from "../env";
import { getPullRequestHeadSha } from "../github/api";
import { getDefaultBranch, getBranchProtection, setBranchProtection } from "../github/api";
import { runGateProtect, type ProtectPort } from "./protect";
import { repoTokenMinter } from "../github/auth";
import { startManualGateRun, type GateRunIndex, type GateRunParams } from "./auto-run";
import { d1RunIndex } from "./auto-run-env";
import { isGateRunnerRepo } from "./config";
import { gateDraining } from "./drain";
import { greenLegsOf, type CarryGreen, type OutcomeLeg } from "./fanout";
import { rerunInstanceId, statusFollowingRerun } from "./infra-rerun";

// Narrow view of the GATE_WORKFLOW binding. Task 14 adds the real field to
// Env; until then this cast keeps this module typechecking. Drop it then.
type GateWorkflowBinding = {
  create(opts: { id?: string; params: GateRunParams }): Promise<{ id: string }>;
  get(id: string): Promise<{
    status(): Promise<{ status: string; output?: unknown }>;
    terminate(): Promise<void>;
  }>;
};

const workflow = (env: Env) => (env as unknown as { GATE_WORKFLOW: GateWorkflowBinding }).GATE_WORKFLOW;

const j = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** The PR's live head sha: the manual start keys its run on it (#1072). */
export const liveHeadSha = (env: Env) => async (repo: string, pr: number): Promise<string> =>
  getPullRequestHeadSha(await repoTokenMinter(env)(repo), repo, pr);

/** #1247: the real GitHub calls behind `gate protect`. One credential per repo
 *  owner, minted lazily, same as liveHeadSha. */
export function realProtectPort(env: Env): ProtectPort {
  const mint = repoTokenMinter(env);
  return {
    getDefaultBranch: async (repo) => getDefaultBranch(await mint(repo), repo),
    getProtection: async (repo, branch) => getBranchProtection(await mint(repo), repo, branch),
    setProtection: async (repo, branch, contexts) => setBranchProtection(await mint(repo), repo, branch, contexts),
  };
}

/** The status one run id reports. A throw (an unknown id included) is the
 *  caller's to map to a JSON error. */
async function gateRunStatus(env: Env, runId: string): Promise<Response> {
  const instance = await workflow(env).get(runId); // Workflows get() is async
  let first = await instance.status();
  // The watchdog ends a first run once its rerun has taken over (#1148): the run then reports that rerun (#1150 review).
  if (first.status === "terminated") {
    const rerun = await workflow(env).get(rerunInstanceId(runId)).catch(() => undefined);
    if (rerun !== undefined) first = await rerun.status();
  }
  // A run that handed off to its infra rerun (#1119) reports the rerun's status.
  const status = await statusFollowingRerun(first, async (rerunId) =>
    (await workflow(env).get(rerunId)).status());
  // Task 14's verdict rides in the Workflow's own output once terminal;
  // anything not yet terminal maps to pending.
  const out = status.output as
    | {
        state?: string; description?: string; statusPostFailed?: boolean; skipped?: string; legs?: unknown[];
        baseSha?: string; planFingerprint?: string; headSha?: string;
      }
    | undefined;
  // "terminated" is terminal too: mapping it to pending would poll forever.
  if (status.status === "errored" || status.status === "terminated") {
    return j({ state: "error", description: "gate workflow instance ended without a verdict" });
  }
  if (status.status !== "complete") {
    return j({ state: "pending" });
  }
  if (out?.skipped !== undefined) {
    // The only skip that still carries `skipped` is the #1125 "head moved"
    // skip, which posted nothing to GitHub: error, never a false green. The
    // "no gated paths changed" skip returns its guarded state/description
    // directly (the `out.state` branch below) since #1214 round 2.
    return j({ state: "error", description: `skipped: ${out.skipped}`, statusPostFailed: out.statusPostFailed });
  }
  if (!out?.state) {
    return j({ state: "error", description: "gate workflow instance errored" });
  }
  // legs (#1049), baseSha, planFingerprint and headSha (#1230) are dropped
  // from the JSON when the run carries none (the early-return paths never
  // set them).
  return j({
    state: out.state, description: out.description, statusPostFailed: out.statusPostFailed, legs: out.legs,
    baseSha: out.baseSha, planFingerprint: out.planFingerprint, headSha: out.headSha,
  });
}

/** gateRunStatus, with an unknown/expired instance mapped to the same clean
 *  JSON error the GET /studio/gate/status handler returns (#1144) — a bare
 *  throw must never reach a caller, whichever route reads a run's status. */
async function gateRunStatusSafe(env: Env, runId: string): Promise<Response> {
  try {
    return await gateRunStatus(env, runId);
  } catch (err) {
    // An id the Workflow does not know is a JSON 404 (#1144). Any other throw
    // is a JSON 500: a bare throw reached Cloudflare's HTML error page.
    if (/not[ _.-]?found/i.test(err instanceof Error ? err.message : String(err))) {
      return j({ error: "no such gate run", runId }, 404);
    }
    console.error("gate status failed", err);
    return j({ error: "gate status unavailable" }, 500);
  }
}

/** #1230: the carry for a `--failed-only` rerun, built from the PR's latest
 *  run — or the clean error Response to return in its place: 404 when there
 *  is no prior run (or its instance is gone behind a stale D1 pointer,
 *  reusing gateRunStatusSafe's own mapping), 409 when the prior run carries
 *  no leg results to carry from.
 *
 *  Maestro review (#1230): `latest.headSha` (from the D1 run index) is only
 *  the DISPATCH-TIME sha `recordRun` stored when the run was created — it is
 *  NOT necessarily what the run actually resolved and tested. A run that is
 *  slow to start can have its `resolve-pr` step do its live head read AFTER
 *  the PR moved again; if that later push dedupes back onto the same run id
 *  (gateRunId is deterministic on repo+sha), the run's own `headSha` in its
 *  output can differ from the index's stale label even though the index was
 *  never told the run tested something else. Trusting `latest.headSha` here
 *  would let legs that validated the WRONG commit ride forward as "green"
 *  for a later run of the right one. So the run's own `headSha` (from step 2
 *  below, `resolved.headSha` in workflow.ts) must agree with the index's
 *  before a carry is built at all; a mismatch is treated exactly like "no leg
 *  results to carry from", never a special case. */
async function carryGreenFromLatestRun(
  env: Env, repo: string, pr: number, index: GateRunIndex,
): Promise<CarryGreen | Response> {
  const latest = await index.latest(repo, pr);
  if (latest === null) return j({ error: "no prior gate run for this PR to rerun failed legs from" }, 404);
  const statusRes = await gateRunStatusSafe(env, latest.runId);
  if (statusRes.status !== 200) return statusRes;
  const statusBody = await statusRes.json() as {
    legs?: OutcomeLeg[]; baseSha?: string; planFingerprint?: string; headSha?: string;
  };
  if (
    statusBody.legs === undefined || statusBody.baseSha === undefined || statusBody.planFingerprint === undefined
    || statusBody.headSha === undefined || statusBody.headSha !== latest.headSha
  ) {
    return j({ error: "latest gate run has no leg results to carry" }, 409);
  }
  return {
    // The run's OWN resolved head sha is the ground truth; `latest.headSha`
    // above was only the check. They are confirmed equal at this point, but
    // the run's own value is the one that actually matches what its legs
    // tested.
    headSha: statusBody.headSha, baseSha: statusBody.baseSha, planFingerprint: statusBody.planFingerprint,
    // ms/summary ride along too (#1230 review): OutcomeLeg already carries
    // both, and the auto-infra-rerun carry (workflow.ts) passes full leg
    // results through, so this carry must not be the one path that drops them.
    legs: greenLegsOf(statusBody.legs).map((l) => (
      { leg: l.leg, state: "success" as const, description: l.description, ms: l.ms, summary: l.summary }
    )),
  };
}

export async function handleGateRoute(
  req: Request, env: Env, headShaOf: (repo: string, pr: number) => Promise<string> = liveHeadSha(env),
  protect: ProtectPort = realProtectPort(env),
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/studio/gate/protect" && req.method === "POST") {
    const body = (await req.json()) as { repo?: unknown };
    if (typeof body.repo !== "string" || !body.repo.includes("/")) {
      return j({ error: "repo required as owner/name" }, 400);
    }
    try {
      const result = await runGateProtect(protect, body.repo);
      return j(result);
    } catch (err) {
      console.error("gate protect failed", err);
      return j({ error: "gate protect failed" }, 500);
    }
  }

  if (url.pathname === "/studio/gate/start" && req.method === "POST") {
    const body = (await req.json()) as { repo: string; pr: number; failedOnly?: boolean };
    if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, body.repo)) {
      return j({ error: "gate runner not enabled for this repo" }, 404);
    }
    // #1232: a Worker deploy is draining — the manual start queues as pending
    // instead of creating a run the deploy would kill. The id-less manual form
    // carries no headSha to queue, so it is told to wait rather than queued.
    if (await gateDraining(env.DB)) {
      return j({ started: false, pending: true });
    }
    const headSha = await headShaOf(body.repo, body.pr);
    const index = d1RunIndex(env.DB);
    // #1230: `fleet gate run --failed-only` reruns only the legs the PR's
    // latest run did not already go green on. The new run still targets the
    // LIVE head sha above; a head that moved since `latest` is caught by
    // carriedGreenByLeg's own headSha check (a full replan), never a special
    // case here.
    if (body.failedOnly === true) {
      const carryGreen = await carryGreenFromLatestRun(env, body.repo, body.pr, index);
      if (carryGreen instanceof Response) return carryGreen;
      const run = await startManualGateRun(workflow(env), { repo: body.repo, pr: body.pr, headSha, carryGreen }, index);
      return j({ started: true, runId: run.runId, reused: run.reused });
    }
    const run = await startManualGateRun(workflow(env), { repo: body.repo, pr: body.pr, headSha }, index);
    return j({ started: true, runId: run.runId, reused: run.reused });
  }

  if (url.pathname === "/studio/gate/status" && req.method === "GET") {
    const repo = url.searchParams.get("repo") ?? "";
    if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, repo)) {
      return j({ error: "gate runner not enabled for this repo" }, 404);
    }
    const runId = url.searchParams.get("runId");
    if (!runId) return j({ error: "runId required" }, 400);
    return await gateRunStatusSafe(env, runId);
  }

  return j({ error: "not found" }, 404);
}
