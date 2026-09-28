import { describe, expect, test } from "bun:test";
import { formatTable } from "../../cli/fleet";
import type { StudioStatus } from "../../src/studio/types";

// Issue #95: formatTable's STATE column must go through formatState, or the
// detector's verdict never reaches the operator's screen.
function row(overrides: Partial<StudioStatus>): StudioStatus {
  return {
    id: "acme-os--maestro", state: "stopped", tailscaleHost: null, lastRefresh: null,
    error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null,
    repoSlug: null, ...overrides,
  };
}

describe("fleet ls — stopped studio whose container runs", () => {
  test("STATE says the container is running and billing", () => {
    const out = formatTable([row({ containerRunningSince: "2026-09-24T12:39:08.000Z" })]);
    expect(out).toContain("stopped (container RUNNING since 12:39Z — billing)");
  });
});

describe("fleet ls — ROW column (#55)", () => {
  test("prints the local Orca row verdict per studio", () => {
    const out = formatTable([row({})], new Date(), new Map([["acme-os--maestro", "STALE row"]]));
    expect(out.split("\n")[0]).toContain("ROW");
    expect(out).toContain("STALE row");
  });
  test("reads '-' when no row map (not under Orca)", () => {
    expect(formatTable([row({})]).split("\n")[0]).toContain("ROW");
  });
});

// Issue #271: the ACCOUNT column names the secret, and its label when one is set.
describe("fleet ls — ACCOUNT column labels (#271)", () => {
  test("label present: '<label> (<secret name>)'", () => {
    const out = formatTable([row({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2", claudeAccountLabel: "second@example.com" })]);
    expect(out).toContain("second@example.com (CLAUDE_CODE_OAUTH_TOKEN_2)");
  });
  test("label on a studio with no recorded account names the first secret", () => {
    const out = formatTable([row({ claudeAccountLabel: "first@example.com" })]);
    expect(out).toContain("first@example.com (CLAUDE_CODE_OAUTH_TOKEN)");
  });
  test("label absent: the secret name, as today", () => {
    const out = formatTable([row({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" })]);
    expect(out).toContain("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(out).not.toContain("(CLAUDE_CODE_OAUTH_TOKEN_2)");
  });
});
