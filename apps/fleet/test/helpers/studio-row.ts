import type { StudioStatus } from "../../src/studio/types";

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
