// GateWorkflow itself needs a live Workflow/DO/GitHub round trip — not
// unit-testable here. This pins the one pure decision the Workflow's own
// fan-in step makes before calling postCommitStatus: the (state, description)
// pair a commit status needs. The description is the per-leg roster (#1049
// addendum item 5), built from the planned leg names and their results.
//
// Imported from fanout.ts, not workflow.ts: workflow.ts imports
// cloudflare:workers (WorkflowEntrypoint), which bun test cannot load.
import { describe, it, expect } from "bun:test";
import { verdictToStatusArgs } from "../../src/gate/fanout";
import type { LegResult } from "../../src/gate/verdict";

const RUN_ID = "0123456789abcdef"; // the Workflow instance id; the roster shows its first 8
const ID8 = "(run 01234567)";

const green = (leg: string, description?: string): LegResult => ({ leg, state: "success", description });
const red = (leg: string, state: "failure" | "error" = "failure"): LegResult => ({ leg, state, description: "x" });

describe("verdictToStatusArgs: the roster description", () => {
  it("success reads '<n>/<n> green (run <id8>)'", () => {
    const args = verdictToStatusArgs({ state: "success" }, {
      expected: ["lint", "bun-1"], results: [green("lint"), green("bun-1")], runId: RUN_ID,
    });
    expect(args).toEqual({ state: "success", description: `2/2 green ${ID8}` });
  });

  it("a flaky pass is named in the success roster, not counted as a plain ok", () => {
    const args = verdictToStatusArgs({ state: "success" }, {
      expected: ["lint", "bun-1"], results: [green("lint"), green("bun-1", "flaky: passed on retry")], runId: RUN_ID,
    });
    expect(args).toEqual({ state: "success", description: `2/2 green (1 flaky: bun-1) ${ID8}` });
  });

  it("one red leg reads '<green>/<total> green; red: <leg> (run <id8>)'", () => {
    const args = verdictToStatusArgs({ state: "failure", description: "vitest-1 failed" }, {
      expected: ["lint", "vitest-1", "vitest-2"],
      results: [green("lint"), red("vitest-1"), green("vitest-2")],
      runId: RUN_ID,
    });
    expect(args).toEqual({ state: "failure", description: `2/3 green; red: vitest-1 ${ID8}` });
  });

  it("an error leg is non-green and listed too", () => {
    const args = verdictToStatusArgs({ state: "error", description: "GateRunnerDO OOM" }, {
      expected: ["lint", "bun-1"], results: [green("lint"), red("bun-1", "error")], runId: RUN_ID,
    });
    expect(args).toEqual({ state: "error", description: `1/2 green; red: bun-1 ${ID8}` });
  });

  it("a leg with no report counts as red, so a pending verdict names it", () => {
    const args = verdictToStatusArgs({ state: "error", description: "no legs reported" }, {
      expected: ["lint", "vitest-1", "vitest-2"], results: [green("lint")], runId: RUN_ID,
    });
    expect(args).toEqual({ state: "error", description: `1/3 green; red: vitest-1, vitest-2 ${ID8}` });
  });

  it("many reds: the list is truncated with '+N more' and the whole text stays within 140 chars", () => {
    const expected = Array.from({ length: 60 }, (_, i) => `vitest-${i + 1}`);
    const args = verdictToStatusArgs({ state: "failure", description: "x" }, {
      expected, results: expected.map((l) => red(l)), runId: RUN_ID,
    });
    expect(args.description.length).toBeLessThanOrEqual(140);
    expect(args.description).toMatch(/^0\/60 green; red: vitest-1, .*, \+\d+ more \(run 01234567\)$/);
  });
});
