// #1346: grantedSecretNames is the one gate every secret grant passes
// through. Four independent guards (trust, repo, leg, registry name) -- each
// test below isolates one, so a mutation that weakens any single guard
// fails exactly one test, never none. trustedForSecrets' own four guards
// (sameRepo/association/bot/default-base) are covered separately in
// gate-secrets-trust.test.ts -- here the fourth parameter is just the
// already-computed `trusted` boolean.
import { describe, it, expect } from "bun:test";
import { grantedSecretNames } from "../../src/gate/secrets-scope";
import { parseGateSecretsAllowlist, type GateSecretsAllowlist } from "../../src/gate/secrets-config";

const ALLOWLIST = parseGateSecretsAllowlist({
  "acme/example": {
    "browser-e2e": ["staging-login"],
    "ai-smoke": ["workers-ai"],
    "typo-leg": ["not-a-real-secret"],
  },
});

describe("grantedSecretNames: trust guard", () => {
  it("an untrusted PR (trusted: false) gets nothing, even for an allowlisted leg", () => {
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

// grantedSecretNames's own type accepts ANY GateSecretsAllowlist, not only
// one parseGateSecretsAllowlist itself built -- parseGateSecretsAllowlist's
// Object.create(null) containers already make a literal prototype lookup
// return undefined on their own, so these tests build a RAW plain-object
// allowlist (bypassing the parser entirely) to exercise grantedSecretNames'
// OWN hasOwn/Array.isArray guards independently of that upstream hardening --
// two independent reasons this can never go wrong, not one hiding the other.
const RAW_ALLOWLIST = {
  "acme/example": { "browser-e2e": ["staging-login"], "bad-leg": "not-an-array" },
} as unknown as GateSecretsAllowlist;

describe("grantedSecretNames: prototype-safe leg lookup (#1346 security review r1, LOW)", () => {
  it("a leg literally named 'constructor' does not resolve through Object.prototype", () => {
    expect(() => grantedSecretNames(RAW_ALLOWLIST, "acme/example", "constructor", true)).not.toThrow();
    expect(grantedSecretNames(RAW_ALLOWLIST, "acme/example", "constructor", true)).toEqual([]);
  });

  it("a leg literally named '__proto__' does not resolve through the object's own prototype", () => {
    expect(() => grantedSecretNames(RAW_ALLOWLIST, "acme/example", "__proto__", true)).not.toThrow();
    expect(grantedSecretNames(RAW_ALLOWLIST, "acme/example", "__proto__", true)).toEqual([]);
  });

  it("a leg named 'toString' does not resolve through Object.prototype either", () => {
    expect(grantedSecretNames(RAW_ALLOWLIST, "acme/example", "toString", true)).toEqual([]);
  });

  it("a leg whose raw value isn't an array (bypassing the parser's own isStringArray check) returns [], never throws", () => {
    expect(() => grantedSecretNames(RAW_ALLOWLIST, "acme/example", "bad-leg", true)).not.toThrow();
    expect(grantedSecretNames(RAW_ALLOWLIST, "acme/example", "bad-leg", true)).toEqual([]);
  });

  it("the same lookups still resolve safely when built via parseGateSecretsAllowlist's own null-prototype containers", () => {
    expect(grantedSecretNames(ALLOWLIST, "acme/example", "constructor", true)).toEqual([]);
    expect(grantedSecretNames(ALLOWLIST, "acme/example", "__proto__", true)).toEqual([]);
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
