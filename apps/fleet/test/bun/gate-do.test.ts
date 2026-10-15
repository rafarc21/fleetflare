import { describe, it, expect } from "bun:test";
import { buildLegEnvVars, type GateLegRequest } from "../../src/gate/leg-env";

describe("buildLegEnvVars", () => {
  it("carries every leg field into the container's env, no token or URL field", () => {
    const req: GateLegRequest = {
      owner: "acme", repo: "example", commit: "abc123", leg: "typecheck",
      installCmd: "bun install --frozen-lockfile", legCmd: "bun run check",
      resultKey: "gate/acme/example/runs/715/shard-typecheck.json",
      baselineKeys: ["gate/acme/example/baselines/mainsha-lockhash.tar"],
    };
    const env = buildLegEnvVars(req);
    expect(env).toEqual({
      GATE_REPO: "acme/example", GATE_COMMIT: "abc123", GATE_LEG: "typecheck",
      GATE_INSTALL_CMD: "bun install --frozen-lockfile", GATE_LEG_CMD: "bun run check",
      GATE_RESULT_KEY: "gate/acme/example/runs/715/shard-typecheck.json",
      GATE_BASELINE_KEYS: "gate/acme/example/baselines/mainsha-lockhash.tar",
    });
    expect(Object.keys(env).join(",")).not.toMatch(/token/i);
    expect(Object.values(env).join(",")).not.toMatch(/https?:\/\//);
  });

  it("empty baselineKeys -> empty string, not undefined", () => {
    const req: GateLegRequest = {
      owner: "acme", repo: "example", commit: "abc123", leg: "lint",
      installCmd: "x", legCmd: "y", resultKey: "z", baselineKeys: [],
    };
    expect(buildLegEnvVars(req).GATE_BASELINE_KEYS).toBe("");
  });
});
