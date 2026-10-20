// Worker gate routes (#715 Phase 1, Task 12): /studio/gate/start and
// /studio/gate/status. Inner handler called directly, same convention as
// llm.models-route.test.ts — auth lives at the handleStudio mount point.
import { describe, it, expect, vi, type Mock } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { handleGateRoute } from "../src/gate/routes";
import type { ProtectPort } from "../src/gate/protect";
import { gateRunId } from "../src/gate/auto-run";
import { setFlag, deleteFlag } from "../src/state";
import { d1RunIndex } from "../src/gate/auto-run-env";
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

// #1232: while a Worker deploy drains running gate runs, the manual start queues
// as pending instead of creating a run the deploy would kill.
describe("POST /studio/gate/start while a deploy drains (#1232)", () => {
  it("with gate_drain set, returns pending and never creates a run", async () => {
    await setFlag(testEnv.DB, "gate_drain", "1", Date.now());
    try {
      const env = fakeEnv();
      const req = new Request("https://worker/studio/gate/start", {
        method: "POST", body: JSON.stringify({ repo: REPO, pr: 1 }),
      });
      const res = await handleGateRoute(req, env, headSha);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ started: false, pending: true });
      expect(env.GATE_WORKFLOW.create).not.toHaveBeenCalled();
    } finally {
      await deleteFlag(testEnv.DB, "gate_drain");
    }
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

  it("a #1125 head-moved skip posted nothing to GitHub: error, never a false green", async () => {
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
      state: "error", description: "skipped: head moved since the infra error", statusPostFailed: false,
    });
  });
});

// #1214 round 2: the workflow returns the GUARDED state/description now, so the
// route and CLI report the same red a downgraded success posts to GitHub.
describe("GET /studio/gate/status with a guarded run (#1214 round 2)", () => {
  it("a skip downgraded by the shared-head guard reports failure, never success", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async () => ({
      status: vi.fn(async () => ({
        status: "complete",
        output: { state: "failure", description: "head aaaaaaaa shared with PR #7", statusPostFailed: false },
      })),
    })) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=run-1`);
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "failure", description: "head aaaaaaaa shared with PR #7", statusPostFailed: false,
    });
  });

  it("a clean skip now carries state success (not the skipped field), passed through", async () => {
    const env = fakeEnv();
    env.GATE_WORKFLOW.get = vi.fn(async () => ({
      status: vi.fn(async () => ({
        status: "complete",
        output: { state: "success", description: "no gated paths changed", statusPostFailed: false, legs: [] },
      })),
    })) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=run-1`);
    const res = await handleGateRoute(req, env);
    expect(await res.json()).toEqual({
      state: "success", description: "no gated paths changed", statusPostFailed: false, legs: [],
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

  // #1230: a `--failed-only` rerun of this run builds its own carry from these
  // fields, so the status route must surface them, not just `legs`.
  it("a complete run's output also carries baseSha and planFingerprint through", async () => {
    const env = fakeEnv();
    const output = {
      state: "success", statusPostFailed: false, legs: [{ leg: "merge-tree", state: "success" }],
      baseSha: "b".repeat(40), planFingerprint: "fp-7",
    };
    env.GATE_WORKFLOW.get = vi.fn(async () => ({
      status: vi.fn(async () => ({ status: "complete", output })),
    })) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request(`https://worker/studio/gate/status?repo=${REPO}&runId=run-1`);
    const res = await handleGateRoute(req, env);
    expect(await res.json()).toMatchObject({ baseSha: "b".repeat(40), planFingerprint: "fp-7" });
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

// #1230: `fleet gate run --failed-only <pr>` reruns only the legs the PR's
// latest run did not already go green on.
describe("POST /studio/gate/start with failedOnly (#1230)", () => {
  it("no prior gate run for the PR -> 404 naming the rerun it has nothing to carry from", async () => {
    const env = fakeEnv();
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 201, failedOnly: true }),
    });
    const res = await handleGateRoute(req, env, headSha);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no prior gate run for this PR to rerun failed legs from" });
    expect(env.GATE_WORKFLOW.create).not.toHaveBeenCalled();
  });

  it("a prior run whose status carries no legs/baseSha/planFingerprint -> 409, nothing started", async () => {
    const env = fakeEnv();
    await d1RunIndex(env.DB).record(REPO, 202, { headSha: HEAD, runId: "run-202", progressedAt: Date.now() });
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => {
      if (id === "run-202") {
        return { status: vi.fn(async () => ({ status: "complete", output: { state: "success", statusPostFailed: false } })) };
      }
      throw new Error(`no instance ${id}`);
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 202, failedOnly: true }),
    });
    const res = await handleGateRoute(req, env, headSha);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "latest gate run has no leg results to carry" });
    expect(env.GATE_WORKFLOW.create).not.toHaveBeenCalled();
  });

  it("a complete prior run with green legs builds carryGreen from its own green legs for the new run", async () => {
    const env = fakeEnv();
    await d1RunIndex(env.DB).record(REPO, 203, { headSha: HEAD, runId: "run-203", progressedAt: Date.now() });
    const legs = [
      { leg: "merge-tree", state: "success" },
      { leg: "lint", state: "failure", description: "3 errors" },
    ];
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => {
      if (id === "run-203") {
        return {
          status: vi.fn(async () => ({
            status: "complete",
            output: {
              state: "failure", description: "1/2 green", statusPostFailed: false, legs,
              baseSha: "b".repeat(40), planFingerprint: "fp-9", headSha: HEAD,
            },
          })),
        };
      }
      throw new Error(`no instance ${id}`);
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 203, failedOnly: true }),
    });
    const res = await handleGateRoute(req, env, headSha);
    expect(res.status).toBe(200);
    // Only "merge-tree" is a green leg; the red "lint" never rides along.
    expect(env.GATE_WORKFLOW.create).toHaveBeenCalledWith({
      id: expect.any(String),
      params: {
        repo: REPO, pr: 203,
        carryGreen: { headSha: HEAD, baseSha: "b".repeat(40), planFingerprint: "fp-9", legs: [{ leg: "merge-tree", state: "success" }] },
      },
    });
  });

  // #1230 review: the auto-infra-rerun carry (workflow.ts) passes full leg
  // results through, so ms/summary survive into the rerun's verdict. The
  // --failed-only carry must do the same: a leg's wall time and test summary
  // are real leg-run output (OutcomeLeg already carries both), not something
  // this route should silently drop on the way into carryGreen.
  it("a green leg's ms/summary survive into the --failed-only carry, not just leg/state/description", async () => {
    const env = fakeEnv();
    await d1RunIndex(env.DB).record(REPO, 205, { headSha: HEAD, runId: "run-205", progressedAt: Date.now() });
    const legs = [
      { leg: "merge-tree", state: "success", ms: 4321, summary: "1 passed" },
      { leg: "lint", state: "failure", description: "3 errors" },
    ];
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => {
      if (id === "run-205") {
        return {
          status: vi.fn(async () => ({
            status: "complete",
            output: {
              state: "failure", description: "1/2 green", statusPostFailed: false, legs,
              baseSha: "b".repeat(40), planFingerprint: "fp-11", headSha: HEAD,
            },
          })),
        };
      }
      throw new Error(`no instance ${id}`);
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 205, failedOnly: true }),
    });
    const res = await handleGateRoute(req, env, headSha);
    expect(res.status).toBe(200);
    expect(env.GATE_WORKFLOW.create).toHaveBeenCalledWith({
      id: expect.any(String),
      params: {
        repo: REPO, pr: 205,
        carryGreen: {
          headSha: HEAD, baseSha: "b".repeat(40), planFingerprint: "fp-11",
          legs: [{ leg: "merge-tree", state: "success", ms: 4321, summary: "1 passed" }],
        },
      },
    });
  });

  // #1230 maestro review: the D1 index's `headSha` is only the dispatch-time
  // label `recordRun` stored when the run was created — a run that is slow to
  // start can resolve (and actually test) a DIFFERENT live head than the one
  // its run id was dispatched for (two pushes dedupe onto the same run id;
  // the run's own late `resolve-pr` step reads whichever head is live then).
  // When the run's own resolved headSha disagrees with the index's stale
  // label, the carry must never be built from it: treat it exactly like
  // "nothing to carry" (the same 409 as no legs/baseSha/planFingerprint).
  it("stored head sha differs from the run's own resolved head sha: no carry, never a false green", async () => {
    const env = fakeEnv();
    await d1RunIndex(env.DB).record(REPO, 206, { headSha: HEAD, runId: "run-206", progressedAt: Date.now() });
    const legs = [{ leg: "merge-tree", state: "success" }];
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => {
      if (id === "run-206") {
        return {
          status: vi.fn(async () => ({
            status: "complete",
            output: {
              state: "success", statusPostFailed: false, legs,
              baseSha: "b".repeat(40), planFingerprint: "fp-12",
              // The run actually resolved and tested a DIFFERENT head than
              // the D1 index's dispatch-time label (HEAD).
              headSha: "d".repeat(40),
            },
          })),
        };
      }
      throw new Error(`no instance ${id}`);
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 206, failedOnly: true }),
    });
    const res = await handleGateRoute(req, env, headSha);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "latest gate run has no leg results to carry" });
    expect(env.GATE_WORKFLOW.create).not.toHaveBeenCalled();
  });

  // #1230 review: the GET status handler wraps gateRunStatus in a
  // try/catch mapping a not-found instance to a clean 404; the failedOnly
  // branch called the same gateRunStatus with no such guard, so an
  // expired/unknown instance behind a stale D1 pointer threw uncaught
  // through the whole call stack instead of returning clean JSON.
  it("a prior run whose instance the Workflow no longer knows -> clean JSON error, never an uncaught throw", async () => {
    const env = fakeEnv();
    await d1RunIndex(env.DB).record(REPO, 204, { headSha: HEAD, runId: "run-204", progressedAt: Date.now() });
    env.GATE_WORKFLOW.get = vi.fn(async (id: string) => {
      if (id === "run-204") throw new Error("instance.not_found");
      throw new Error(`no instance ${id}`);
    }) as unknown as FakeEnv["GATE_WORKFLOW"]["get"];
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 204, failedOnly: true }),
    });
    const res = await handleGateRoute(req, env, headSha);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such gate run", runId: "run-204" });
    expect(env.GATE_WORKFLOW.create).not.toHaveBeenCalled();
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

// #1247: `fleet gate protect <owner/repo>` — the route that turns on
// gate/verdict branch protection. It runs FIRST, before the FLEET_GATE_RUNNER
// checks, so the runner flag being off does not matter here.
describe("POST /studio/gate/protect (#1247)", () => {
  it("runs the pure protect over the injected port and returns the before/after", async () => {
    const env = fakeEnv({ FLEET_GATE_RUNNER: "off" });
    const calls: Array<{ method: string; repo: string; branch?: string; contexts?: string[]; strict?: boolean }> = [];
    const protect: ProtectPort = {
      getDefaultBranch: async (repo) => { calls.push({ method: "getDefaultBranch", repo }); return "main"; },
      getProtection: async (repo, branch) => { calls.push({ method: "getProtection", repo, branch }); return { contexts: ["lint"] }; },
      createProtection: async (repo, branch, contexts) => { calls.push({ method: "createProtection", repo, branch, contexts }); },
      addRequiredContexts: async (repo, branch, contexts) => { calls.push({ method: "addRequiredContexts", repo, branch, contexts }); },
      setStrict: async (repo, branch, strict) => { calls.push({ method: "setStrict", repo, branch, strict }); },
    };
    const req = new Request("https://worker/studio/gate/protect", {
      method: "POST", body: JSON.stringify({ repo: "acme/websites" }),
    });
    const res = await handleGateRoute(req, env, headSha, protect);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      branch: "main", before: ["lint"], after: ["lint", "gate/verdict"], changed: true,
    });
    expect(calls).toEqual([
      { method: "getDefaultBranch", repo: "acme/websites" },
      { method: "getProtection", repo: "acme/websites", branch: "main" },
      { method: "addRequiredContexts", repo: "acme/websites", branch: "main", contexts: ["gate/verdict"] },
      { method: "setStrict", repo: "acme/websites", branch: "main", strict: false },
    ]);
  });

  it("a missing or slashless repo is a 400", async () => {
    const env = fakeEnv();
    for (const body of [{}, { repo: "not-a-repo" }]) {
      const req = new Request("https://worker/studio/gate/protect", {
        method: "POST", body: JSON.stringify(body),
      });
      const res = await handleGateRoute(req, env, headSha);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "repo required as owner/name" });
    }
  });

  // #1247 review: a protect failure must map the upstream status, not collapse
  // every throw into a generic 500 — a repo typo is a 404 the operator can act
  // on; a 403 (missing admin) is still "our call failed" (502), with the
  // underlying message (which never carries the token) preserved in the body.
  it("maps an upstream 404 to 404, naming the missing repo", async () => {
    const env = fakeEnv();
    const protect: ProtectPort = {
      getDefaultBranch: async () => { throw new Error("read acme/x failed (404): Not Found"); },
      getProtection: async () => ({ contexts: [] }),
      createProtection: async () => {},
      addRequiredContexts: async () => {},
      setStrict: async () => {},
    };
    const req = new Request("https://worker/studio/gate/protect", {
      method: "POST", body: JSON.stringify({ repo: "acme/x" }),
    });
    const res = await handleGateRoute(req, env, headSha, protect);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "read acme/x failed (404): Not Found" });
  });

  it("maps any other upstream failure (a 403) to 502, preserving the message", async () => {
    const env = fakeEnv();
    const protect: ProtectPort = {
      getDefaultBranch: async () => { throw new Error("read acme/x failed (403): Forbidden"); },
      getProtection: async () => ({ contexts: [] }),
      createProtection: async () => {},
      addRequiredContexts: async () => {},
      setStrict: async () => {},
    };
    const req = new Request("https://worker/studio/gate/protect", {
      method: "POST", body: JSON.stringify({ repo: "acme/x" }),
    });
    const res = await handleGateRoute(req, env, headSha, protect);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Forbidden");
  });
});
