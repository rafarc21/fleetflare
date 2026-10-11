import { describe, it, expect } from "vitest";
import type { StudioStatus } from "../src/studio/types";
import { row, runningRow, stoppedRow } from "./helpers/studio-row";

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
