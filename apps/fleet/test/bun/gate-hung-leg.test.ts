// #1135 item 3 + live hang: a leg whose DO call never answers must end as
// infra and take the one #1119 rerun. Every call inside the step carries its
// own AbortSignal below the Workflows step timeout, so a hung attempt ends
// without the step timeout ever firing. Pure: a fake step engine with retries.
import { describe, it, expect } from "bun:test";
import { MAX_LEG_TIMEOUT_MIN } from "../../src/gate/config";
import { infraRerunDecision, isInfraLegFailure } from "../../src/gate/infra-rerun";
import { legStepDeadlineMs, runLegStep, storedLegResult, totalLegWallMs, type LegStepConfig } from "../../src/gate/leg-run";
import type { PlannedLeg } from "../../src/gate/fanout";
import type { LegResult } from "../../src/gate/verdict";

const PLANNED: PlannedLeg = {
  leg: "lint", commit: "abc", installCmd: "bun install", legCmd: "bun run lint",
  resultKey: "gate/o/r/runs/1/i/shard-lint.json", baselineKeys: [],
};

/** Workflows' retry rule: a throwing step re-runs until its retry limit is
 *  spent. Generic (#1398): LegStepRunner.do is generic now. */
function fakeStep() {
  return {
    do: async <T>(_name: string, config: LegStepConfig, fn: (ctx: { attempt: number; step: { name: string; count: number } }) => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn({ attempt: attempt + 1, step: { name: _name, count: 1 } });
        } catch (err) {
          if (attempt >= config.retries.limit) throw err;
        }
      }
    },
  };
}

const STEP_TIMEOUT_MS = 30 * 60_000;

describe("runLegStep: a hung DO call ends as infra and takes one rerun (#1135 item 3)", () => {
  it("each hung attempt's own AbortSignal fires, so the call ends, and the leg is infra", async () => {
    const signals: AbortSignal[] = [];
    // A DO call that never answers, but honors the signal it was given.
    const hangUntilAborted = (_planned: PlannedLeg, _attemptId: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    };
    const result = await runLegStep(fakeStep(), hangUntilAborted, PLANNED, { stepDeadlineMs: 20 });

    expect(signals).toHaveLength(3); // start-lint and its two infra retries (#1231)
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(result.state).toBe("error");
    expect(isInfraLegFailure({ leg: "lint", state: result.state, description: result.description })).toBe(true);
  });

  it("the infra error takes exactly one rerun; the rerun's own infra-only run is final", async () => {
    const hang = (_p: PlannedLeg, _a: string, signal: AbortSignal) =>
      new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const result = await runLegStep(fakeStep(), hang, PLANNED, { stepDeadlineMs: 20 });
    expect(infraRerunDecision([result], undefined)).toBe(true);
    expect(infraRerunDecision([result], "gate-first-run")).toBe(false);
  });
});

describe("legStepDeadlineMs: the per-attempt deadline always ends before the step timeout (#1135 item 3)", () => {
  it.each([undefined, 1, 25, 28])("leg timeout %p: the deadline is below the 30 min step timeout", (timeoutMin) => {
    expect(legStepDeadlineMs(timeoutMin)).toBeLessThan(STEP_TIMEOUT_MS);
  });

  it("the default leg's deadline is 28 min: its 25 min timeout plus slack, never the 35 min that could not fire", () => {
    expect(legStepDeadlineMs(undefined)).toBe(28 * 60_000);
  });

  it("the largest configurable leg, plus the container's <= 180 s start, ends inside the step deadline: the cap is reachable (#1148 item 5)", () => {
    expect(legStepDeadlineMs(MAX_LEG_TIMEOUT_MIN)).toBeGreaterThanOrEqual(MAX_LEG_TIMEOUT_MIN * 60_000 + 180_000);
    expect(legStepDeadlineMs(MAX_LEG_TIMEOUT_MIN)).toBeLessThan(STEP_TIMEOUT_MS);
  });

  it("a short leg keeps its own timeout plus grace, so it is not held to the cap", () => {
    expect(legStepDeadlineMs(5)).toBe(15 * 60_000);
  });
});

// #1387: the whole leg's total wall time (every attempt, every step) is capped
// at the leg's timeout plus grace. Distinct from the per-attempt step deadline.
describe("totalLegWallMs: the whole leg is bounded (#1387)", () => {
  it("the default leg's total is 35 min: 25 min timeout plus 10 min grace", () => {
    expect(totalLegWallMs(undefined)).toBe(35 * 60_000);
  });

  it("a short leg's total is its own timeout plus grace", () => {
    expect(totalLegWallMs(3)).toBe(13 * 60_000);
  });

  it("the total is NOT clamped to the per-attempt step timeout: it spans two steps", () => {
    expect(totalLegWallMs(undefined)).toBeGreaterThan(legStepDeadlineMs(undefined));
  });
});

describe("infra text the Workflows and AbortSignal timeouts really produce (#1135 item 3)", () => {
  it.each([
    "lint: Execution timed out after 1800000ms",
    "lint: The operation was aborted due to timeout after 28 min",
    "lint: no progress past its deadline after 28 min",
  ])("infra: %s", (description) => {
    expect(isInfraLegFailure({ leg: "lint", state: "error", description })).toBe(true);
  });
});

describe("storedLegResult: a hung R2 read cannot hold the step open (#1135 item 3)", () => {
  it("a read that never answers gives up at the read timeout, with no stored result", async () => {
    const hung = () => new Promise<never>(() => {});
    const started = Date.now();
    expect(await storedLegResult(hung, "k", 20)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
