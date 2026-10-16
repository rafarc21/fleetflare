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

// #1032 (refs #715): a skipped run's workflow output carries `skipped`, not
// `state` — the route must surface success, not "instance errored", because
// GitHub already got the skip's success status. The get mocks cast through
// FakeEnv's own property type: its Env half demands a full WorkflowInstance,
// while the fake implements only status().
describe("GET /studio/gate/status with a skipped run", () => {
  it("skipped output -> success with the skip reason in the description", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async () => ({
      status: vi.fn(async () => ({
        status: "complete",
        output: { skipped: "no gated paths changed", statusPostFailed: false },
      })),
    })) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=run-1`);
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "success", description: "skipped: no gated paths changed", statusPostFailed: false,
    });
  });

  it("a paths skip with a failed status post stays success and carries statusPostFailed", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async () => ({
      status: vi.fn(async () => ({
        status: "complete",
        output: { skipped: "no gated paths changed", statusPostFailed: true },
      })),
    })) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=run-1`);
    const res = await handleGateRoute(req, env);
    expect(await res.json()).toEqual({
      state: "success", description: "skipped: no gated paths changed", statusPostFailed: true,
    });
  });

  it("a no-gate-block skip posted nothing to GitHub: error, never a false green", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async () => ({
      status: vi.fn(async () => ({
        status: "complete",
        output: { skipped: "no gate block in fleet.json", statusPostFailed: false },
      })),
    })) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=run-1`);
    const res = await handleGateRoute(req, env);
    expect(await res.json()).toEqual({
      state: "error", description: "skipped: no gate block in fleet.json", statusPostFailed: false,
    });
  });
});

describe("GET /studio/gate/status per-leg output (#1049)", () => {
  it("a complete run's legs pass through in plan order, with ms and summary", async () => {
    const env = fakeEnv();
    const legs = [
      { leg: "merge-tree", state: "success", ms: 900 },
      { leg: "vitest-1", state: "failure", description: "vitest-1 exited 1", ms: 83_000, summary: "Tests  1 failed | 1640 passed (1641)" },
    ];
    const output = { state: "failure", description: "1/2 green; red: vitest-1 (run 01234567)", statusPostFailed: false, legs };
    env.GATE_WORKFLOW.get = vi.fn(async () => ({
      status: vi.fn(async () => ({ status: "complete", output })),
    })) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=run-1`);
    const res = await handleGateRoute(req, env);
    expect(await res.json()).toEqual(output);
  });
});
