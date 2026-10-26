// #1346: resolveGrantedSecrets is do.ts's whole resolution loop, pulled out
// pure and testable -- env is a plain record, minting is injected, so this
// covers the real behavior do.ts relies on without needing cloudflare:workers.
import { describe, it, expect } from "bun:test";
import {
  resolveGrantedSecrets, isKnownSecretName, secretDef, SECRET_REGISTRY, firstUnresolvedSecret,
} from "../../src/gate/secrets-registry";

describe("SECRET_REGISTRY / isKnownSecretName / secretDef", () => {
  it("knows its own registered names", () => {
    expect(isKnownSecretName("staging-login")).toBe(true);
    expect(isKnownSecretName("workers-ai")).toBe(true);
    expect(isKnownSecretName("not-a-real-secret")).toBe(false);
  });

  it("staging-login resolves through an env var, workers-ai is minted", () => {
    expect(secretDef("staging-login")).toEqual({ envVar: "GATE_SECRET_STAGING_LOGIN" });
    expect(secretDef("workers-ai")).toEqual({ minted: true });
  });

  it("every registry entry is exactly one of envVar or minted, never both or neither", () => {
    for (const [name, def] of Object.entries(SECRET_REGISTRY)) {
      const hasEnvVar = def.envVar !== undefined;
      const isMinted = def.minted === true;
      expect(hasEnvVar !== isMinted, `${name}: exactly one of envVar/minted`).toBe(true);
    }
  });
});

describe("resolveGrantedSecrets", () => {
  it("resolves a stored secret from the env", async () => {
    const out = await resolveGrantedSecrets(
      ["staging-login"], { GATE_SECRET_STAGING_LOGIN: "sup3r-s3cret" }, async () => undefined,
    );
    expect(out).toEqual({ "staging-login": "sup3r-s3cret" });
  });

  it("skips a granted name whose Worker secret is unset", async () => {
    const out = await resolveGrantedSecrets(["staging-login"], {}, async () => undefined);
    expect(out).toEqual({});
  });

  it("skips a granted name whose Worker secret is the empty string", async () => {
    const out = await resolveGrantedSecrets(["staging-login"], { GATE_SECRET_STAGING_LOGIN: "" }, async () => undefined);
    expect(out).toEqual({});
  });

  it("mints the workers-ai value instead of reading it from env", async () => {
    const out = await resolveGrantedSecrets(["workers-ai"], {}, async (name) => `minted-for-${name}`);
    expect(out).toEqual({ "workers-ai": "minted-for-workers-ai" });
  });

  it("skips workers-ai when minting declines (e.g. no signing key configured)", async () => {
    const out = await resolveGrantedSecrets(["workers-ai"], {}, async () => undefined);
    expect(out).toEqual({});
  });

  it("an unknown name (should never happen -- secrets-scope.ts already filters it) resolves to nothing", async () => {
    const out = await resolveGrantedSecrets(["not-a-real-secret"], { GATE_SECRET_STAGING_LOGIN: "x" }, async () => undefined);
    expect(out).toEqual({});
  });

  it("resolves several granted names together, mixed stored and minted", async () => {
    const out = await resolveGrantedSecrets(
      ["staging-login", "workers-ai"],
      { GATE_SECRET_STAGING_LOGIN: "sup3r-s3cret" },
      async () => "ai-token-abc",
    );
    expect(out).toEqual({ "staging-login": "sup3r-s3cret", "workers-ai": "ai-token-abc" });
  });

  it("an empty names list resolves to nothing, no mint call made", async () => {
    let minted = false;
    const out = await resolveGrantedSecrets([], {}, async () => { minted = true; return "x"; });
    expect(out).toEqual({});
    expect(minted).toBe(false);
  });
});

// #1346 security review r1 item 3: "missing secret fails open" -> do.ts turns
// this into an immediate RED leg instead.
describe("firstUnresolvedSecret", () => {
  it("null when every granted name resolved", () => {
    expect(firstUnresolvedSecret(["staging-login"], { "staging-login": "x" })).toBeNull();
  });

  it("the unresolved name when a granted name has no resolved value", () => {
    expect(firstUnresolvedSecret(["staging-login"], {})).toBe("staging-login");
  });

  it("the FIRST unresolved name, in request order, when more than one is missing", () => {
    expect(firstUnresolvedSecret(["workers-ai", "staging-login"], {})).toBe("workers-ai");
  });

  it("an empty names list is never unresolved", () => {
    expect(firstUnresolvedSecret([], {})).toBeNull();
  });

  it("a resolved name with the exact value \"\" does not count -- resolveGrantedSecrets never stores one", () => {
    // Documents the invariant resolveGrantedSecrets relies on: an empty-string
    // resolved value is treated as unresolved there, so firstUnresolvedSecret
    // never needs to special-case "" itself -- it only ever sees keys that are
    // genuinely present with a non-empty value, or genuinely absent.
    expect(firstUnresolvedSecret(["staging-login"], { "staging-login": "" })).toBeNull();
  });
});
