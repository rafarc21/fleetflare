import { describe, it, expect } from "vitest";
import type { StudioStatus } from "../src/studio/types";
import { row, runningRow, stoppedRow, burnRow } from "./helpers/studio-row";

// Sweep-3 S3-F2 (#372): golden table for the shared studio-row fixture —
// every migrated suite's old hand-written builder must equal one of these.

const BASE = {
  id: "acme-os--maestro", state: "stopped", tailscaleHost: null, lastRefresh: null,
  error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null,
  repoSlug: null,
} as const;

describe("studio-row helper", () => {
  it("row() is exactly the census base, no extra keys", () => {
    expect(row()).toStrictEqual(BASE);
  });

  it("row(overrides) applies the override and keeps every other default", () => {
    // "x" is a sentinel, not a real Burn — only override priority is under test.
    expect(row({ burn: "x" as unknown as StudioStatus["burn"] })).toStrictEqual({ ...BASE, burn: "x" });
  });

  it("runningRow() and stoppedRow() set state and change nothing else", () => {
    expect(runningRow().state).toBe("running");
    expect(stoppedRow().state).toBe("stopped");
    expect(runningRow()).toStrictEqual({ ...BASE, state: "running" });
    expect(stoppedRow()).toStrictEqual(BASE);
  });

  it("runningRow(overrides) keeps the running state and applies the id", () => {
    const r = runningRow({ id: "z" });
    expect(r.state).toBe("running");
    expect(r.id).toBe("z");
  });

  it("stoppedRow(overrides) applies the override on the stopped base", () => {
    const r = stoppedRow({ spawnTokenHash: "h" });
    expect(r.state).toBe("stopped");
    expect(r.spawnTokenHash).toBe("h");
  });
});

// Sweep-18 F9 (#596): golden table for burnRow — the zero Burn literal that
// co-travels with row(). window5hStart is REQUIRED (no default): the two
// adopting sites genuinely diverge, so a call without it must not compile.
describe("burnRow", () => {
  it("burnRow({window5hStart}) is exactly the zero Burn, no extra keys", () => {
    expect(burnRow({ window5hStart: "2026-08-16T00:00:00.000Z" })).toStrictEqual({
      turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
      window5hStart: "2026-08-16T00:00:00.000Z", window5hOutput: 0,
    });
  });

  it("a call without window5hStart is a type error, not a silent zero", () => {
    // Compile-time pin: window5hStart is REQUIRED, so this call fails
    // type-checking — the @ts-expect-error directive is the assertion. The
    // runtime half pins the same design's other edge: the helper never
    // fabricates a window5hStart either, so there is no silent zero to fall
    // back on when a caller forgets one.
    // @ts-expect-error window5hStart is required
    const silent = burnRow();
    expect(silent.window5hStart).toBeUndefined();
  });

  it("burnRow({..., turns}) overrides the zero default for that key alone", () => {
    const b = burnRow({ window5hStart: "x", turns: 7 });
    expect(b.turns).toBe(7);
    expect(b.window5hStart).toBe("x");
    expect(b.inputTokens).toBe(0);
    expect(b.outputTokens).toBe(0);
    expect(b.costUsd).toBe(0);
    expect(b.window5hOutput).toBe(0);
  });
});
