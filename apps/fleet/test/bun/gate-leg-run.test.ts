// runLegStep is the one-leg decision GateWorkflow makes: one start-<leg> step
// whose return value is the GateRunnerDO's LegResult. Imported from
// leg-run.ts, not workflow.ts: workflow.ts imports cloudflare:workers, which
// bun test cannot load.
import { describe, it, expect } from "bun:test";
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
    expect(await runLegStep(step, dispatch, PLANNED)).toEqual({ leg: "lint", state: "success" });
  });

  it("failure: a red test is data, carried through and never retried", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ state: "failure", description: "3 errors" }); };
    expect(await runLegStep(step, dispatch, PLANNED)).toEqual({
      leg: "lint", state: "failure", description: "3 errors",
    });
    expect(sent).toBe(1);
  });

  it("error: a leg-reported error is data, carried through", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "error", description: "container OOM" });
    expect(await runLegStep(step, dispatch, PLANNED)).toEqual({
      leg: "lint", state: "error", description: "container OOM",
    });
  });

  it("non-2xx: retried once, then becomes an error leg (infra, never a pass)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ error: "boom" }, 503); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.leg).toBe("lint");
    expect(result.state).toBe("error");
    expect(result.description).toContain("lint");
    expect(sent).toBe(2);
  });

  it("only one step per leg, and no waitForEvent: the start step is the whole leg", async () => {
    const step = fakeStep();
    await runLegStep(step, async () => reply({ state: "success" }), PLANNED);
    expect(step.calls.map((c) => c.name)).toEqual(["start-lint"]);
    expect("waitForEvent" in step).toBe(false);
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
  });

  it("unknown state from the DO becomes error, never success", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "passed" });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.state).toBe("error");
    expect(result.description).toContain("unknown state");
  });
});
