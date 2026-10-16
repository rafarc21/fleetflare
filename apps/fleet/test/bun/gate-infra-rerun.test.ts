// #1119: a run whose failures are ALL infra-class (Workflows internal error, a
// lost connection, a container that never answered) re-runs itself once on the
// same head. A second infra-only run is a final error. Pure: the infra
// classifier, the rerun decision, the rerun's pending status and the per-leg
// step deadline (no orphan step holds the run open).
import { describe, it, expect } from "bun:test";
import {
  infraRerunDecision, isInfraLegFailure, recordInfraRerun, rerunStatusArgs, startInfraRerun, statusFollowingRerun,
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
    do: async (_name: string, config: LegStepConfig, fn: () => Promise<LegResult>): Promise<LegResult> => {
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
    "lint: no progress past its deadline after 35 min",
    "lint: HTTP 503 after 0 min",
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
  it("is pending, with the rerun phrase and the run's short id", () => {
    expect(rerunStatusArgs("1234567890abcdef")).toEqual({
      state: "pending", description: "rerun after infra error (run 12345678)",
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

describe("startInfraRerun: a replayed start is success, not a failed rerun (#1119 review)", () => {
  it("a create that resolves starts the rerun", async () => {
    expect(await startInfraRerun(async () => ({ id: "rerun-x" }))).toBe(true);
  });

  it("an 'already exists' create (a replayed step) is success: the rerun is running", async () => {
    expect(await startInfraRerun(async () => { throw new Error("Instance already exists: rerun-x"); })).toBe(true);
  });

  it("any other create failure is not started, so the final error verdict posts", async () => {
    expect(await startInfraRerun(async () => { throw new Error("quota exceeded"); })).toBe(false);
  });
});

describe("recordInfraRerun: the rerun takes the PR's run pointer, like a normal start (#1119 review)", () => {
  function fakeIndex(latest: { headSha: string; runId: string } | null) {
    const records: { repo: string; pr: number; run: { headSha: string; runId: string } }[] = [];
    return {
      records,
      index: {
        latest: async () => latest,
        record: async (repo: string, pr: number, run: { headSha: string; runId: string }) => {
          records.push({ repo, pr, run });
        },
      },
    };
  }

  it("the first run is still the PR's latest: the rerun is recorded on the same head", async () => {
    const { index, records } = fakeIndex({ headSha: HEAD, runId: "first" });
    await recordInfraRerun(index, { repo: "acme/example", pr: 7, headSha: HEAD, runId: "rerun-first", instanceId: "first" });
    expect(records).toEqual([{ repo: "acme/example", pr: 7, run: { headSha: HEAD, runId: "rerun-first" } }]);
  });

  it("a newer push already took the pointer: the rerun is not recorded over it", async () => {
    const { index, records } = fakeIndex({ headSha: NEWER, runId: "newer" });
    await recordInfraRerun(index, { repo: "acme/example", pr: 7, headSha: HEAD, runId: "rerun-first", instanceId: "first" });
    expect(records).toEqual([]);
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
