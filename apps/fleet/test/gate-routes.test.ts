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
    // get() must miss for an id this test never created: the route reads the
    // PR's latest run (kept in D1 across tests) before it creates.
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => {
      if (!ids.has(id)) throw new Error("instance not found");
      return { status: vi.fn(async () => ({ status: "running" })) };
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
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

  it("a run the watchdog ended while its rerun runs reports the rerun's status, not an error (#1150 review)", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => {
      if (id === "gate-run-1") return { status: vi.fn(async () => ({ status: "terminated" })) };
      if (id === "rerun-gate-run-1") return { status: vi.fn(async () => ({ status: "running" })) };
      throw new Error(`no instance ${id}`);
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const res = await handleGateRoute(new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=gate-run-1`), env);
    expect(await res.json()).toEqual({ state: "pending" });
  });

  it("a terminated run with no rerun still reports the error: nothing else will post its verdict", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => {
      if (id === "gate-run-1") return { status: vi.fn(async () => ({ status: "terminated" })) };
      throw new Error(`no instance ${id}`);
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const res = await handleGateRoute(new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=gate-run-1`), env);
    expect(await res.json()).toEqual({ state: "error", description: "gate workflow instance ended without a verdict" });
  });
});

// #1085 (refs #715): a manual start reuses only a LIVE run of the sha. Once the
// sha's run has finished, the same POST starts a fresh run under a new id.
describe("POST /studio/gate/start after the sha's run finished (#1085)", () => {
  it("the finished run is not reused: the start returns a new run id, reused false", async () => {
    const env = fakeEnv();
    const ids = new Map<string, string>();
    env.GATE_WORKFLOW.create = vi.fn(async (opts: { id: string }) => {
      if (ids.has(opts.id)) throw new Error("instance already exists");
      ids.set(opts.id, "running");
      return { id: opts.id };
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["create"];
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => {
      if (!ids.has(id)) throw new Error("instance not found");
      return {
        status: vi.fn(async () => ({ status: ids.get(id)! })),
        terminate: vi.fn(async () => {}),
      };
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const start = () => handleGateRoute(new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 2 }),
    }), env, async () => "e".repeat(40));
    const first = (await (await start()).json()) as { runId: string };
    ids.set(first.runId, "complete");
    const rerun = await (await start()).json() as { runId: string; reused: boolean };
    expect(rerun.reused).toBe(false);
    expect(rerun.runId).not.toBe(first.runId);
    expect(rerun.runId.startsWith(`${first.runId}-r`)).toBe(true);
    expect(ids.size).toBe(2);
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

  it("a #1125 head-moved skip posted nothing to post, but its head's own push gates it: success, never a false red", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async () => ({
      status: vi.fn(async () => ({
        status: "complete",
        output: { skipped: "head moved since the infra error", statusPostFailed: false },
      })),
    })) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=run-1`);
    const res = await handleGateRoute(req, env);
    expect(await res.json()).toEqual({
      state: "success", description: "skipped: head moved since the infra error", statusPostFailed: false,
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

// #1144: an unknown run id is a JSON 404, and any other throw a JSON 500. A
// raw throw reached Cloudflare's HTML error page (1101) before this.
describe("GET /studio/gate/status with a run id the Workflow does not know (#1144)", () => {
  it("an unknown run id -> JSON 404 naming the run, never an HTML error page", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async () => { throw new Error("instance.not_found"); });
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=rerun-ga`);
    const res = await handleGateRoute(req, env, headSha);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "no such gate run", runId: "rerun-ga" });
  });

  it("any other throw -> JSON 500, never an uncaught error", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async () => { throw new Error("workflow binding unavailable"); });
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=run-1`);
    const res = await handleGateRoute(req, env, headSha);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "gate status unavailable" });
  });
});

// #1148 review: a first run the watchdog ended reports its infra rerun's status, not "ended without a verdict".
describe("GET /studio/gate/status after the watchdog ended the run for its infra rerun (#1148 review, minor)", () => {
  it("a terminated first run whose rerun is live reports pending, not an error verdict", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => ({
      status: vi.fn(async () => ({ status: id === "gate-first" ? "terminated" : "running" })),
    })) as never;
    const res = await handleGateRoute(new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=gate-first`), env, headSha);
    expect(await res.json()).toEqual({ state: "pending" });
  });

  it("a terminated run with no rerun is still the error verdict", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => {
      if (id === "gate-first") return { status: vi.fn(async () => ({ status: "terminated" })) };
      throw new Error("instance.not_found");
    }) as never;
    const res = await handleGateRoute(new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=gate-first`), env, headSha);
    expect(await res.json()).toMatchObject({ state: "error" });
  });
});
