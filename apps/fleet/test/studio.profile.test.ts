import { describe, it, expect, vi } from "vitest";
import {
  isBigProfileRole, doClassForRole, realDoClassForRole, studioNamespace, getStudioStubForRow, BIG_PROFILE_ROLES,
} from "../src/studio/profile";
import type { Env } from "../src/env";

// Issue #107 (#70 ask 3): profile.ts's own role-name-keyed routing — see
// that file's header for the full ruling. These are pure-function tests
// against a fake Env; test/studio.spawn.test.ts covers:
//   - the real call path through routes.ts's provisionChild (a fresh spawn)
//   - getStudioStub's async, real-D1-backed row lookup (orphan-risk fix)

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

describe("doClassForRole", () => {
  it("is STUDIO_BIG for release-studio", () => {
    expect(doClassForRole("release-studio")).toBe("STUDIO_BIG");
  });

  it("is STUDIO for an ordinary role", () => {
    expect(doClassForRole("pilot")).toBe("STUDIO");
  });
});

// Issue #107 fix-first round 2: realDoClassForRole is the ONLY function that
// should ever decide what doClass value gets WRITTEN to a row — see that
// function's own doc comment. Unlike doClassForRole, it also asks "is
// env.STUDIO_BIG genuinely reachable right now," since the container/ change
// that wires the real binding ships in a separate, batched rollout from this
// code (the issue's own body) — so there is a real window where this code is
// live but the binding is not.
describe("realDoClassForRole", () => {
  it("is STUDIO_BIG for release-studio when env.STUDIO_BIG is bound", () => {
    const env = fakeEnv();
    expect(realDoClassForRole(env, "release-studio")).toBe("STUDIO_BIG");
  });

  it("is STUDIO for release-studio when env.STUDIO_BIG is undefined -- the batched-rollout window", () => {
    const env = { STUDIO: fakeNamespace("default"), STUDIO_BIG: undefined } as unknown as Env;
    expect(realDoClassForRole(env, "release-studio")).toBe("STUDIO");
  });

  it("is STUDIO for an ordinary role regardless of STUDIO_BIG's presence", () => {
    const env = fakeEnv();
    expect(realDoClassForRole(env, "pilot")).toBe("STUDIO");
  });
});

/** Two distinguishable fake namespaces, in the shape studioNamespace/
 *  getStudioStubForRow actually read: `idFromName` returns the name
 *  verbatim (a DurableObjectId stand-in), `get` returns an object tagging
 *  which namespace served it, so a test can tell them apart without a real
 *  DO. */
function fakeNamespace(marker: "default" | "big") {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({ marker, id: id as unknown as string }),
  } as unknown as Env["STUDIO"];
}

function fakeEnv(): Env {
  return { STUDIO: fakeNamespace("default"), STUDIO_BIG: fakeNamespace("big") } as unknown as Env;
}

// Issue #107 fix-first: studioNamespace now routes on the RECORDED
// doClass, never on the id's role — a row's `doClass` is the ONLY input.
describe("studioNamespace", () => {
  it("picks STUDIO_BIG for a row recorded doClass: STUDIO_BIG", () => {
    const env = fakeEnv();
    expect(studioNamespace(env, { id: "acme--release-studio", doClass: "STUDIO_BIG" })).toBe(env.STUDIO_BIG);
  });

  it("picks STUDIO for a row recorded doClass: STUDIO, even for a big-profile-shaped id", () => {
    const env = fakeEnv();
    expect(studioNamespace(env, { id: "acme--release-studio", doClass: "STUDIO" })).toBe(env.STUDIO);
  });

  it("picks STUDIO for a row with NO recorded doClass (absent) — never re-derived from role", () => {
    const env = fakeEnv();
    expect(studioNamespace(env, { id: "acme--release-studio" })).toBe(env.STUDIO);
  });

  it("falls back to STUDIO, with a console.warn, when doClass is STUDIO_BIG but env.STUDIO_BIG is unset", () => {
    const env = { STUDIO: fakeNamespace("default"), STUDIO_BIG: undefined } as unknown as Env;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(studioNamespace(env, { id: "acme--release-studio", doClass: "STUDIO_BIG" })).toBe(env.STUDIO);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("getStudioStubForRow", () => {
  it("routes a row recorded STUDIO_BIG through STUDIO_BIG's own get/idFromName", () => {
    const env = fakeEnv();
    const stub = getStudioStubForRow(env, { id: "acme--release-studio", doClass: "STUDIO_BIG" }) as unknown as { marker: string; id: string };
    expect(stub.marker).toBe("big");
    expect(stub.id).toBe("acme--release-studio");
  });

  it("routes a row with no recorded doClass through STUDIO's own get/idFromName", () => {
    const env = fakeEnv();
    const stub = getStudioStubForRow(env, { id: "acme--pilot" }) as unknown as { marker: string; id: string };
    expect(stub.marker).toBe("default");
    expect(stub.id).toBe("acme--pilot");
  });
});
