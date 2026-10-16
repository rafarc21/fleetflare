// #1072 (refs #715): the gate's auto-run on a pull_request delivery. A gated
// PR's push starts one gate run per head sha; a manual `fleet gate run` of that
// sha reuses it; drafts, other actions and ungated repos start nothing. #1082:
// a new head sha ends the still-live run of the sha it replaces. The
// GATE_WORKFLOW binding, the PR's run index and the fleet.json reader are fakes
// at the boundary; the decisions themselves are pure.
import { describe, it, expect } from "bun:test";
import {
  autoRunPullRequest, gateRunId, pullRequestAutoRun, startGateRun, startManualGateRun,
  type GateRunIndex, type GateRunInstance, type GateRunRecord, type GateRunStarter, type PullRequestAutoRun,
} from "../../src/gate/auto-run";
import type { FleetJsonReader } from "../../src/gate/load-config";

const FLEET = "acme/fleet";
const PR_REPO = "acme/example";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const THIRD = "c".repeat(40);
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
 *  that already exists throws, and get() throws for an unknown id. Each run
 *  carries a status the test sets; terminate() moves it to "terminated" and is
 *  logged, the way the binding's instance handle would end it. */
function fakeWorkflow(opts: { createError?: Error; terminateError?: Error } = {}) {
  const runs = new Map<string, { params: unknown; status: string }>();
  const creates: { id?: string; params: unknown }[] = [];
  const terminated: string[] = [];
  const instance = (id: string): GateRunInstance => ({
    async status() { return { status: runs.get(id)!.status }; },
    async terminate() {
      if (opts.terminateError) throw opts.terminateError;
      terminated.push(id);
      runs.get(id)!.status = "terminated";
    },
  });
  const wf: GateRunStarter = {
    async create(create) {
      creates.push(create);
      if (opts.createError) throw opts.createError;
      if (create.id !== undefined && runs.has(create.id)) throw new Error(`instance ${create.id} already exists`);
      const id = create.id ?? `anon-${runs.size + 1}`;
      runs.set(id, { params: create.params, status: "running" });
      return { id };
    },
    async get(id) {
      if (!runs.has(id)) throw new Error(`instance ${id} not found`);
      return instance(id);
    },
  };
  return { wf, runs, creates, terminated };
}

/** The per-PR run index in memory: the latest run recorded for each repo#pr. */
function fakeIndex() {
  const heads = new Map<string, GateRunRecord>();
  const index: GateRunIndex = {
    async latest(repo, pr) { return heads.get(`${repo}#${pr}`) ?? null; },
    async record(repo, pr, run) { heads.set(`${repo}#${pr}`, run); },
  };
  return { index, heads };
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
    const { index } = fakeIndex();
    const out = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(out).toEqual({ runId: await gateRunId(PR_REPO, HEAD), reused: false, supersededRunId: undefined });
    expect(creates).toEqual([{ id: out.runId, params: { repo: PR_REPO, pr: 7 } }]);
    expect(runs.size).toBe(1);
  });

  it("a second start for the same sha reuses the run and creates nothing new", async () => {
    const { wf, runs, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    const second = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(second).toEqual({ runId: first.runId, reused: true });
    expect(runs.size).toBe(1);
    expect(terminated).toEqual([]);
  });

  it("a new head sha starts a new run", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    const next = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: BASE }, index);
    expect(next.reused).toBe(false);
    expect(runs.size).toBe(2);
  });

  it("a create that fails for any reason but an existing id rethrows that error", async () => {
    const { wf } = fakeWorkflow({ createError: new Error("workflow quota exceeded") });
    const { index } = fakeIndex();
    await expect(startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index)).rejects.toThrow("workflow quota exceeded");
  });
});

describe("startGateRun: a new head sha ends the still-live run of the sha it replaces (#1082)", () => {
  it("a synchronize ends the previous sha's running run and starts the new one", async () => {
    const { wf, runs, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    const second = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: BASE }, index);
    expect(second).toEqual({ runId: await gateRunId(PR_REPO, BASE), reused: false, supersededRunId: first.runId });
    expect(terminated).toEqual([first.runId]);
    expect(runs.get(first.runId)!.status).toBe("terminated");
    expect(runs.get(second.runId)!.status).toBe("running");
  });

  it("a previous run that already finished is left alone", async () => {
    const { wf, runs, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    runs.get(first.runId)!.status = "complete";
    const second = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: BASE }, index);
    expect(second.supersededRunId).toBeUndefined();
    expect(terminated).toEqual([]);
    expect(runs.get(first.runId)!.status).toBe("complete");
  });

  it("only the previous run ends: a third sha ends the second, each older run ends once", async () => {
    const { wf, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    const second = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: BASE }, index);
    await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: THIRD }, index);
    expect(terminated).toEqual([first.runId, second.runId]);
  });

  it("a re-start of the current sha ends nothing, the run it reuses is still the PR's latest", async () => {
    const { wf, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: BASE }, index);
    await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: BASE }, index);
    expect(terminated).toHaveLength(1);
  });

  it("a terminate that fails does not block the new run, and reports no superseded run", async () => {
    const { wf, runs } = fakeWorkflow({ terminateError: new Error("instance busy") });
    const { index } = fakeIndex();
    await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    const second = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: BASE }, index);
    expect(second.reused).toBe(false);
    expect(second.supersededRunId).toBeUndefined();
    expect(runs.size).toBe(2);
  });

  it("a PR's runs are kept apart: another PR's run is never ended", async () => {
    const { wf, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    await startGateRun(wf, { repo: PR_REPO, pr: 8, headSha: BASE }, index);
    expect(terminated).toEqual([]);
  });
});

// #1085 (refs #715): a manual start (`fleet gate run`, /studio/gate/start)
// reattaches ONLY to a live run of the sha. A finished run of that sha gets a
// fresh instance under a new id, so a rerun after base drift or an infra flake
// is possible without a new push. The auto-run on push keeps dedupe-by-sha.
describe("startManualGateRun: reattach to a live run, start fresh after a finished one (#1085)", () => {
  const T1 = 1_700_000_000_000;
  const T2 = T1 + 60_000;
  const LIVE_STATUSES = ["queued", "running", "paused", "waiting"];
  const FINISHED_STATUSES = ["complete", "errored", "terminated"];

  it("the first manual start creates the run under the sha's id, like the auto-run", async () => {
    const { wf, creates } = fakeWorkflow();
    const { index } = fakeIndex();
    const out = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    expect(out).toEqual({ runId: await gateRunId(PR_REPO, HEAD), reused: false, supersededRunId: undefined });
    expect(creates).toEqual([{ id: out.runId, params: { repo: PR_REPO, pr: 7 } }]);
  });

  for (const status of LIVE_STATUSES) {
    it(`a start while the sha's run is ${status} reattaches: creates nothing, reused`, async () => {
      const { wf, runs, creates } = fakeWorkflow();
      const { index } = fakeIndex();
      const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
      runs.get(first.runId)!.status = status;
      const second = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T2);
      expect(second).toEqual({ runId: first.runId, reused: true });
      expect(creates).toHaveLength(1);
    });
  }

  for (const status of FINISHED_STATUSES) {
    it(`a start after the sha's run is ${status} starts a fresh run under a new id, not the cached one`, async () => {
      const { wf, runs, creates } = fakeWorkflow();
      const { index } = fakeIndex();
      const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
      runs.get(first.runId)!.status = status;
      const fresh = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T2);
      const expectedId = `${first.runId}-r${T2.toString(36)}`;
      expect(fresh).toEqual({ runId: expectedId, reused: false, supersededRunId: undefined });
      expect(creates.at(-1)).toEqual({ id: expectedId, params: { repo: PR_REPO, pr: 7 } });
      expect(runs.get(expectedId)!.status).toBe("running");
    });
  }

  it("the fresh run is recorded as the PR's latest, so the next manual start reattaches to it", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index, heads } = fakeIndex();
    const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    runs.get(first.runId)!.status = "complete";
    const fresh = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T2);
    expect(heads.get(`${PR_REPO}#7`)).toEqual({ headSha: HEAD, runId: fresh.runId });
    const again = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T2 + 1);
    expect(again).toEqual({ runId: fresh.runId, reused: true });
  });

  it("a rerun after a finished one gets a new id each time: the second fresh run is not the first", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    runs.get(first.runId)!.status = "complete";
    const second = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T2);
    runs.get(second.runId)!.status = "errored";
    const third = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T2 + 1);
    expect(new Set([first.runId, second.runId, third.runId]).size).toBe(3);
    expect(runs.size).toBe(3);
  });

  it("a finished run of the sha, superseded by a newer sha, still gets a fresh run for the old sha", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    runs.get(first.runId)!.status = "complete";
    await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: BASE }, index, () => T1);
    const rerun = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T2);
    expect(rerun.reused).toBe(false);
    expect(rerun.runId).toBe(`${first.runId}-r${T2.toString(36)}`);
  });

  it("a create that fails for any reason but an existing id rethrows, and nothing is recorded", async () => {
    const { wf } = fakeWorkflow({ createError: new Error("workflow quota exceeded") });
    const { index, heads } = fakeIndex();
    await expect(startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1))
      .rejects.toThrow("workflow quota exceeded");
    expect(heads.size).toBe(0);
  });

  it("the auto-run on push still reuses a finished run of the same sha (dedupe-by-sha unchanged)", async () => {
    const { wf, runs, creates } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    runs.get(first.runId)!.status = "complete";
    const again = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(again).toEqual({ runId: first.runId, reused: true });
    expect(creates).toHaveLength(2);
    expect(runs.size).toBe(1);
  });
});

describe("autoRunPullRequest: only a gated base starts a run", () => {
  it("a base with no gate block anywhere starts nothing", async () => {
    const { wf, creates } = fakeWorkflow();
    const { index } = fakeIndex();
    const out = await autoRunPullRequest(PR, {
      fleetRepo: FLEET, readFleetJson: reader({ [`${FLEET}@HEAD`]: { gates: {} } }), workflow: wf, index,
    });
    expect(out).toBe("no-gate-block");
    expect(creates).toHaveLength(0);
  });

  it("a PR repo whose base carries a gate block starts one run", async () => {
    const { wf, creates } = fakeWorkflow();
    const { index } = fakeIndex();
    const out = await autoRunPullRequest(PR, {
      fleetRepo: FLEET,
      readFleetJson: reader({
        [`${FLEET}@HEAD`]: { gates: {} },
        [`${PR_REPO}@${BASE}`]: { gate: BLOCK },
      }),
      workflow: wf,
      index,
    });
    expect(out).toBe("started");
    expect(creates).toEqual([{ id: await gateRunId(PR_REPO, HEAD), params: { repo: PR_REPO, pr: 7 } }]);
  });

  it("the same head sha seen twice starts one run, the second reports reused", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    const deps = {
      fleetRepo: FLEET,
      readFleetJson: reader({ [`${FLEET}@HEAD`]: { gates: {} }, [`${PR_REPO}@${BASE}`]: { gate: BLOCK } }),
      workflow: wf,
      index,
    };
    expect(await autoRunPullRequest(PR, deps)).toBe("started");
    expect(await autoRunPullRequest(PR, deps)).toBe("reused");
    expect(runs.size).toBe(1);
  });

  it("a synchronize on a gated PR ends the run of the sha it replaces (#1082)", async () => {
    const { wf, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const deps = {
      fleetRepo: FLEET,
      readFleetJson: reader({ [`${FLEET}@HEAD`]: { gates: {} }, [`${PR_REPO}@${BASE}`]: { gate: BLOCK } }),
      workflow: wf,
      index,
    };
    await autoRunPullRequest(PR, deps);
    const out = await autoRunPullRequest({ ...PR, headSha: THIRD }, deps);
    expect(out).toBe("started");
    expect(terminated).toEqual([await gateRunId(PR_REPO, HEAD)]);
  });

  it("an ungated base ends nothing: the gate block check runs before any supersede", async () => {
    const { wf, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const deps = {
      fleetRepo: FLEET,
      readFleetJson: reader({ [`${FLEET}@HEAD`]: { gates: {} }, [`${PR_REPO}@${BASE}`]: { gate: BLOCK } }),
      workflow: wf,
      index,
    };
    await autoRunPullRequest(PR, deps);
    const ungated = { ...deps, readFleetJson: reader({ [`${FLEET}@HEAD`]: { gates: {} } }) };
    expect(await autoRunPullRequest({ ...PR, headSha: THIRD }, ungated)).toBe("no-gate-block");
    expect(terminated).toEqual([]);
  });
});
