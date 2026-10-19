// #1072 (refs #715): the gate's auto-run on a pull_request delivery. A gated
// PR's push starts one gate run per (pr, head sha); a manual `fleet gate run` of that
// sha reuses it; drafts, other actions and ungated repos start nothing. #1082:
// a new head sha ends the still-live run of the sha it replaces. The
// GATE_WORKFLOW binding and the PR's run index are fakes at the boundary; the
// decisions themselves are pure.
import { describe, it, expect } from "bun:test";
import { MAX_LEG_TIMEOUT_MIN } from "../../src/gate/config";
import { legStepDeadlineMs } from "../../src/gate/leg-run";
import {
  autoRunPullRequest, gateRunId, GATE_STALL_MS, markRunProgress, pullRequestAutoRun, startGateRun, startManualGateRun, startEditedGateRun,
  type GateRunIndex, type GateRunInstance, type GateRunRecord, type GateRunStarter, type PullRequestAutoRun,
} from "../../src/gate/auto-run";
import type { CarryGreen } from "../../src/gate/fanout";

const PR_REPO = "acme/example";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const THIRD = "c".repeat(40);
const BLOCK = { install: "bun install", legs: ["lint"], pathRules: ["src/**"] };
const ON = { FLEET_GATE_RUNNER: "on", GATE_RUNNER_REPOS: PR_REPO };

function payload(over: { action?: string; draft?: boolean; repo?: string; changes?: { title?: unknown; body?: unknown; base?: unknown } } = {}): string {
  return JSON.stringify({
    action: over.action ?? "opened",
    number: 7,
    repository: { full_name: over.repo ?? PR_REPO },
    ...(over.changes === undefined ? {} : { changes: over.changes }),
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

/** The per-PR run index in memory: the latest run recorded for each repo#pr.
 *  progress() and handOff() follow the D1 store's rules: progress only moves
 *  the pointed run, and a handoff only lands while the pointer still names `from`. */
function fakeIndex() {
  const heads = new Map<string, GateRunRecord>();
  const index: GateRunIndex = {
    async latest(repo, pr) { return heads.get(`${repo}#${pr}`) ?? null; },
    async record(repo, pr, run) { heads.set(`${repo}#${pr}`, run); },
    async progress(repo, pr, runId, at) {
      const cur = heads.get(`${repo}#${pr}`);
      if (cur?.runId === runId) heads.set(`${repo}#${pr}`, { ...cur, progressedAt: at });
    },
    async handOff(repo, pr, from, run) {
      const cur = heads.get(`${repo}#${pr}`);
      if (cur?.runId !== from) return false;
      heads.set(`${repo}#${pr}`, run);
      return true;
    },
  };
  return { index, heads };
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
    for (const action of ["closed", "labeled", "converted_to_draft"]) {
      expect(pullRequestAutoRun(payload({ action }), ON)).toBeNull();
    }
  });

  it("a reopen starts a run (round 2 item 2)", () => {
    expect(pullRequestAutoRun(payload({ action: "reopened" }), ON)).toEqual({ ...PR, reopened: true });
  });

  it("a base change fires with edited:true and the same head sha (round 2 item 2)", () => {
    const out = pullRequestAutoRun(payload({ action: "edited", changes: { base: { from: "main" } } }), ON);
    expect(out).toEqual({ ...PR, edited: true });
  });

  it("an edit of the title fires with edited:true and the same head sha", () => {
    const out = pullRequestAutoRun(payload({ action: "edited", changes: { title: { from: "old" } } }), ON);
    expect(out).toEqual({ ...PR, edited: true });
  });

  it("an edit of the body fires with edited:true", () => {
    const out = pullRequestAutoRun(payload({ action: "edited", changes: { body: { from: "old" } } }), ON);
    expect(out).toEqual({ ...PR, edited: true });
  });

  it("an edit with neither a title nor a body change starts nothing", () => {
    expect(pullRequestAutoRun(payload({ action: "edited", changes: {} }), ON)).toBeNull();
    expect(pullRequestAutoRun(payload({ action: "edited" }), ON)).toBeNull();
  });

  it("a non-edit action still carries no edited flag", () => {
    expect(pullRequestAutoRun(payload({ action: "synchronize" }), ON)).toEqual(PR);
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

  it("a run under this head owned by the same PR (pointer names the head) still reuses", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    const second = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(second).toEqual({ runId: first.runId, reused: true });
    expect(runs.size).toBe(1);
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
    expect(heads.get(`${PR_REPO}#7`)).toMatchObject({ headSha: HEAD, runId: fresh.runId });
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

// #1230: `fleet gate run --failed-only` passes carryGreen in. That must
// always take the fresh-start path, never reattach to a live run of the same
// head sha: a failed-only rerun is an explicit request to re-test specific
// legs, and reusing a stale live run would silently ignore it.
describe("startManualGateRun: carryGreen always starts fresh, never reattaches (#1230)", () => {
  const T1 = 1_700_000_000_000;
  const T2 = T1 + 60_000;
  const CARRY: CarryGreen = {
    headSha: HEAD, baseSha: BASE, configHash: "fp-1", legs: [{ leg: "merge-tree", state: "success" }],
  };

  it("a live run of the same head sha is not reattached to; a fresh -r run starts, carrying carryGreen", async () => {
    const { wf, runs, creates } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    expect(runs.get(first.runId)!.status).toBe("running");
    const second = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD, carryGreen: CARRY }, index, () => T2);
    const expectedId = `${first.runId}-r${T2.toString(36)}`;
    // The still-live first run is superseded: a fresh run starts (never a
    // reattach), and the old one is ended the same way any superseded run is.
    expect(second).toEqual({ runId: expectedId, reused: false, supersededRunId: first.runId });
    expect(creates.at(-1)).toEqual({ id: expectedId, params: { repo: PR_REPO, pr: 7, carryGreen: CARRY } });
  });

  it("no live run at all still starts fresh (the base id), carrying carryGreen", async () => {
    const { wf, creates } = fakeWorkflow();
    const { index } = fakeIndex();
    const out = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD, carryGreen: CARRY }, index, () => T1);
    expect(out).toEqual({ runId: `${await gateRunId(PR_REPO, HEAD)}-r${T1.toString(36)}`, reused: false, supersededRunId: undefined });
    expect(creates.at(-1)).toEqual({ id: out.runId, params: { repo: PR_REPO, pr: 7, carryGreen: CARRY } });
  });

  it("no carryGreen -> params carry no carryGreen key at all (unchanged shape)", async () => {
    const { wf, creates } = fakeWorkflow();
    const { index } = fakeIndex();
    await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    expect(creates[0].params).toEqual({ repo: PR_REPO, pr: 7 });
  });
});

// #1132 (refs #715): auto-run does not read the base's gate config. It starts a
// run for every gated PR, and the Workflow decides: a base with no gate block
// gets a visible failure on the head (gate-config.test.ts), a head that adds
// fleet.json (#1091) gets its legs. One decision point, so auto-run and a manual
// start can never disagree.
describe("startManualGateRun: a live run with no progress is hung, so it is ended and never reattached (#1135)", () => {
  const T1 = 1_700_000_000_000;

  it("the gate's stall window is longer than one leg attempt (the default leg's step deadline + retry delay), so a healthy run is never ended", () => {
    expect(GATE_STALL_MS).toBeGreaterThan(legStepDeadlineMs(MAX_LEG_TIMEOUT_MIN) + 15_000);
    expect(GATE_STALL_MS).toBeGreaterThan(legStepDeadlineMs(undefined) + 15_000);
  });

  it("a live run with no progress for the stall window is ended, and a fresh run starts under a new id", async () => {
    const { wf, runs, creates, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    runs.get(first.runId)!.status = "running";
    const second = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1 + GATE_STALL_MS);
    expect(terminated).toEqual([first.runId]);
    expect(second.reused).toBe(false);
    expect(second.runId).not.toBe(first.runId);
    expect(creates).toHaveLength(2);
  });

  it("a progress touch inside the window keeps the live run: the manual start reattaches to it", async () => {
    const { wf, creates, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    await markRunProgress(index, PR_REPO, 7, first.runId, T1 + GATE_STALL_MS - 60_000);
    const second = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1 + GATE_STALL_MS);
    expect(second).toEqual({ runId: first.runId, reused: true });
    expect(terminated).toEqual([]);
    expect(creates).toHaveLength(1);
  });

  it("markRunProgress never throws: a failed progress write must not fail the leg that reports it", async () => {
    const failing = { ...fakeIndex().index, progress: async () => { throw new Error("D1 down"); } };
    await expect(markRunProgress(failing, PR_REPO, 7, "gate-x", T1)).resolves.toBeUndefined();
  });

  it("a run the sweep retired (progressedAt -1) is ended and a fresh run starts, never reattached (#1196 C)", async () => {
    const { wf, creates, terminated } = fakeWorkflow();
    const { index, heads } = fakeIndex();
    const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    // A switched-off repo's sweep retired the run: the pointer still names it with the -1 retire stamp.
    heads.set(`${PR_REPO}#7`, { headSha: HEAD, runId: first.runId, progressedAt: -1 });
    const second = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1 + 60_000);
    expect(terminated).toEqual([first.runId]);
    expect(second.reused).toBe(false);
    expect(second.runId).not.toBe(first.runId);
    expect(creates).toHaveLength(2);
  });
});

describe("startManualGateRun: the manual start's edges around a live run (#1148 items 2, 3 and the handoff race)", () => {
  const T1 = 1_700_000_000_000;

  it("a stalled run that will not terminate throws: no second live run is started on the head (#1148 item 2)", async () => {
    const { wf, creates } = fakeWorkflow({ terminateError: new Error("DO down") });
    const { index } = fakeIndex();
    const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    await expect(startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1 + GATE_STALL_MS))
      .rejects.toThrow("DO down");
    expect(creates.map((c) => c.id)).toEqual([first.runId]);
  });

  it("a live run of the sha that the pointer does not name is untracked: its progress is unknown, so it is ended and a fresh run starts (#1148 item 2)", async () => {
    const { wf, runs, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    // A live run of the sha with no pointer row (the row was lost, or never written).
    await wf.create({ id: await gateRunId(PR_REPO, HEAD), params: { repo: PR_REPO, pr: 7 } });
    const second = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    expect(terminated).toEqual([await gateRunId(PR_REPO, HEAD)]);
    expect(second.reused).toBe(false);
    expect(second.runId).not.toBe(await gateRunId(PR_REPO, HEAD));
    expect(runs.get(second.runId)?.status).toBe("running");
  });

  it("a live run with progressedAt 0 (the deploy window's unknown stamp) is reattached, not ended, however old it looks (#1148 item 3)", async () => {
    const { wf, creates, terminated } = fakeWorkflow();
    const { index, heads } = fakeIndex();
    const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => 0);
    heads.set(`${PR_REPO}#7`, { headSha: HEAD, runId: first.runId, progressedAt: 0 });
    const second = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1 + 200 * 60_000);
    expect(second).toEqual({ runId: first.runId, reused: true });
    expect(terminated).toEqual([]);
    expect(creates).toHaveLength(1);
  });

  it("a stalled run whose pointer moved to an infra rerun during the end is reattached to that rerun: the rerun is never ended (handoff race)", async () => {
    const { wf, terminated, creates } = fakeWorkflow();
    const { index, heads } = fakeIndex();
    const stalled = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    // The stalled run's own infra rerun is created and takes the pointer while the stall is being ended.
    const rerunId = `rerun-${stalled.runId}`;
    await wf.create({ id: rerunId, params: { repo: PR_REPO, pr: 7 } });
    let reads = 0;
    const racing: GateRunIndex = {
      ...index,
      async latest(repo, pr) {
        reads++;
        return reads === 1
          ? { headSha: HEAD, runId: stalled.runId, progressedAt: T1 }
          : { headSha: HEAD, runId: rerunId, progressedAt: T1 + GATE_STALL_MS };
      },
    };
    heads.set(`${PR_REPO}#7`, { headSha: HEAD, runId: rerunId, progressedAt: T1 + GATE_STALL_MS });
    const second = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, racing, () => T1 + GATE_STALL_MS);
    expect(second).toEqual({ runId: rerunId, reused: true });
    expect(terminated).toEqual([stalled.runId]);
    expect(creates.map((c) => c.id)).toEqual([stalled.runId, rerunId]);
  });
});

describe("startManualGateRun: a transient status failure never ends a healthy run (#1150 review item 4)", () => {
  const T1 = 1_700_000_000_000;

  it("the pointer's own live run whose first status read fails is reattached, not ended", async () => {
    const { wf, creates, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startManualGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    let failNext = true;
    const flaky: GateRunStarter = {
      create: wf.create,
      get: async (id) => {
        if (failNext) { failNext = false; throw new Error("D1 hiccup"); }
        return wf.get(id);
      },
    };
    const second = await startManualGateRun(flaky, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1 + 60_000);
    expect(second).toEqual({ runId: first.runId, reused: true });
    expect(terminated).toEqual([]);
    // The fall-through's create is the duplicate attempt on the same id; nothing new starts.
    expect(creates.map((c) => c.id)).toEqual([first.runId, first.runId]);
  });
});

describe("startEditedGateRun: an edit re-runs under its own -e id (#1176)", () => {
  const T1 = 1_700_000_000_000;

  it("starts under a fresh id suffixed -e<base36 time>, and records it as the PR's latest", async () => {
    const { wf, creates } = fakeWorkflow();
    const { index, heads } = fakeIndex();
    const out = await startEditedGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    const baseId = await gateRunId(PR_REPO, HEAD);
    expect(out).toEqual({ runId: `${baseId}-e${T1.toString(36)}`, reused: false });
    expect(creates).toEqual([{ id: `${baseId}-e${T1.toString(36)}`, params: { repo: PR_REPO, pr: 7 } }]);
    expect(heads.get(`${PR_REPO}#7`)).toMatchObject({ headSha: HEAD, runId: `${baseId}-e${T1.toString(36)}` });
  });

  it("calls postPending exactly once, before the edited run is created (#1191)", async () => {
    const { wf, creates } = fakeWorkflow();
    const { index } = fakeIndex();
    const log: string[] = [];
    const wrapped: GateRunStarter = {
      create: async (opts) => { log.push("create"); return wf.create(opts); },
      get: (id) => wf.get(id),
    };
    await startEditedGateRun(wrapped, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1, async (repo, headSha) => {
      log.push(`pending:${repo}:${headSha}`);
    });
    expect(log).toEqual([`pending:${PR_REPO}:${HEAD}`, "create"]);
    expect(creates).toHaveLength(1);
  });

  it("ends a live plain-sha run of the same head before creating the edited run (#1191)", async () => {
    const { wf, terminated, creates } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(first.runId).toBe(await gateRunId(PR_REPO, HEAD));
    const baseId = await gateRunId(PR_REPO, HEAD);
    const out = await startEditedGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    expect(terminated).toEqual([baseId]);
    // The edited run is created only after the plain run was ended.
    expect(creates.at(-1)).toEqual({ id: out.runId, params: { repo: PR_REPO, pr: 7 } });
    expect(out.runId).not.toBe(baseId);
  });

  it("does not end a plain-sha run that is not live (#1191)", async () => {
    const { wf, runs, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    runs.get(first.runId)!.status = "complete";
    await startEditedGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    expect(terminated).toEqual([]);
    expect(runs.get(first.runId)!.status).toBe("complete");
  });

  it("ends every live run of the sha — a prior -e run and the plain run — before creating the new one (#1203)", async () => {
    const { wf, runs, terminated } = fakeWorkflow();
    const baseId = await gateRunId(PR_REPO, HEAD);
    const eOldId = `${baseId}-eOLD`;
    // Two live runs gate the same head sha: the plain-sha run and an earlier
    // -e run the index still records as this PR's latest. Both are stale gates
    // of the pre-edit title/body once a new edit arrives.
    await wf.create({ id: baseId, params: { repo: PR_REPO, pr: 7 } });
    await wf.create({ id: eOldId, params: { repo: PR_REPO, pr: 7 } });
    const { index, heads } = fakeIndex();
    heads.set(`${PR_REPO}#7`, { headSha: HEAD, runId: eOldId, progressedAt: T1 });
    const out = await startEditedGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    expect(terminated).toEqual([baseId, eOldId]);
    expect(runs.get(baseId)!.status).toBe("terminated");
    expect(runs.get(eOldId)!.status).toBe("terminated");
    // Only the new -e run stays live.
    expect(runs.get(out.runId)!.status).toBe("running");
  });

  it("a recorded latest of a different head sha is not ended by an edit (#1203)", async () => {
    const { wf, runs, terminated } = fakeWorkflow();
    const baseId = await gateRunId(PR_REPO, HEAD);
    const otherShaRunId = `gate-other`;
    await wf.create({ id: baseId, params: { repo: PR_REPO, pr: 7 } });
    await wf.create({ id: otherShaRunId, params: { repo: PR_REPO, pr: 7 } });
    const { index, heads } = fakeIndex();
    heads.set(`${PR_REPO}#7`, { headSha: BASE, runId: otherShaRunId, progressedAt: T1 });
    await startEditedGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    expect(terminated).toEqual([baseId]);
    expect(runs.get(otherShaRunId)!.status).toBe("running");
  });
});

describe("autoRunPullRequest: every gated PR starts a run; the Workflow decides (#1132)", () => {
  it("a base with no gate block still starts one run, so the Workflow can post the visible failure", async () => {
    const { wf, creates } = fakeWorkflow();
    const { index } = fakeIndex();
    expect(await autoRunPullRequest(PR, { workflow: wf, index })).toBe("started");
    expect(creates).toEqual([{ id: await gateRunId(PR_REPO, HEAD), params: { repo: PR_REPO, pr: 7 } }]);
  });

  it("the same head sha seen twice starts one run, the second reports reused", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    expect(await autoRunPullRequest(PR, { workflow: wf, index })).toBe("started");
    expect(await autoRunPullRequest(PR, { workflow: wf, index })).toBe("reused");
    expect(runs.size).toBe(1);
  });

  it("a synchronize on a gated PR ends the run of the sha it replaces (#1082)", async () => {
    const { wf, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const deps = { workflow: wf, index };
    await autoRunPullRequest(PR, deps);
    expect(await autoRunPullRequest({ ...PR, headSha: THIRD }, deps)).toBe("started");
    expect(terminated).toEqual([await gateRunId(PR_REPO, HEAD)]);
  });

  it("a PR into an ungated base still supersedes the previous sha's run: the new run gets the visible failure", async () => {
    const { wf, terminated } = fakeWorkflow();
    const { index } = fakeIndex();
    const deps = { workflow: wf, index };
    await autoRunPullRequest(PR, deps);
    expect(await autoRunPullRequest({ ...PR, headSha: THIRD }, deps)).toBe("started");
    expect(terminated).toEqual([await gateRunId(PR_REPO, HEAD)]);
  });
});

describe("startGateRun: a shared head sha does not inherit another PR's verdict (#1172)", () => {
  it("a run under this head owned by another PR starts a fresh -p<pr> run, never a reuse", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    // Another PR (#8) opened first with this head: its run owns the (repo, sha) id.
    await startGateRun(wf, { repo: PR_REPO, pr: 8, headSha: HEAD }, index);
    const foreignRunId = await gateRunId(PR_REPO, HEAD);
    expect(runs.get(foreignRunId)!.status).toBe("running");
    // This PR (#7) shares the head but has no pointer of its own.
    const out = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(out.reused).toBe(false);
    expect(out.runId).not.toBe(foreignRunId);
    expect(out.runId).toBe(`${foreignRunId}-p7`);
    expect(runs.size).toBe(2);
  });

  it("one live run per (pr, sha): a second start reuses the fresh run, never a third instance", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    await startGateRun(wf, { repo: PR_REPO, pr: 8, headSha: HEAD }, index);
    const fresh = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    const again = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(fresh.reused).toBe(false);
    expect(again).toEqual({ runId: fresh.runId, reused: true });
    expect(runs.size).toBe(2);
  });

  it("a fresh run already live under the PR's deterministic id is reused, never a third instance (concurrent first-starts)", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    await startGateRun(wf, { repo: PR_REPO, pr: 8, headSha: HEAD }, index);
    const freshId = `${await gateRunId(PR_REPO, HEAD)}-p7`;
    // A concurrent first-start of PR 7 already created the deterministic fresh id.
    await wf.create({ id: freshId, params: { repo: PR_REPO, pr: 7 } });
    const out = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(out).toEqual({ runId: freshId, reused: true });
    expect(runs.size).toBe(2);
  });
});

describe("startGateRun: pending-first + live-only reuse of the -p run (round 2)", () => {
  const T1 = 1_700_000_000_000;

  it("posts pending BEFORE the fresh -p<pr> create, exactly once (round 2 item 1)", async () => {
    const { wf } = fakeWorkflow();
    const { index } = fakeIndex();
    await startGateRun(wf, { repo: PR_REPO, pr: 8, headSha: HEAD }, index);
    const log: string[] = [];
    const wrapped: GateRunStarter = {
      create: async (opts) => {
        if (opts.id !== undefined && opts.id.endsWith("-p7")) log.push(`create:${opts.id}`);
        return wf.create(opts);
      },
      get: (id) => wf.get(id),
    };
    const out = await startGateRun(wrapped, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1,
      async (repo, headSha) => { log.push(`pending:${repo}:${headSha}`); });
    expect(out.runId).toBe(`${await gateRunId(PR_REPO, HEAD)}-p7`);
    // pending fires before the -p7 create, and never before the foreign sha-id create (which already threw).
    expect(log).toEqual([`pending:${PR_REPO}:${HEAD}`, `create:${out.runId}`]);
  });

  it("reuses a LIVE -p<pr> run, never a third instance (round 2 item 1)", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    await startGateRun(wf, { repo: PR_REPO, pr: 8, headSha: HEAD }, index);
    const fresh = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(fresh.reused).toBe(false);
    const again = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(again).toEqual({ runId: fresh.runId, reused: true });
    expect(runs.size).toBe(2);
  });

  it("a FINISHED -p<pr> run starts a fresh -p<pr>-r<time>, never reused (round 2 item 1)", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    await startGateRun(wf, { repo: PR_REPO, pr: 8, headSha: HEAD }, index);
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    runs.get(first.runId)!.status = "complete"; // finished
    const again = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    expect(again.reused).toBe(false);
    expect(again.runId).toBe(`${first.runId}-r${T1.toString(36)}`);
    expect(runs.size).toBe(3);
  });

  it("a recorded latest for a DIFFERENT head is not reused when the sha id is foreign (kills latest !== null mutant)", async () => {
    const { wf } = fakeWorkflow();
    const { index } = fakeIndex();
    // PR 7's latest points at BASE.
    await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: BASE }, index);
    // PR 8 owns the HEAD sha id.
    await startGateRun(wf, { repo: PR_REPO, pr: 8, headSha: HEAD }, index);
    // PR 7 pushes HEAD (shared with PR 8): fresh -p7, never BASE's run.
    const out = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(out.reused).toBe(false);
    expect(out.runId).toBe(`${await gateRunId(PR_REPO, HEAD)}-p7`);
  });

  it("the fresh -p<pr> run is recorded as the PR's latest (kills dropped recordRun mutant)", async () => {
    const { wf } = fakeWorkflow();
    const { index, heads } = fakeIndex();
    await startGateRun(wf, { repo: PR_REPO, pr: 8, headSha: HEAD }, index);
    const out = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    expect(heads.get(`${PR_REPO}#7`)).toMatchObject({ headSha: HEAD, runId: out.runId });
  });

  it("a reopen never reuses a finished base-id run: it starts a fresh run (S1)", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    runs.get(first.runId)!.status = "complete"; // prior verdict finished
    const again = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD, reopened: true }, index, () => T1);
    expect(again.reused).toBe(false);
    expect(again.runId).not.toBe(first.runId);
    expect(runs.size).toBe(2);
  });

  it("a reopen with a still-live base-id run also starts fresh (S1)", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    // still live
    const again = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD, reopened: true }, index, () => T1);
    expect(again.reused).toBe(false);
    expect(again.runId).not.toBe(first.runId);
    expect(runs.get(first.runId)!.status).toBe("terminated"); // recordRun ends the superseded live run
  });

  it("a reopen with a still-live -p<pr> run also starts fresh, never reuses it (S1 -p path)", async () => {
    const { wf, runs } = fakeWorkflow();
    const { index } = fakeIndex();
    // PR 8 owns the HEAD base-id run; PR 7's -p7 run is still live.
    await startGateRun(wf, { repo: PR_REPO, pr: 8, headSha: HEAD }, index);
    const first = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD }, index);
    // PR 7 reopens after its base moved: it must NOT reuse the live -p7 run.
    const again = await startGateRun(wf, { repo: PR_REPO, pr: 7, headSha: HEAD, reopened: true }, index, () => T1);
    expect(again.reused).toBe(false);
    expect(again.runId).toBe(`${first.runId}-r${T1.toString(36)}`);
    expect(runs.get(first.runId)!.status).toBe("terminated"); // recordRun ends the superseded live -p7
    expect(runs.size).toBe(3);
  });
});

describe("startManualGateRun: one transient status read never ends a healthy run (#1148 review, LOW 4)", () => {
  const T1 = 1_700_000_000_000;

  it("a status read that fails once while the pointer names the live, unstalled run reattaches to it; nothing is ended", async () => {
    const { wf, terminated, creates } = fakeWorkflow();
    const { index, heads } = fakeIndex();
    const baseId = await gateRunId(PR_REPO, HEAD);
    await wf.create({ id: baseId, params: { repo: PR_REPO, pr: 7 } });
    heads.set(`${PR_REPO}#7`, { headSha: HEAD, runId: baseId, progressedAt: T1 - 60_000 });
    // The first status read of the run fails once: the start must not read that as "not live" and end it.
    let blips = 1;
    const flaky: GateRunStarter = {
      create: (opts) => wf.create(opts),
      async get(id) {
        if (id === baseId && blips-- > 0) throw new Error("status blip");
        return wf.get(id);
      },
    };
    const started = await startManualGateRun(flaky, { repo: PR_REPO, pr: 7, headSha: HEAD }, index, () => T1);
    expect(started).toEqual({ runId: baseId, reused: true });
    expect(terminated).toEqual([]);
    // The setup create, then the start's create under the same id, which the engine refuses.
    expect(creates.map((c) => c.id)).toEqual([baseId, baseId]);
  });
});
