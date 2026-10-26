// #1343: browser-leg semantics. A browser leg is a real verdict only when
// spec evidence exists; zero specs or a skipped leg is RED DID-NOT-RUN.
import { describe, it, expect } from "bun:test";
import {
  DID_NOT_RUN, didNotRunDescription, enforceBrowserLeg, enforceBrowserLegs, verdictEvidenceUrl,
} from "../../src/gate/browser-leg";
import type { LegResult } from "../../src/gate/verdict";

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