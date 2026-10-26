// #1346: parseGateSecretsAllowlist fails closed on every malformed shape --
// this is the OPS-repo file no PR can ever write to, but a Worker must never
// crash a gate run over a hand-edited JSON file either.
import { describe, it, expect } from "bun:test";
import { parseGateSecretsAllowlist, gateSecretsRepoEntry } from "../../src/gate/secrets-config";

describe("parseGateSecretsAllowlist", () => {
  it("parses a well-formed file", () => {
    const parsed = parseGateSecretsAllowlist({ "acme/example": { "browser-e2e": ["staging-login"] } });
    expect(parsed).toEqual({ "acme/example": { "browser-e2e": ["staging-login"] } });
  });

  it("a non-object top level parses to an empty allowlist", () => {
    expect(parseGateSecretsAllowlist("nope")).toEqual({});
    expect(parseGateSecretsAllowlist(null)).toEqual({});
    expect(parseGateSecretsAllowlist(42)).toEqual({});
    expect(parseGateSecretsAllowlist(["acme/example"])).toEqual({});
  });

  it("a repo entry that isn't an object is dropped, not fatal to the rest of the file", () => {
    const parsed = parseGateSecretsAllowlist({
      "acme/example": { "browser-e2e": ["staging-login"] },
      "acme/broken": "not an object",
    });
    expect(parsed).toEqual({ "acme/example": { "browser-e2e": ["staging-login"] } });
  });

  it("a leg entry that isn't a string array is dropped, not fatal to its own repo's other legs", () => {
    const parsed = parseGateSecretsAllowlist({
      "acme/example": { "browser-e2e": ["staging-login"], "broken-leg": "staging-login", "mixed-leg": ["ok", 7] },
    });
    expect(parsed).toEqual({ "acme/example": { "browser-e2e": ["staging-login"] } });
  });
});

describe("gateSecretsRepoEntry", () => {
  const allowlist = parseGateSecretsAllowlist({ "Acme/Example": { "browser-e2e": ["staging-login"] } });

  it("matches case-insensitively", () => {
    expect(gateSecretsRepoEntry(allowlist, "acme/example")).toEqual({ "browser-e2e": ["staging-login"] });
  });

  it("undefined for a repo with no entry", () => {
    expect(gateSecretsRepoEntry(allowlist, "acme/other")).toBeUndefined();
  });
});
