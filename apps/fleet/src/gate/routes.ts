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
import { repoTokenMinter } from "../github/auth";
import { startManualGateRun, type GateRunParams } from "./auto-run";
import { d1RunIndex } from "./auto-run-env";
import { isGateRunnerRepo } from "./config";
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
    | { state?: string; description?: string; statusPostFailed?: boolean; skipped?: string; legs?: unknown[] }
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
  // legs (#1049) is dropped from the JSON when the run carries none.
  return j({ state: out.state, description: out.description, statusPostFailed: out.statusPostFailed, legs: out.legs });
}

export async function handleGateRoute(
  req: Request, env: Env, headShaOf: (repo: string, pr: number) => Promise<string> = liveHeadSha(env),
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/studio/gate/start" && req.method === "POST") {
    const body = (await req.json()) as { repo: string; pr: number };
    if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, body.repo)) {
      return j({ error: "gate runner not enabled for this repo" }, 404);
    }
    const headSha = await headShaOf(body.repo, body.pr);
    const run = await startManualGateRun(workflow(env), { repo: body.repo, pr: body.pr, headSha }, d1RunIndex(env.DB));
    return j({ started: true, runId: run.runId, reused: run.reused });
  }

  if (url.pathname === "/studio/gate/status" && req.method === "GET") {
    const repo = url.searchParams.get("repo") ?? "";
    if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, repo)) {
      return j({ error: "gate runner not enabled for this repo" }, 404);
    }
    const runId = url.searchParams.get("runId");
    if (!runId) return j({ error: "runId required" }, 400);
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

  return j({ error: "not found" }, 404);
}
