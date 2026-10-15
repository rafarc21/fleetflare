import { describe, it, expect } from "bun:test";
import { buildLegEnvVars, gateOutboundProps, legGitToken, type GateLegRequest } from "../../src/gate/leg-env";

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
      GATE_BASELINE_KEYS: "gate/acme/example/baselines/mainsha-lockhash.tar", GATE_PRIVATE: "0",
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

  it("private: true -> GATE_PRIVATE=1, which tells gate-server to clone through the Worker proxy", () => {
    const req: GateLegRequest = {
      owner: "acme", repo: "example", commit: "abc123", leg: "lint",
      installCmd: "x", legCmd: "y", resultKey: "z", baselineKeys: [], private: true,
    };
    expect(buildLegEnvVars(req).GATE_PRIVATE).toBe("1");
  });
});

const RESULT_KEY = "gate/acme/example/runs/715/run-a/shard-lint.json";
const PUBLIC_LEG: GateLegRequest = {
  owner: "acme", repo: "example", commit: "abc123", leg: "lint",
  installCmd: "x", legCmd: "y", resultKey: RESULT_KEY, baselineKeys: [],
};
const PRIVATE_LEG: GateLegRequest = { ...PUBLIC_LEG, private: true };

describe("gateOutboundProps (#715: the leg's proxy scope)", () => {
  it("a private leg scopes the outbound handler to its result key, its one repo, and its minted token", () => {
    expect(gateOutboundProps(PRIVATE_LEG, "ghs_TESTONLY_0000")).toEqual({
      resultKey: RESULT_KEY,
      repo: "acme/example",
      gitToken: "ghs_TESTONLY_0000",
    });
  });

  it("a public leg carries no repo and no token: the git proxy 403s for it", () => {
    const props = gateOutboundProps(PUBLIC_LEG);
    expect(props).toEqual({ resultKey: RESULT_KEY });
    expect("repo" in props).toBe(false);
    expect("gitToken" in props).toBe(false);
  });

  it("a public leg never takes a token, even if one is passed by mistake", () => {
    const props = gateOutboundProps(PUBLIC_LEG, "ghs_TESTONLY_0000");
    expect("gitToken" in props).toBe(false);
    expect("repo" in props).toBe(false);
  });

  it("a private leg with no minted token carries no repo either: nothing to proxy with", () => {
    expect(gateOutboundProps(PRIVATE_LEG)).toEqual({ resultKey: RESULT_KEY });
  });
});

describe("legGitToken (#715: one mint per leg, at leg start)", () => {
  it("a public leg mints nothing", async () => {
    let calls = 0;
    const token = await legGitToken(PUBLIC_LEG, async () => { calls++; return "x"; });
    expect(token).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("a private leg mints exactly once, for its own owner/repo", async () => {
    const minted: string[] = [];
    const token = await legGitToken(PRIVATE_LEG, async (repo) => { minted.push(repo); return "ghs_TESTONLY_0000"; });
    expect(token).toBe("ghs_TESTONLY_0000");
    expect(minted).toEqual(["acme/example"]);
  });

  it("a mint failure propagates: the leg fails before any container starts", async () => {
    await expect(
      legGitToken(PRIVATE_LEG, async () => { throw new Error("private clone needs the GitHub App on this owner"); }),
    ).rejects.toThrow("private clone needs the GitHub App on this owner");
  });
});
