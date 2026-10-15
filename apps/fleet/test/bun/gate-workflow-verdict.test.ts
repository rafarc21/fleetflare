// GateWorkflow itself needs a live Workflow/DO/GitHub round trip — not
// unit-testable here. This pins the one pure decision the Workflow's own
// fan-in step makes before calling postCommitStatus: mapping verdict.ts's
// Verdict into the exact (state, description) pair a commit status needs.
//
// Imported from fanout.ts, not workflow.ts: workflow.ts imports
// cloudflare:workers (WorkflowEntrypoint), which bun test cannot load.
import { describe, it, expect } from "bun:test";
import { verdictToStatusArgs } from "../../src/gate/fanout";

describe("verdictToStatusArgs", () => {
  it("success -> pending description text replaced with a terminal one", () => {
    expect(verdictToStatusArgs({ state: "success" })).toEqual({
      state: "success", description: "all legs green",
    });
  });
  it("failure carries its own description through unchanged", () => {
    expect(verdictToStatusArgs({ state: "failure", description: "vitest-3 failed" })).toEqual({
      state: "failure", description: "vitest-3 failed",
    });
  });
  it("error carries its own description through unchanged", () => {
    expect(verdictToStatusArgs({ state: "error", description: "GateRunnerDO OOM" })).toEqual({
      state: "error", description: "GateRunnerDO OOM",
    });
  });
});
