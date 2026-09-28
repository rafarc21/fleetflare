import { describe, expect, test } from "bun:test";
import { formatTable } from "../../cli/fleet";
import type { StudioStatus } from "../../src/studio/types";

// Issues #289/#285: the ACCOUNT cell. The Worker stamps the LAUNCHED account
// into claudeAccount (withAccountDisplay), the next launch's account into
// claudeAccountNext when they differ, and launchedAccount: null for a refused
// launch that left nothing running on a named account.
function row(overrides: Partial<StudioStatus>): StudioStatus {
  return {
    id: "demosite-life--pilot", state: "running", tailscaleHost: null, lastRefresh: null,
    error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null,
    repoSlug: null, ...overrides,
  };
}

function accountCell(s: StudioStatus): string {
  const [header, line] = formatTable([s]).split("\n");
  const at = header.indexOf("ACCOUNT");
  const next = header.indexOf("HOST");
  return line.slice(at, next).trim();
}

describe("fleet ls — ACCOUNT cell (#289, #285)", () => {
  test("launched on one account, next launch on another: both named", () => {
    expect(accountCell(row({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN", claudeAccountNext: "CLAUDE_CODE_OAUTH_TOKEN_2" })))
      .toBe("CLAUDE_CODE_OAUTH_TOKEN (next launch: CLAUDE_CODE_OAUTH_TOKEN_2)");
  });

  test("the label rides with the launched account, the note after it", () => {
    expect(accountCell(row({
      claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN", claudeAccountLabel: "first@example.com",
      launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN", claudeAccountNext: "CLAUDE_CODE_OAUTH_TOKEN_2",
    }))).toBe("first@example.com (CLAUDE_CODE_OAUTH_TOKEN) (next launch: CLAUDE_CODE_OAUTH_TOKEN_2)");
  });

  test("a refused launch reads '-', never a stale or default name", () => {
    expect(accountCell(row({ state: "degraded", error: "claude account: refused", launchedAccount: null, claudeAccount: null }))).toBe("-");
  });

  test("no launch record (#292 r2): `?` with the next launch's account", () => {
    expect(accountCell(row({ claudeAccount: "?", claudeAccountNext: "CLAUDE_CODE_OAUTH_TOKEN_2" })))
      .toBe("? (next launch: CLAUDE_CODE_OAUTH_TOKEN_2)");
  });

  test("a row from before #289 (no launchedAccount) reads as it always did", () => {
    expect(accountCell(row({}))).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(accountCell(row({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }))).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });
});
