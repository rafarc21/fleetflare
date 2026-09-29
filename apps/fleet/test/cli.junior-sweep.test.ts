import { describe, it, expect } from "vitest";
import { sweepAllPages, type SweepPage } from "../cli/junior-sweep";

// Issue #41: the Worker sweeps one page per request; the CLI follows `next`.
// Imports cli/junior-sweep.ts, not cli/fleet.ts (bun-only globals).

const page = (numbers: number[], next: number | null): SweepPage => ({
  repo: "example-org/demo", apply: false, next,
  results: numbers.map((number) => ({ number, outcome: "kept", reason: "working" })),
});

describe("sweepAllPages", () => {
  it("follows next until null, sending each cursor back as after", async () => {
    const asked: (number | null)[] = [];
    const pages = [page([1, 2], 2), page([3, 4], 4), page([5], null)];
    const all = await sweepAllPages(async (after) => { asked.push(after); return pages[asked.length - 1]; });
    expect(asked).toEqual([null, 2, 4]);
    expect(all.results.map((r) => r.number)).toEqual([1, 2, 3, 4, 5]);
    expect(all.repo).toBe("example-org/demo");
  });

  it("one page when next is null (or absent, an older Worker)", async () => {
    let calls = 0;
    const old = { ...page([1], null) } as Partial<SweepPage>;
    delete old.next;
    const all = await sweepAllPages(async () => { calls++; return old as SweepPage; });
    expect(calls).toBe(1);
    expect(all.results).toHaveLength(1);
  });

  it("a cursor that does not advance stops instead of looping forever", async () => {
    let calls = 0;
    await expect(sweepAllPages(async () => { calls++; return page([1], 1); })).rejects.toThrow(/did not advance/);
    expect(calls).toBe(2);
  });
});
