// #1191/#1203: drive GateWorkflow.run() end to end through the real Workflows
// engine (vitest-pool-workers). The SKIP path never touches the GATE_RUNNER DO;
// the RUN path does, through the test-only GateRunnerStub bound in
// wrangler.test.jsonc (the real container-backed GateRunnerDO cannot boot under
// vitest). The precheck must fail on a commit-message closing keyword BEFORE
// the skip returns success, and both the skip-path and the success-path recheck
// must post a gate/verdict failure naming a title edited to a closing keyword
// after the precheck passed. Neutral fixtures only (acme/example): this file
// ships public.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, introspectWorkflowInstance } from "cloudflare:test";
import type { Env } from "../src/env";
import { CLOSING_KEYWORD_COMMIT_FAILURE, CLOSING_KEYWORD_FAILURE } from "../src/gate/merge-precheck";
import { GATE_STATUS_CONTEXT } from "../src/gate/status-post";
import { requestedLegs } from "./helpers/gate-runner-stub";

const REPO = "acme/example";
const PR = 7;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const INSTANCE_ID = "gate-precheck-fix5";

const FLEET_JSON = JSON.stringify({
  gate: { install: "bun install", legs: ["lint"], pathRules: ["src/**"] },
});

// #1203: the success-path block. pathRules matches the compare's
// docs/readme.md (unlike FLEET_JSON's src/**), so decideGateRun=run instead of
// skip, and legs [] leaves exactly the always-planned merge-tree leg. Every
// fleet.json read returns whatever `fleetJson` currently holds.
const RUN_FLEET_JSON = JSON.stringify({
  gate: { install: "bun install", legs: [], pathRules: ["docs/**"] },
});

type Recorded = { method: string; url: string; body: unknown };

let recorded: Recorded[] = [];
let realFetch: typeof globalThis.fetch;
// #1203: the two /compare/ GETs in one run — resolve-pr's compareFiles first,
// then the precheck's comparePrecheckData — are told apart by call count, so a
// test can throw ONLY the precheck's call and pin the fail-closed catch.
let compareCalls = 0;
let compareThrows2nd = false;
// #1203: the title getPullRequest serves is call-count driven, so a test can
// leave it clean through resolve-pr (calls 1-2) and flip it to a closing
// keyword only at the recheck (call 3), which re-reads the PR after the
// initial precheck passed.
let pullsCalls = 0;
// The compare's commit message, so a test can hold the precheck clean (the
// default "Fix #9" fails it before the recheck could ever run).
let commitMessage = "Fix #9";
// The fleet.json body served (FLEET_JSON or RUN_FLEET_JSON), so a test can
// pick the skip path or the run path.
let fleetJson = FLEET_JSON;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  const method = init?.method ?? "GET";
  recorded.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(init.body as string) });

  if (method === "GET" && /\/pulls\/\d+$/.test(url)) {
    // getPullRequest + getPullRequestHeadSha: same body serves both (head.sha
    // is read only by the latter; getPullRequest ignores it). The title is
    // clean through resolve-pr's two reads (calls 1-2) and flips to a closing
    // keyword at the recheck's re-read (call 3), so a title edited between the
    // initial precheck and the recheck goes red.
    pullsCalls++;
    return Promise.resolve(json({
      number: PR, merged: false, merge_commit_sha: null, state: "open",
      base: { ref: "main", repo: { full_name: REPO, private: false } },
      head: { ref: "feature", sha: HEAD },
      title: pullsCalls >= 3 ? "Fix #2" : "Docs update", body: "Readme tweak",
    }));
  }
  if (method === "GET" && /\/commits\/main$/.test(url)) {
    return Promise.resolve(json({ sha: BASE }));
  }
  if (method === "GET" && /\/compare\/[0-9a-f]+\.\.\.[0-9a-f]+$/.test(url)) {
    // compareFiles (resolve-pr) + comparePrecheckData (precheck step): the one
    // body serves both. The commit message carries a closing keyword.
    compareCalls++;
    // #1203: throw every precheck compare (call 2 and any Workflows retry of
    // it), never resolve-pr's own first call. `=== 2` alone would let a retry
    // of the precheck step (call 3) succeed and mask the fail-closed catch.
    if (compareThrows2nd && compareCalls >= 2) {
      return Promise.reject(new Error("boom"));
    }
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
    // Every fleet.json read (the fleet repo's at HEAD, and the PR repo's at
    // merge-base, head and base) returns the same gate block: FLEET_JSON (a
    // skip-path block) or RUN_FLEET_JSON (a run-path block whose pathRules
    // match docs/readme.md).
    return Promise.resolve(new Response(fleetJson, { status: 200 }));
  }
  if (method === "GET" && /\/contents\/public-denylist\.txt\?ref=/.test(url)) {
    // The ops denylist: one pattern that does not hit the neutral fixtures, so
    // a precheck with FLEET_OPS_REPO set passes clean and reaches the recheck.
    return Promise.resolve(new Response("acmeclient\n", { status: 200 }));
  }
  if (method === "POST" && /\/statuses\/[0-9a-f]{40}$/.test(url)) {
    return Promise.resolve(json({}));
  }
  return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
}

const workflowEnv = () => env as unknown as Env;

beforeEach(() => {
  recorded = [];
  compareCalls = 0;
  compareThrows2nd = false;
  pullsCalls = 0;
  commitMessage = "Fix #9";
  fleetJson = FLEET_JSON;
  requestedLegs.length = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("GateWorkflow.run() precheck via the Workflows engine (#1191)", () => {
  it("a commit-message closing keyword fails the precheck before the skip returns, and posts failure", async () => {
    const e = workflowEnv();
    // Token provider for every owner (acme-corp included, which
    // wrangler.test.jsonc's GITHUB_REPO_AUTH maps to the unconfigured App).
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    // FLEET_OPS_REPO stays unset: resolveOpsRepo -> null -> patterns [], so the
    // denylist is unavailable. The commit-message keyword is checked before the
    // leak scan, so it is failures[0] regardless of DENYLIST_UNAVAILABLE also
    // being appended.
    delete e.FLEET_OPS_REPO;

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, INSTANCE_ID);
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: INSTANCE_ID, params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("failure");
      expect(out.description).toContain(CLOSING_KEYWORD_COMMIT_FAILURE);

      const post = recorded.find((r) => r.method === "POST" && /\/statuses\//.test(r.url));
      expect(post).toBeDefined();
      expect(post!.body).toEqual({
        state: "failure",
        context: GATE_STATUS_CONTEXT,
        description: CLOSING_KEYWORD_COMMIT_FAILURE,
      });

      // No leg ran: the SKIP path and its precheck never touch GATE_RUNNER.
      const legCalls = recorded.filter((r) => /\/run-leg/.test(r.url));
      expect(legCalls).toEqual([]);
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  it("a precheck compare that throws fails closed: posts the fail-closed description (#1203)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    delete e.FLEET_OPS_REPO;

    // Only the precheck's own compare GET throws: resolve-pr's compareFiles is
    // the first /compare/ call and must still resolve, or the run errors before
    // the precheck step ever runs.
    compareThrows2nd = true;

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-precheck-fix2");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-precheck-fix2", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("failure");
      expect(out.description).toBe("gate precheck failed closed");

      const post = recorded.find((r) => r.method === "POST" && /\/statuses\//.test(r.url));
      expect(post).toBeDefined();
      expect(post!.body).toEqual({
        state: "failure",
        context: GATE_STATUS_CONTEXT,
        description: "gate precheck failed closed",
      });
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  it("a title edited to a closing keyword after the precheck fails the skip-path recheck (#1203)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    // A real denylist with one non-hitting pattern: the precheck must pass clean
    // (title and commit message are clean) so the run reaches the skip recheck.
    e.FLEET_OPS_REPO = "acme/ops";
    // The compare's commit message must not carry a keyword, or the precheck
    // fails before the recheck could ever run.
    commitMessage = "clean";

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-precheck-fix3a");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-precheck-fix3a", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("failure");
      expect(out.description).toBe(CLOSING_KEYWORD_FAILURE);

      const post = recorded.find((r) => r.method === "POST" && /\/statuses\//.test(r.url));
      expect(post).toBeDefined();
      expect(post!.body).toEqual({
        state: "failure",
        context: GATE_STATUS_CONTEXT,
        description: CLOSING_KEYWORD_FAILURE,
      });

      // No leg ran: the SKIP path and its recheck never touch GATE_RUNNER.
      const legCalls = recorded.filter((r) => /\/run-leg/.test(r.url));
      expect(legCalls).toEqual([]);
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  // #1203: the success-path recheck (workflow.ts:290) fires only when
  // final.state === "success", reached after real legs run. The real
  // GateRunnerDO is container-backed and cannot boot under vitest-pool-workers,
  // so wrangler.test.jsonc binds the test-only GateRunnerStub under GATE_RUNNER:
  // it answers /run-leg with a success LegResult, the always-planned merge-tree
  // leg goes green, and the run reaches the success-path recheck — whose
  // title/body re-read then flips to a closing keyword and posts failure.
  // Deleting workflow.ts:290-292 (the success-only recheck block) makes this
  // test red: the run would post success instead.
  it("a title edited to a closing keyword after the legs passed fails the success-path recheck (#1203)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    // The precheck must pass clean (title and commit message clean) so the run
    // reaches the legs and then the success-path recheck.
    commitMessage = "clean";
    // pathRules docs/** matches the compare's docs/readme.md, so decideGateRun
    // is "run", not "skip"; legs [] leaves exactly the merge-tree leg.
    fleetJson = RUN_FLEET_JSON;

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-precheck-fix4");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-precheck-fix4", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("failure");
      expect(out.description).toBe(CLOSING_KEYWORD_FAILURE);

      // The run path posts pending first ("running ... 1 legs"), then the
      // recheck failure — find the failure post, not the pending one.
      const post = recorded.find((r) =>
        r.method === "POST" && /\/statuses\//.test(r.url) && (r.body as { state?: string }).state === "failure");
      expect(post).toBeDefined();
      expect(post!.body).toEqual({
        state: "failure",
        context: GATE_STATUS_CONTEXT,
        description: CLOSING_KEYWORD_FAILURE,
      });

      // The merge-tree leg ran once (the run path touched GATE_RUNNER), and the
      // stub's success verdict is what carried the run to the success recheck.
      expect(requestedLegs).toEqual(["merge-tree"]);
    } finally {
      await instance.dispose();
    }
  }, 60_000);
});
