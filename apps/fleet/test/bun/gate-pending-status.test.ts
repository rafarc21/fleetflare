// #1088 (refs #715): the gate posts gate/verdict = pending when a run starts.
// #1226: postGateStatus no longer swallows a failed POST — it confirms the
// post landed by reading gate/verdict back, and THROWS (carrying the real
// cause) when it cannot confirm. Callers wrap this in step.do with
// STATUS_POST_STEP_CONFIG, so Workflows' own retry (never this file) is what
// retries a failed post. Both are pure enough to pin with fakes: the
// Workflow's own step wiring is not unit-testable (workflow.ts imports
// cloudflare:workers), so the decisions live here.
import { describe, it, expect } from "bun:test";
import { pendingStatusArgs } from "../../src/gate/fanout";
import { postGateStatus, RateLimitedStatusError, STATUS_POST_STEP_CONFIG, type StatusPort } from "../../src/gate/status-post";

const RUN_ID = "0123456789abcdef";
const SHA = "a".repeat(40);

interface Call { token: string; repo: string; sha: string; state: string; context: string; description: string }

/** A StatusPort whose postCommitStatus and getCommitStatus are both
 *  independently scripted, so a test can pin "POST failed but landed
 *  anyway" and "POST succeeded but never confirmed" separately. */
function fakePort(opts: {
  postError?: Error;
  landed?: { state: string; description?: string } | undefined;
  mintFails?: boolean;
} = {}) {
  const calls: Call[] = [];
  let postAttempts = 0;
  const port: StatusPort = {
    async mintToken(repo) {
      if (opts.mintFails) throw new Error(`mint ${repo} failed`);
      return "tok";
    },
    async postCommitStatus(token, repo, sha, state, context, description) {
      postAttempts++;
      if (opts.postError) throw opts.postError;
      calls.push({ token, repo, sha, state, context, description });
    },
    async getCommitStatus() {
      return opts.landed;
    },
  };
  return { port, calls, postAttempts: () => postAttempts };
}

/** Mirrors Workflows' own step retry (same shape as gate-leg-run.test.ts's
 *  and gate-infra-rerun.test.ts's fakeStep()): calls fn, and on a throw
 *  retries until config.retries.limit attempts are spent. */
function fakeStep() {
  return {
    do: async <T>(_name: string, config: typeof STATUS_POST_STEP_CONFIG, fn: () => Promise<T>): Promise<T> => {
      const limit = config.retries.limit;
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (attempt >= limit) throw err;
        }
      }
    },
  };
}

describe("pendingStatusArgs: the run-start status", () => {
  it("reads 'running (run <full id>) — <n> legs' in state pending (#1144)", () => {
    expect(pendingStatusArgs(RUN_ID, 3)).toEqual({
      state: "pending", description: `running (run ${RUN_ID}) — 3 legs`,
    });
  });
});

describe("postGateStatus: one attempt, confirmed by reading the status back (#1226)", () => {
  it("a clean POST whose read-back matches resolves", async () => {
    const { port, calls } = fakePort({ landed: { state: "pending", description: "d" } });
    await expect(postGateStatus(port, "acme/app", SHA, { state: "pending", description: "d" })).resolves.toBeUndefined();
    expect(calls).toEqual([{ token: "tok", repo: "acme/app", sha: SHA, state: "pending", context: "gate/verdict", description: "d" }]);
  });

  it("the POST itself throws, but the read-back confirms it landed anyway: resolves (recovery path)", async () => {
    const { port } = fakePort({
      postError: new Error("ECONNRESET"),
      landed: { state: "success", description: "ok" },
    });
    await expect(postGateStatus(port, "acme/app", SHA, { state: "success", description: "ok" })).resolves.toBeUndefined();
  });

  it("the POST succeeds (2xx) but the read-back shows something else: throws on the mismatch (a false-positive 2xx)", async () => {
    const { port } = fakePort({ landed: { state: "pending", description: "stale" } });
    await expect(postGateStatus(port, "acme/app", SHA, { state: "success", description: "ok" }))
      .rejects.toThrow(/did not match/);
  });

  it("the POST succeeds but there is no status at all yet (read-back undefined): throws", async () => {
    const { port } = fakePort({ landed: undefined });
    await expect(postGateStatus(port, "acme/app", SHA, { state: "success", description: "ok" }))
      .rejects.toThrow(/did not match/);
  });

  it("the POST throws and the read-back never confirms: throws with the ORIGINAL post error's message (real HTTP detail, not a generic string)", async () => {
    const { port } = fakePort({ postError: new Error("gate/verdict HTTP 503"), landed: undefined });
    await expect(postGateStatus(port, "acme/app", SHA, { state: "pending", description: "d" }))
      .rejects.toThrow(/503/);
  });

  it("a token mint failure propagates (never swallowed into a boolean)", async () => {
    const { port } = fakePort({ mintFails: true });
    await expect(postGateStatus(port, "acme/app", SHA, { state: "pending", description: "d" }))
      .rejects.toThrow(/mint acme\/app failed/);
  });

  it("a rate-limited POST throws RateLimitedStatusError, distinct from a plain failure (#1276)", async () => {
    const { port } = fakePort({ postError: new Error("gate/verdict HTTP 403: API rate limit exceeded for installation"), landed: undefined });
    await expect(postGateStatus(port, "acme/app", SHA, { state: "failure", description: "d" }))
      .rejects.toThrow(/rate limited/);
    await expect(postGateStatus(port, "acme/app", SHA, { state: "failure", description: "d" }))
      .rejects.toBeInstanceOf(RateLimitedStatusError);
  });
});

describe("postGateStatus retried by Workflows' own step.do with STATUS_POST_STEP_CONFIG (#1226)", () => {
  it("fails twice then succeeds: the verdict lands, matching the step's own retry, not this file's", async () => {
    const step = fakeStep();
    let call = 0;
    const port: StatusPort = {
      mintToken: async () => "tok",
      postCommitStatus: async () => {
        call++;
        if (call <= 2) throw new Error(`HTTP 503 attempt ${call}`);
      },
      getCommitStatus: async () => call > 2 ? { state: "success", description: "ok" } : undefined,
    };
    await step.do("post-verdict", STATUS_POST_STEP_CONFIG, () =>
      postGateStatus(port, "acme/app", SHA, { state: "success", description: "ok" }));
    expect(call).toBe(3);
  });

  it("always failing: once the step's retries are exhausted, the final thrown error still carries the real HTTP-status detail", async () => {
    const step = fakeStep();
    const port: StatusPort = {
      mintToken: async () => "tok",
      postCommitStatus: async () => { throw new Error("gate/verdict HTTP 503"); },
      getCommitStatus: async () => undefined,
    };
    await expect(step.do("post-verdict", STATUS_POST_STEP_CONFIG, () =>
      postGateStatus(port, "acme/app", SHA, { state: "success", description: "ok" })))
      .rejects.toThrow(/503/);
  });
});
