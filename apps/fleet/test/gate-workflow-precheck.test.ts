// #1191/#1203/#1205: drive GateWorkflow.run() end to end through the real
// Workflows engine (vitest-pool-workers). The SKIP path never touches the
// GATE_RUNNER DO; the RUN path answers it with an inline fake namespace in
// this file (the real container-backed GateRunnerDO cannot boot under
// vitest), so no wrangler binding or test entrypoint is needed. The precheck
// must fail on a commit-message closing keyword BEFORE the skip returns
// success, and both the skip-path and the success-path recheck must post a
// gate/verdict failure naming a title edited to a closing keyword after the
// precheck passed. Neutral fixtures only (acme/example): this file ships
// public.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, introspectWorkflowInstance } from "cloudflare:test";
import type { Env } from "../src/env";
import { planFingerprint, planUnionLegs, type PlanInput } from "../src/gate/fanout";
import { CLOSING_KEYWORD_COMMIT_FAILURE, CLOSING_KEYWORD_FAILURE } from "../src/gate/merge-precheck";
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

// #1203: the success-path block. pathRules matches the compare's
// docs/readme.md (unlike FLEET_JSON's src/**), so decideGateRun=run instead of
// skip, and legs [] leaves exactly the always-planned merge-tree leg. Every
// fleet.json read returns whatever `fleetJson` currently holds.
const RUN_FLEET_JSON = JSON.stringify({
  gate: { install: "bun install", legs: [], pathRules: ["docs/**"] },
});

// #1230: a run-path block with ONE configured leg (merge-tree + typecheck =
// two legs), so a carryGreen test can carry one green and still dispatch the
// other through GATE_RUNNER.
const RUN_FLEET_JSON_TWO_LEGS = JSON.stringify({
  gate: { install: "bun install", legs: [{ name: "typecheck", cmd: "bun run typecheck" }], pathRules: ["docs/**"] },
});

// #1230: the plan fingerprint this fixture's run resolves to — mirrors
// workflow.ts's own planFor(base, bunFiles.base) for RUN_FLEET_JSON_TWO_LEGS's
// block (no bun lane, no vitest lane, no head config since fleetJson is
// unchanged between merge-base and head in these fixtures).
function fixtureFingerprint(): string {
  const base: PlanInput = {
    owner: "acme", repo: "example", pr: PR, runId: "fingerprint-only",
    headSha: HEAD, baseSha: BASE,
    install: "bun install", legs: [{ name: "typecheck", cmd: "bun run typecheck" }],
    bunShards: [], bunLaneRoot: "", vitestShards: 8, baselineKeys: [],
  };
  return planFingerprint(planUnionLegs(base, null));
}

type Recorded = { method: string; url: string; body: unknown };

// #1205: an inline fake GATE_RUNNER namespace — idFromName/get/fetch answer a
// green LegResult for every leg, so run() reaches a success verdict without the
// real container-backed DO (which vitest cannot spawn). No wrangler binding.
const greenRunner = {
  idFromName: (name: string) => name as unknown as DurableObjectId,
  get: (_id: unknown) => ({
    fetch: async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { leg?: string };
      recorded.push({ method: init.method ?? "POST", url: _url, body });
      return Response.json({ leg: body.leg ?? "merge-tree", state: "success" });
    },
  }),
};

// #1230 maestro review: every leg green EXCEPT the one named `redLeg`, which
// answers "failure" — a carried-green leg alongside a freshly-dispatched red
// sibling must never certify the run success.
function runnerGreenExcept(redLeg: string) {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (_id: unknown) => ({
      fetch: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { leg?: string };
        recorded.push({ method: init.method ?? "POST", url: _url, body });
        const leg = body.leg ?? "merge-tree";
        return Response.json(
          leg === redLeg
            ? { leg, state: "failure", description: `${leg} exited 1` }
            : { leg, state: "success" },
        );
      },
    }),
  };
}

let recorded: Recorded[] = [];
let realFetch: typeof globalThis.fetch;
// #1203: the two /compare/ GETs in one run — resolve-pr's compareFiles first,
// then the precheck's comparePrecheckData — are told apart by call count, so a
// test can throw ONLY the precheck's call and pin the fail-closed catch.
let compareCalls = 0;
let compareThrows2nd = false;
// #1203: the title getPullRequest serves is call-count driven, so a test can
// leave it clean through resolve-pr (call 1) and flip it to a closing keyword
// only at the recheck (call 2), which re-reads the PR after the initial
// precheck passed (#1276 dropped resolve-pr's second /pulls GET).
let pullsCalls = 0;
// The compare's commit message, so a test can hold the precheck clean (the
// default "Fix #9" fails it before the recheck could ever run).
let commitMessage = "Fix #9";
// The fleet.json body served (FLEET_JSON or RUN_FLEET_JSON), so a test can
// pick the skip path or the run path.
let fleetJson = FLEET_JSON;
// #1215: the guard's listOpenPulls endpoint (paged ?state=open). A test serves
// an arbitrary body, throws on the FIRST call (step.do retries), throws on
// EVERY call (fails closed after retries), or emits a next Link every page
// (truncated -> fail closed).
let openPullsCalls = 0;
let openPullsBody: unknown[] = [];
let openPullsThrowsFirst = false;
let openPullsAlwaysThrows = false;
let openPullsTruncated = false;
// #1214: the /pulls/<n> title mock flips to a closing keyword at the recheck
// (call 2) by default (#1203). A guard test keeps the title clean so the run
// reaches the verdict guard instead of failing the success recheck.
let titleFlipsOnRecheck = true;
// #1226: gate/verdict's current landed state, served back by the combined
// -status GET postGateStatus reads to confirm a post. A test can make the
// POST itself fail (reject) on specific 1-based call numbers
// (statusPostFailOn), so Workflows' own step retry (STATUS_POST_STEP_CONFIG)
// must re-run postGateStatus for real before the verdict ever lands.
let lastPostedStatus: { state: string; description?: string } | undefined;
let statusPostCalls = 0;
let statusPostFailOn: Set<number> = new Set();

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
    // #1276: one getPullRequest GET serves resolve-pr (head.sha and title ride
    // the same body). The title is clean through resolve-pr's one read (call 1)
    // and flips to a closing keyword at the recheck's re-read (call 2), so a
    // title edited between the initial precheck and the recheck goes red.
    pullsCalls++;
    return Promise.resolve(json({
      number: PR, merged: false, merge_commit_sha: null, state: "open",
      base: { ref: "main", repo: { full_name: REPO, private: false } },
      head: { ref: "feature", sha: HEAD },
      title: titleFlipsOnRecheck && pullsCalls >= 2 ? "Fix #2" : "Docs update", body: "Readme tweak",
    }));
  }
  if (method === "GET" && /\/pulls\?state=open/.test(url)) {
    // #1215: listOpenPulls — the shared-head guard. Paged; an empty body means
    // no sibling PRs (guard stays green).
    openPullsCalls++;
    if (openPullsAlwaysThrows || (openPullsThrowsFirst && openPullsCalls === 1)) {
      return Promise.reject(new Error("boom 500"));
    }
    const headers: Record<string, string> = {};
    if (openPullsTruncated) {
      headers.link = '<https://api.github.com/repos/acme/example/pulls?state=open&per_page=100&page=2>; rel="next"';
    }
    return Promise.resolve(new Response(JSON.stringify(openPullsBody), { status: 200, headers }));
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
    statusPostCalls++;
    if (statusPostFailOn.has(statusPostCalls)) {
      return Promise.reject(new Error(`gate/verdict HTTP 503 (attempt ${statusPostCalls})`));
    }
    lastPostedStatus = init?.body === undefined ? undefined : (JSON.parse(init.body as string) as { state: string; description?: string });
    return Promise.resolve(json({}));
  }
  if (method === "GET" && /\/commits\/[0-9a-f]{40}\/statuses/.test(url)) {
    // #1226: postGateStatus's read-back confirmation — reflects whatever the
    // last successful POST above landed, so every pre-existing test's clean
    // single-attempt post still confirms and resolves. The per-context
    // statuses endpoint returns a plain array, empty when nothing posted.
    return Promise.resolve(json(
      lastPostedStatus === undefined ? [] : [{ context: GATE_STATUS_CONTEXT, ...lastPostedStatus }],
    ));
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
  openPullsCalls = 0;
  openPullsBody = [];
  openPullsThrowsFirst = false;
  openPullsAlwaysThrows = false;
  openPullsTruncated = false;
  titleFlipsOnRecheck = true;
  lastPostedStatus = undefined;
  statusPostCalls = 0;
  statusPostFailOn = new Set();
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

  // #1203/#1205: the success-path recheck (workflow.ts:290) fires only when
  // final.state === "success", reached after real legs run. The real
  // GateRunnerDO is container-backed and cannot boot under vitest-pool-workers,
  // so the test sets an inline fake GATE_RUNNER namespace (greenRunner above):
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
    // #1205: the inline fake answers every /run-leg green, no wrangler binding.
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];

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

      // The merge-tree leg was dispatched through the inline fake (the run path
      // touched GATE_RUNNER), and its success verdict is what carried the run
      // to the success recheck.
      const runLeg = recorded.find((r) => /\/run-leg/.test(r.url));
      expect(runLeg).toBeDefined();
      expect((runLeg!.body as { leg?: string }).leg).toBe("merge-tree");
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  it("a shared-head lookup 5xx followed by success ends green (retry, not false red) (#1214)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    // Clean precheck (no closing keyword), run path (pathRules match the compare),
    // and the title must stay clean through the success recheck so the run reaches
    // the verdict guard.
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];
    // The guard's first listOpenPulls throws 5xx; step.do retries and the
    // second call returns [] (no sibling PRs) -> guarded success.
    openPullsThrowsFirst = true;

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-guard-retry-green");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-guard-retry-green", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("success");
      // The guard threw once and was retried (a second call succeeded).
      expect(openPullsCalls).toBeGreaterThanOrEqual(2);

      const post = recorded.find((r) =>
        r.method === "POST" && /\/statuses\//.test(r.url) && (r.body as { state?: string }).state === "success");
      expect(post).toBeDefined();
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  it("a sibling PR with a different head sha is not a shared head (#1214 S3)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    // Clean precheck, run path, title stays clean through the success recheck.
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];
    // A sibling OPEN PR #8 with a DIFFERENT tip sha (stacked PR) and a different
    // base. Without the head-sha filter the guard falsely reports it as "shared
    // with PR #8"; the guard must keep only the gated head's own PRs -> green.
    openPullsBody = [{ number: 8, base: { ref: "staging" }, head: { sha: "c".repeat(40) }, state: "open" }];

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-guard-headsha-filter");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-guard-headsha-filter", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("success");
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  it("skip path: a sibling open PR on the same head with a different base fails both the post and the result (#1215)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = FLEET_JSON;
    titleFlipsOnRecheck = false;
    // The guard's own PR #7 (main) and a sibling open PR #8 on the SAME head sha
    // with a DIFFERENT base (staging): a shared head, red must win across both.
    openPullsBody = [
      { number: PR, head: { sha: HEAD }, base: { ref: "main" }, state: "open" },
      { number: 8, head: { sha: HEAD }, base: { ref: "staging" }, state: "open" },
    ];

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-guard-skip-shared");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-guard-skip-shared", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("failure");
      expect(out.description).toBe("head aaaaaaaa shared with PR #8");

      const post = recorded.find((r) =>
        r.method === "POST" && /\/statuses\//.test(r.url) && (r.body as { state?: string }).state === "failure");
      expect(post).toBeDefined();
      expect(post!.body).toEqual({
        state: "failure",
        context: GATE_STATUS_CONTEXT,
        description: "head aaaaaaaa shared with PR #8",
      });
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  it("verdict path: a sibling open PR on the same head with a different base fails both the post and the result (#1215)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];
    openPullsBody = [
      { number: PR, head: { sha: HEAD }, base: { ref: "main" }, state: "open" },
      { number: 8, head: { sha: HEAD }, base: { ref: "staging" }, state: "open" },
    ];

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-guard-verdict-shared");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-guard-verdict-shared", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("failure");
      expect(out.description).toBe("head aaaaaaaa shared with PR #8");

      const post = recorded.find((r) =>
        r.method === "POST" && /\/statuses\//.test(r.url) && (r.body as { state?: string }).state === "failure");
      expect(post).toBeDefined();
      expect(post!.body).toEqual({
        state: "failure",
        context: GATE_STATUS_CONTEXT,
        description: "head aaaaaaaa shared with PR #8",
      });
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  it("a listing error that never clears fails closed after the step retries (#1215)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];
    // listOpenPulls throws on EVERY call: step.do retries once, both throw, and
    // the .catch fails closed — a swallowed error must never read as green.
    openPullsAlwaysThrows = true;

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-guard-error-failclosed");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-guard-error-failclosed", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("failure");
      expect(out.description).toBe("gate: cannot list shared-head PRs");
      // Retried once: the first throw and the retry's throw both hit the endpoint.
      expect(openPullsCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  it("skip path: a listing error that never clears fails closed after the step retries (#1217)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = FLEET_JSON;
    titleFlipsOnRecheck = false;
    // #1217: listOpenPulls throws on EVERY call; the skip-path .catch must fail
    // closed, never swap a lookup error for a silent green (#1213 review).
    openPullsAlwaysThrows = true;

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-guard-skip-error");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-guard-skip-error", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("failure");
      expect(out.description).toBe("gate: cannot list shared-head PRs");

      const post = recorded.find((r) =>
        r.method === "POST" && /\/statuses\//.test(r.url) && (r.body as { state?: string }).state === "failure");
      expect(post).toBeDefined();
      expect(post!.body).toEqual({
        state: "failure",
        context: GATE_STATUS_CONTEXT,
        description: "gate: cannot list shared-head PRs",
      });
      // No leg ran: the SKIP path and its guard never touch GATE_RUNNER.
      const legCalls = recorded.filter((r) => /\/run-leg/.test(r.url));
      expect(legCalls).toEqual([]);
      // Retried once: the first throw and the retry's throw both hit the endpoint.
      expect(openPullsCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  it("a closed sibling is ignored, the run stays green (#1215)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];
    // A sibling #8 on the SAME head sha with a DIFFERENT base but CLOSED: the
    // open-state filter must ignore it — only an OPEN shared head is red.
    openPullsBody = [
      { number: PR, head: { sha: HEAD }, base: { ref: "main" }, state: "open" },
      { number: 8, head: { sha: HEAD }, base: { ref: "staging" }, state: "closed" },
    ];

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-guard-closed-sibling");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-guard-closed-sibling", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("success");
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  it("a truncated open-PR list fails closed (#1215 item 1)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];
    // Every page still offers a next Link, so listOpenPulls hits its page cap and
    // reports truncated — the guard must fail closed, never read a prefix green.
    openPullsTruncated = true;
    openPullsBody = [];

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-guard-truncated");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-guard-truncated", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; description?: string };
      expect(out.state).toBe("failure");
      expect(out.description).toBe("gate: cannot list shared-head PRs");
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  // #1230: a carryGreen matching this run's own head sha, base sha and plan
  // fingerprint skips dispatching the carried leg to GATE_RUNNER; only the
  // leg not already green is actually run.
  it("a carryGreen matching head/base/plan skips the carried leg's run-leg call; its result rides into the verdict (#1230)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON_TWO_LEGS;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];

    const instanceId = "gate-carry-match";
    const carryGreen = {
      headSha: HEAD, baseSha: BASE, planFingerprint: fixtureFingerprint(),
      legs: [{ leg: "merge-tree", state: "success" as const }],
    };

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, instanceId);
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: instanceId, params: { repo: REPO, pr: PR, carryGreen } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; baseSha?: string; planFingerprint?: string };
      expect(out.state).toBe("success");
      expect(out.baseSha).toBe(BASE);
      expect(out.planFingerprint).toBe(carryGreen.planFingerprint);

      // Only "typecheck" was dispatched: "merge-tree" rode in from the carry.
      const legCalls = recorded.filter((r) => /\/run-leg/.test(r.url));
      expect(legCalls.map((r) => (r.body as { leg?: string }).leg)).toEqual(["typecheck"]);
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  it("a carryGreen with a mismatched headSha is ignored: every leg runs fresh (#1230)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON_TWO_LEGS;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];

    const instanceId = "gate-carry-mismatch";
    const carryGreen = {
      headSha: "c".repeat(40), baseSha: BASE, planFingerprint: fixtureFingerprint(),
      legs: [{ leg: "merge-tree", state: "success" as const }],
    };

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, instanceId);
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: instanceId, params: { repo: REPO, pr: PR, carryGreen } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string };
      expect(out.state).toBe("success");

      const legCalls = recorded.filter((r) => /\/run-leg/.test(r.url));
      expect(legCalls.map((r) => (r.body as { leg?: string }).leg).sort()).toEqual(["merge-tree", "typecheck"]);
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  // #1230 maestro review: a carried green leg alongside a freshly-run red leg:
  // the verdict is still red. A carry that correctly matches head/base/plan
  // for "merge-tree" must not mask "typecheck" coming back red from its own
  // fresh run-leg dispatch — the two legs are aggregated independently
  // (aggregateVerdict is leg-keyed), so a carried success can never paper over
  // a sibling that genuinely failed this run.
  it("a carried green leg alongside a freshly-run red leg: the verdict is still red (#1230 maestro review)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON_TWO_LEGS;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = runnerGreenExcept("typecheck") as unknown as Env["GATE_RUNNER"];

    const instanceId = "gate-carry-match-sibling-red";
    const carryGreen = {
      headSha: HEAD, baseSha: BASE, planFingerprint: fixtureFingerprint(),
      legs: [{ leg: "merge-tree", state: "success" as const }],
    };

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, instanceId);
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: instanceId, params: { repo: REPO, pr: PR, carryGreen } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string };
      expect(out.state).not.toBe("success");
      expect(["failure", "error"]).toContain(out.state);

      // Only "typecheck" was dispatched fresh (a red leg retries once, so it
      // shows up twice): "merge-tree" never ran — it rode in from the carry.
      const legCalls = recorded.filter((r) => /\/run-leg/.test(r.url));
      expect(legCalls.map((r) => (r.body as { leg?: string }).leg)).toEqual(["typecheck", "typecheck"]);
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  // #1226: a verdict POST that fails on its first attempts (mocked 503s) must
  // still land through the REAL Workflows step engine's own retry
  // (STATUS_POST_STEP_CONFIG, not postGateStatus's own old 2x-immediate loop).
  // disableSleeps() bypasses the exponential backoff wait, the same pattern
  // already used above for the shared-head-guard's retried listOpenPulls.
  it("a verdict POST that fails twice then succeeds still lands, through the step engine's own retry (#1226)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];
    // Call 1 is the run-start "pending" post (must land clean so the run
    // proceeds); calls 2 and 3 are the verdict post's first two attempts,
    // mocked as a transient HTTP 503; call 4 is the verdict post's third
    // attempt, which succeeds.
    statusPostFailOn = new Set([2, 3]);

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-verdict-post-retry");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-verdict-post-retry", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string; statusPostFailed: boolean };
      expect(out.state).toBe("success");
      expect(out.statusPostFailed).toBe(false);
      // 1 pending post + 3 verdict-post attempts (2 failed, 1 landed).
      expect(statusPostCalls).toBe(4);
      expect(lastPostedStatus?.state).toBe("success");
    } finally {
      await instance.dispose();
    }
  }, 60_000);

  // #1226 review: the production bug was a step LOOKING successful when it
  // wasn't, so the scenario that most needs proving against the REAL engine
  // is the one where every attempt fails — not just the happy-retry path
  // above. STATUS_POST_STEP_CONFIG's 5 retries mean 6 real attempts (1
  // initial + 5 retries) all fail here, every one a mocked HTTP 503, and the
  // run must end up "errored" with the real HTTP-status cause visible on the
  // instance, never a "complete" instance whose outcome quietly says nothing
  // was posted. disableRetryDelays() (on top of disableSleeps(), used above)
  // bypasses step.do's own exponential backoff between attempts — without it
  // 5 real exponential-from-10s delays would need minutes, not seconds.
  it("a verdict POST that always fails exhausts the step engine's real retries and errors loudly, HTTP status visible (#1226)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];
    // Call 1 is the run-start "pending" post (must land clean so the run
    // proceeds to the verdict); every call from 2 onward is a verdict-post
    // attempt, and every one of them is mocked as a transient HTTP 503 — the
    // real step engine then exhausts all 5 of its own retries (6 attempts:
    // calls 2-7) and gives up.
    statusPostFailOn = new Set(Array.from({ length: 20 }, (_, i) => i + 2));

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-verdict-post-always-fails");
    try {
      await instance.modify(async (m) => {
        await m.disableSleeps();
        await m.disableRetryDelays();
      });
      await e.GATE_WORKFLOW.create({ id: "gate-verdict-post-always-fails", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("errored");

      const err = await instance.getError();
      expect(err.message).toContain("503");
      expect(err.message).toContain("gate/verdict POST failed");
      // 1 pending post (landed) + 6 verdict-post attempts (1 initial + 5
      // retries, all failed): the real engine ran the full retry budget, not
      // postGateStatus's own old 2x-immediate loop.
      expect(statusPostCalls).toBe(7);
    } finally {
      await instance.dispose();
    }
  }, 60_000);
});

// #1319: a run-path block with a vitest lane and a lane timeout, so a test can
// assert the vitest leg's /run-leg body carries the clamped timeoutMin.
const RUN_FLEET_JSON_VITEST_TIMEOUT = JSON.stringify({
  gate: { install: "bun install", legs: [], pathRules: ["docs/**"], vitestCmd: "bun test --shard={i}/{n}", vitestShards: 2, vitestTimeoutMin: 9 },
});

  // #1319: deleting workflow.ts's vitestTimeoutMin/bunTimeoutMin passthrough
  // (planFor) makes this red: the vitest legs' /run-leg bodies would carry no
  // timeoutMin. The lane timeout must reach the dispatched leg.
  it("a vitest lane timeout rides the /run-leg body of each vitest shard (#1319)", async () => {
    const e = workflowEnv();
    e.GITHUB_TOKEN = "github_pat_TESTONLY_not_real";
    e.GITHUB_REPO_AUTH = "";
    e.FLEET_OPS_REPO = "acme/ops";
    commitMessage = "clean";
    fleetJson = RUN_FLEET_JSON_VITEST_TIMEOUT;
    titleFlipsOnRecheck = false;
    e.GATE_RUNNER = greenRunner as unknown as Env["GATE_RUNNER"];

    const instance = await introspectWorkflowInstance(e.GATE_WORKFLOW, "gate-vitest-lane-timeout");
    try {
      await instance.modify(async (m) => { await m.disableSleeps(); });
      await e.GATE_WORKFLOW.create({ id: "gate-vitest-lane-timeout", params: { repo: REPO, pr: PR } });
      await instance.waitForStatus("complete");

      const out = await instance.getOutput() as { state: string };
      expect(out.state).toBe("success");

      const vitestCalls = recorded.filter((r) =>
        /\/run-leg/.test(r.url) && /^vitest-/.test((r.body as { leg?: string }).leg ?? ""));
      expect(vitestCalls).toHaveLength(2);
      for (const call of vitestCalls) {
        expect((call.body as { timeoutMin?: number }).timeoutMin).toBe(9);
      }
      // The merge-tree leg carries no lane timeout.
      const merge = recorded.find((r) => /\/run-leg/.test(r.url) && (r.body as { leg?: string }).leg === "merge-tree");
      expect(merge).toBeDefined();
      expect((merge!.body as { timeoutMin?: number }).timeoutMin).toBeUndefined();
    } finally {
      await instance.dispose();
    }
  }, 60_000);
