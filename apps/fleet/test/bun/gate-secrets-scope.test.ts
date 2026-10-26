// #1346: grantedSecretNames is the one gate every secret grant passes
// through. Four independent guards (fork, repo, leg, registry name) -- each
// test below isolates one, so a mutation that weakens any single guard
// fails exactly one test, never none.
import { describe, it, expect } from "bun:test";
import { grantedSecretNames } from "../../src/gate/secrets-scope";
import { parseGateSecretsAllowlist } from "../../src/gate/secrets-config";

const ALLOWLIST = parseGateSecretsAllowlist({
  "acme/example": {
    "browser-e2e": ["staging-login"],
    "ai-smoke": ["workers-ai"],
    "typo-leg": ["not-a-real-secret"],
  },
});

describe("grantedSecretNames: fork guard", () => {
  it("a fork PR (sameRepo: false) gets nothing, even for an allowlisted leg", () => {
    expect(grantedSecretNames(ALLOWLIST, "acme/example", "browser-e2e", false)).toEqual([]);
  });

  it("the same repo+leg, same-repo PR, gets its granted name", () => {
    expect(grantedSecretNames(ALLOWLIST, "acme/example", "browser-e2e", true)).toEqual(["staging-login"]);
  });
});

describe("grantedSecretNames: repo guard", () => {
  it("a repo absent from the OPS allowlist gets nothing for any leg", () => {
    expect(grantedSecretNames(ALLOWLIST, "acme/other-repo", "browser-e2e", true)).toEqual([]);
  });

  it("matches the repo case-insensitively, like fleet.json's own gates map", () => {
    expect(grantedSecretNames(ALLOWLIST, "ACME/EXAMPLE", "browser-e2e", true)).toEqual(["staging-login"]);
  });
});

describe("grantedSecretNames: leg guard", () => {
  it("a leg not named in the repo's entry gets nothing", () => {
    expect(grantedSecretNames(ALLOWLIST, "acme/example", "some-other-leg", true)).toEqual([]);
  });

  it("one leg's grant does not leak into a sibling leg of the same repo", () => {
    expect(grantedSecretNames(ALLOWLIST, "acme/example", "ai-smoke", true)).toEqual(["workers-ai"]);
    expect(grantedSecretNames(ALLOWLIST, "acme/example", "browser-e2e", true)).not.toContain("workers-ai");
  });
});

describe("grantedSecretNames: registry guard", () => {
  it("a name the OPS file lists but the registry never defined grants nothing", () => {
    expect(grantedSecretNames(ALLOWLIST, "acme/example", "typo-leg", true)).toEqual([]);
  });
});

describe("grantedSecretNames: malformed/empty allowlist fails closed", () => {
  it("an empty allowlist grants nothing to anyone", () => {
    expect(grantedSecretNames(parseGateSecretsAllowlist({}), "acme/example", "browser-e2e", true)).toEqual([]);
  });

  it("a malformed OPS file (parsed to {}) grants nothing, never throws", () => {
    const malformed = parseGateSecretsAllowlist("not an object");
    expect(() => grantedSecretNames(malformed, "acme/example", "browser-e2e", true)).not.toThrow();
    expect(grantedSecretNames(malformed, "acme/example", "browser-e2e", true)).toEqual([]);
  });
});
