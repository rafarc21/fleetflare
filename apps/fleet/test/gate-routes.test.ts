// Worker gate routes (#715 Phase 1, Task 12): /studio/gate/start and
// /studio/gate/status. Inner handler called directly, same convention as
// llm.models-route.test.ts — auth lives at the handleStudio mount point.
import { describe, it, expect, vi, type Mock } from "vitest";
import { handleGateRoute } from "../src/gate/routes";
import type { Env } from "../src/env";

const REPO = "acme/example";

// GATE_WORKFLOW joins Env in Task 14; the fake carries it until then.
type FakeEnv = Env & { GATE_WORKFLOW: { create: Mock; get: Mock } };

function fakeEnv(overrides: Partial<Env> = {}): FakeEnv {
  return {
    FLEET_GATE_RUNNER: "on",
    GATE_RUNNER_REPOS: REPO,
    GATE_WORKFLOW: {
      create: vi.fn(async () => ({ id: "run-1" })),
      get: vi.fn(async () => ({ status: vi.fn(async () => ({ status: "running" })) })),
    },
    ...overrides,
  } as unknown as FakeEnv;
}

describe("handleGateRoute", () => {
  it("POST /studio/gate/start -> 404 when FLEET_GATE_RUNNER is off", async () => {
    const env = fakeEnv({ FLEET_GATE_RUNNER: "off" });
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 1 }),
    });
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(404);
    expect(env.GATE_WORKFLOW.create).not.toHaveBeenCalled();
  });

  it("POST /studio/gate/start -> 404 when the repo isn't in GATE_RUNNER_REPOS", async () => {
    const env = fakeEnv({ GATE_RUNNER_REPOS: "other/repo" });
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 1 }),
    });
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(404);
    expect(env.GATE_WORKFLOW.create).not.toHaveBeenCalled();
  });

  it("POST /studio/gate/start -> creates a workflow instance for a gated-in repo", async () => {
    const env = fakeEnv();
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 1 }),
    });
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true, runId: "run-1" });
    expect(env.GATE_WORKFLOW.create).toHaveBeenCalledOnce();
  });

  it("GET /studio/gate/status -> 404 when FLEET_GATE_RUNNER is off, before touching the workflow", async () => {
    const env = fakeEnv({ FLEET_GATE_RUNNER: "off" });
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=run-1`);
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(404);
    expect(env.GATE_WORKFLOW.get).not.toHaveBeenCalled();
  });

  it("GET /studio/gate/status -> 404 when the repo isn't gated in", async () => {
    const env = fakeEnv();
    const req = new Request("https://worker/studio/gate/status?repo=other/repo&runId=run-1");
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(404);
    expect(env.GATE_WORKFLOW.get).not.toHaveBeenCalled();
  });

  it("GET /studio/gate/status -> reads the workflow instance's own status, no GitHub call", async () => {
    const env = fakeEnv();
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=run-1`);
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(200);
    expect(env.GATE_WORKFLOW.get).toHaveBeenCalledWith("run-1");
  });
});
