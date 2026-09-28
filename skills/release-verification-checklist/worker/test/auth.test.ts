import { describe, it, expect } from "vitest";
import { tokenKind, allow, inScope } from "../src/auth";

const env = {
  REVIEW_READ_TOKEN: "read-tok",
  REVIEW_WRITE_TOKEN: "write-tok",
  REVIEW_READ_TOKENS: JSON.stringify({ "acme-read-tok": "acme" }),
} as any;
const req = (t?: string) => new Request("https://x/", t ? { headers: { authorization: "Bearer " + t } } : {});

describe("auth", () => {
  it("classifies tokens", () => {
    expect(tokenKind(req("read-tok"), env)).toEqual({ kind: "read", prefix: null });
    expect(tokenKind(req("write-tok"), env)).toEqual({ kind: "write", prefix: null });
    expect(tokenKind(req("nope"), env)).toBe(null);
    expect(tokenKind(req(), env)).toBe(null);
  });

  it("classifies a scoped read token with its prefix", () => {
    expect(tokenKind(req("acme-read-tok"), env)).toEqual({ kind: "read", prefix: "acme" });
  });

  it("tolerates a malformed REVIEW_READ_TOKENS without failing open", () => {
    const bad = { ...env, REVIEW_READ_TOKENS: "{not json" } as any;
    expect(tokenKind(req("read-tok"), bad)).toEqual({ kind: "read", prefix: null }); // unscoped still works
    expect(tokenKind(req("acme-read-tok"), bad)).toBe(null);                       // scoped map ignored
  });

  it("read satisfies read+write; write satisfies only write", () => {
    const read = { kind: "read", prefix: null } as const;
    const write = { kind: "write", prefix: null } as const;
    expect(allow(read, "read")).toBe(true);
    expect(allow(read, "write")).toBe(true);
    expect(allow(write, "write")).toBe(true);
    expect(allow(write, "read")).toBe(false);
    expect(allow(null, "write")).toBe(false);
  });

  it("unscoped tokens reach every release; scoped tokens only their namespace", () => {
    const un = { kind: "read", prefix: null } as const;
    const sc = { kind: "read", prefix: "acme" } as const;
    expect(inScope(un, "anything--at-all")).toBe(true);
    expect(inScope(un, "2026-07-29-fixround")).toBe(true);   // legacy unprefixed
    expect(inScope(sc, "acme--spec-smoke")).toBe(true);
    expect(inScope(sc, "other--x")).toBe(false);
    expect(inScope(sc, "2026-07-29-fixround")).toBe(false);  // legacy is not in a namespace
    expect(inScope(sc, "acme-evil--x")).toBe(false);       // prefix must end at the separator
    expect(inScope(sc, "acme")).toBe(false);               // bare prefix is not a release
  });
});
