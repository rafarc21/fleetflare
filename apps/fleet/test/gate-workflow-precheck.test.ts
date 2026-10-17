// #1191: drive GateWorkflow.run() end to end through the real Workflows
// engine (vitest-pool-workers), on the SKIP path so no leg runs and the
// GATE_RUNNER DO is never touched. The precheck must fail on a commit-message
// closing keyword BEFORE the skip returns success, and post a gate/verdict
// failure naming that keyword. Neutral fixtures only (acme/example): this file
// ships public.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, introspectWorkflowInstance } from "cloudflare:test";
import type { Env } from "../src/env";
import { CLOSING_KEYWORD_COMMIT_FAILURE } from "../src/gate/merge-precheck";
import { GATE_STATUS_CONTEXT } from "../src/gate/status-post";

const REPO = "acme/example";
const PR = 7;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const INSTANCE_ID = "gate-precheck-fix5";

const FLEET_JSON = JSON.stringify({
  gate: { install: "bun install", legs: ["lint"], pathRules: ["src/**"] },
});

type Recorded = { method: string; url: string; body: unknown };

let recorded: Recorded[] = [];
let realFetch: typeof globalThis.fetch;
// #1203: the two /compare/ GETs in one run — resolve-pr's compareFiles first,
// then the precheck's comparePrecheckData — are told apart by call count, so a
// test can throw ONLY the precheck's call and pin the fail-closed catch.
let compareCalls = 0;
let compareThrows2nd = false;

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
    // is read only by the latter; getPullRequest ignores it).
    return Promise.resolve(json({
      number: PR, merged: false, merge_commit_sha: null, state: "open",
      base: { ref: "main", repo: { full_name: REPO, private: false } },
      head: { ref: "feature", sha: HEAD },
      title: "Docs update", body: "Readme tweak",
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
          message: "Fix #9",
        },
      }],
    }));
  }
  if (method === "GET" && /\/contents\/fleet\.json\?ref=/.test(url)) {
    // Every fleet.json read (the fleet repo's at HEAD, and the PR repo's at
    // merge-base, head and base) returns the same gate block: paths outside it.
    return Promise.resolve(new Response(FLEET_JSON, { status: 200 }));
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
});