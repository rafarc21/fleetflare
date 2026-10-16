// #1088 (refs #715): the gate posts gate/verdict = pending when a run starts,
// and the post helper never lets a failed POST block the run. Both are pure
// enough to pin with fakes: the Workflow's own step wiring is not unit-testable
// (workflow.ts imports cloudflare:workers), so the decisions live here.
import { describe, it, expect } from "bun:test";
import { pendingStatusArgs } from "../../src/gate/fanout";
import { postGateStatus, type StatusPort } from "../../src/gate/status-post";

const RUN_ID = "0123456789abcdef";

interface Call { token: string; repo: string; sha: string; state: string; context: string; description: string }

/** A StatusPort whose POSTs fail on the attempt numbers listed in `failOn`. */
function fakePort(failOn: number[] = [], mintFails = false) {
  const calls: Call[] = [];
  let attempts = 0;
  const port: StatusPort = {
    async mintToken(repo) {
      if (mintFails) throw new Error(`mint ${repo} failed`);
      return "tok";
    },
    async postCommitStatus(token, repo, sha, state, context, description) {
      attempts++;
      if (failOn.includes(attempts)) throw new Error(`POST attempt ${attempts} failed`);
      calls.push({ token, repo, sha, state, context, description });
    },
  };
  return { port, calls, attempts: () => attempts };
}

const SHA = "a".repeat(40);

describe("pendingStatusArgs: the run-start status", () => {
  it("reads 'running (run <id8>) — <n> legs' in state pending", () => {
    expect(pendingStatusArgs(RUN_ID, 3)).toEqual({
      state: "pending", description: "running (run 01234567) — 3 legs",
    });
  });
});

describe("postGateStatus: post with one retry, never throws", () => {
  it("one successful POST: posts gate/verdict on the sha and reports no failure", async () => {
    const { port, calls } = fakePort();
    const failed = await postGateStatus(port, "acme/app", SHA, { state: "pending", description: "d" });
    expect(failed).toBe(false);
    expect(calls).toEqual([{ token: "tok", repo: "acme/app", sha: SHA, state: "pending", context: "gate/verdict", description: "d" }]);
  });

  it("first POST fails, second succeeds: retried once, not reported as failed", async () => {
    const { port, calls, attempts } = fakePort([1]);
    const failed = await postGateStatus(port, "acme/app", SHA, { state: "success", description: "ok" });
    expect(failed).toBe(false);
    expect(attempts()).toBe(2);
    expect(calls.length).toBe(1);
  });

  it("both POSTs fail: returns true (statusPostFailed) and does not throw", async () => {
    const { port, attempts } = fakePort([1, 2]);
    const failed = await postGateStatus(port, "acme/app", SHA, { state: "pending", description: "d" });
    expect(failed).toBe(true);
    expect(attempts()).toBe(2);
  });

  it("token mint failure is caught like a POST failure: never throws", async () => {
    const { port } = fakePort([], true);
    const failed = await postGateStatus(port, "acme/app", SHA, { state: "pending", description: "d" });
    expect(failed).toBe(true);
  });
});
