// runLegStep is the one-leg decision GateWorkflow makes: one start-<leg> step
// whose return value is the GateRunnerDO's LegResult. Imported from
// leg-run.ts, not workflow.ts: workflow.ts imports cloudflare:workers, which
// bun test cannot load.
import { describe, it, expect, spyOn } from "bun:test";
import { combineCauses, gateRunnerName, legResultReader, MAX_COMBINED_CAUSE_CHARS, runLegStep, type LegStepConfig } from "../../src/gate/leg-run";
import type { PlannedLeg } from "../../src/gate/fanout";
import type { LegResult } from "../../src/gate/verdict";

const PLANNED: PlannedLeg = {
  leg: "lint", commit: "abc", installCmd: "bun install", legCmd: "bun run lint",
  resultKey: "gate/o/r/runs/1/i/shard-lint.json", baselineKeys: [],
};

// Mirrors Workflows' retry rule: a step that throws is re-run until its retry
// limit is spent, then the error propagates to the caller.
function fakeStep() {
  const calls: { name: string; config: LegStepConfig }[] = [];
  return {
    calls,
    do: async (name: string, config: LegStepConfig, fn: () => Promise<LegResult>): Promise<LegResult> => {
      calls.push({ name, config });
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

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("runLegStep", () => {
  it("a leg deadline (200, state error) is final: no infra retry and no flaky retry", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "error", description: "lint exceeded 25 min without a result" });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "error", description: "lint exceeded 25 min without a result" });
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint"]);
  });

  it("success: returns the DO payload as the leg result", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "success" });
    expect(await runLegStep(step, dispatch, PLANNED)).toEqual({ ms: expect.any(Number), leg: "lint", state: "success" });
  });

  it("failure: a red leg retries once as retry-<leg>, and a second failure is the final result", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ state: "failure", description: "3 errors" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "failure", description: "3 errors", redFirst: true });
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("failure then success on retry: success with 'flaky: passed on retry'", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return sent === 1 ? reply({ state: "failure", description: "timing" }) : reply({ state: "success" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "success", description: "flaky: passed on retry; first: timing" });
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("error: a leg-reported error is data, carried through", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "error", description: "container OOM" });
    expect(await runLegStep(step, dispatch, PLANNED)).toEqual({
      ms: expect.any(Number),
      leg: "lint", state: "error", description: "container OOM",
    });
  });

  it("non-2xx: retried twice (#1231); the 503 error body surfaces as '<leg>: <error>' for every attempt, combined", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ error: "gate container did not start within 180 s" }, 503); };
    const result = await runLegStep(step, dispatch, PLANNED);
    const cause = "lint: gate container did not start within 180 s after 0 min";
    expect(result.leg).toBe("lint");
    expect(result.state).toBe("error");
    expect(result.description).toBe(combineCauses([cause, cause, cause]));
    expect(sent).toBe(3);
  });

  it("the infra cause is cut at 200 chars per attempt, then the wall time is appended, then all 3 attempts are combined (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ error: "x".repeat(300) }, 503);
    const result = await runLegStep(step, dispatch, PLANNED);
    const cause = `lint: ${"x".repeat(200 - "lint: ".length)} after 0 min`;
    expect(result.state).toBe("error");
    expect(result.description).toBe(combineCauses([cause, cause, cause]));
  });

  it("only one step per leg, and no waitForEvent: the start step is the whole leg", async () => {
    const step = fakeStep();
    await runLegStep(step, async () => reply({ state: "success" }), PLANNED);
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint"]);
    expect("waitForEvent" in step).toBe(false);
  });

  it("a first success or error never retries — one start step only", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "error", description: "container OOM" });
    await runLegStep(step, dispatch, PLANNED);
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint"]);
  });

  it("start step config: two retries from a 15s exponential base delay, 30-minute attempt timeout (#1231)", async () => {
    const step = fakeStep();
    await runLegStep(step, async () => reply({ state: "success" }), PLANNED);
    expect(step.calls[0].config).toEqual({
      retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
      timeout: "30 minutes",
    });
  });

  it("caps a long description at 2,000 chars (step result limit)", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "failure", description: "x".repeat(5000) });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.description?.length).toBe(2000);
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint", "retry-lint"]);
  });

  it("unknown state from the DO becomes error, never success", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "passed" });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.state).toBe("error");
    expect(result.description).toContain("unknown state");
  });
});

// #1231: retries.limit raised from 1 to 2, so a start-<leg> step now gets up
// to 2 infra retries (3 total attempts) before giving up.
describe("runLegStep: two infra retries, not one (#1231)", () => {
  it("two infra failures then success: the third attempt's result is the leg's success", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      if (sent <= 2) return reply({ error: "gate container did not start within 180 s" }, 503);
      return reply({ state: "success" });
    };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toMatchObject({ leg: "lint", state: "success" });
    expect(sent).toBe(3);
  });

  it("three infra failures: final error combines all attempt causes, capped at 140 chars", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ error: `attempt ${sent} boom` }, 503); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.state).toBe("error");
    expect(result.description!.length).toBeLessThanOrEqual(MAX_COMBINED_CAUSE_CHARS);
    expect(result.description).toContain("attempt 1 boom");
    expect(result.description).toContain("attempt 2 boom");
    expect(result.description).toContain("attempt 3 boom");
    expect(sent).toBe(3);
  });
});

describe("combineCauses: every failed attempt's cause, joined, capped at 140 chars (#1231)", () => {
  it("causes that fit comfortably are joined verbatim with '; ', no truncation marker", () => {
    expect(combineCauses(["a: boom", "b: boom", "c: boom"])).toBe("a: boom; b: boom; c: boom");
  });

  it("causes that together exceed 140 chars are cut to exactly 140 chars, ending with an ellipsis", () => {
    const result = combineCauses(["x".repeat(60), "y".repeat(60), "z".repeat(60)]);
    expect(result.length).toBe(MAX_COMBINED_CAUSE_CHARS);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("runLegStep: time and test summary per leg (#1049)", () => {
  it("ms is the sum of both attempts' wall time when a red leg retries (Date.now read inside each step)", async () => {
    const clock = [1_000, 1_500, 2_000, 2_300];
    const now = spyOn(Date, "now").mockImplementation(() => (clock.length > 1 ? clock.shift()! : clock[0]));
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return sent === 1 ? reply({ state: "failure", description: "timing" }) : reply({ state: "success" }); };
    try {
      const result = await runLegStep(step, dispatch, PLANNED);
      expect(result).toMatchObject({ state: "success", ms: 800, description: "flaky: passed on retry; first: timing" });
    } finally {
      now.mockRestore();
    }
  });

  it("the test summary the DO reports flows through to the leg result", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "failure", description: "lint exited 1", summary: "Tests  1 failed | 1640 passed (1641)" });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toMatchObject({ state: "failure", summary: "Tests  1 failed | 1640 passed (1641)" });
  });

  it("a flaky pass carries the retry's summary", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      return sent === 1 ? reply({ state: "failure", description: "timing" }) : reply({ state: "success", summary: "5 pass" });
    };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toMatchObject({ state: "success", description: "flaky: passed on retry; first: timing", summary: "5 pass" });
  });
});

describe("runLegStep: flaky evidence and HTTP fallback (#1057)", () => {
  it("the retry's resultKey is the first key with '.retry'; the first attempt keeps the plain key", async () => {
    const step = fakeStep();
    const keys: string[] = [];
    let sent = 0;
    const dispatch = async (p: PlannedLeg) => {
      keys.push(p.resultKey);
      sent++;
      return sent === 1 ? reply({ state: "failure", description: "timing" }) : reply({ state: "success" });
    };
    await runLegStep(step, dispatch, PLANNED);
    expect(keys).toEqual([
      "gate/o/r/runs/1/i/shard-lint.json",
      "gate/o/r/runs/1/i/shard-lint.retry.json",
    ]);
  });

  it("the flaky description cuts the first attempt's description at 150 chars", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      return sent === 1 ? reply({ state: "failure", description: "y".repeat(400) }) : reply({ state: "success" });
    };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.description).toBe(`flaky: passed on retry; first: ${"y".repeat(150)}`);
  });

  it("non-2xx with a non-JSON body: the cause is '<leg>: HTTP <status>', combined across all 3 attempts (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => new Response("<html>bad gateway</html>", { status: 502 });
    const result = await runLegStep(step, dispatch, PLANNED);
    const cause = "lint: HTTP 502 after 0 min";
    expect(result).toMatchObject({ leg: "lint", state: "error", description: combineCauses([cause, cause, cause]) });
  });
});

// Each attempt dispatches under its own DO name, so a retry never lands on the
// DO (and container) a previous attempt is still tearing down (#1068).
describe("gateRunnerName: one runner DO per leg attempt (#1068)", () => {
  it("names the DO by run instance, leg and attempt", () => {
    expect(gateRunnerName("run-1", "lint", "a1")).toBe("run-1/lint/a1");
  });

  it("two attempts of the same leg in the same run never share a name", () => {
    expect(gateRunnerName("run-1", "lint", "a1")).not.toBe(gateRunnerName("run-1", "lint", "a2"));
  });

  it("the same attempt id on two legs or two runs never share a name", () => {
    expect(gateRunnerName("run-1", "lint", "a1")).not.toBe(gateRunnerName("run-1", "test", "a1"));
    expect(gateRunnerName("run-1", "lint", "a1")).not.toBe(gateRunnerName("run-2", "lint", "a1"));
  });
});

describe("runLegStep: every attempt dispatches under a fresh attempt id (#1068)", () => {
  it("a start-step infra retry gets a new attempt id on every attempt (#1231): the id is made inside the step callback", async () => {
    const step = fakeStep();
    const ids: string[] = [];
    const dispatch = async (_p: PlannedLeg, attemptId: string) => {
      ids.push(attemptId);
      return reply({ error: "container not listening" }, 503);
    };
    await runLegStep(step, dispatch, PLANNED);
    expect(ids).toHaveLength(3);
    expect(ids[0]).not.toBe("");
    expect(new Set(ids).size).toBe(3);
  });

  it("a flaky red leg's retry-<leg> step gets its own attempt id", async () => {
    const step = fakeStep();
    const ids: string[] = [];
    const dispatch = async (_p: PlannedLeg, attemptId: string) => {
      ids.push(attemptId);
      return reply({ state: "failure", description: "timing" });
    };
    await runLegStep(step, dispatch, PLANNED);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("start infra retry, then red, then the flaky retry: three dispatches, three distinct ids", async () => {
    const step = fakeStep();
    const ids: string[] = [];
    const replies = [reply({ error: "not listening" }, 503), reply({ state: "failure", description: "timing" }), reply({ state: "success" })];
    const dispatch = async (_p: PlannedLeg, attemptId: string) => {
      ids.push(attemptId);
      return replies.shift()!;
    };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.state).toBe("success");
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});

// Thrown attempts still count: the wall time from the callback start is put
// into the thrown message. Date.now is pinned so the minutes are exact.
describe("runLegStep: a thrown attempt reports its wall time (#1068)", () => {
  it("an infra attempt that spends 4 min then throws says 'after 4 min', combined across all 3 attempts (#1231)", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const step = fakeStep();
      const dispatch = async () => { now += 4 * 60_000; return reply({ error: "gate server unreachable: The container is not listening" }, 503); };
      const result = await runLegStep(step, dispatch, PLANNED);
      const cause = "lint: gate server unreachable: The container is not listening after 4 min";
      expect(result).toEqual({
        leg: "lint", state: "error",
        description: combineCauses([cause, cause, cause]),
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("a dispatch that rejects (no reply at all) still reports its wall time, combined across all 3 attempts (#1231)", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const step = fakeStep();
      const dispatch = async () => { now += 2 * 60_000; throw new Error("socket reset"); };
      const result = await runLegStep(step, dispatch, PLANNED);
      const cause = "socket reset after 2 min";
      expect(result).toEqual({ leg: "lint", state: "error", description: combineCauses([cause, cause, cause]) });
    } finally {
      clock.mockRestore();
    }
  });

  it("a successful attempt's description is not given a time suffix", async () => {
    const step = fakeStep();
    const result = await runLegStep(step, async () => reply({ state: "error", description: "container OOM" }), PLANNED);
    expect(result.description).toBe("container OOM");
  });
});

// #1094: a transport loss (or a container that exited mid-leg) leaves the leg's
// verdict with only the transport error. The leg's own R2 result, written by
// the container before it stopped, says why: the description carries it.
describe("runLegStep: an infra failure carries the leg's R2 result (#1094)", () => {
  const LOST = "Network connection lost.";
  const EXITED = { state: "failure" as const, description: "lint exited 143" };

  it("transport lost, R2 holds a known result: that result is the leg's, its state from R2 (#1122)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => EXITED });
    // A failure from R2 earns the one failure-retry on a fresh container, which also reads R2.
    expect(result).toMatchObject({
      leg: "lint", state: "failure", description: "result read from R2 after transport loss: lint exited 143",
    });
    expect(sent).toBe(2);
  });

  it("no R2 result for the leg: the description is the transport error, combined across all 3 attempts (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => undefined });
    const cause = `${LOST} after 0 min`;
    expect(result.description).toBe(combineCauses([cause, cause, cause]));
  });

  it("an R2 read that throws never masks the transport error, combined across all 3 attempts (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => { throw new Error("r2 down"); } });
    const cause = `${LOST} after 0 min`;
    expect(result).toEqual({ leg: "lint", state: "error", description: combineCauses([cause, cause, cause]) });
  });

  it("no deps given: the transport error alone, combined across all 3 attempts (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const cause = `${LOST} after 0 min`;
    expect((await runLegStep(step, dispatch, PLANNED)).description).toBe(combineCauses([cause, cause, cause]));
  });

  it("transport lost, R2 holds success: the leg passes on the first try, no retry (#1122)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => ({ state: "success" }) });
    expect(result).toMatchObject({
      leg: "lint", state: "success", description: "result read from R2 after transport loss: success",
    });
    expect(sent).toBe(1);
  });

  it("a container that exited mid-leg (503) with a known R2 failure: the failure-retry runs, each try reads its own key", async () => {
    const step = fakeStep();
    const keys: string[] = [];
    const dispatch = async () => reply({ error: "gate container exited mid-leg" }, 503);
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async (key) => { keys.push(key); return EXITED; },
    });
    expect(result).toMatchObject({
      leg: "lint", state: "failure", description: "result read from R2 after transport loss: lint exited 143",
    });
    expect(keys).toEqual([PLANNED.resultKey, "gate/o/r/runs/1/i/shard-lint.retry.json"]);
  });

  it("R2 failure then a passing retry: flaky, the first cause is the R2 result (#1122)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      if (sent === 1) throw new Error(LOST);
      return reply({ state: "success" });
    };
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async () => ({ state: "failure", description: "lint 3 errors" }),
    });
    expect(result).toMatchObject({
      leg: "lint", state: "success",
      description: "flaky: passed on retry; first: result read from R2 after transport loss: lint 3 errors",
    });
  });

  it("R2 absent under a transport loss: the transport error is the cause, and the start step's own infra retries run (#1231: now 3 attempts)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => undefined });
    expect(result).toMatchObject({ leg: "lint", state: "error" });
    expect(sent).toBe(3);
  });

  it("a retry that loses its transport reads the retry's own key", async () => {
    const step = fakeStep();
    const keys: string[] = [];
    let sent = 0;
    const dispatch = async () => {
      sent++;
      if (sent === 1) return reply({ state: "failure", description: "timing" });
      throw new Error(LOST);
    };
    await runLegStep(step, dispatch, PLANNED, { readResult: async (key) => { keys.push(key); return undefined; } });
    expect(keys).toContain("gate/o/r/runs/1/i/shard-lint.retry.json");
    expect(keys).not.toContain("gate/o/r/runs/1/i/shard-lint.json");
  });

  it("the R2 description is capped at the 2000-char description ceiling, and R2 stderr never reaches the description", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const big = { state: "failure" as const, description: `lint ${"x".repeat(5000)}`, stderr: "SECRET-STDERR-TAIL" };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => big });
    expect(result.description).toBe(`result read from R2 after transport loss: lint ${"x".repeat(5000)}`.slice(0, 2000));
    expect(result.description).not.toContain("SECRET-STDERR-TAIL");
  });

  it("R2 stderr is never quoted into the description, even when the description is short", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const short = { state: "failure" as const, description: "lint 3 errors", stderr: "SECRET-STDERR-TAIL" };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => short });
    expect(result.description).toBe("result read from R2 after transport loss: lint 3 errors");
  });

  it("the start step's infra retries read their own result key, not try 1's or each other's (#1231: tries 2 and 3 each get their own key)", async () => {
    const step = fakeStep();
    const readKeys: string[] = [];
    const dispatch = async () => { throw new Error(LOST); };
    await runLegStep(step, dispatch, PLANNED, { readResult: async (key) => { readKeys.push(key); return undefined; } });
    expect(readKeys).toEqual([
      PLANNED.resultKey,
      "gate/o/r/runs/1/i/shard-lint-try2.json",
      "gate/o/r/runs/1/i/shard-lint-try3.json",
    ]);
  });

  it("try 3 reads back its own stored result, never try 2's late-arriving one, under a shared-key collision (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    // Models the race the plan calls out: try 2's read finds nothing yet (its
    // container's late write hasn't landed), but by the time something reads
    // the try2 key again, it has — a stale value a collision would hand to
    // try 3. try 3's OWN key always holds its own, distinct result.
    let try2Reads = 0;
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async (key) => {
        if (key === "gate/o/r/runs/1/i/shard-lint-try2.json") {
          try2Reads++;
          return try2Reads === 1 ? undefined : { state: "error", description: "try 2's stale result" };
        }
        if (key === "gate/o/r/runs/1/i/shard-lint-try3.json") {
          return { state: "error", description: "try 3's own result" };
        }
        return undefined;
      },
    });
    expect(result.state).toBe("error");
    expect(result.description).toBe("result read from R2 after transport loss: try 3's own result");
  });
});

describe("legResultReader: reads a leg's R2 result from a bucket", () => {
  it("absent key: undefined", async () => {
    const read = legResultReader({ get: async () => null });
    expect(await read("gate/o/r/runs/1/i/shard-lint.json")).toBeUndefined();
  });

  it("present key: its JSON, when it carries a state", async () => {
    const body = { state: "failure" as const, description: "lint exited 143" };
    const read = legResultReader({ get: async () => ({ json: async () => body }) });
    expect(await read("k")).toEqual(body);
  });

  it("a body without a known state is treated as absent", async () => {
    const read = legResultReader({ get: async () => ({ json: async () => ({ nope: 1 }) }) });
    expect(await read("k")).toBeUndefined();
  });

  it("a body whose state is not one of the leg states is treated as absent", async () => {
    const read = legResultReader({ get: async () => ({ json: async () => ({ state: "bogus" }) }) });
    expect(await read("k")).toBeUndefined();
  });
});

// #1092: an "install failed" error is an infra-class flake (a tarball fetch
// that died), so it gets the same one retry as a red leg, on a fresh container.
// #1104: a "clone failed" error (a git smart-HTTP stream garbled through the
// outbound proxy) is an infra-class flake too: one retry on a fresh container.
describe("runLegStep: clone failure retries once (#1104)", () => {
  const CLONE = "clone failed: fatal: remote-curl: bad line length character";

  it("clone failed, then success on a fresh container: success, first cause noted", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return sent === 1 ? reply({ state: "error", description: CLONE }) : reply({ state: "success" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "success", description: `flaky: passed on retry; first: ${CLONE}` });
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("clone failed twice: the second clone failure is final, and its description notes the first cause", async () => {
    const step = fakeStep();
    let sent = 0;
    const second = "clone failed: fatal: unable to access 'http:/'";
    const dispatch = async () => { sent++; return reply({ state: "error", description: sent === 1 ? CLONE : second }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({
      ms: expect.any(Number), leg: "lint", state: "error",
      description: `${second}; first: ${CLONE}`,
    });
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("the clone retry runs under retry-<leg> with the .retry.json evidence key", async () => {
    const step = fakeStep();
    const keys: string[] = [];
    let sent = 0;
    const dispatch = async (p: PlannedLeg) => {
      keys.push(p.resultKey);
      sent++;
      return sent === 1 ? reply({ state: "error", description: CLONE }) : reply({ state: "success" });
    };
    await runLegStep(step, dispatch, PLANNED);
    expect(keys).toEqual([
      "gate/o/r/runs/1/i/shard-lint.json",
      "gate/o/r/runs/1/i/shard-lint.retry.json",
    ]);
  });

  it("a clone failure recovered from R2 is retried and a true pass is tagged flaky (#1178)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      if (sent === 1) throw new Error("Network connection lost.");
      return reply({ state: "success" });
    };
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async () => ({ state: "error", description: CLONE }),
    });
    // The R2 prefix must not hide the clone-failed match: the retry earns a flaky success.
    expect(result).toEqual({
      ms: expect.any(Number), leg: "lint", state: "success",
      description: `flaky: passed on retry; first: result read from R2 after transport loss: ${CLONE}`,
    });
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("an R2-recovered error with an unrelated cause stays final: no retry (#1178)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; throw new Error("Network connection lost."); };
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async () => ({ state: "error", description: "disk quota exceeded" }),
    });
    expect(result).toEqual({
      ms: expect.any(Number), leg: "lint", state: "error",
      description: "result read from R2 after transport loss: disk quota exceeded",
    });
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint"]);
    expect(sent).toBe(1);
  });
});

describe("runLegStep: install failure retries once (#1092)", () => {
  const INSTALL = 'install failed: error: Fail extracting tarball for "wrangler"';

  it("install failed, then success on a fresh container: success, first cause noted", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return sent === 1 ? reply({ state: "error", description: INSTALL }) : reply({ state: "success" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "success", description: `flaky: passed on retry; first: ${INSTALL}` });
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("an install-failed result read from R2 is retried once (#1126)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; throw new Error("Network connection lost."); };
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async () => ({ state: "error", description: INSTALL }),
    });
    // The R2 prefix must not hide the install-failed match: one fresh-container retry.
    expect(sent).toBe(2);
    expect(result.description).toContain("result read from R2 after transport loss");
  });

  it("install failed twice: the retry's error is final, and its description notes the first cause", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ state: "error", description: sent === 1 ? INSTALL : "install failed: 404 for registry" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({
      ms: expect.any(Number), leg: "lint", state: "error",
      description: `install failed: 404 for registry; first: ${INSTALL}`,
    });
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("the install retry runs under retry-<leg> with the .retry.json evidence key", async () => {
    const step = fakeStep();
    const keys: string[] = [];
    let sent = 0;
    const dispatch = async (p: PlannedLeg) => {
      keys.push(p.resultKey);
      sent++;
      return sent === 1 ? reply({ state: "error", description: INSTALL }) : reply({ state: "success" });
    };
    await runLegStep(step, dispatch, PLANNED);
    expect(keys).toEqual([
      "gate/o/r/runs/1/i/shard-lint.json",
      "gate/o/r/runs/1/i/shard-lint.retry.json",
    ]);
  });

  it("an install retry that dies as infra still ends as error with the first cause noted, all 3 retry-step attempts combined (#1231)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      return sent === 1 ? reply({ state: "error", description: INSTALL }) : reply({ error: "gate container did not start within 180 s" }, 503);
    };
    const result = await runLegStep(step, dispatch, PLANNED);
    const cause = "lint: gate container did not start within 180 s after 0 min";
    expect(result.state).toBe("error");
    expect(result.description).toBe(`${combineCauses([cause, cause, cause])}; first: ${INSTALL}`);
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint", "retry-lint"]);
  });

  it.each([
    ["fetch failed: fatal: couldn't find remote ref"],
    ["checkout failed: error: pathspec"],
    ["gate-server: boom"],
  ])("other error kinds stay final, no retry: %s", async (description) => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "error", description });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toMatchObject({ state: "error", description });
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint"]);
  });
});
