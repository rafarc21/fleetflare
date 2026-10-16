import { describe, it, expect } from "bun:test";
import { gateWatchExitCode, gateWatchDecision, onGateWatchDeadline, GATE_WATCH_DEADLINE_MS, type GateStatusResponse } from "../../cli/gate";

describe("gateWatchExitCode", () => {
  it("success -> 0", () => {
    expect(gateWatchExitCode({ state: "success" })).toBe(0);
  });
  it("failure -> 1", () => {
    expect(gateWatchExitCode({ state: "failure", description: "x" })).toBe(1);
  });
  it("error -> 2", () => {
    expect(gateWatchExitCode({ state: "error", description: "x" })).toBe(2);
  });
  it("missing or unknown state -> 2, never a green exit", () => {
    expect(gateWatchExitCode({} as GateStatusResponse)).toBe(2);
    expect(gateWatchExitCode({ state: "bogus" } as unknown as GateStatusResponse)).toBe(2);
  });
  it("statusPostFailed overrides the state's own code -> 3", () => {
    const status: GateStatusResponse = { state: "success", statusPostFailed: true };
    expect(gateWatchExitCode(status)).toBe(3);
  });
});

describe("gateWatchDecision", () => {
  it("a non-pending status is terminal immediately, even well before the deadline", () => {
    expect(gateWatchDecision({ state: "success" }, 0)).toEqual({ kind: "terminal", status: { state: "success" } });
  });
  it("a pending status before the deadline keeps watching", () => {
    expect(gateWatchDecision({ state: "pending" }, GATE_WATCH_DEADLINE_MS - 1)).toEqual({ kind: "continue" });
  });
  it("a pending status at or past the deadline ends the watch", () => {
    expect(gateWatchDecision({ state: "pending" }, GATE_WATCH_DEADLINE_MS)).toEqual({ kind: "deadline" });
  });
});

describe("onGateWatchDeadline", () => {
  it("prints the 45-min message and exits 2", () => {
    const originalExitCode = process.exitCode;
    const originalError = console.error;
    const lines: unknown[] = [];
    console.error = ((...args: unknown[]) => { lines.push(args); }) as typeof console.error;
    try {
      onGateWatchDeadline("run-abc");
      expect(process.exitCode).toBe(2);
      expect(lines[0]).toEqual(["gate watch: no verdict after 45 min (run run-abc)"]);
    } finally {
      process.exitCode = originalExitCode;
      console.error = originalError;
    }
  });
});
