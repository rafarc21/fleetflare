// #1398 Task 12: engine tests for the async /run-leg path, driven through the
// REAL Workflows engine and the REAL GateRunnerDO (both under miniflare), but
// designed around the one environment constraint this repo's own
// gate-workflow-precheck.test.ts already states: the real container-backed
// GateRunnerDO cannot boot a container under vitest. So `this.ctx.container`
// is never a usable binding here -- which is exactly what makes the
// idempotency proof (test 4) and the alarm-tick proof (test 2) STRONGER, not
// weaker: each reaches the code path it proves WITHOUT the container that
// would otherwise mask the ordering being asserted.
//
// Neutral fixtures only (acme/example, acme/widgets): this file ships public.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  env, introspectWorkflowInstance, runDurableObjectAlarm, runInDurableObject,
} from "cloudflare:test";
import type { Env } from "../src/env";
import { claimOrReadBack, type ClaimableBucket } from "../src/gate/leg-run";
import type { RunLegAlarmState } from "../src/gate/run-leg-alarm";
import { GATE_STATUS_CONTEXT } from "../src/gate/status-post";

const REPO = "acme/example";
const PR = 7;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);

// A run-path block whose pathRules match the compare's docs/readme.md, and
// whose legs [] leaves exactly the always-planned merge-tree leg.
const RUN_FLEET_JSON = JSON.stringify({
  gate: { install: "bun install", legs: [], pathRules: ["docs/**"] },
});

type Recorded = { method: string; url: string; body: unknown };

// The async path's GATE_RUNNER answers 202 (container started, no result yet);
// runLegStepPolling then finds the terminal result by polling R2.
const asyncRunner = {
  idFromName: (name: string) => name as unknown as DurableObjectId,
  get: (_id: unknown) => ({
    fetch: async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { leg?: string };
      recorded.push({ method: init.method ?? "POST", url: _url, body });
      return new Response(null, { status: 202 });
    },
  }),
};

let recorded: Recorded[] = [];
let realFetch: typeof globalThis.fetch;
let pullsCalls = 0;
let compareCalls = 0;
let commitMessage = "Fix #9";
let fleetJson = RUN_FLEET_JSON;
let titleFlipsOnRecheck = true;
let lastPostedStatus: { state: string; description?: string } | undefined;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Mirrors gate-workflow-precheck.test.ts's mockFetch: enough of the GitHub
// surface for a clean, successful run path (resolve-pr -> precheck -> legs ->
// guard -> verdict). The title stays clean and the commit message is clean, so
// nothing fails before the legs run.
function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  const method = init?.method ?? "GET";
  recorded.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(init.body as string) });

  if (method === "GET" && /\/pulls\/\d+$/.test(url)) {
    pullsCalls++;
    return Promise.resolve(json({
      number: PR, merged: false, merge_commit_sha: null, state: "open",
      base: { ref: "main", repo: { full_name: REPO, private: false } },
      head: { ref: "feature", sha: HEAD },
      title: titleFlipsOnRecheck && pullsCalls >= 2 ? "Fix #2" : "Docs update", body: "Readme tweak",
    }));
  }
  if (method === "GET" && /\/pulls\?state=open/.test(url)) {
    // listOpenPulls -- the shared-head guard. Empty body = no sibling PRs.
    return Promise.resolve(json([]));
  }
  if (method === "GET" && /\/commits\/main$/.test(url)) {
    return Promise.resolve(json({ sha: BASE }));
  }
  if (method === "GET" && /\/compare\/[0-9a-f]+\.\.\.[0-9a-f]+$/.test(url)) {
    compareCalls++;
    return Promise.resolve(json({
      ahead_by: 1,
      merge_base_commit: { sha: MERGE_BASE },
      files: [{ filename: "docs/readme.md", status: "modified", patch: "@@ -1 +1 @@\n+updated", changes: 1 }],
      commits: [{
        commit: {
          author: { name: "Acme Dev", email: "dev@example.com" },
          committer: { name: "Acme Bot", email: "bot@example.com" },
          message: commitMessage,
        },
      }],
    }));
  }
  if (method === "GET" && /\/contents\/fleet\.json\?ref=/.test(url)) {
    return Promise.resolve(new Response(fleetJson, { status: 200 }));
  }
  if (method === "GET" && /\/contents\/public-denylist\.txt\?ref=/.test(url)) {
    // The ops denylist: one pattern that does not hit the neutral fixtures, so
    // the leak scan passes clean.
    return Promise.resolve(new Response("acmeclient\n", { status: 200 }));
  }
  if (method === "POST" && /\/statuses\/[0-9a-f]{40}$/.test(url)) {
    lastPostedStatus = init?.body === undefined ? undefined : (JSON.parse(init.body as string) as { state: string; description?: string });
    return Promise.resolve(json({}));
  }
  if (method === "GET" && /\/commits\/[0-9a-f]{40}\/statuses/.test(url)) {
    return Promise.resolve(json(
      lastPostedStatus === undefined ? [] : [{ context: GATE_STATUS_CONTEXT, ...lastPostedStatus }],
    ));
  }
  return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
}

const workflowEnv = () => env as unknown as Env;

// `env` is shared across every test in this file. Test 1 replaces
// GATE_RUNNER with an inline fake (the async 202 namespace); tests 2 and 4
// need the REAL DurableObjectNamespace to seed/run the actual GateRunnerDO.
// Capture it once at module load and restore it after every test.
const realGateRunnerNamespace = workflowEnv().GATE_RUNNER;

beforeEach(() => {
  recorded = [];
  pullsCalls = 0;
  compareCalls = 0;
  commitMessage = "Fix #9";
  fleetJson = RUN_FLEET_JSON;
  titleFlipsOnRecheck = true;
  lastPostedStatus = undefined;
  realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  workflowEnv().GATE_RUNNER = realGateRunnerNamespace;
});

describe("gate async /run-leg engine (#1398 Task 12)", () => {
  it("a poll step forced to fail once (the #1393 invocation-cut) still finds the leg's own R2 result on the next attempt", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = asyncRunner as unknown as Env["GATE_RUNNER"];
    e.GATE_ASYNC_LEGS = REPO;

    const instanceId = "gate-async-poll-replay";
    // The leg's own result already sits in R2 before the run -- exactly as if a
    // real container finished and reported before this invocation was cut.
    const resultKey = `gate/acme/example/runs/${PR}/${instanceId}/shard-merge-tree.json`;
    await e.STUDIO_ARCHIVE.put(resultKey, JSON.stringify({ state: "success" }));

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, instanceId);
    try {
      // Force the FIRST poll step to throw once (the engine-level
      // "internal workflows error" of an invocation cut); the step's own
      // LEG_STEP_CONFIG retry must then run the callback for real and find the
      // already-written R2 result, never lose it.
      await instance.modify(async (m) => {
        await m.disableSleeps();
        await m.mockStepError(
          { name: "dispatch-start-merge-tree-try1-poll-1" },
          new Error("internal workflows error"),
          1,
        );
      });
      await e.GATE_WORKFLOW.create({ id: instanceId, params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string };
      expect(out.state).toBe("success");

      // The async path dispatched (202) and the poll found the seeded success.
      const runLeg = recorded.find((r) => /\/run-leg/.test(r.url));
      expect(runLeg).toBeDefined();
      expect((runLeg!.body as { mode?: string }).mode).toBe("async-poll");
    } finally {
      await instance.dispose();
      await e.STUDIO_ARCHIVE.delete(resultKey);
    }
  }, 90_000);

  it("a duplicate/redelivered alarm tick never produces a second terminal write to the same result key", async () => {
    const e = workflowEnv();
    const instanceId = "gate-alarm-tick-once";
    const resultKey = `gate/acme/widgets/runs/9/${instanceId}/shard-lint.json`;
    const stub = e.GATE_RUNNER.get(e.GATE_RUNNER.idFromName(`${instanceId}/lint/attempt-1`));

    // "polling" phase with no real container: observeOnce's own c===undefined
    // branch answers "poll-failed", so the FIRST alarm tick concludes infra
    // immediately -- the terminal-write path, reached without a container.
    await runInDurableObject(stub, async (_instance, state) => {
      const alarmState: RunLegAlarmState = {
        phase: "polling", resultKey, leg: "lint", timeoutMin: undefined,
        readyStartedAt: 0, pollStartedAt: 0, instanceId: "", statusCheckCount: 0, consecutiveFailures: 0,
      };
      await state.storage.put("alarmState", alarmState);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const firstRan = await runDurableObjectAlarm(stub);
    expect(firstRan).toBe(true);
    const first = await e.STUDIO_ARCHIVE.get(resultKey);
    expect(first).not.toBeNull();
    const firstBody = await first!.json() as { state: string; description?: string };
    expect(firstBody.state).toBe("error"); // the DO's own "gate container exited mid-leg" conclusion
    expect(firstBody.description).toContain("gate container exited mid-leg");

    // alarmState was deleted after the first terminal write -- a second,
    // redelivered tick finds NOTHING scheduled and is a safe no-op.
    const secondRan = await runDurableObjectAlarm(stub);
    expect(secondRan).toBe(false);
    const second = await e.STUDIO_ARCHIVE.get(resultKey);
    expect(second).not.toBeNull();
    expect(await second!.json()).toEqual(firstBody); // unchanged -- no second write
  }, 60_000);

  it("the DO-vs-Workflow write-once race holds under the REAL R2 conditional-write behavior", async () => {
    const e = workflowEnv();
    const resultKey = `gate/acme/widgets/runs/9/gate-race-${Date.now()}/shard-lint.json`;
    // Pre-populate: the container's own report already landed.
    await e.STUDIO_ARCHIVE.put(resultKey, JSON.stringify({ state: "success" }));

    // claimOrReadBack (Task 6) against the REAL binding, with a guessed infra
    // value -- the one assertion a fake bucket cannot prove: that R2Bucket.put's
    // own onlyIf semantics produce the conflict (null) claimOrReadBack handles.
    const guessed = { state: "error" as const, description: "guessed infra, should never win" };
    const result = await claimOrReadBack(e.STUDIO_ARCHIVE as unknown as ClaimableBucket, resultKey, guessed);
    expect(result).toEqual({ state: "success" }); // the pre-populated report wins, never the guess
    const stored = await (await e.STUDIO_ARCHIVE.get(resultKey))!.json();
    expect(stored).toEqual({ state: "success" }); // the R2 object itself was never overwritten
  }, 60_000);

  it("a /run-leg POST against a DO with already-seeded alarmState answers 202 without touching the container path", async () => {
    const e = workflowEnv();
    const instanceId = "gate-run-leg-idempotent";
    const resultKey = `gate/acme/widgets/runs/9/${instanceId}/shard-lint.json`;
    const stub = e.GATE_RUNNER.get(e.GATE_RUNNER.idFromName(`${instanceId}/lint/attempt-1`));

    // "waiting-for-ready" alarmState already persisted, standing in for "a
    // container was already started by an earlier /run-leg call".
    await runInDurableObject(stub, async (_instance, state) => {
      const alarmState: RunLegAlarmState = {
        phase: "waiting-for-ready", resultKey, leg: "lint", timeoutMin: undefined,
        readyStartedAt: Date.now(), instanceId, statusCheckCount: 0, consecutiveFailures: 0,
      };
      await state.storage.put("alarmState", alarmState);
    });

    const res = await stub.fetch("https://gate-runner/run-leg", {
      method: "POST",
      body: JSON.stringify({
        owner: "acme", repo: "widgets", commit: "abc", leg: "lint", installCmd: "true", legCmd: "true",
        resultKey, baselineKeys: [], baseRef: "main", pr: "9", mode: "async-poll", instanceId,
      }),
    });
    // 202, not a 503 "gate container binding missing" -- had the idempotency
    // check NOT run first, this call would have reached startLegContainer,
    // which hits the missing-container branch in this environment.
    expect(res.status).toBe(202);
  }, 60_000);

  // #1428 item 1: the Workflow's own give-up calls this idempotent RPC
  // against the REAL GateRunnerDO. The container cannot boot under vitest
  // (this file's own header), which makes the no-container assertion here
  // STRONGER, not weaker: destroy() is a no-op on an unbound container
  // binding, so the only thing left to prove is the one thing that matters --
  // the storage deletes themselves -- without a container to mask them.
  it("/abandon deletes alarmState and secretValues for a matching resultKey, and is a safe no-op called again", async () => {
    const e = workflowEnv();
    const instanceId = "gate-abandon-match";
    const resultKey = `gate/acme/widgets/runs/9/${instanceId}/shard-lint.json`;
    const stub = e.GATE_RUNNER.get(e.GATE_RUNNER.idFromName(`${instanceId}/lint/attempt-1`));

    await runInDurableObject(stub, async (_instance, state) => {
      const alarmState: RunLegAlarmState = {
        phase: "polling", resultKey, leg: "lint", timeoutMin: undefined,
        readyStartedAt: 0, pollStartedAt: 0, instanceId, statusCheckCount: 0, consecutiveFailures: 0,
      };
      await state.storage.put("alarmState", alarmState);
      await state.storage.put("secretValues", { "staging-login": "sup3r-s3cret" });
    });

    const first = await stub.fetch("https://gate-runner/abandon", {
      method: "POST",
      body: JSON.stringify({ resultKey }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ result: "abandoned" });

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("alarmState")).toBeUndefined();
      expect(await state.storage.get("secretValues")).toBeUndefined();
    });

    // Idempotent: calling it again (the real scenario this RPC is FOR -- the
    // Workflow retries it, or a redelivered call lands twice) is a safe
    // no-op, never an error.
    const second = await stub.fetch("https://gate-runner/abandon", {
      method: "POST",
      body: JSON.stringify({ resultKey }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ result: "no-op" });
  }, 60_000);

  it("/abandon with a resultKey that does not match the stored attempt's own leaves it untouched", async () => {
    const e = workflowEnv();
    const instanceId = "gate-abandon-mismatch";
    const resultKey = `gate/acme/widgets/runs/9/${instanceId}/shard-lint.json`;
    const stub = e.GATE_RUNNER.get(e.GATE_RUNNER.idFromName(`${instanceId}/lint/attempt-1`));

    await runInDurableObject(stub, async (_instance, state) => {
      const alarmState: RunLegAlarmState = {
        phase: "polling", resultKey, leg: "lint", timeoutMin: undefined,
        readyStartedAt: 0, pollStartedAt: 0, instanceId, statusCheckCount: 0, consecutiveFailures: 0,
      };
      await state.storage.put("alarmState", alarmState);
    });

    const res = await stub.fetch("https://gate-runner/abandon", {
      method: "POST",
      body: JSON.stringify({ resultKey: "a completely different key" }),
    });
    expect(await res.json()).toEqual({ result: "no-op" });

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("alarmState")).toBeDefined(); // untouched
    });
  }, 60_000);
});