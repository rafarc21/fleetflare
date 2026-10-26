// apps/fleet/test/bun/walk-evidence.test.ts
// #1348: pure evidence-shaping helpers. No I/O — keys, the stub schema
// shape, and sweep-state aggregation (same precedence gate/verdict.ts
// already uses for legs: error > failure > did-not-run > success).
import { describe, it, expect } from "bun:test";
import {
  itemEvidenceKey,
  sweepEvidenceKey,
  makeItemEvidence,
  makeSweepEvidence,
  aggregateSweepState,
} from "../../src/walk/evidence";

describe("itemEvidenceKey / sweepEvidenceKey", () => {
  it("places an item under walk/<sweepId>/items/<itemId>.json", () => {
    expect(itemEvidenceKey("sweep-1", "home")).toBe("walk/sweep-1/items/home.json");
  });

  it("places the sweep summary at walk/<sweepId>/sweep.json", () => {
    expect(sweepEvidenceKey("sweep-1")).toBe("walk/sweep-1/sweep.json");
  });
});

describe("makeItemEvidence", () => {
  it("carries every required stub-v0 field", () => {
    const ev = makeItemEvidence({
      sweepId: "sweep-1",
      itemId: "home",
      url: "https://staging.example.com/",
      state: "success",
      startedAt: "2026-10-26T00:00:00.000Z",
      finishedAt: "2026-10-26T00:00:01.000Z",
    });
    expect(ev).toEqual({
      schemaVersion: "stub-v0",
      sweepId: "sweep-1",
      itemId: "home",
      url: "https://staging.example.com/",
      state: "success",
      startedAt: "2026-10-26T00:00:00.000Z",
      finishedAt: "2026-10-26T00:00:01.000Z",
    });
  });

  it("redacts the secret out of description when one is given", () => {
    const ev = makeItemEvidence({
      sweepId: "sweep-1",
      itemId: "home",
      url: "https://staging.example.com/",
      state: "error",
      description: "login failed with token sekret123",
      startedAt: "t0",
      finishedAt: "t1",
      secret: "sekret123",
    });
    expect(ev.description).toBe("login failed with token [REDACTED]");
  });

  it("leaves description untouched when no secret is given", () => {
    const ev = makeItemEvidence({
      sweepId: "sweep-1",
      itemId: "home",
      url: "https://staging.example.com/",
      state: "failure",
      description: "assertion failed",
      startedAt: "t0",
      finishedAt: "t1",
    });
    expect(ev.description).toBe("assertion failed");
  });
});

describe("aggregateSweepState", () => {
  it("all success -> success", () => {
    expect(aggregateSweepState(["success", "success"])).toBe("success");
  });

  it("any did-not-run with no error/failure -> did-not-run", () => {
    expect(aggregateSweepState(["did-not-run", "did-not-run"])).toBe("did-not-run");
  });

  it("any failure beats did-not-run and success", () => {
    expect(aggregateSweepState(["success", "did-not-run", "failure"])).toBe("failure");
  });

  it("any error beats failure, did-not-run, and success", () => {
    expect(aggregateSweepState(["failure", "error", "did-not-run"])).toBe("error");
  });

  it("empty list -> success (vacuously, nothing failed)", () => {
    expect(aggregateSweepState([])).toBe("success");
  });
});

describe("makeSweepEvidence", () => {
  it("rolls up item evidence into refs plus an aggregated state", () => {
    const items = [
      makeItemEvidence({
        sweepId: "sweep-1", itemId: "home", url: "https://x/", state: "success",
        startedAt: "t0", finishedAt: "t1",
      }),
      makeItemEvidence({
        sweepId: "sweep-1", itemId: "login", url: "https://x/login", state: "failure",
        description: "bad", startedAt: "t0", finishedAt: "t1",
      }),
    ];
    const sweep = makeSweepEvidence("sweep-1", items, "t0", "t2");
    expect(sweep).toEqual({
      schemaVersion: "stub-v0",
      sweepId: "sweep-1",
      state: "failure",
      startedAt: "t0",
      finishedAt: "t2",
      items: [
        { itemId: "home", state: "success", key: "walk/sweep-1/items/home.json" },
        { itemId: "login", state: "failure", key: "walk/sweep-1/items/login.json" },
      ],
    });
  });
});
