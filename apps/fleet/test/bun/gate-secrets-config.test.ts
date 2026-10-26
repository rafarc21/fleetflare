// #1346: parseGateSecretsAllowlist fails closed on every malformed shape --
// this is the OPS-repo file no PR can ever write to, but a Worker must never
// crash a gate run over a hand-edited JSON file either.
//
// #1376: a leg's OPS-file value may be the original plain array (back-compat,
// normalizes to { secrets }) or the new { secrets, head? } object -- every
// entry this file hands back, after parsing, is always the normalized object
// form, so nothing downstream ever branches on which shape the file used.
import { describe, it, expect } from "bun:test";
import {
  parseGateSecretsAllowlist, gateSecretsRepoEntry, gateSecretsAllowlistFailure, parseTrustOwnApp,
} from "../../src/gate/secrets-config";

describe("parseGateSecretsAllowlist: array form (back-compat)", () => {
  it("parses a well-formed file, normalizing the array form to { secrets }", () => {
    const parsed = parseGateSecretsAllowlist({ "acme/example": { "browser-e2e": ["staging-login"] } });
    expect(parsed).toEqual({ "acme/example": { "browser-e2e": { secrets: ["staging-login"] } } });
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
    expect(parsed).toEqual({ "acme/example": { "browser-e2e": { secrets: ["staging-login"] } } });
  });

  it("a leg entry that isn't a string array (and isn't {secrets, head?} either) is dropped, not fatal to its own repo's other legs", () => {
    const parsed = parseGateSecretsAllowlist({
      "acme/example": { "browser-e2e": ["staging-login"], "broken-leg": "staging-login", "mixed-leg": ["ok", 7] },
    });
    expect(parsed).toEqual({ "acme/example": { "browser-e2e": { secrets: ["staging-login"] } } });
  });
});

// #1376: the new object form, the only way an ops entry opts a leg's @head
// union-plan copy into sharing its grant (secrets-scope.ts's own guard).
describe("parseGateSecretsAllowlist: {secrets, head?} object form (#1376)", () => {
  it("parses { secrets, head: true }", () => {
    const parsed = parseGateSecretsAllowlist({ "acme/example": { "ai-smoke": { secrets: ["workers-ai"], head: true } } });
    expect(parsed).toEqual({ "acme/example": { "ai-smoke": { secrets: ["workers-ai"], head: true } } });
  });

  it("parses { secrets } with head omitted -- normalizes the SAME as the array form (head: false default)", () => {
    const parsed = parseGateSecretsAllowlist({ "acme/example": { "ai-smoke": { secrets: ["workers-ai"] } } });
    expect(parsed).toEqual({ "acme/example": { "ai-smoke": { secrets: ["workers-ai"] } } });
  });

  it("parses { secrets, head: false } the same as head omitted (head stays unset, never a stray `head: false` key)", () => {
    const parsed = parseGateSecretsAllowlist({ "acme/example": { "ai-smoke": { secrets: ["workers-ai"], head: false } } });
    expect(parsed).toEqual({ "acme/example": { "ai-smoke": { secrets: ["workers-ai"] } } });
    expect(Object.hasOwn(parsed["acme/example"]["ai-smoke"], "head")).toBe(false);
  });

  it("drops an object entry whose secrets field is missing or not a string array", () => {
    const parsed = parseGateSecretsAllowlist({
      "acme/example": {
        "ok-leg": ["staging-login"],
        "no-secrets": { head: true },
        "bad-secrets": { secrets: "not-an-array", head: true },
        "mixed-secrets": { secrets: ["ok", 7], head: true },
      },
    });
    expect(parsed).toEqual({ "acme/example": { "ok-leg": { secrets: ["staging-login"] } } });
  });

  it("drops an object entry whose head field is present but not a boolean", () => {
    const parsed = parseGateSecretsAllowlist({
      "acme/example": { "ai-smoke": { secrets: ["workers-ai"], head: "true" } },
    });
    expect(parsed).toEqual({ "acme/example": {} });
  });

  it("an array and an object entry coexist fine in the same repo", () => {
    const parsed = parseGateSecretsAllowlist({
      "acme/example": {
        "browser-e2e": ["staging-login"],
        "ai-smoke": { secrets: ["workers-ai"], head: true },
      },
    });
    expect(parsed).toEqual({
      "acme/example": {
        "browser-e2e": { secrets: ["staging-login"] },
        "ai-smoke": { secrets: ["workers-ai"], head: true },
      },
    });
  });

  // #1376 security review r1 LOW: the schema says additionalProperties:
  // false, but an unknown key is a typo to surface, not a reason to drop an
  // otherwise well-formed grant.
  it("warns on an unknown key but keeps the entry and its grant unchanged", () => {
    const parsed = parseGateSecretsAllowlist({
      "acme/example": { "ai-smoke": { secrets: ["workers-ai"], head: true, heads: true } },
    });
    expect(parsed).toEqual({ "acme/example": { "ai-smoke": { secrets: ["workers-ai"], head: true } } });
  });
});

describe("gateSecretsRepoEntry", () => {
  const allowlist = parseGateSecretsAllowlist({ "Acme/Example": { "browser-e2e": ["staging-login"] } });

  it("matches case-insensitively", () => {
    expect(gateSecretsRepoEntry(allowlist, "acme/example")).toEqual({ "browser-e2e": { secrets: ["staging-login"] } });
  });

  it("undefined for a repo with no entry", () => {
    expect(gateSecretsRepoEntry(allowlist, "acme/other")).toBeUndefined();
  });
});

// #1346 security review r1 item 3 / correctness review r1 item 1: workflow.ts
// cannot be loaded by bun test (cloudflare:workers) -- this is the pure
// decision pulled out of it, so a revert of the whole-run-fail guard fails a
// real test here instead of surviving silently.
describe("gateSecretsAllowlistFailure", () => {
  it("fails the run when a trusted PR's allowlist read failed (null)", () => {
    expect(gateSecretsAllowlistFailure(true, null)).toBe("gate-secrets: OPS allowlist unavailable");
  });

  it("does not fail when the allowlist read succeeded, even if empty", () => {
    expect(gateSecretsAllowlistFailure(true, {})).toBeNull();
  });

  it("does not fail an untrusted PR even when the allowlist is null -- it was never going to grant anything anyway", () => {
    expect(gateSecretsAllowlistFailure(false, null)).toBeNull();
  });

  it("does not fail an untrusted PR with a successful empty read either", () => {
    expect(gateSecretsAllowlistFailure(false, {})).toBeNull();
  });
});

// #1380 security review r1 MED: the fleet-wide App opt-in, read from the SAME
// raw JSON parseGateSecretsAllowlist itself parses -- a top-level field,
// never a per-repo one, since "the fleet's own GitHub App" is one identity
// across every gated repo. A boolean, not a free-form slug list: there is no
// slug for an OPS typo to mistype into trusting the wrong App (the earlier
// `trustApps: string[]` design's companion "App id matches" cross-check was
// found dead -- it could only ever compare this Worker to itself -- so a
// config mistake naming any other bot's slug would have granted it trust
// with nothing left to catch the error).
describe("parseTrustOwnApp", () => {
  it("true when explicitly set", () => {
    expect(parseTrustOwnApp({ trustOwnApp: true })).toBe(true);
  });

  it("false when explicitly set", () => {
    expect(parseTrustOwnApp({ trustOwnApp: false })).toBe(false);
  });

  it("absent -> false (feature off, the default)", () => {
    expect(parseTrustOwnApp({ "acme/example": { "browser-e2e": ["staging-login"] } })).toBe(false);
  });

  it("a non-boolean value -> false, WARNED, never throws", () => {
    const warnings: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    let result: boolean;
    try {
      result = parseTrustOwnApp({ trustOwnApp: "true" });
    } finally {
      console.warn = realWarn;
    }
    expect(result).toBe(false);
    expect(warnings.some((w) => String(w[0]).includes("trustOwnApp"))).toBe(true);
  });

  it("a non-object top level -> false, never throws", () => {
    expect(parseTrustOwnApp("nope")).toBe(false);
    expect(parseTrustOwnApp(null)).toBe(false);
    expect(parseTrustOwnApp(42)).toBe(false);
  });

  it("coexists with repo entries in the same file, read from the same raw value", () => {
    const raw = { trustOwnApp: true, "acme/example": { "browser-e2e": ["staging-login"] } };
    expect(parseTrustOwnApp(raw)).toBe(true);
    expect(parseGateSecretsAllowlist(raw)).toEqual({ "acme/example": { "browser-e2e": { secrets: ["staging-login"] } } });
  });
});

describe("parseGateSecretsAllowlist: trustOwnApp is never mistaken for a repo entry (#1380)", () => {
  it("a top-level trustOwnApp key is skipped, not warned about or parsed as a malformed repo", () => {
    const warnings: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    let parsed: ReturnType<typeof parseGateSecretsAllowlist>;
    try {
      parsed = parseGateSecretsAllowlist({
        trustOwnApp: true,
        "acme/example": { "browser-e2e": ["staging-login"] },
      });
    } finally {
      console.warn = realWarn;
    }
    expect(parsed).toEqual({ "acme/example": { "browser-e2e": { secrets: ["staging-login"] } } });
    expect(Object.hasOwn(parsed, "trustOwnApp")).toBe(false);
    // The dropped-entry warning path (for a genuinely malformed repo) must
    // never fire for the reserved trustOwnApp key -- it is a known, valid
    // shape at this level, not a malformed repo entry that happens to be a
    // boolean.
    expect(warnings.some((w) => String(w[0]).includes("trustOwnApp"))).toBe(false);
  });
});
