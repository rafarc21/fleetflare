// GateWorkflow itself needs a live Workflow/DO/GitHub round trip — not
// unit-testable here. This pins the one pure decision the Workflow's own
// fan-in step makes before calling postCommitStatus: the (state, description)
// pair a commit status needs. The description is the per-leg roster (#1049
// addendum item 5), built from the planned leg names and their results.
//
// Imported from fanout.ts, not workflow.ts: workflow.ts imports
// cloudflare:workers (WorkflowEntrypoint), which bun test cannot load.
import { describe, it, expect } from "bun:test";
import { parseSummaryCounts, verdictToStatusArgs } from "../../src/gate/fanout";
import type { LegResult } from "../../src/gate/verdict";

const RUN_ID = "0123456789abcdef"; // the Workflow instance id; the roster shows its first 8
const ID8 = `(run ${RUN_ID})`;

const green = (leg: string, description?: string): LegResult => ({ leg, state: "success", description });
const red = (leg: string, state: "failure" | "error" = "failure"): LegResult => ({ leg, state, description: "x" });

describe("verdictToStatusArgs: the roster description", () => {
  it("success reads '<n>/<n> green (run <id8>)'", () => {
    const args = verdictToStatusArgs({ state: "success" }, {
      expected: ["lint", "bun-1"], results: [green("lint"), green("bun-1")], runId: RUN_ID,
    });
    expect(args).toEqual({ state: "success", description: `2/2 green ${ID8}` });
  });

  it("a flaky pass is named in the success roster, not counted as a plain ok", () => {
    const args = verdictToStatusArgs({ state: "success" }, {
      expected: ["lint", "bun-1"], results: [green("lint"), green("bun-1", "flaky: passed on retry")], runId: RUN_ID,
    });
    expect(args).toEqual({ state: "success", description: `2/2 green (1 flaky: bun-1) ${ID8}` });
  });

  it("one red leg reads '<green>/<total> green; red: <leg> (run <id8>)'", () => {
    const args = verdictToStatusArgs({ state: "failure", description: "vitest-1 failed" }, {
      expected: ["lint", "vitest-1", "vitest-2"],
      results: [green("lint"), red("vitest-1"), green("vitest-2")],
      runId: RUN_ID,
    });
    expect(args).toEqual({ state: "failure", description: `2/3 green; red: vitest-1 ${ID8}` });
  });

  it("an error leg is non-green and listed too", () => {
    const args = verdictToStatusArgs({ state: "error", description: "GateRunnerDO OOM" }, {
      expected: ["lint", "bun-1"], results: [green("lint"), red("bun-1", "error")], runId: RUN_ID,
    });
    expect(args).toEqual({ state: "error", description: `1/2 green; red: bun-1 ${ID8}` });
  });

  it("a leg with no report counts as red, so a pending verdict names it", () => {
    const args = verdictToStatusArgs({ state: "error", description: "no legs reported" }, {
      expected: ["lint", "vitest-1", "vitest-2"], results: [green("lint")], runId: RUN_ID,
    });
    expect(args).toEqual({ state: "error", description: `1/3 green; red: vitest-1, vitest-2 ${ID8}` });
  });

  it("many reds: the list is truncated with '+N more' and the whole text stays within 140 chars", () => {
    const expected = Array.from({ length: 60 }, (_, i) => `vitest-${i + 1}`);
    const args = verdictToStatusArgs({ state: "failure", description: "x" }, {
      expected, results: expected.map((l) => red(l)), runId: RUN_ID,
    });
    expect(args.description.length).toBeLessThanOrEqual(140);
    expect(args.description).toMatch(/^0\/60 green; red: vitest-1, .*, \+\d+ more \(run 0123456789abcdef\)$/);
  });
});

// #1449: parse the test-summary line the container stored into per-leg
// executed/skipped counts. Only the formats the container actually writes
// (vitest's "Tests ... (N)" and bun's "N pass, M fail[, K skip]") count.
describe("parseSummaryCounts: executed/skipped from a stored summary (#1449)", () => {
  it("vitest with a skipped count: run = total - skipped", () => {
    expect(parseSummaryCounts("Tests  1 failed | 1640 passed | 2 skipped (1643)")).toEqual({ run: 1641, skipped: 2 });
    expect(parseSummaryCounts("Tests  12 skipped (4210)")).toEqual({ run: 4198, skipped: 12 });
  });

  it("vitest without a skipped count: skipped 0", () => {
    expect(parseSummaryCounts("Tests  1 failed | 1640 passed (1641)")).toEqual({ run: 1641, skipped: 0 });
    expect(parseSummaryCounts("Tests 1 failed")).toBeNull();
  });

  it("bun 'N pass, M fail': run = pass + fail, skipped 0", () => {
    expect(parseSummaryCounts("1640 pass, 1 fail")).toEqual({ run: 1641, skipped: 0 });
    expect(parseSummaryCounts("5 pass")).toEqual({ run: 5, skipped: 0 });
  });

  it("bun skip lines are not stored, so a bun leg's skipped reads 0", () => {
    expect(parseSummaryCounts("1640 pass, 1 fail, 2 skip")).toEqual({ run: 1641, skipped: 0 });
    expect(parseSummaryCounts("0 pass, 0 fail")).toEqual({ run: 0, skipped: 0 });
  });

  it("nothing parseable -> null (never a fabricated count)", () => {
    expect(parseSummaryCounts(undefined)).toBeNull();
    expect(parseSummaryCounts("")).toBeNull();
    expect(parseSummaryCounts("merge-tree ok")).toBeNull();
  });
});

// #1449: a run that reports test counts carries them in the roster description.
describe("verdictToStatusArgs: executed/skipped totals (#1449)", () => {
  const run = (state: "success" | "failure", results: (LegResult & { summary?: string })[]) =>
    verdictToStatusArgs({ state } as never, { expected: results.map((r) => r.leg), results, runId: RUN_ID });

  it("a green roster appends 'tests N run, M skipped' when counts parse", () => {
    const args = run("success", [
      { leg: "lint", state: "success", summary: "5 pass" },
      { leg: "bun-1", state: "success", summary: "Tests  1 failed | 1640 passed | 2 skipped (1643)" },
    ]);
    expect(args.description).toBe(`2/2 green; tests 1646 run, 2 skipped ${ID8}`);
  });

  it("totals are conditional: no parseable summary keeps the legacy text byte-identical", () => {
    const args = run("success", [green("lint"), green("bun-1")]);
    expect(args.description).toBe(`2/2 green ${ID8}`);
  });

  it("a leg that ran zero tests is flagged, not failed", () => {
    const args = run("success", [
      { leg: "lint", state: "success", summary: "5 pass" },
      { leg: "bun-1", state: "success", summary: "0 pass, 0 fail" },
    ]);
    expect(args.description).toBe(`2/2 green; tests 5 run, 0 skipped; 1 leg ran 0 tests ${ID8}`);
    expect(args.state).toBe("success");
  });

  it("a red roster carries totals too, after the leg list", () => {
    const args = run("failure", [
      green("lint"),
      { leg: "vitest-1", state: "failure", description: "x", summary: "Tests  1 failed | 1393 passed (1394)" },
      { leg: "vitest-2", state: "success", summary: "1393 pass" },
    ]);
    expect(args.description).toBe(`2/3 green; red: vitest-1; tests 2787 run, 0 skipped ${ID8}`);
  });

  it("totals never push the description past GitHub's 140-char cap", () => {
    const expected = Array.from({ length: 60 }, (_, i) => `vitest-${i + 1}-with-a-long-name`);
    const args = verdictToStatusArgs({ state: "failure", description: "x" }, {
      expected, results: expected.map((l) => red(l)), runId: RUN_ID,
    });
    expect(args.description.length).toBeLessThanOrEqual(140);
    expect(args.description.endsWith(`(run ${RUN_ID})`)).toBe(true);
  });
});

// #1343 LOW: a DID-NOT-RUN browser leg is named in the roster, not just "red".
describe("verdictToStatusArgs: DID-NOT-RUN roster text (#1343 LOW)", () => {
  it("names a DID-NOT-RUN leg with its marker", () => {
    const args = verdictToStatusArgs({ state: "failure", description: "DID-NOT-RUN: e2e (no spec evidence)" }, {
      expected: ["merge-tree", "e2e"], runId: RUN_ID,
      results: [
        green("merge-tree"),
        { leg: "e2e", state: "failure", description: "DID-NOT-RUN: e2e (no spec evidence)" },
      ],
    });
    expect(args.description).toContain("e2e (DID-NOT-RUN)");
  });
});
