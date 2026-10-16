// Worker gate routes (#715 Phase 1, Task 12): /studio/gate/start and
// /studio/gate/status. Inner handler called directly, same convention as
// llm.models-route.test.ts — auth lives at the handleStudio mount point.
import { describe, it, expect, vi, type Mock } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { handleGateRoute } from "../src/gate/routes";
import { gateRunId } from "../src/gate/auto-run";
import type { Env } from "../src/env";

const REPO = "acme/example";
const HEAD = "c".repeat(40);
const headSha = async () => HEAD;

// GATE_WORKFLOW joins Env in Task 14; the fake carries it until then.
type FakeEnv = Env & { GATE_WORKFLOW: { create: Mock; get: Mock } };

function fakeEnv(overrides: Partial<Env> = {}): FakeEnv {
  return {
    FLEET_GATE_RUNNER: "on",
    GATE_RUNNER_REPOS: REPO,
    DB: testEnv.DB,
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

  it("POST /studio/gate/start -> creates a workflow instance for a gated-in repo, under the head sha's id", async () => {
    const env = fakeEnv();
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 1 }),
    });
    const res = await handleGateRoute(req, env, headSha);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true, runId: await gateRunId(REPO, HEAD), reused: false });
    expect(env.GATE_WORKFLOW.create).toHaveBeenCalledOnce();
    expect(env.GATE_WORKFLOW.create).toHaveBeenCalledWith({ id: await gateRunId(REPO, HEAD), params: { repo: REPO, pr: 1 } });
  });

  // #1072: a manual `fleet gate run` of a sha the auto-run already started
  // reuses that run. The fake keeps Workflows' duplicate-id rule.
  it("POST /studio/gate/start twice for one head sha -> one run; the second reuses it", async () => {
    const env = fakeEnv();
    const ids = new Set<string>();
    env.GATE_WORKFLOW.create = vi.fn(async (opts: { id: string }) => {
      if (ids.has(opts.id)) throw new Error("instance already exists");
      ids.add(opts.id);
      return { id: opts.id };
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["create"];
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => {
      if (!ids.has(id)) throw new Error("instance not found");
      return { status: vi.fn(async () => ({ status: "running" })) };
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const start = () => handleGateRoute(new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 1 }),
    }), env, headSha);
    const first = (await (await start()).json()) as { runId: string };
    const second = await (await start()).json();
    expect(first).toEqual({ started: true, runId: await gateRunId(REPO, HEAD), reused: false });
    expect(second).toEqual({ started: true, runId: first.runId, reused: true });
    expect(ids.size).toBe(1);
  });

  it("POST /studio/gate/start for a new head sha starts a new run", async () => {
    const env = fakeEnv();
    const ids = new Set<string>();
    env.GATE_WORKFLOW.create = vi.fn(async (opts: { id: string }) => {
      if (ids.has(opts.id)) throw new Error("instance already exists");
      ids.add(opts.id);
      return { id: opts.id };
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["create"];
    const start = (sha: string) => handleGateRoute(new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 1 }),
    }), env, async () => sha);
    await start(HEAD);
    const later = (await (await start("d".repeat(40))).json()) as { reused: boolean };
    expect(later.reused).toBe(false);
    expect(ids.size).toBe(2);
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
