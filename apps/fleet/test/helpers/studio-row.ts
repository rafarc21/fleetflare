import type { StudioStatus } from "../../src/studio/types";
import type { Burn } from "../../src/studio/burn";

// Sweep-3 S3-F2 (#372): one fixture for the 9-null StudioStatus literal the
// test suite hand-wrote a dozen times. Defaults are the sweep's census
// defaults; a caller whose old builder differed passes its own id/state as
// overrides rather than re-spelling the nulls.
export function row(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "acme-os--maestro", state: "stopped", tailscaleHost: null, lastRefresh: null,
    error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null,
    repoSlug: null, ...overrides,
  };
}

export const runningRow = (o: Partial<StudioStatus> = {}) => row({ state: "running", ...o });
export const stoppedRow = (o: Partial<StudioStatus> = {}) => row({ state: "stopped", ...o });

// Sweep-18 F9 (#596): the zero Burn literal that co-travels with row().
// window5hStart has NO default — the two adopting sites genuinely diverge
// (grid: now per issue #181; cli.fleet: frozen 2026-08-16), so each caller
// pins its own; a call without it is a type error, not a silent zero. No
// default parameter either, for the same reason: a default would make the
// "required" spelling optional again and let a forgotten window5hStart
// compile — every caller passes one.
export function burnRow(o: { window5hStart: string } & Partial<Burn>): Burn {
  return { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, window5hOutput: 0, ...o };
}
