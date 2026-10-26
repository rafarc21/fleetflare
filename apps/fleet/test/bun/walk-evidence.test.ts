// apps/fleet/test/bun/walk-evidence.test.ts
// #1348: pure evidence-shaping helpers against the v1 walk-evidence schema
// (consumer maestro, issue #1348 comment 6412380632) — R2 key segment
// validation, the item evidence builder, and this runner's own
// WalkRunState aggregation (review r1 item 1: an empty item list is
// did-not-run, not a vacuous success).
import { describe, it, expect } from "bun:test";
import {
  itemEvidenceKey,
  sweepEvidenceKey,
  makeItemEvidence,
  makeAbnormalSweepEvidence,
  aggregateSweepState,
} from "../../src/walk/evidence";
import type { WalkAttempt, WalkItem } from "../../src/walk/types";

const ITEM: WalkItem = { id: "signup", role: "member", idx: 0, url: "https://staging.example.com/signup" };

const EMPTY_CONSOLE = {
  consoleErrors: [], consoleWarnings: [], debugLogs: [], exceptions: [], badRequests: [], canceledRequests: [],
};

const PASS_ATTEMPT: WalkAttempt = {
  result: "pass",
  steps: [{ n: 1, screenshot: "s3://x/1.png", observed: "Welcome" }],
  console: EMPTY_CONSOLE,
  ai: { turns: [] },
  accounts: ["acct-a"],
};

describe("itemEvidenceKey", () => {
  it("builds walk/<fingerprint>/item-<role>-<idx>-<id>.json", () => {
    expect(itemEvidenceKey("build-42", ITEM)).toBe("walk/build-42/item-member-0-signup.json");
  });

  it("refuses a role outside the safe key-segment charset", () => {
    expect(() => itemEvidenceKey("build-42", { ...ITEM, role: "../etc" })).toThrow();
  });

  it("refuses an id outside the safe key-segment charset", () => {
    expect(() => itemEvidenceKey("build-42", { ...ITEM, id: "a/b" })).toThrow();
  });

  it("refuses a non-integer idx", () => {
    expect(() => itemEvidenceKey("build-42", { ...ITEM, idx: 1.5 })).toThrow();
  });

  it("refuses a negative idx", () => {
    expect(() => itemEvidenceKey("build-42", { ...ITEM, idx: -1 })).toThrow();
  });

  it("refuses an unsafe fingerprint", () => {
    expect(() => itemEvidenceKey("../x", ITEM)).toThrow();
  });
});

describe("sweepEvidenceKey", () => {
  it("builds walk/<fingerprint>/sweep.json", () => {
    expect(sweepEvidenceKey("build-42")).toBe("walk/build-42/sweep.json");
  });

  it("refuses an unsafe fingerprint", () => {
    expect(() => sweepEvidenceKey("../x")).toThrow();
  });
});

describe("makeItemEvidence", () => {
  it("carries the attempt's fields verbatim under fingerprint/verifier/at", () => {
    const ev = makeItemEvidence("build-42", "member-walker", "2026-10-26T00:00:00.000Z", PASS_ATTEMPT);
    expect(ev).toEqual({
      fingerprint: "build-42",
      verifier: "member-walker",
      at: "2026-10-26T00:00:00.000Z",
      result: "pass",
      steps: PASS_ATTEMPT.steps,
      console: EMPTY_CONSOLE,
      ai: { turns: [] },
      accounts: ["acct-a"],
    });
  });

  it("includes failReason only when the attempt carries one", () => {
    const failed: WalkAttempt = { ...PASS_ATTEMPT, result: "fail", failReason: "red chip shown" };
    const ev = makeItemEvidence("build-42", "member-walker", "t0", failed);
    expect(ev.failReason).toBe("red chip shown");
  });

  it("omits failReason on a pass", () => {
    const ev = makeItemEvidence("build-42", "member-walker", "t0", PASS_ATTEMPT);
    expect("failReason" in ev).toBe(false);
  });
});

describe("makeAbnormalSweepEvidence", () => {
  it("carries fingerprint/at/state/reason, no route fields", () => {
    expect(makeAbnormalSweepEvidence("build-42", "t0", "did-not-run", "no usable auth")).toEqual({
      fingerprint: "build-42",
      at: "t0",
      state: "did-not-run",
      reason: "no usable auth",
    });
  });
});

describe("aggregateSweepState", () => {
  it("an empty item list is did-not-run, never a vacuous success", () => {
    expect(aggregateSweepState([])).toBe("did-not-run");
  });

  it("all success -> success", () => {
    expect(aggregateSweepState(["success", "success"])).toBe("success");
  });

  it("any failure beats success", () => {
    expect(aggregateSweepState(["success", "failure"])).toBe("failure");
  });

  it("any error beats failure and success", () => {
    expect(aggregateSweepState(["failure", "error", "success"])).toBe("error");
  });

  it("did-not-run among real outcomes ranks above success but below failure/error", () => {
    expect(aggregateSweepState(["success", "did-not-run"])).toBe("did-not-run");
    expect(aggregateSweepState(["did-not-run", "failure"])).toBe("failure");
    expect(aggregateSweepState(["did-not-run", "error"])).toBe("error");
  });
});
