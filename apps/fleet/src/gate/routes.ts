// /studio/gate/start, /studio/gate/status (#715 Phase 1). Mounted inside
// src/studio/routes.ts's handleStudio, same Access-gated lane as
// /studio/models — this module carries no auth of its own, same posture
// handleModelsRoute's own header states. Never touches a GitHub token:
// /start creates a GATE_WORKFLOW instance (the Workflow itself, Task 14,
// is the one place that mints one); /status reads the Workflow binding's
// OWN native instance-status API, not a second GitHub read.
import type { Env } from "../env";
import { isGateRunnerRepo } from "./config";

// Narrow view of the GATE_WORKFLOW binding. Task 14 adds the real field to
// Env; until then this cast keeps this module typechecking. Drop it then.
type GateWorkflowBinding = {
  create(opts: { params: { repo: string; pr: number } }): Promise<{ id: string }>;
  get(id: string): Promise<{ status(): Promise<{ status: string; output?: unknown }> }>;
};

const workflow = (env: Env) => (env as unknown as { GATE_WORKFLOW: GateWorkflowBinding }).GATE_WORKFLOW;

const j = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export async function handleGateRoute(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/studio/gate/start" && req.method === "POST") {
    const body = (await req.json()) as { repo: string; pr: number };
    if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, body.repo)) {
      return j({ error: "gate runner not enabled for this repo" }, 404);
    }
    const instance = await workflow(env).create({ params: { repo: body.repo, pr: body.pr } });
    return j({ started: true, runId: instance.id });
  }

  if (url.pathname === "/studio/gate/status" && req.method === "GET") {
    const repo = url.searchParams.get("repo") ?? "";
    if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, repo)) {
      return j({ error: "gate runner not enabled for this repo" }, 404);
    }
    const runId = url.searchParams.get("runId");
    if (!runId) return j({ error: "runId required" }, 400);
    const instance = await workflow(env).get(runId); // Workflows get() is async
    const status = await instance.status();
    // Task 14's verdict rides in the Workflow's own output once terminal;
    // anything not yet terminal maps to pending.
    const out = status.output as
      | { state?: string; description?: string; statusPostFailed?: boolean; skipped?: string }
      | undefined;
    // "terminated" is terminal too: mapping it to pending would poll forever.
    if (status.status === "errored" || status.status === "terminated") {
      return j({ state: "error", description: "gate workflow instance ended without a verdict" });
    }
    if (status.status !== "complete") {
      return j({ state: "pending" });
    }
    if (out?.skipped !== undefined) {
      // Only the "no gated paths changed" skip posted success to GitHub
      // (workflow.ts post-skip-status). Any other skip (no gate block) posted
      // nothing: the repo is not configured, so it is an error, never green.
      const state = out.skipped.startsWith("no gated paths changed") ? "success" : "error";
      return j({ state, description: `skipped: ${out.skipped}`, statusPostFailed: out.statusPostFailed });
    }
    if (!out?.state) {
      return j({ state: "error", description: "gate workflow instance errored" });
    }
    return j({ state: out.state, description: out.description, statusPostFailed: out.statusPostFailed });
  }

  return j({ error: "not found" }, 404);
}
