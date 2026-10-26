// #1343: browser-leg semantics. A browser leg is a real verdict only when
// spec evidence exists; zero specs or a skipped leg is RED DID-NOT-RUN.
import { describe, it, expect } from "bun:test";
import {
  browserLegsToCheck, DID_NOT_RUN, didNotRunDescription, enforceBrowserLeg, enforceBrowserLegs, manifestProvesExecution, verdictEvidenceUrl,
} from "../../src/gate/browser-leg";
import { resultKeysPrefix } from "../../src/gate/log";
import type { LegResult } from "../../src/gate/verdict";
import type { PlannedLeg } from "../../src/gate/fanout";

describe("enforceBrowserLeg: zero specs -> RED DID-NOT-RUN", () => {
  it("a success with no evidence downgrades to failure DID-NOT-RUN", () => {
    expect(enforceBrowserLeg("e2e", { leg: "e2e", state: "success" }, false)).toEqual({
      leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (no spec evidence)`,
    });
  });

  it("a success with evidence passes through", () => {
    expect(enforceBrowserLeg("e2e", { leg: "e2e", state: "success" }, true)).toEqual({
      leg: "e2e", state: "success",
    });
  });

  it("a failure or error never downgrades (it is already red)", () => {
    const failure: LegResult = { leg: "e2e", state: "failure", description: "3 failed" };
    expect(enforceBrowserLeg("e2e", failure, false)).toEqual(failure);
    const error: LegResult = { leg: "e2e", state: "error", description: "crash" };
    expect(enforceBrowserLeg("e2e", error, false)).toEqual(error);
  });
});

describe("enforceBrowserLegs: a skipped browser leg -> RED DID-NOT-RUN", () => {
  const browser = new Set(["e2e"]);
  const evidence = new Set<string>();

  it("a browser leg with no result is filled as DID-NOT-RUN, never left missing", () => {
    const out = enforceBrowserLegs(["merge-tree", "e2e"], [{ leg: "merge-tree", state: "success" }], browser, evidence);
    expect(out).toEqual([
      { leg: "merge-tree", state: "success" },
      { leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (no spec evidence)` },
    ]);
  });

  it("a browser success without evidence downgrades, keeping sibling results", () => {
    const out = enforceBrowserLegs(
      ["merge-tree", "e2e"],
      [{ leg: "merge-tree", state: "success" }, { leg: "e2e", state: "success" }],
      browser, evidence,
    );
    expect(out[1]).toEqual({ leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (no spec evidence)` });
    expect(out[0].state).toBe("success");
  });

  it("evidence present keeps the browser success", () => {
    const out = enforceBrowserLegs(
      ["e2e"], [{ leg: "e2e", state: "success" }], browser, new Set(["e2e"]),
    );
    expect(out).toEqual([{ leg: "e2e", state: "success" }]);
  });

  it("plain legs are untouched: their missing report stays the verdict's own pending", () => {
    const out = enforceBrowserLegs(["lint", "e2e"], [{ leg: "e2e", state: "success" }], browser, evidence);
    expect(out).toEqual([
      { leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (no spec evidence)` },
    ]);
  });
});

describe("didNotRunDescription", () => {
  it("carries the DID-NOT-RUN marker and the leg name", () => {
    expect(didNotRunDescription("e2e")).toBe(`${DID_NOT_RUN}: e2e (no spec evidence)`);
  });
});

describe("verdictEvidenceUrl", () => {
  it("builds the Worker's own evidence overview URL, trailing slash stripped", () => {
    expect(verdictEvidenceUrl("https://fleet.example.com/", "acme/example", 7, "run-a")).toBe(
      "https://fleet.example.com/studio/gate/evidence?repo=acme%2Fexample&pr=7&run=run-a",
    );
  });
});
// #1343 MED4: a manifest must declare executed>0 to prove specs ran.
describe("manifestProvesExecution (#1343 MED4)", () => {
  it("true for executed>0, false for 0, missing, unparseable or non-number", () => {
    expect(manifestProvesExecution({ executed: 3 })).toBe(true);
    expect(manifestProvesExecution({ executed: 0 })).toBe(false);
    expect(manifestProvesExecution({})).toBe(false);
    expect(manifestProvesExecution(null)).toBe(false);
    expect(manifestProvesExecution("x")).toBe(false);
    expect(manifestProvesExecution({ executed: "three" })).toBe(false);
    expect(manifestProvesExecution({ executed: -1 })).toBe(false);
  });
});

// #1343 MED6: result keys are listed under `shard-`, never the whole run
// prefix (evidence lives under `evidence/` and must not crowd results out).
describe("resultKeysPrefix (#1343 MED6)", () => {
  it("scopes to shard-, never the run prefix", () => {
    expect(resultKeysPrefix("gate/acme/example/runs/7/run-a/")).toBe("gate/acme/example/runs/7/run-a/shard-");
  });
});

// #1343 r2 blocker 2: a carried green browser leg is exempt from evidence
// checking — re-checking under the NEW run's prefix flips green->red.
describe("browserLegsToCheck (#1343 r2)", () => {
  const planned: PlannedLeg[] = [
    { leg: "merge-tree", commit: "b..h", installCmd: "", legCmd: "", resultKey: "k1", baselineKeys: [] },
    { leg: "e2e", commit: "b..h", installCmd: "i", legCmd: "c", resultKey: "k2", baselineKeys: [], browser: true },
    { leg: "lint", commit: "b..h", installCmd: "i", legCmd: "c", resultKey: "k3", baselineKeys: [] },
  ];

  it("a carried green browser leg is exempt (never re-checked under the new run)", () => {
    const carried = new Map([["e2e", { leg: "e2e", state: "success" as const }]]);
    expect(browserLegsToCheck(planned, carried)).toEqual([]);
  });

  it("a non-carried browser leg IS checked", () => {
    expect(browserLegsToCheck(planned, new Map())).toEqual(["e2e"]);
  });

  it("a carried leg under a DIFFERENT name never exempts a browser leg of the same name", () => {
    const carried = new Map([["other", { leg: "other", state: "success" as const }]]);
    expect(browserLegsToCheck(planned, carried)).toEqual(["e2e"]);
  });

  it("a carried leg that is NOT green (failure/error) is still checked", () => {
    const carried = new Map([["e2e", { leg: "e2e", state: "failure" as const }]]);
    expect(browserLegsToCheck(planned, carried)).toEqual(["e2e"]);
  });
});
