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

// #1367: consumer AI legs' own labels, registered the same way staging-login
// already is -- each a name -> Env-var indirection, never a value.
describe("SECRET_REGISTRY: consumer AI labels (#1367)", () => {
  it("registers appcheck-debug-token, staging-minter-sa and gemini-gate-key", () => {
    expect(isKnownSecretName("appcheck-debug-token")).toBe(true);
    expect(isKnownSecretName("staging-minter-sa")).toBe(true);
    expect(isKnownSecretName("gemini-gate-key")).toBe(true);
  });

  it("each resolves through its own Env key", () => {
    expect(secretDef("appcheck-debug-token")).toEqual({ envVar: "GATE_SECRET_APPCHECK_DEBUG_TOKEN" });
    expect(secretDef("staging-minter-sa")).toEqual({ envVar: "GATE_SECRET_STAGING_MINTER_SA" });
    expect(secretDef("gemini-gate-key")).toEqual({ envVar: "GATE_SECRET_GEMINI_GATE_KEY" });
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

  // #1367: each consumer AI label resolves the same way staging-login does --
  // confirms the registry entries, not the (already-generic) resolution loop.
  it("resolves each consumer AI label when its own Env var is set", async () => {
    const env = {
      GATE_SECRET_APPCHECK_DEBUG_TOKEN: "appcheck-value",
      GATE_SECRET_STAGING_MINTER_SA: "minter-value",
      GATE_SECRET_GEMINI_GATE_KEY: "gemini-value",
    };
    const out = await resolveGrantedSecrets(
      ["appcheck-debug-token", "staging-minter-sa", "gemini-gate-key"], env, async () => undefined,
    );
    expect(out).toEqual({
      "appcheck-debug-token": "appcheck-value",
      "staging-minter-sa": "minter-value",
      "gemini-gate-key": "gemini-value",
    });
  });

  it("skips a consumer AI label whose own Env var is unset", async () => {
    const out = await resolveGrantedSecrets(["gemini-gate-key"], {}, async () => undefined);
    expect(out).toEqual({});
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

  // #1367: a consumer AI label whose Worker secret was never set goes through
  // the SAME existing fail-closed path -- no new guard needed, just confirming
  // it reaches a new label the same way it already does staging-login.
  it("flags a consumer AI label as unresolved the same way, via the existing path", async () => {
    const resolved = await resolveGrantedSecrets(["staging-minter-sa"], {}, async () => undefined);
    const unresolved = firstUnresolvedSecret(["staging-minter-sa"], resolved);
    expect(unresolved).toBe("staging-minter-sa");
  });
});
