// #1119: a run whose failures are ALL infra-class (Workflows internal error, a
// lost connection, a container that never answered) re-runs itself once on the
// same head. A second infra-only run is a final error. Pure: the infra
// classifier, the rerun decision, the rerun's pending status and the per-leg
// step deadline (no orphan step holds the run open).
import { describe, it, expect } from "bun:test";
import {
  announceInfraRerun, infraRerunDecision, isInfraLegFailure, isRerunInstance, launchInfraRerun, recordInfraRerun,
  rerunInstanceId, rerunStarted, rerunStatusArgs, startInfraRerun, statusFollowingRerun,
} from "../../src/gate/infra-rerun";
import { runLegStep, withStepDeadline, type LegStepConfig } from "../../src/gate/leg-run";
import type { PlannedLeg } from "../../src/gate/fanout";
import type { LegResult } from "../../src/gate/verdict";

const PLANNED: PlannedLeg = {
  leg: "lint", commit: "abc", installCmd: "bun install", legCmd: "bun run lint",
  resultKey: "gate/o/r/runs/1/i/shard-lint.json", baselineKeys: [],
};

function fakeStep() {
  return {
    do: async (_name: string, config: LegStepConfig, fn: (ctx: { attempt: number; step: { name: string; count: number } }) => Promise<LegResult>): Promise<LegResult> => {
      const limit = config.retries.limit;
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn({ attempt: attempt + 1, step: { name: _name, count: 1 } });
        } catch (err) {
          if (attempt >= limit) throw err;
        }
      }
    },
  };
}

const INFRA = "Attempt failed due to internal workflows error";
const HEAD = "a".repeat(40);
const NEWER = "c".repeat(40);

describe("isInfraLegFailure: which leg errors are infra-class (#1119)", () => {
  it.each([
    `lint: ${INFRA} after 1 min`,
    "lint: Network connection lost. after 4 min",
    "lint: gate container exited mid-leg after 0 min",
    "gate container did not start within 180 s",
    "gate container failed: boom",
    "gate server unreachable: ECONNREFUSED",
    "lint: gate server HTTP 500",
    "lint exceeded 25 min without a result",
    // #1284: combineCauses cuts the deadline cause's "a result" tail, so the
    // classifier matches the prefix that survives truncation.
    "lint exceeded 8 min without …",
    "lint: gate capacity: no container instance available",
    "lint: no progress past its deadline after 35 min",
    "lint: HTTP 503 after 0 min",
    "lint: Execution timed out after 30 min",
    "lint: The operation was aborted due to timeout after 28 min",
    "lint: checkout failed: fatal: remote end hung up after 2 min",
    "lint: clone failed: fatal: remote-curl: bad line length character: UNKNO after 1 min",
    // #1283: a GitHub 429 surfaced by the git proxy or the checkout's lazy fetch.
    "lint: checkout failed: fatal: unable to access 'http://git-proxy.internal/o/r.git/': The requested URL returned error: 429 after 0 min",
    "lint: HTTP 429 after 0 min",
    // #1321: a container the platform SIGTERM/SIGKILL'd reports "exited 143/137";
    // the kill is infra, never the code under test, whatever prefix rides on it.
    "lint: exited 143 after 0 min",
    "result read from R2 after transport loss: lint exited 137",
  ])("infra: %s", (description) => {
    expect(isInfraLegFailure({ leg: "lint", state: "error", description })).toBe(true);
  });

  it.each([
    "lint 3 errors",
    "install failed: bun exit 1",
    "clone failed: fetch-pack",
    "private clone token unavailable",
    "gate image not bound (images.gate)",
    "lint: returned an unknown state",
  ])("not infra: %s", (description) => {
    expect(isInfraLegFailure({ leg: "lint", state: "error", description })).toBe(false);
  });

  it("a leg whose first attempt was red is not infra, even when its retry lost the connection (redFirst)", () => {
    // The shape runLegStep really returns: the retry's own error, flagged redFirst.
    const description = "lint: Network connection lost. after 0 min";
    expect(isInfraLegFailure({ leg: "lint", state: "error", description, redFirst: true })).toBe(false);
    expect(isInfraLegFailure({ leg: "lint", state: "error", description })).toBe(true);
  });

  it("a red test or a pass is never infra", () => {
    expect(isInfraLegFailure({ leg: "lint", state: "failure", description: "Network connection lost." })).toBe(false);
    expect(isInfraLegFailure({ leg: "lint", state: "success" })).toBe(false);
  });
});

describe("infraRerunDecision: one auto-rerun for an all-infra run (#1119)", () => {
  const infra = (leg: string): LegResult => ({ leg, state: "error", description: `${leg}: ${INFRA} after 1 min` });

  it("every failing leg is infra on a first run: re-run once", () => {
    expect(infraRerunDecision([infra("lint"), infra("test")], undefined)).toBe(true);
  });

  it("mixed: a real red leg with an infra leg does not re-run", () => {
    const red: LegResult = { leg: "test", state: "failure", description: "test 2 failed" };
    expect(infraRerunDecision([infra("lint"), red], undefined)).toBe(false);
  });

  it("mixed: a non-infra error with an infra error does not re-run", () => {
    const other: LegResult = { leg: "test", state: "error", description: "private clone token unavailable" };
    expect(infraRerunDecision([infra("lint"), other], undefined)).toBe(false);
  });

  it("a second infra-only run is final: no re-run of a re-run", () => {
    expect(infraRerunDecision([infra("lint")], "run-first")).toBe(false);
  });

  it("a run with no error leg has nothing to re-run", () => {
    expect(infraRerunDecision([{ leg: "lint", state: "success" }], undefined)).toBe(false);
  });
});

describe("rerunStatusArgs: the status a re-running run posts instead of an error verdict (#1119)", () => {
  it("is pending, with the rerun phrase and the run's full id (#1144)", () => {
    expect(rerunStatusArgs("1234567890abcdef")).toEqual({
      state: "pending", description: "rerun after infra error (run 1234567890abcdef)",
    });
  });
});

describe("withStepDeadline: a leg step with no progress past its deadline ends cleanly (#1119)", () => {
  it("resolves with the work's value when the work finishes first", async () => {
    expect(await withStepDeadline(Promise.resolve(7), 1_000, "late")).toBe(7);
  });

  it("rejects with the message once the deadline passes", async () => {
    const hang = new Promise<number>(() => {});
    await expect(withStepDeadline(hang, 5, "lint: no progress past its deadline")).rejects.toThrow("no progress past its deadline");
  });
});

describe("runLegStep: a hung dispatch ends the step at its deadline, as infra (#1119)", () => {
  it("a dispatch that never answers becomes an infra error the run can read, not an open step", async () => {
    const step = fakeStep();
    const dispatch = () => new Promise<Response>(() => {});
    const result = await runLegStep(step, dispatch, PLANNED, { stepDeadlineMs: 5 });
    expect(result.state).toBe("error");
    expect(result.description).toContain("no progress past its deadline");
    expect(isInfraLegFailure({ leg: "lint", state: result.state, description: result.description })).toBe(true);
  });
});

describe("runLegStep: a red first try with an infra retry is flagged redFirst, never infra (#1119 review)", () => {
  it("the retry's infra error comes back redFirst, so the run does not auto-rerun on it", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      if (sent === 1) return new Response(JSON.stringify({ state: "failure", description: "lint 3 errors" }));
      throw new Error("Network connection lost.");
    };
    const result = await runLegStep(step, dispatch, PLANNED, {});
    expect(result).toMatchObject({ leg: "lint", state: "error", redFirst: true });
    expect(isInfraLegFailure(result)).toBe(false);
  });
});

describe("startInfraRerun: a replayed start is success, not a failed rerun (#1119, #1135 item 1)", () => {
  const noInstance = async () => { throw new Error("no such instance"); };

  it("a create that resolves starts the rerun", async () => {
    expect(await startInfraRerun(async () => ({ id: "rerun-x" }), noInstance)).toBe(true);
  });

  it("a create that throws but whose instance exists (a replayed step) is success, whatever the error text", async () => {
    // Miniflare and the live binding word a duplicate differently: the instance itself is the signal.
    let looked = 0;
    const get = async () => { looked++; return { id: "rerun-x" }; };
    for (const message of ["Instance already exists: rerun-x", "instance.already_exists"]) {
      expect(await startInfraRerun(async () => { throw new Error(message); }, get)).toBe(true);
    }
    expect(looked).toBe(2);
  });

  it("a create that throws and a get that then fails is ambiguous: it rejects, so the step retries (#1148 item 4)", async () => {
    // A transient get() failure after a duplicate create must not read as "not started": the rerun may be running.
    const transient = async () => { throw new Error("D1 timeout"); };
    await expect(startInfraRerun(async () => { throw new Error("Instance already exists"); }, transient))
      .rejects.toThrow("Instance already exists");
  });

  it("a create that throws with no instance behind it rejects, so the step's retries run out and the caller posts the final error verdict", async () => {
    await expect(startInfraRerun(async () => { throw new Error("quota exceeded"); }, noInstance)).rejects.toThrow("quota exceeded");
  });
});

describe("launchInfraRerun: start, then the pointer handoff; a lost handoff ends the orphan rerun (#1148 item 3, race)", () => {
  const inst = (overrides: Partial<Parameters<typeof launchInfraRerun>[0]> = {}) => {
    const log: string[] = [];
    return {
      log,
      deps: {
        create: async () => { log.push("create"); return {}; },
        get: async () => { log.push("get"); return {}; },
        handOff: async () => { log.push("handOff"); return true; },
        terminate: async () => { log.push("terminate"); },
        ...overrides,
      },
    };
  };

  it("a started rerun that takes the pointer is started", async () => {
    const { log, deps } = inst();
    expect(await launchInfraRerun(deps)).toBe("started");
    expect(log).toEqual(["create", "handOff"]);
  });

  it("a rerun that loses the pointer to a newer push is ended, and the outcome is superseded: one live run per head", async () => {
    const { log, deps } = inst({ handOff: async () => { log.push("handOff"); return false; } });
    expect(await launchInfraRerun(deps)).toBe("superseded");
    expect(log).toEqual(["create", "handOff", "terminate"]);
  });

  it("a superseded rerun whose terminate also fails still reports superseded, never a started rerun", async () => {
    const { deps } = inst({ handOff: async () => false, terminate: async () => { throw new Error("DO down"); } });
    expect(await launchInfraRerun(deps)).toBe("superseded");
  });

  it("a start that rejects propagates, so the caller's step retries it", async () => {
    const { log, deps } = inst({ create: async () => { throw new Error("internal workflows error"); }, get: async () => { throw new Error("nope"); } });
    await expect(launchInfraRerun(deps)).rejects.toThrow("internal workflows error");
    expect(log).toEqual([]);
  });
});

describe("rerun instance naming: a rerun is recognised by its id (#1148 item 1)", () => {
  it("the rerun id is rerun-<run id>, and only that prefix is a rerun", () => {
    expect(rerunInstanceId("gate-abc-def")).toBe("rerun-gate-abc-def");
    expect(isRerunInstance("rerun-gate-abc-def")).toBe(true);
    expect(isRerunInstance("gate-abc-def")).toBe(false);
    expect(isRerunInstance("gate-abc-def-r1f2")).toBe(false);
  });
});

describe("recordInfraRerun: the rerun takes the PR's run pointer in one conditional write (#1119, #1135 item 2)", () => {
  function fakeIndex(pointer: { headSha: string; runId: string }) {
    const handoffs: { repo: string; pr: number; from: string; run: { headSha: string; runId: string; progressedAt?: number } }[] = [];
    let reads = 0;
    return {
      handoffs,
      reads: () => reads,
      index: {
        latest: async () => { reads++; return pointer; },
        record: async () => { throw new Error("record must not be used for a handoff"); },
        progress: async () => {},
        // The real store: the write lands only while the pointer still names `from`.
        handOff: async (repo: string, pr: number, from: string, run: { headSha: string; runId: string; progressedAt?: number }) => {
          handoffs.push({ repo, pr, from, run });
          if (pointer.runId !== from) return false;
          Object.assign(pointer, { headSha: run.headSha, runId: run.runId });
          return true;
        },
      },
    };
  }

  it("the first run is still the PR's latest: the rerun takes the pointer on the same head", async () => {
    const pointer = { headSha: HEAD, runId: "first" };
    const { index, handoffs } = fakeIndex(pointer);
    expect(await recordInfraRerun(index, { repo: "acme/example", pr: 7, headSha: HEAD, runId: "rerun-first", instanceId: "first", at: 5 }))
      .toBe(true);
    expect(handoffs).toEqual([{ repo: "acme/example", pr: 7, from: "first", run: { headSha: HEAD, runId: "rerun-first", progressedAt: 5 } }]);
    expect(pointer).toEqual({ headSha: HEAD, runId: "rerun-first" });
  });

  it("a newer push already took the pointer: the handoff is refused and the newer run keeps it", async () => {
    const pointer = { headSha: NEWER, runId: "newer" };
    const { index } = fakeIndex(pointer);
    expect(await recordInfraRerun(index, { repo: "acme/example", pr: 7, headSha: HEAD, runId: "rerun-first", instanceId: "first", at: 5 }))
      .toBe(false);
    expect(pointer).toEqual({ headSha: NEWER, runId: "newer" });
  });

  it("is a single conditional write: it never reads the pointer first (the read-then-write race of #1135 item 2)", async () => {
    const { index, reads } = fakeIndex({ headSha: HEAD, runId: "first" });
    await recordInfraRerun(index, { repo: "acme/example", pr: 7, headSha: HEAD, runId: "rerun-first", instanceId: "first", at: 5 });
    expect(reads()).toBe(0);
  });
});

describe("statusFollowingRerun: a run that handed off to its rerun reports the rerun's status (#1119 review)", () => {
  it("a complete run that handed off answers with its rerun's status, so the poller waits for the rerun", async () => {
    const first = { status: "complete", output: { rerun: "rerun-first", statusPostFailed: false, legs: [] } };
    const rerun = { status: "running" };
    expect(await statusFollowingRerun(first, async (id) => (id === "rerun-first" ? rerun : { status: "missing" }))).toEqual(rerun);
  });

  it("a run with no handoff is its own status", async () => {
    const own = { status: "complete", output: { state: "success", statusPostFailed: false } };
    expect(await statusFollowingRerun(own, async () => { throw new Error("not called"); })).toEqual(own);
  });

  it("a run still running is its own status, even if it carries no output yet", async () => {
    const running = { status: "running" };
    expect(await statusFollowingRerun(running, async () => { throw new Error("not called"); })).toEqual(running);
  });
});

describe("rerunStarted: a cached start result from before the outcome union still reads as started (#1148 review)", () => {
  it("the boolean true a pre-union deploy cached is a started rerun, not a failed one", () => {
    expect(rerunStarted(true)).toBe(true);
  });

  it("'started' is started; 'superseded', 'failed' and a replayed nothing are not", () => {
    expect(rerunStarted("started")).toBe(true);
    expect(rerunStarted("superseded")).toBe(false);
    expect(rerunStarted("failed")).toBe(false);
    expect(rerunStarted(undefined)).toBe(false);
  });
});

describe("announceInfraRerun: progress is stamped before the rerun's pending status (#1148 review, #1226)", () => {
  it("the touch runs before the post, so a watchdog never sees a stale stamp during the rerun's start", async () => {
    const calls: string[] = [];
    await announceInfraRerun({
      touch: async () => { calls.push("touch"); },
      post: async () => { calls.push("post"); },
    });
    expect(calls).toEqual(["touch", "post"]);
  });

  it("a post that throws propagates: the caller's step fails loudly, never a silently swallowed boolean (#1226)", async () => {
    const calls: string[] = [];
    await expect(announceInfraRerun({
      touch: async () => { calls.push("touch"); },
      post: async () => { calls.push("post"); throw new Error("gate/verdict HTTP 503"); },
    })).rejects.toThrow(/503/);
    expect(calls).toEqual(["touch", "post"]);
  });
});
