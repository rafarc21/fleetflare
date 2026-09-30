import { describe, it, expect } from "vitest";
import { isBigProfileRole, studioNamespace, getStudioStub, BIG_PROFILE_ROLES } from "../src/studio/profile";
import type { Env } from "../src/env";

// Issue #107 (#70 ask 3): profile.ts's own role-name-keyed routing — see
// that file's header for the full ruling. These are pure-function tests
// against a fake Env; test/studio.spawn.test.ts covers the real call path
// through routes.ts's provisionChild.

describe("isBigProfileRole", () => {
  it("is true for release-studio, the QA/gate role", () => {
    expect(isBigProfileRole("release-studio")).toBe(true);
  });

  for (const role of ["pilot", "web-studio", "maestro", "scratch"]) {
    it(`is false for ${role}`, () => {
      expect(isBigProfileRole(role)).toBe(false);
    });
  }

  it("BIG_PROFILE_ROLES holds exactly release-studio today", () => {
    expect([...BIG_PROFILE_ROLES]).toEqual(["release-studio"]);
  });
});

/** Two distinguishable fake namespaces, in the shape studioNamespace/
 *  getStudioStub actually read: `idFromName` returns the name verbatim (a
 *  DurableObjectId stand-in), `get` returns an object tagging which
 *  namespace served it, so a test can tell them apart without a real DO. */
function fakeNamespace(marker: "default" | "big") {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({ marker, id: id as unknown as string }),
  } as unknown as Env["STUDIO"];
}

function fakeEnv(): Env {
  return { STUDIO: fakeNamespace("default"), STUDIO_BIG: fakeNamespace("big") } as unknown as Env;
}

describe("studioNamespace", () => {
  it("picks STUDIO_BIG for a release-studio id (bare)", () => {
    const env = fakeEnv();
    expect(studioNamespace(env, "acme--release-studio")).toBe(env.STUDIO_BIG);
  });

  it("picks STUDIO_BIG for a release-studio id with an instance suffix", () => {
    const env = fakeEnv();
    expect(studioNamespace(env, "acme--release-studio--2")).toBe(env.STUDIO_BIG);
  });

  for (const id of ["acme--pilot", "acme--web-studio", "acme--maestro", "acme--scratch--3"]) {
    it(`picks STUDIO for a non-big-profile id: ${id}`, () => {
      const env = fakeEnv();
      expect(studioNamespace(env, id)).toBe(env.STUDIO);
    });
  }

  it("falls back to STUDIO for an id that fails to parse", () => {
    const env = fakeEnv();
    expect(studioNamespace(env, "not-a-valid-id")).toBe(env.STUDIO);
  });
});

describe("getStudioStub", () => {
  it("routes a release-studio id through STUDIO_BIG's own get/idFromName", () => {
    const env = fakeEnv();
    const stub = getStudioStub(env, "acme--release-studio") as unknown as { marker: string; id: string };
    expect(stub.marker).toBe("big");
    expect(stub.id).toBe("acme--release-studio");
  });

  it("routes every other role's id through STUDIO's own get/idFromName", () => {
    const env = fakeEnv();
    const stub = getStudioStub(env, "acme--pilot") as unknown as { marker: string; id: string };
    expect(stub.marker).toBe("default");
    expect(stub.id).toBe("acme--pilot");
  });

  it("routes a malformed id through STUDIO, not STUDIO_BIG", () => {
    const env = fakeEnv();
    const stub = getStudioStub(env, "not-a-valid-id") as unknown as { marker: string; id: string };
    expect(stub.marker).toBe("default");
  });
});
