import { describe, it, expect } from "vitest";
import { reapTerminalAll, type TerminalPage } from "../cli/reap-terminal";

// Issue #55: the Worker closes one page per request; the CLI asks again while
// `remaining` > 0. Imports cli/reap-terminal.ts, not cli/fleet.ts.

const page = (closed: number[], remaining: number, errors: number[] = []): TerminalPage => ({
  repo: "example-org/demo", apply: true, terminal: true, remaining,
  results: [
    ...closed.map((number) => ({ number, state: "completed", outcome: "closed", reason: "completed" })),
    ...errors.map((number) => ({ number, state: "failed", outcome: "error", reason: "not_planned", error: "502" })),
  ],
});

describe("reapTerminalAll", () => {
  it("asks again while remaining > 0, collecting every page", async () => {
    const pages = [page([1, 2], 2), page([3, 4], 0)];
    let calls = 0;
    const all = await reapTerminalAll(async () => pages[calls++]);
    expect(calls).toBe(2);
    expect(all.results.map((r) => r.number)).toEqual([1, 2, 3, 4]);
    expect(all.remaining).toBe(0);
  });

  it("stops when a page closed nothing (every close failed), instead of looping", async () => {
    let calls = 0;
    const all = await reapTerminalAll(async () => { calls++; return page([], 5, [1, 2]); });
    expect(calls).toBe(1);
    expect(all.remaining).toBe(5);
  });

  it("a dry run is one request", async () => {
    let calls = 0;
    const dry = { ...page([], 0), apply: false };
    await reapTerminalAll(async () => { calls++; return dry; });
    expect(calls).toBe(1);
  });
});
