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

// #1376: a PR that ADDS a secret-needing leg to its own fleet.json runs it as
// `<leg>@head` under the union plan -- a different NAME from whatever the OPS
// file grants, so with no opt-in it is DID-NOT-RUN forever. `head: true` on
// the BASE leg's own OPS entry opts its `@head`/`@head-<n>` copy into sharing
// the SAME grant, under the exact same trust filter -- never a looser one.
const HEAD_ALLOWLIST = parseGateSecretsAllowlist({
  "acme/example": {
    "ai-smoke": { secrets: ["workers-ai"], head: true },
    "browser-e2e": ["staging-login"], // array form: head stays unset/false (back-compat)
    "no-head-flag": { secrets: ["staging-login"] }, // object form, head omitted: same as false
  },
});

describe("grantedSecretNames: head opt-in on (#1376)", () => {
  it("an ordinary @head copy of an opted-in leg gets the same grant as its base", () => {
    expect(grantedSecretNames(HEAD_ALLOWLIST, "acme/example", "ai-smoke@head", true)).toEqual(["workers-ai"]);
  });

  it("a sharded @head-<n> copy of an opted-in leg gets the same grant too", () => {
    expect(grantedSecretNames(HEAD_ALLOWLIST, "acme/example", "ai-smoke@head-3", true)).toEqual(["workers-ai"]);
    expect(grantedSecretNames(HEAD_ALLOWLIST, "acme/example", "ai-smoke@head-12", true)).toEqual(["workers-ai"]);
  });

  it("still goes through the registry guard: an unknown name under head:true grants nothing", () => {
    const allowlist = parseGateSecretsAllowlist({ "acme/example": { "leg": { secrets: ["not-a-real-secret"], head: true } } });
    expect(grantedSecretNames(allowlist, "acme/example", "leg@head", true)).toEqual([]);
  });
});

describe("grantedSecretNames: head opt-in off / absent, back-compat (#1376)", () => {
  it("the array form (head implicitly false) denies the @head copy -- this is the pre-#1376 default, unchanged", () => {
    expect(grantedSecretNames(HEAD_ALLOWLIST, "acme/example", "browser-e2e@head", true)).toEqual([]);
    // the base leg itself (no @head suffix) is completely unaffected by any of this:
    expect(grantedSecretNames(HEAD_ALLOWLIST, "acme/example", "browser-e2e", true)).toEqual(["staging-login"]);
  });

  it("the object form with head omitted denies the @head copy the same as head: false", () => {
    expect(grantedSecretNames(HEAD_ALLOWLIST, "acme/example", "no-head-flag@head", true)).toEqual([]);
  });

  it("explicit head: false denies the @head copy", () => {
    const allowlist = parseGateSecretsAllowlist({ "acme/example": { "leg": { secrets: ["staging-login"], head: false } } });
    expect(grantedSecretNames(allowlist, "acme/example", "leg@head", true)).toEqual([]);
  });

  it("a base leg with no entry at all denies its @head copy (no entry to opt in)", () => {
    expect(grantedSecretNames(HEAD_ALLOWLIST, "acme/example", "never-configured@head", true)).toEqual([]);
  });
});

describe("grantedSecretNames: head opt-in still requires trust (#1376)", () => {
  it("an untrusted PR (fork / bot / non-default-base, collapsed to trusted: false) gets nothing from an opted-in leg's @head copy either", () => {
    expect(grantedSecretNames(HEAD_ALLOWLIST, "acme/example", "ai-smoke@head", false)).toEqual([]);
    expect(grantedSecretNames(HEAD_ALLOWLIST, "acme/example", "ai-smoke@head-3", false)).toEqual([]);
  });
});

describe("grantedSecretNames: head opt-in prototype-safe lookup (#1376)", () => {
  it("a leg named 'constructor@head' or '__proto__@head' never resolves through Object.prototype", () => {
    expect(() => grantedSecretNames(RAW_ALLOWLIST, "acme/example", "constructor@head", true)).not.toThrow();
    expect(grantedSecretNames(RAW_ALLOWLIST, "acme/example", "constructor@head", true)).toEqual([]);
    expect(() => grantedSecretNames(RAW_ALLOWLIST, "acme/example", "__proto__@head", true)).not.toThrow();
    expect(grantedSecretNames(RAW_ALLOWLIST, "acme/example", "__proto__@head", true)).toEqual([]);
  });

  it("the base-leg name extracted from a @head suffix is itself looked up prototype-safely, via the real parsed allowlist", () => {
    // "constructor" and "__proto__" are never real base legs in HEAD_ALLOWLIST,
    // so their @head copies resolve to nothing -- proving the lookup never
    // silently falls through to an inherited Object.prototype member instead.
    expect(grantedSecretNames(HEAD_ALLOWLIST, "acme/example", "constructor@head", true)).toEqual([]);
    expect(grantedSecretNames(HEAD_ALLOWLIST, "acme/example", "__proto__@head", true)).toEqual([]);
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
