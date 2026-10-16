import { describe, expect, test } from "bun:test";
import { formatAccount, formatTable } from "../../cli/fleet";
import { leadModelOf } from "../../cli/lead-model";
import { runningRow as row } from "../helpers/studio-row";

// Issue #1074 (maintainer review, CHANGE NEEDED): no new positional column.
// Monitors parse `fleet ls` rows by column position, so the header must stay
// exactly main's 17 columns, in main's order. A non-Claude lead's model rides
// inside the existing ACCOUNT cell instead.
const MAIN_HEADERS = [
  "ID", "REPO", "STATE", "RST", "WIP", "PRS", "READY", "SESSION", "ACTIVITY",
  "INFER", "CHECKED", "ROW", "ACCOUNT", "HOST", "BURN", "REFRESHED", "ERROR",
];
const ASSIGN: Record<string, string> = {
  "beta--pilot": "@cf/zai-org/glm-5.3",
  "websites--pilot": "@cf/moonshotai/kimi-k2.7-code",
};

describe("fleet ls column count (#1074)", () => {
  test("the header row is main's 17 columns, in main's order — no MODEL column", () => {
    const header = formatTable([row({ id: "acme-os--maestro" })]).split("\n")[0];
    expect(header.trim().split(/\s+/)).toEqual(MAIN_HEADERS);
  });

  test("a glm lead's model sits inside the ACCOUNT column, at ACCOUNT's own position", () => {
    const studios = [row({ id: "beta--pilot", leadType: "glm", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" })];
    const [header, data] = formatTable(studios, new Date(), null, undefined, undefined, ASSIGN).split("\n");
    expect(data.slice(header.indexOf("ACCOUNT"))).toMatch(/^glm:glm-5\.3/);
  });
});

describe("ACCOUNT cell for a non-Claude lead (#1074)", () => {
  test("a glm lead shows its assigned model: glm:glm-5.3", () => {
    expect(formatAccount(row({ id: "beta--pilot", leadType: "glm", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }), leadModelOf(row({ id: "beta--pilot", leadType: "glm", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }), ASSIGN)))
      .toBe("glm:glm-5.3");
  });

  test("a pool-pinned glm lead shows its pool key and short model id: kimi:kimi-k2.7-code", () => {
    expect(formatAccount(row({ id: "websites--pilot", leadType: "glm", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }), leadModelOf(row({ id: "websites--pilot", leadType: "glm", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }), ASSIGN)))
      .toBe("kimi:kimi-k2.7-code");
  });

  test("a glm lead with no assignment shows the bare type, never the Claude token name", () => {
    expect(formatAccount(row({ id: "gamma--pilot", leadType: "glm", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }), leadModelOf(row({ id: "gamma--pilot", leadType: "glm", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }), ASSIGN)))
      .toBe("glm");
  });

  test("a Claude lead's ACCOUNT cell is unchanged by the assignments map", () => {
    const claude = row({ id: "websites--pilot", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(formatAccount(claude, leadModelOf(claude, ASSIGN))).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
