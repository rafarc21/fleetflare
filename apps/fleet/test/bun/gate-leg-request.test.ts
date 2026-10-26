// #715: a PR's private flag reaches the leg container as GATE_PRIVATE, and the
// git proxy's one repo is the PR's own owner/repo.
import { describe, it, expect } from "bun:test";
import { legRequest } from "../../src/gate/leg-run";
import { buildLegEnvVars, gateOutboundProps } from "../../src/gate/leg-env";
import type { PlannedLeg } from "../../src/gate/fanout";
import { parseGateSecretsAllowlist } from "../../src/gate/secrets-config";

const PLANNED: PlannedLeg = {
  leg: "lint", commit: "b..h", installCmd: "bun install", legCmd: "bun run lint",
  resultKey: "gate/acme/example/runs/7/run-a/shard-lint.json", baselineKeys: [],
};

describe("legRequest", () => {
  it("carries the PR's private flag as true in the request body", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: true });
    expect(body.private).toBe(true);
  });

  it("a private PR's leg env gets GATE_PRIVATE=1", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: true });
    expect(buildLegEnvVars(body).GATE_PRIVATE).toBe("1");
  });

  it("a public PR's leg env gets GATE_PRIVATE=0", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false });
    expect(buildLegEnvVars(body).GATE_PRIVATE).toBe("0");
  });

  it("the git proxy's one repo is the PR's own owner/repo, with the minted token", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: true });
    expect(gateOutboundProps(body, "tok")).toEqual({
      resultKey: PLANNED.resultKey, repo: "acme/example", gitToken: "tok",
    });
  });

  it("the planned leg's timeoutMin reaches the /run-leg body", () => {
    const body = legRequest("acme", "example", { ...PLANNED, timeoutMin: 9 }, { baseRef: "main", pr: "7", private: false });
    expect(body.timeoutMin).toBe(9);
  });

  it("the request keeps the planned leg's command and result key unchanged", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false });
    expect(body).toMatchObject({
      owner: "acme", repo: "example", commit: "b..h", leg: "lint",
      installCmd: "bun install", legCmd: "bun run lint", resultKey: PLANNED.resultKey,
      baseRef: "main", pr: "7",
    });
  });
});

// #1066: the run's image key rides the leg request, and is absent when unset.
describe("legRequest: image key", () => {
  it("carries the run's image key in the request body", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false, image: "desktop" });
    expect(body.image).toBe("desktop");
  });
  it("no image key on the body when the run names none", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false });
    expect(Object.hasOwn(body, "image")).toBe(false);
  });
});

// #1346: legRequest is the ONLY place a secret grant is decided -- every
// guard lives in grantedSecretNames (secrets-scope.ts), exercised here end to
// end from a parsed OPS allowlist through to the request body.
describe("legRequest: gate-scoped secrets (#1346)", () => {
  const ALLOWLIST = parseGateSecretsAllowlist({ "acme/example": { lint: ["staging-login"] } });

  it("a same-repo PR for an allowlisted leg gets its granted secret names", () => {
    const body = legRequest("acme", "example", PLANNED, {
      baseRef: "main", pr: "7", private: false, sameRepo: true, secretsAllowlist: ALLOWLIST,
    });
    expect(body.secretNames).toEqual(["staging-login"]);
  });

  it("a fork PR (sameRepo: false) gets no secretNames at all, even for an allowlisted leg", () => {
    const body = legRequest("acme", "example", PLANNED, {
      baseRef: "main", pr: "7", private: false, sameRepo: false, secretsAllowlist: ALLOWLIST,
    });
    expect(Object.hasOwn(body, "secretNames")).toBe(false);
  });

  it("omitting sameRepo entirely fails closed, same as sameRepo: false", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false, secretsAllowlist: ALLOWLIST });
    expect(Object.hasOwn(body, "secretNames")).toBe(false);
  });

  it("a leg absent from the allowlist gets no secretNames key", () => {
    const other: PlannedLeg = { ...PLANNED, leg: "not-lint" };
    const body = legRequest("acme", "example", other, { baseRef: "main", pr: "7", private: false, sameRepo: true, secretsAllowlist: ALLOWLIST });
    expect(Object.hasOwn(body, "secretNames")).toBe(false);
  });

  it("no secretsAllowlist at all (OPS repo unset) gets no secretNames key", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false, sameRepo: true });
    expect(Object.hasOwn(body, "secretNames")).toBe(false);
  });
});
