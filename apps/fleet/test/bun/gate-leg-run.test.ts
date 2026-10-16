// runLegStep is the one-leg decision GateWorkflow makes: one start-<leg> step
// whose return value is the GateRunnerDO's LegResult. Imported from
// leg-run.ts, not workflow.ts: workflow.ts imports cloudflare:workers, which
// bun test cannot load.
import { describe, it, expect, spyOn } from "bun:test";
import { runLegStep, type LegStepConfig } from "../../src/gate/leg-run";
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
    expect(result.description).toBe("lint: gate container did not start within 180 s");
    expect(sent).toBe(2);
  });

  it("the infra cause is cut at 200 chars", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ error: "x".repeat(300) }, 503);
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.state).toBe("error");
    expect(result.description).toBe(`lint: ${"x".repeat(200 - "lint: ".length)}`);
    expect(result.description?.length).toBe(200);
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
    expect(result).toMatchObject({ leg: "lint", state: "error", description: "lint: HTTP 502" });
  });
});
