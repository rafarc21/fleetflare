// #1343: browser-leg semantics. A browser leg is a real verdict only when
// spec evidence exists; zero specs or a skipped leg is RED DID-NOT-RUN.
// #1381: the manifest's COUNT breakdown decides that — `executed` alone is a
// SCHEDULED count and never greens.
import { describe, it, expect } from "bun:test";
import {
  browserLegsToCheck, classifyManifest, DID_NOT_RUN, didNotRunDescription, enforceBrowserLeg, enforceBrowserLegs, manifestReadFrom, verdictEvidenceUrl,
} from "../../src/gate/browser-leg";
import { resultKeysPrefix } from "../../src/gate/log";
import type { LegResult } from "../../src/gate/verdict";
import type { PlannedLeg } from "../../src/gate/fanout";

const proven = { kind: "proven" } as const;
const absent = { kind: "absent" } as const;

describe("enforceBrowserLeg: zero specs -> RED DID-NOT-RUN", () => {
  it("a success with no evidence downgrades to failure DID-NOT-RUN", () => {
    expect(enforceBrowserLeg("e2e", { leg: "e2e", state: "success" }, absent)).toEqual({
      leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (no spec evidence)`,
    });
  });

  it("a success with a proven manifest passes through", () => {
    expect(enforceBrowserLeg("e2e", { leg: "e2e", state: "success" }, proven)).toEqual({
      leg: "e2e", state: "success",
    });
  });

  it("a failure or error never downgrades (it is already red)", () => {
    const failure: LegResult = { leg: "e2e", state: "failure", description: "3 failed" };
    expect(enforceBrowserLeg("e2e", failure, absent)).toEqual(failure);
    const error: LegResult = { leg: "e2e", state: "error", description: "crash" };
    expect(enforceBrowserLeg("e2e", error, absent)).toEqual(error);
  });
});

describe("enforceBrowserLegs: a skipped browser leg -> RED DID-NOT-RUN", () => {
  const browser = new Set(["e2e"]);
  const noManifests = new Map();

  it("a browser leg with no result is filled as DID-NOT-RUN, never left missing", () => {
    const out = enforceBrowserLegs(["merge-tree", "e2e"], [{ leg: "merge-tree", state: "success" }], browser, noManifests);
    expect(out).toEqual([
      { leg: "merge-tree", state: "success" },
      { leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (no spec evidence)` },
    ]);
  });

  it("a browser success without evidence downgrades, keeping sibling results", () => {
    const out = enforceBrowserLegs(
      ["merge-tree", "e2e"],
      [{ leg: "merge-tree", state: "success" }, { leg: "e2e", state: "success" }],
      browser, noManifests,
    );
    expect(out[1]).toEqual({ leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (no spec evidence)` });
    expect(out[0].state).toBe("success");
  });

  it("a proven manifest keeps the browser success", () => {
    const out = enforceBrowserLegs(
      ["e2e"], [{ leg: "e2e", state: "success" }], browser, new Map([["e2e", proven]]),
    );
    expect(out).toEqual([{ leg: "e2e", state: "success" }]);
  });

  it("plain legs are untouched: their missing report stays the verdict's own pending", () => {
    const out = enforceBrowserLegs(["lint", "e2e"], [{ leg: "e2e", state: "success" }], browser, noManifests);
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

// #1381: the manifest's counts decide the verdict. `executed` alone is a
// SCHEDULED count (the defect's manifest said 317, only 221 ran) and must
// never green a leg.
describe("classifyManifest (#1381)", () => {
  const full = { executed: 221, passed: 2, failed: 219, flaky: 0, skipped: 0, didNotRun: 0 };

  it("proven when counts present, outcomes > 0, didNotRun == 0", () => {
    expect(classifyManifest(full)).toEqual({ kind: "proven" });
    expect(classifyManifest({ executed: 221, passed: 2, failed: 219, flaky: 0, skipped: 0, didNotRun: 0 })).toEqual({ kind: "proven" });
  });

  it("did-not-run when passed+failed+flaky == 0 (all interrupted/did not run)", () => {
    expect(classifyManifest({ executed: 317, passed: 0, failed: 0, flaky: 0, skipped: 0, didNotRun: 0 }))
      .toEqual({ kind: "did-not-run" });
  });

  it("incomplete when didNotRun > 0 alongside real outcomes", () => {
    expect(classifyManifest({ executed: 317, passed: 2, failed: 219, flaky: 0, skipped: 44, didNotRun: 52 }))
      .toEqual({ kind: "incomplete", didNotRun: 52 });
  });

  it("unverified (lacks counts) for the old {executed} schema", () => {
    expect(classifyManifest({ executed: 3 })).toEqual({ kind: "unverified" });
    expect(classifyManifest({ executed: 0 })).toEqual({ kind: "unverified" });
    expect(classifyManifest({})).toEqual({ kind: "unverified" });
    expect(classifyManifest(null)).toEqual({ kind: "unverified" });
    expect(classifyManifest("x")).toEqual({ kind: "unverified" });
  });

  it("malformed when a count is not a non-negative integer (never coerced)", () => {
    // `Number(v)` would turn these into 0/1/5 and green a didNotRun:null —
    // the type check refuses them instead.
    expect(classifyManifest({ ...full, didNotRun: null })).toEqual({ kind: "malformed" });
    expect(classifyManifest({ ...full, didNotRun: false })).toEqual({ kind: "malformed" });
    expect(classifyManifest({ ...full, didNotRun: true })).toEqual({ kind: "malformed" });
    expect(classifyManifest({ ...full, didNotRun: "" })).toEqual({ kind: "malformed" });
    expect(classifyManifest({ ...full, didNotRun: [] })).toEqual({ kind: "malformed" });
    expect(classifyManifest({ ...full, executed: "three" })).toEqual({ kind: "malformed" });
    expect(classifyManifest({ ...full, executed: "5" })).toEqual({ kind: "malformed" });
    expect(classifyManifest({ ...full, failed: -1 })).toEqual({ kind: "malformed" });
    expect(classifyManifest({ ...full, passed: 1.5 })).toEqual({ kind: "malformed" });
  });

  it("inconsistent when executed < passed + failed + flaky", () => {
    expect(classifyManifest({ executed: 2, passed: 2, failed: 1, flaky: 0, skipped: 0, didNotRun: 0 }))
      .toEqual({ kind: "inconsistent" });
    // Equal is fine (flaky overlaps failed): executed == outcomes is consistent.
    expect(classifyManifest({ executed: 3, passed: 2, failed: 1, flaky: 0, skipped: 0, didNotRun: 0 }))
      .toEqual({ kind: "proven" });
  });
});

// #1381 r1: the workflow's manifest-read glue — an absent manifest reads
// absent (DID-NOT-RUN), a present-but-unparseable one reads unverified.
describe("manifestReadFrom (#1381 r1)", () => {
  it("absent when the file is not present, regardless of parsed content", () => {
    expect(manifestReadFrom({ kind: "proven" }, false)).toEqual({ kind: "absent" });
    expect(manifestReadFrom(null, false)).toEqual({ kind: "absent" });
  });

  it("classifies a present manifest; a parse failure (null) reads unverified", () => {
    expect(manifestReadFrom({ executed: 2, passed: 2, failed: 0, flaky: 0, skipped: 0, didNotRun: 0 }, true))
      .toEqual({ kind: "proven" });
    expect(manifestReadFrom(null, true)).toEqual({ kind: "unverified" });
  });
});

// #1381: a success whose manifest lacks counts, or declares zero outcomes /
// did-not-run, is RED — the leg would otherwise read green.
describe("enforceBrowserLeg: manifest count verdicts (#1381)", () => {
  const success: LegResult = { leg: "e2e", state: "success" };

  it("unverified manifest -> RED 'manifest lacks counts'", () => {
    expect(enforceBrowserLeg("e2e", success, { kind: "unverified" })).toEqual({
      leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (manifest lacks counts)`,
    });
  });

  it("malformed manifest -> RED 'manifest counts malformed'", () => {
    expect(enforceBrowserLeg("e2e", success, { kind: "malformed" })).toEqual({
      leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (manifest counts malformed)`,
    });
  });

  it("inconsistent manifest -> RED 'manifest counts inconsistent'", () => {
    expect(enforceBrowserLeg("e2e", success, { kind: "inconsistent" })).toEqual({
      leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (manifest counts inconsistent)`,
    });
  });

  it("zero outcomes -> RED 'no test reached an outcome'", () => {
    expect(enforceBrowserLeg("e2e", success, { kind: "did-not-run" })).toEqual({
      leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (no test reached an outcome)`,
    });
  });

  it("didNotRun > 0 -> RED with the count", () => {
    expect(enforceBrowserLeg("e2e", success, { kind: "incomplete", didNotRun: 52 })).toEqual({
      leg: "e2e", state: "failure", description: `${DID_NOT_RUN}: e2e (52 did not run)`,
    });
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