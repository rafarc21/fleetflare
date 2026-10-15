import { describe, it, expect } from "bun:test";
import { warmPoolSize, shouldNudgeWarmPool } from "../../src/gate/warm-pool";

describe("warmPoolSize", () => {
  it("absent -> 0 (off), the safe default", () => {
    expect(warmPoolSize(undefined)).toBe(0);
  });
  it("a set, valid size is the operator's own tradeoff, not hardcoded", () => {
    expect(warmPoolSize("5")).toBe(5);
  });
  it("malformed value -> 0, never NaN", () => {
    expect(warmPoolSize("not-a-number")).toBe(0);
  });
  it("negative value -> 0, never negative", () => {
    expect(warmPoolSize("-3")).toBe(0);
  });
});

describe("shouldNudgeWarmPool", () => {
  it("false when size is 0", () => {
    expect(shouldNudgeWarmPool(0, "on")).toBe(false);
  });
  it("false when FLEET_GATE_RUNNER is off even with a set size", () => {
    expect(shouldNudgeWarmPool(5, "off")).toBe(false);
  });
  it("true when both are set", () => {
    expect(shouldNudgeWarmPool(5, "on")).toBe(true);
  });
});
