import { describe, it, expect } from "vitest";
import { lookupTestCred, parseTestCredsConfig } from "../src/creds/test-creds";

// Issue #279: TEST_CREDS_BY_REPO is the per-repo allowlist of staging test
// logins a studio may fetch. The guard refuses the WHOLE config when any one
// entry points outside staging-like environments or outside /test-accounts —
// fail closed, never "skip the bad entry and serve the rest".

const entry = (over: Record<string, string> = {}) => ({
  workspaceId: "ws-123", environment: "staging", secretPath: "/test-accounts", key: "VIEWER_PASSWORD", ...over,
});
const cfg = (repoMap: unknown) => JSON.stringify(repoMap);

describe("parseTestCredsConfig — guard", () => {
  it("accepts a staging entry under /test-accounts", () => {
    const r = parseTestCredsConfig(cfg({ "acme/web": { viewer: entry() } }));
    expect(r.ok).toBe(true);
  });

  it("accepts dev-like environments and nested /test-accounts paths", () => {
    for (const environment of ["staging", "dev", "development", "test", "Staging"]) {
      const r = parseTestCredsConfig(cfg({ "acme/web": { viewer: entry({ environment, secretPath: "/test-accounts/web" }) } }));
      expect(r.ok, environment).toBe(true);
    }
  });

  it("rejects a prod environment at load", () => {
    for (const environment of ["prod", "production", "PROD", "live", "main", ""]) {
      const r = parseTestCredsConfig(cfg({ "acme/web": { viewer: entry({ environment }) } }));
      expect(r.ok, environment).toBe(false);
    }
  });

  it("rejects any secretPath outside /test-accounts", () => {
    for (const secretPath of ["/", "/admin", "/prod/test-accounts", "/test-accounts-admin", "test-accounts",
      "/test-accounts/../admin", "/test-accounts/./x", "/test-accounts//x"]) {
      const r = parseTestCredsConfig(cfg({ "acme/web": { viewer: entry({ secretPath }) } }));
      expect(r.ok, secretPath).toBe(false);
    }
  });

  it("rejects an admin-looking entry name, key or path", () => {
    expect(parseTestCredsConfig(cfg({ "acme/web": { admin: entry() } })).ok).toBe(false);
    expect(parseTestCredsConfig(cfg({ "acme/web": { viewer: entry({ key: "ADMIN_PASSWORD" }) } })).ok).toBe(false);
    expect(parseTestCredsConfig(cfg({ "acme/web": { viewer: entry({ secretPath: "/test-accounts/admins" }) } })).ok)
      .toBe(false);
  });

  it("one bad entry refuses the whole config (fail closed)", () => {
    const r = parseTestCredsConfig(cfg({
      "acme/web": { viewer: entry() },
      "acme/api": { prodlogin: entry({ environment: "production" }) },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("acme/api");
  });

  it("rejects malformed shapes", () => {
    for (const raw of ["", "not json", "[]", "null", cfg({ "acme/web": [] }), cfg({ "acme/web": { viewer: "x" } }),
      cfg({ "acme/web": { viewer: { ...entry(), key: 7 } } }), cfg({ "acme/web": { viewer: { ...entry(), workspaceId: "" } } }),
      cfg({ "not-a-slug": { viewer: entry() } }), cfg({ "acme/web": { "bad name!": entry() } })]) {
      expect(parseTestCredsConfig(raw).ok, raw).toBe(false);
    }
  });
});

describe("lookupTestCred — allowlist", () => {
  const parsed = parseTestCredsConfig(cfg({
    "acme/web": { viewer: entry() },
    "acme/api": { editor: entry({ key: "EDITOR_PASSWORD" }) },
  }));
  if (!parsed.ok) throw new Error(parsed.error);

  it("finds a name in the caller's own repo", () => {
    expect(lookupTestCred(parsed.value, "acme/web", "viewer")?.key).toBe("VIEWER_PASSWORD");
  });

  it("denies a name allowlisted only for ANOTHER repo", () => {
    expect(lookupTestCred(parsed.value, "acme/web", "editor")).toBeNull();
  });

  it("denies an unknown repo and an unknown name", () => {
    expect(lookupTestCred(parsed.value, "acme/other", "viewer")).toBeNull();
    expect(lookupTestCred(parsed.value, "acme/web", "nobody")).toBeNull();
  });

  it("does not resolve prototype keys", () => {
    expect(lookupTestCred(parsed.value, "acme/web", "__proto__")).toBeNull();
    expect(lookupTestCred(parsed.value, "__proto__", "viewer")).toBeNull();
    expect(lookupTestCred(parsed.value, "acme/web", "constructor")).toBeNull();
  });
});
