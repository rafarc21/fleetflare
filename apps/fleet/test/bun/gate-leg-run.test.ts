// runLegStep is the one-leg decision GateWorkflow makes: one start-<leg> step
// whose return value is the GateRunnerDO's LegResult. Imported from
// leg-run.ts, not workflow.ts: workflow.ts imports cloudflare:workers, which
// bun test cannot load.
import { describe, it, expect, spyOn } from "bun:test";
import { gateRunnerName, legResultReader, runLegStep, type LegStepConfig } from "../../src/gate/leg-run";
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
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "failure", description: "3 errors" });
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

  it("non-2xx: retried once; the 503 error body surfaces as '<leg>: <error>'", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ error: "gate container did not start within 180 s" }, 503); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.leg).toBe("lint");
    expect(result.state).toBe("error");
    expect(result.description).toBe("lint: gate container did not start within 180 s after 0 min");
    expect(sent).toBe(2);
  });

  it("the infra cause is cut at 200 chars, then the wall time is appended", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ error: "x".repeat(300) }, 503);
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.state).toBe("error");
    expect(result.description).toBe(`lint: ${"x".repeat(200 - "lint: ".length)} after 0 min`);
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

  it("start step config: one retry after 15s constant, 30-minute attempt timeout", async () => {
    const step = fakeStep();
    await runLegStep(step, async () => reply({ state: "success" }), PLANNED);
    expect(step.calls[0].config).toEqual({
      retries: { limit: 1, delay: "15 seconds", backoff: "constant" },
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

  it("non-2xx with a non-JSON body: the cause is '<leg>: HTTP <status>'", async () => {
    const step = fakeStep();
    const dispatch = async () => new Response("<html>bad gateway</html>", { status: 502 });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toMatchObject({ leg: "lint", state: "error", description: "lint: HTTP 502 after 0 min" });
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
  it("a start-step infra retry gets a new attempt id: the id is made inside the step callback", async () => {
    const step = fakeStep();
    const ids: string[] = [];
    const dispatch = async (_p: PlannedLeg, attemptId: string) => {
      ids.push(attemptId);
      return reply({ error: "container not listening" }, 503);
    };
    await runLegStep(step, dispatch, PLANNED);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe("");
    expect(ids[0]).not.toBe(ids[1]);
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
  it("an infra attempt that spends 4 min then throws says 'after 4 min'", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const step = fakeStep();
      const dispatch = async () => { now += 4 * 60_000; return reply({ error: "gate server unreachable: The container is not listening" }, 503); };
      const result = await runLegStep(step, dispatch, PLANNED);
      expect(result).toEqual({
        leg: "lint", state: "error",
        description: "lint: gate server unreachable: The container is not listening after 4 min",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("a dispatch that rejects (no reply at all) still reports its wall time", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const step = fakeStep();
      const dispatch = async () => { now += 2 * 60_000; throw new Error("socket reset"); };
      const result = await runLegStep(step, dispatch, PLANNED);
      expect(result).toEqual({ leg: "lint", state: "error", description: "socket reset after 2 min" });
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

  it("transport lost, R2 has the leg's result: the description carries it, state stays error", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => EXITED });
    expect(result).toEqual({
      leg: "lint", state: "error",
      description: `${LOST} after 0 min; result: lint exited 143 (container stopped?)`,
    });
  });

  it("no R2 result for the leg: the description is the transport error alone", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => undefined });
    expect(result.description).toBe(`${LOST} after 0 min`);
  });

  it("an R2 read that throws never masks the transport error", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => { throw new Error("r2 down"); } });
    expect(result).toEqual({ leg: "lint", state: "error", description: `${LOST} after 0 min` });
  });

  it("no deps given: the transport error alone, as before", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    expect((await runLegStep(step, dispatch, PLANNED)).description).toBe(`${LOST} after 0 min`);
  });

  it("the annotation is for exit 143 only: any other R2 description is quoted as is", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async () => ({ state: "failure", description: "lint 3 errors" }),
    });
    expect(result.description).toBe(`${LOST} after 0 min; result: lint 3 errors`);
  });

  it("an R2 success under an infra error is still state error: only the description gains it", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => ({ state: "success" }) });
    expect(result).toEqual({ leg: "lint", state: "error", description: `${LOST} after 0 min; result: success` });
  });

  it("a container that exited mid-leg (503) also reads R2, and the start key is the one read", async () => {
    const step = fakeStep();
    const keys: string[] = [];
    const dispatch = async () => reply({ error: "gate container exited mid-leg" }, 503);
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async (key) => { keys.push(key); return EXITED; },
    });
    expect(result.description).toBe("lint: gate container exited mid-leg after 0 min; result: lint exited 143 (container stopped?)");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k === PLANNED.resultKey)).toBe(true);
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
});
