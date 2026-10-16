// apps/fleet/test/studio.constructor-launch-leadtype.test.ts
//
// Issue #911: a DO restart or container replace auto-starts the container
// from StudioDO's constructor (do.ts constructorLaunch). That path read only
// the recorded account, never the row's leadType, so a glm-led studio whose
// row carried a stale Claude `launchedAccount` came back with
// CLAUDE_CODE_OAUTH_TOKEN in its start env and the lead ran on a Claude
// account. A glm lead's start env must be the router env, always.
import { describe, it, expect } from "vitest";
import type { Env } from "../src/env";
import { constructorLaunch, launchFields, placeholderEnvVars } from "../src/studio/do";
import type { StudioStatus } from "../src/studio/types";

const FAKE_OAUTH = "sk-ant-oat01-" + "a".repeat(40);
const SPAWN = "spawn-token-fixture";
const STUDIO = "acme-app--web-studio";

function fakeEnv(): Env {
  return {
    CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH,
    WORKER_PUBLIC_URL: "https://fleet.example.test",
    TS_AUTHKEY: "",
  } as unknown as Env;
}

function row(partial: Partial<StudioStatus>): StudioStatus {
  return { id: STUDIO, ...partial } as StudioStatus;
}

describe("constructorLaunch honours leadType (#911)", () => {
  it("glm row with a stale Claude launchedAccount starts on the router, never on Claude", () => {
    const out = constructorLaunch(fakeEnv(), STUDIO, SPAWN, row({ leadType: "glm", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }));
    expect(out.envVars.ANTHROPIC_BASE_URL).toBe("https://fleet.example.test/fleet/llm/anthropic");
    expect(out.envVars.ANTHROPIC_AUTH_TOKEN).toBe(SPAWN);
    expect(out.envVars).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(out.envAccount).toBeUndefined();
  });

  it("glm row with no recorded account still gets the router env and no Claude token", () => {
    const out = constructorLaunch(fakeEnv(), STUDIO, SPAWN, row({ leadType: "glm" }));
    expect(out.envVars.ANTHROPIC_BASE_URL).toBe("https://fleet.example.test/fleet/llm/anthropic");
    expect(out.envVars).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(out.envAccount).toBeUndefined();
  });
});

// Issue #1142, item 4 — the first case above must name a real configured
// account. "acme" is not a secret, so the lookup misses and the glm branch is
// not the thing under test; CLAUDE_CODE_OAUTH_TOKEN is the account fakeEnv
// carries, so without the glm branch this row WOULD start on Claude.

// Issue #1142, item 1 — onSwitched rebuilds the start env after a failover
// switch with the row's leadType (pinned in test/studio.account-launched.test.ts).
// Here: launchFields with leadType glm ignores the account name a switch reports.
describe("launchFields(glm) ignores a switched-to Claude account name (#1142 item 1)", () => {
  it("glm row switched to a named Claude account still starts on the router, never on Claude", () => {
    const out = launchFields(fakeEnv(), STUDIO, SPAWN, "CLAUDE_CODE_OAUTH_TOKEN", "glm");
    expect(out.envVars.ANTHROPIC_BASE_URL).toBe("https://fleet.example.test/fleet/llm/anthropic");
    expect(out.envVars).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(out.envAccount).toBeUndefined();
  });
});

// Issue #1142, item 5 — the field-initializer placeholder (the env a DO boots
// with before the constructor's storage read resolves) must never carry a
// mapped Claude token: a glm studio whose read failed would boot on Claude.
describe("placeholderEnvVars carries no Claude token (#1142 item 5)", () => {
  it("the placeholder's CLAUDE_CODE_OAUTH_TOKEN is empty, never the mapped account token", () => {
    const out = placeholderEnvVars(fakeEnv(), STUDIO, SPAWN);
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(FAKE_OAUTH);
  });
});
