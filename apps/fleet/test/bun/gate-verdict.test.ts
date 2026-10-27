// apps/fleet/test/bun/gate-verdict.test.ts
// #715 Task 4: pure verdict/fan-in state machine. No I/O, no env. Red test
// results are data (leg state "failure"), never thrown. Timeouts and missing
// reports are "error", distinct from "failure". One flake rerun per failed
// leg, modeled as an input outcome (localci.sh:198-207 reruns; we run nothing).
import { describe, it, expect } from "bun:test";
import {
  aggregateVerdict,
  closeOutMissing,
  outcome,
  resolveFlake,
  type LegResult,
} from "../../src/gate/verdict";

const legs = ["typecheck", "lint", "vitest-1", "vitest-2"];

describe("aggregateVerdict", () => {
  it("pending until every expected leg has reported", () => {
    const results: LegResult[] = [{ leg: "typecheck", state: "success" }];
    expect(aggregateVerdict(legs, results)).toEqual({ state: "pending" });
  });

  it("success only when every leg is success", () => {
    const results: LegResult[] = legs.map((leg) => ({ leg, state: "success" }));
    expect(aggregateVerdict(legs, results)).toEqual({ state: "success" });
  });

  it("any failure -> failure, named by configured leg order not arrival order", () => {
    const results: LegResult[] = [
      { leg: "lint", state: "success" },
      { leg: "vitest-2", state: "failure", description: "2 tests failed" },
      { leg: "typecheck", state: "success" },
      { leg: "vitest-1", state: "failure", description: "1 test failed" },
    ];
    // vitest-1 is configured before vitest-2, even though vitest-2 arrived first
    expect(aggregateVerdict(legs, results)).toEqual({ state: "failure", description: "1 test failed" });
  });

  it("any error -> error, never downgraded to failure, even if a failure is also present", () => {
    const results: LegResult[] = [
      { leg: "typecheck", state: "failure", description: "type error" },
      { leg: "lint", state: "error", description: "GateRunnerDO crashed" },
      { leg: "vitest-1", state: "success" },
      { leg: "vitest-2", state: "success" },
    ];
    // #1395: the real red failure is no longer invisible behind the infra error.
    expect(aggregateVerdict(legs, results)).toEqual({
      state: "error", description: "GateRunnerDO crashed; red: typecheck: type error",
    });
  });

  it("an error leg that precedes a failure in configured order still lists that failure (#1395)", () => {
    const results: LegResult[] = [
      { leg: "typecheck", state: "error", description: "GateRunnerDO crashed" },
      { leg: "lint", state: "success" },
      { leg: "vitest-1", state: "failure", description: "1 test failed" },
      { leg: "vitest-2", state: "success" },
    ];
    expect(aggregateVerdict(legs, results)).toEqual({
      state: "error", description: "GateRunnerDO crashed; red: vitest-1: 1 test failed",
    });
  });

  it("lists every real failure alongside the error, in configured leg order (#1395)", () => {
    const results: LegResult[] = [
      { leg: "typecheck", state: "error", description: "GateRunnerDO crashed" },
      { leg: "lint", state: "failure", description: "3 errors" },
      { leg: "vitest-1", state: "failure", description: "1 test failed" },
      { leg: "vitest-2", state: "failure" },
    ];
    expect(aggregateVerdict(legs, results)).toEqual({
      state: "error",
      description: "GateRunnerDO crashed; red: lint: 3 errors, vitest-1: 1 test failed, vitest-2: failed",
    });
  });

  it("an error with no real failure keeps the error description alone (#1395)", () => {
    const results: LegResult[] = [
      { leg: "typecheck", state: "error", description: "GateRunnerDO crashed" },
      { leg: "lint", state: "success" },
      { leg: "vitest-1", state: "success" },
      { leg: "vitest-2", state: "success" },
    ];
    expect(aggregateVerdict(legs, results)).toEqual({ state: "error", description: "GateRunnerDO crashed" });
  });

  it("an error with no description still lists the failures, generated error text intact (#1395)", () => {
    const results: LegResult[] = [
      { leg: "typecheck", state: "error" },
      { leg: "lint", state: "failure", description: "3 errors" },
      { leg: "vitest-1", state: "success" },
      { leg: "vitest-2", state: "success" },
    ];
    expect(aggregateVerdict(legs, results)).toEqual({
      state: "error", description: "typecheck errored; red: lint: 3 errors",
    });
  });

  it("falls back to a generated description when a leg reports none", () => {
    const results: LegResult[] = legs.map((leg) => ({ leg, state: "success" as const }));
    results[0] = { leg: "typecheck", state: "failure" };
    expect(aggregateVerdict(legs, results)).toEqual({ state: "failure", description: "typecheck failed" });
  });

  it("red tests are data: a failing leg returns a verdict instead of throwing", () => {
    const results: LegResult[] = legs.map((leg) => ({ leg, state: "failure" as const, description: "red" }));
    expect(() => aggregateVerdict(legs, results)).not.toThrow();
    expect(aggregateVerdict(legs, results).state).toBe("failure");
  });
});

describe("closeOutMissing (timeout / missing report -> error)", () => {
  it("fills every unreported leg with error, keeps reported legs untouched", () => {
    const results: LegResult[] = [{ leg: "typecheck", state: "success" }];
    const closed = closeOutMissing(legs, results);
    expect(closed).toHaveLength(legs.length);
    expect(closed.find((r) => r.leg === "typecheck")).toEqual({ leg: "typecheck", state: "success" });
    for (const leg of ["lint", "vitest-1", "vitest-2"]) {
      expect(closed.find((r) => r.leg === leg)?.state).toBe("error");
    }
  });

  it("a timed-out leg closes to error, not failure", () => {
    const results: LegResult[] = legs.slice(1).map((leg) => ({ leg, state: "success" as const }));
    const verdict = aggregateVerdict(legs, closeOutMissing(legs, results));
    expect(verdict.state).toBe("error");
  });

  it("with every leg reported, closing out changes nothing", () => {
    const results: LegResult[] = legs.map((leg) => ({ leg, state: "failure" as const, description: "x" }));
    expect(closeOutMissing(legs, results)).toEqual(results);
  });
});

describe("resolveFlake (one rerun per failed leg, outcome is input)", () => {
  it("a passing leg ignores any rerun", () => {
    const first: LegResult = { leg: "lint", state: "success" };
    expect(resolveFlake(first, { leg: "lint", state: "failure", description: "x" })).toEqual(first);
  });

  it("a failed leg with no rerun outcome yet stays failure", () => {
    const first: LegResult = { leg: "lint", state: "failure", description: "1 failed" };
    expect(resolveFlake(first)).toEqual(first);
  });

  it("a failed leg that passes on rerun becomes success", () => {
    const first: LegResult = { leg: "vitest-1", state: "failure", description: "1 failed" };
    expect(resolveFlake(first, { leg: "vitest-1", state: "success" })).toEqual({
      leg: "vitest-1",
      state: "success",
      description: "passed on flake rerun",
    });
  });

  it("a failed leg that fails again stays failure, carrying the rerun description", () => {
    const first: LegResult = { leg: "vitest-1", state: "failure", description: "1 failed" };
    expect(
      resolveFlake(first, { leg: "vitest-1", state: "failure", description: "still 1 failed" }),
    ).toEqual({ leg: "vitest-1", state: "failure", description: "still 1 failed" });
  });

  it("an errored leg is never rerun: error stays error even with a passing rerun input", () => {
    const first: LegResult = { leg: "lint", state: "error", description: "timeout" };
    expect(resolveFlake(first, { leg: "lint", state: "success" })).toEqual(first);
  });

  it("refuses a rerun outcome for a different leg (programmer error, not a red test)", () => {
    const first: LegResult = { leg: "lint", state: "failure" };
    expect(() => resolveFlake(first, { leg: "typecheck", state: "success" })).toThrow();
  });
});

describe("outcome (verdict POST failure lives in its own field)", () => {
  it("keeps the verdict state unchanged when the POST failed", () => {
    const verdict = { state: "failure" as const, description: "1 test failed" };
    const out = outcome(verdict, "POST /statuses 502");
    expect(out.verdict).toEqual(verdict);
    expect(out.postError).toBe("POST /statuses 502");
  });

  it("postError is null when the POST succeeded", () => {
    expect(outcome({ state: "success" }, null)).toEqual({ verdict: { state: "success" }, postError: null });
  });

  it("a POST failure never turns a success into an error", () => {
    expect(outcome({ state: "success" }, "boom").verdict).toEqual({ state: "success" });
  });
});
