// apps/fleet/test/bun/walk-storage-state.test.ts
// #1348 review r1 item 2: "" and a credential-less Playwright storage state
// ({"cookies":[],"origins":[]}) must read as no usable auth, same as
// undefined — none of the three may reach the engine.
import { describe, it, expect } from "bun:test";
import { hasUsableAuth, secretValues } from "../../src/walk/storage-state";

const REAL_STATE = JSON.stringify({
  cookies: [{ name: "sid", value: "cookie-secret-1", domain: "x", path: "/" }],
  origins: [{ origin: "https://x", localStorage: [{ name: "token", value: "ls-secret-2" }] }],
});

const CREDENTIAL_LESS = JSON.stringify({ cookies: [], origins: [] });

describe("secretValues", () => {
  it("extracts every cookie value and every origin localStorage value", () => {
    expect(secretValues(REAL_STATE).sort()).toEqual(["cookie-secret-1", "ls-secret-2"]);
  });

  it("returns empty for a credential-less state (empty cookies and origins)", () => {
    expect(secretValues(CREDENTIAL_LESS)).toEqual([]);
  });

  it("returns empty for an empty string", () => {
    expect(secretValues("")).toEqual([]);
  });

  it("falls back to the whole string for non-JSON input (opaque, still sensitive)", () => {
    expect(secretValues("sekret123")).toEqual(["sekret123"]);
  });

  it("skips empty-string cookie/localStorage values", () => {
    const raw = JSON.stringify({ cookies: [{ value: "" }], origins: [{ localStorage: [{ value: "" }] }] });
    expect(secretValues(raw)).toEqual([]);
  });
});

describe("hasUsableAuth", () => {
  it("false for undefined", () => {
    expect(hasUsableAuth(undefined)).toBe(false);
  });

  it("false for an empty string", () => {
    expect(hasUsableAuth("")).toBe(false);
  });

  it("false for a credential-less storage state", () => {
    expect(hasUsableAuth(CREDENTIAL_LESS)).toBe(false);
  });

  it("true for a storage state carrying a real cookie value", () => {
    expect(hasUsableAuth(REAL_STATE)).toBe(true);
  });

  it("true for an opaque non-JSON secret (back-compat with a plain token string)", () => {
    expect(hasUsableAuth("sekret123")).toBe(true);
  });
});
