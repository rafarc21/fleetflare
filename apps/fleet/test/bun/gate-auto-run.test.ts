// #1072 (refs #715): the gate's auto-run on a pull_request delivery. A gated
// PR's push starts one gate run per head sha; a manual `fleet gate run` of that
// sha reuses it; drafts, other actions and ungated repos start nothing. The
// GATE_WORKFLOW binding and the fleet.json reader are fakes at the boundary;
// the decisions themselves are pure.
import { describe, it, expect } from "bun:test";
import {
  autoRunPullRequest, gateRunId, pullRequestAutoRun, startGateRun, type GateRunStarter, type PullRequestAutoRun,
} from "../../src/gate/auto-run";
import type { FleetJsonReader } from "../../src/gate/load-config";

const FLEET = "acme/fleet";
const PR_REPO = "acme/example";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BLOCK = { install: "bun install", legs: ["lint"], pathRules: ["src/**"] };
const ON = { FLEET_GATE_RUNNER: "on", GATE_RUNNER_REPOS: PR_REPO };

function payload(over: { action?: string; draft?: boolean; repo?: string } = {}): string {
  return JSON.stringify({
    action: over.action ?? "opened",
    number: 7,
    repository: { full_name: over.repo ?? PR_REPO },
    pull_request: { number: 7, draft: over.draft ?? false, head: { sha: HEAD }, base: { sha: BASE, ref: "main" } },
  });
}

const PR: PullRequestAutoRun = { repo: PR_REPO, pr: 7, headSha: HEAD, baseSha: BASE };

/** A GATE_WORKFLOW fake with Workflows' duplicate-id rule: a create under an id
 *  that already exists throws, and get() throws for an unknown id. */
function fakeWorkflow(createError?: Error) {
  const runs = new Map<string, { params: unknown }>();
  const creates: { id?: string; params: unknown }[] = [];
  const wf: GateRunStarter = {
    async create(opts) {
      creates.push(opts);
      if (createError) throw createError;
      if (opts.id !== undefined && runs.has(opts.id)) throw new Error(`instance ${opts.id} already exists`);
      const id = opts.id ?? `anon-${runs.size + 1}`;
      runs.set(id, { params: opts.params });
      return { id };
    },
    async get(id) {
      if (!runs.has(id)) throw new Error(`instance ${id} not found`);
      return {};
    },
  };
  return { wf, runs, creates };
}

/** A fleet.json reader over an in-memory repo map. A missing file reads null. */
function reader(files: Record<string, unknown>): FleetJsonReader {
  return async (repo, ref) => files[`${repo}@${ref}`] ?? null;
}

describe("pullRequestAutoRun: which deliveries start a run", () => {
  it("opened, synchronize and ready_for_review on a gated repo -> the PR's repo, number and both shas", () => {
    for (const action of ["opened", "synchronize", "ready_for_review"]) {
      expect(pullRequestAutoRun(payload({ action }), ON)).toEqual(PR);
    }
  });

  it("a draft PR starts nothing, on any of the three actions", () => {
    expect(pullRequestAutoRun(payload({ action: "opened", draft: true }), ON)).toBeNull();
    expect(pullRequestAutoRun(payload({ action: "synchronize", draft: true }), ON)).toBeNull();
  });

  it("any other action starts nothing", () => {
    for (const action of ["closed", "edited", "labeled", "reopened", "converted_to_draft"]) {
      expect(pullRequestAutoRun(payload({ action }), ON)).toBeNull();
    }
  });

  it("a repo outside GATE_RUNNER_REPOS starts nothing", () => {
    expect(pullRequestAutoRun(payload({ repo: "acme/other" }), ON)).toBeNull();
  });

  it("the gate runner off starts nothing, even for a listed repo", () => {
    expect(pullRequestAutoRun(payload(), { FLEET_GATE_RUNNER: "off", GATE_RUNNER_REPOS: PR_REPO })).toBeNull();
  });

  it("a body that is not JSON, or has no head sha, starts nothing", () => {
    expect(pullRequestAutoRun("not json", ON)).toBeNull();
    const noHead = JSON.stringify({
      action: "opened", repository: { full_name: PR_REPO }, pull_request: { number: 7, base: { sha: BASE } },
    });
    expect(pullRequestAutoRun(noHead, ON)).toBeNull();
  });
});

describe("gateRunId: one instance id per repo and head sha", () => {
  it("is deterministic for a repo and sha", async () => {
    expect(await gateRunId(PR_REPO, HEAD)).toBe(await gateRunId(PR_REPO, HEAD));
  });

  it("differs by head sha and by repo", async () => {
    expect(await gateRunId(PR_REPO, HEAD)).not.toBe(await gateRunId(PR_REPO, BASE));
    expect(await gateRunId("acme/one", HEAD)).not.toBe(await gateRunId("acme/two", HEAD));
  });

  it("matches the repo case-insensitively, like the gate config does", async () => {
    expect(await gateRunId("Acme/Example", HEAD)).toBe(await gateRunId(PR_REPO, HEAD));
  });

  it("is a valid Workflows instance id: <= 100 chars of [A-Za-z0-9_-]", async () => {
    expect(await gateRunId(PR_REPO, HEAD)).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
  });

  it("rejects a head that is not a 40-hex sha", async () => {
    await expect(gateRunId(PR_REPO, "not-a-sha")).rejects.toThrow();
  });
});

describe("startGateRun: a second start for the same sha reuses the first run", () => {
  it("the first start creates the run under the sha's id", async () => {
    const { wf, creates, runs } = fakeWorkflow();
    const out = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD });
    expect(out).toEqual({ runId: await gateRunId(PR_REPO, HEAD), reused: false });
    expect(creates).toEqual([{ id: out.runId, params: { repo: PR_REPO, pr: 7 } }]);
    expect(runs.size).toBe(1);
  });

  it("a second start for the same sha reuses the run and creates nothing new", async () => {
    const { wf, runs } = fakeWorkflow();
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD });
    const second = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD });
    expect(second).toEqual({ runId: first.runId, reused: true });
    expect(runs.size).toBe(1);
  });

  it("a new head sha starts a new run", async () => {
    const { wf, runs } = fakeWorkflow();
    await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD });
    const next = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: BASE });
    expect(next.reused).toBe(false);
    expect(runs.size).toBe(2);
  });

  it("a create that fails for any reason but an existing id rethrows that error", async () => {
    const { wf } = fakeWorkflow(new Error("workflow quota exceeded"));
    await expect(startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD })).rejects.toThrow("workflow quota exceeded");
  });
});

describe("autoRunPullRequest: only a gated base starts a run", () => {
  it("a base with no gate block anywhere starts nothing", async () => {
    const { wf, creates } = fakeWorkflow();
    const out = await autoRunPullRequest(PR, {
      fleetRepo: FLEET, readFleetJson: reader({ [`${FLEET}@HEAD`]: { gates: {} } }), workflow: wf,
    });
    expect(out).toBe("no-gate-block");
    expect(creates).toHaveLength(0);
  });

  it("a PR repo whose base carries a gate block starts one run", async () => {
    const { wf, creates } = fakeWorkflow();
    const out = await autoRunPullRequest(PR, {
      fleetRepo: FLEET,
      readFleetJson: reader({
        [`${FLEET}@HEAD`]: { gates: {} },
        [`${PR_REPO}@${BASE}`]: { gate: BLOCK },
      }),
      workflow: wf,
    });
    expect(out).toBe("started");
    expect(creates).toEqual([{ id: await gateRunId(PR_REPO, HEAD), params: { repo: PR_REPO, pr: 7 } }]);
  });

  it("the same head sha seen twice starts one run, the second reports reused", async () => {
    const { wf, runs } = fakeWorkflow();
    const deps = {
      fleetRepo: FLEET,
      readFleetJson: reader({ [`${FLEET}@HEAD`]: { gates: {} }, [`${PR_REPO}@${BASE}`]: { gate: BLOCK } }),
      workflow: wf,
    };
    expect(await autoRunPullRequest(PR, deps)).toBe("started");
    expect(await autoRunPullRequest(PR, deps)).toBe("reused");
    expect(runs.size).toBe(1);
  });
});
