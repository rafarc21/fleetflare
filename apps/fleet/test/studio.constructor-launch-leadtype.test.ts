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
import { constructorLaunch } from "../src/studio/do";
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
    const out = constructorLaunch(fakeEnv(), STUDIO, SPAWN, row({ leadType: "glm", launchedAccount: "acme" }));
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
