// #1385: the env wiring behind the supersede status post. auto-run.ts stays
// free of Worker bindings, so the real postSuperseded/isCurrentHead callbacks
// live in auto-run-env.ts (supersededPost -> postGateStatus, currentHeadCheck ->
// getPullRequestHeadSha, fail-closed). These tests drive autoRunFromEnv and
// drainPendingGateRuns against a fake GATE_WORKFLOW and the real D1 index, and
// spy the github module namespace the way index.test.ts does, so the real
// status-post path runs and the supersede verdict on the OLD head is asserted
// at the boundary.
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import * as githubApiModule from "../src/github/api";
import * as githubAuthModule from "../src/github/auth";
import { autoRunFromEnv, drainPendingGateRuns, d1RunIndex } from "../src/gate/auto-run-env";
import { gateRunId, type PullRequestAutoRun } from "../src/gate/auto-run";
import { gateDrainQueue } from "../src/gate/drain";
import type { Env } from "../src/env";

const REPO = "acme/example";
const OLD_HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);

/** A GATE_WORKFLOW that owns one live run (the old head) and otherwise starts
 *  fresh. terminate() marks the old run terminated, like the real binding. */
function workflowWith(ids: { oldRunId: string }) {
  const terminated: string[] = [];
  const create = vi.fn(async (opts: { id?: string }) => ({ id: opts.id ?? "anon" }));
  const get = vi.fn(async (id: string) => {
    if (id === ids.oldRunId) {
      return {
        status: async () => ({ status: terminated.includes(id) ? "terminated" : "running" }),
        terminate: async () => { terminated.push(id); },
      };
    }
    throw new Error(`instance ${id} not found`);
  });
  return { create, get, terminated };
}

function fakeEnv(workflow: { create: unknown; get: unknown }): Env {
  return {
    FLEET_GATE_RUNNER: "on",
    DB: env.DB,
    GATE_WORKFLOW: workflow,
  } as unknown as Env;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("autoRunFromEnv: the supersede status post on the old head (#1385)", () => {
  it("a new head posts error 'superseded by <new head short>' on the old head via the real status port", async () => {
    const oldRunId = await gateRunId(REPO, OLD_HEAD);
    const workflow = workflowWith({ oldRunId });
    // Pre-record the live old run, then the delivery for the new head supersedes it.
    await d1RunIndex(env.DB).record(REPO, 1, { headSha: OLD_HEAD, runId: oldRunId, progressedAt: Date.now() });

    vi.spyOn(githubAuthModule, "repoTokenMinter").mockReturnValue(async () => "glue-test-token");
    const postSpy = vi.spyOn(githubApiModule, "postCommitStatus").mockResolvedValue(undefined);
    // Read-back confirms the post landed, so postGateStatus resolves.
    vi.spyOn(githubApiModule, "getCommitContextStatus").mockImplementation(async (_t, _r, sha) =>
      sha === OLD_HEAD ? { state: "error", description: `superseded by ${NEW_HEAD.slice(0, 8)}` } : undefined);
    // currentHeadCheck reads the PR's live head: the new head is current.
    vi.spyOn(githubApiModule, "getPullRequestHeadSha").mockResolvedValue(NEW_HEAD);

    const pr: PullRequestAutoRun = { repo: REPO, pr: 1, headSha: NEW_HEAD, baseSha: "c".repeat(40) };
    await autoRunFromEnv(fakeEnv(workflow), pr);

    expect(workflow.terminated).toEqual([oldRunId]);
    expect(postSpy).toHaveBeenCalledWith(
      "glue-test-token", REPO, OLD_HEAD, "error", "gate/verdict", `superseded by ${NEW_HEAD.slice(0, 8)}`, undefined,
    );
  });

  it("an out-of-order delivery whose head is no longer current posts nothing", async () => {
    const oldRunId = await gateRunId(REPO, OLD_HEAD);
    const workflow = workflowWith({ oldRunId });
    await d1RunIndex(env.DB).record(REPO, 2, { headSha: OLD_HEAD, runId: oldRunId, progressedAt: Date.now() });

    vi.spyOn(githubAuthModule, "repoTokenMinter").mockReturnValue(async () => "glue-test-token");
    const postSpy = vi.spyOn(githubApiModule, "postCommitStatus").mockResolvedValue(undefined);
    vi.spyOn(githubApiModule, "getCommitContextStatus").mockResolvedValue(undefined);
    // The PR's live head is already NEW_HEAD+1: this delivery's head is stale.
    vi.spyOn(githubApiModule, "getPullRequestHeadSha").mockResolvedValue("c".repeat(40));

    const pr: PullRequestAutoRun = { repo: REPO, pr: 2, headSha: NEW_HEAD, baseSha: "d".repeat(40) };
    await autoRunFromEnv(fakeEnv(workflow), pr);

    expect(workflow.terminated).toEqual([oldRunId]);
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe("drainPendingGateRuns: the supersede status post on the old head (#1385)", () => {
  it("a queued new-head PR released from the drain posts the supersede verdict on the old head", async () => {
    const oldRunId = await gateRunId(REPO, OLD_HEAD);
    const workflow = workflowWith({ oldRunId });
    await d1RunIndex(env.DB).record(REPO, 3, { headSha: OLD_HEAD, runId: oldRunId, progressedAt: Date.now() });

    vi.spyOn(githubAuthModule, "repoTokenMinter").mockReturnValue(async () => "glue-test-token");
    const postSpy = vi.spyOn(githubApiModule, "postCommitStatus").mockResolvedValue(undefined);
    vi.spyOn(githubApiModule, "getCommitContextStatus").mockImplementation(async (_t, _r, sha) =>
      sha === OLD_HEAD ? { state: "error", description: `superseded by ${NEW_HEAD.slice(0, 8)}` } : undefined);
    vi.spyOn(githubApiModule, "getPullRequestHeadSha").mockResolvedValue(NEW_HEAD);

    const queued: PullRequestAutoRun = { repo: REPO, pr: 3, headSha: NEW_HEAD, baseSha: "e".repeat(40) };
    await gateDrainQueue(env.DB).append(queued);
    await drainPendingGateRuns(fakeEnv(workflow));

    expect(workflow.terminated).toEqual([oldRunId]);
    expect(postSpy).toHaveBeenCalledWith(
      "glue-test-token", REPO, OLD_HEAD, "error", "gate/verdict", `superseded by ${NEW_HEAD.slice(0, 8)}`, undefined,
    );
  });
});