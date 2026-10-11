import { describe, it, expect } from "vitest";
import { nsWith, envWithNs } from "./fake-namespace";

// Board #373 (sweep-3 S3-F3): the idFromName-verbatim + get-stub +
// `as unknown as Env["STUDIO"]` cast shape, extracted from 6 suites
// (grid, burn-window-expiry, fleet-resume, profile, paste, index) so
// each keeps only its own stub methods. nsWith takes the stub only —
// an OBJECT stub means get() returns it for every id (burn-window/
// paste/profile shape), a FUNCTION stub means get(id) calls it (grid/
// fleet-resume/index shape). envWithNs spreads a base env, so suites
// can override more bindings around it.

describe("nsWith", () => {
  it("returns the object stub from get for every id, and the name verbatim from idFromName", () => {
    const ns = nsWith({ getStatusDetail: async () => ({ id: "x" }) });
    expect((ns.idFromName as unknown as (n: string) => string)("acme--web-studio")).toBe("acme--web-studio");
    const stub = ns.get("ignored" as never) as unknown as { getStatusDetail: () => Promise<{ id: string }> };
    expect(stub.getStatusDetail()).resolves.toEqual({ id: "x" });
    expect(ns.get("other" as never)).toBe(stub as never);
  });

  it("routes each id through a function stub", () => {
    const seen: string[] = [];
    const ns = nsWith((id: string) => {
      seen.push(id);
      return { marker: true };
    });
    (ns.get as unknown as (id: string) => unknown)("id-1");
    (ns.get as unknown as (id: string) => unknown)("id-2");
    expect(seen).toEqual(["id-1", "id-2"]);
  });

  it("is assignable to Env[\"STUDIO\"]'s namespace members without a local cast", () => {
    const envLike = { STUDIO: nsWith({ a: 1 }) };
    expect(envLike.STUDIO.get).toBeTypeOf("function");
    expect(envLike.STUDIO.idFromName).toBeTypeOf("function");
  });

  it("does NOT spread object-stub members onto the namespace surface — get() is the only window onto a stub", () => {
    const ns = nsWith({ marker: "hidden" }) as unknown as Record<string, unknown>;
    expect(ns.marker).toBeUndefined();
  });
});

describe("envWithNs", () => {
  it("spreads the base env and swaps STUDIO for the fake namespace", () => {
    const base = { URL: "https://x", STUDIO: { real: true }, DB: "kept" } as unknown as Record<string, unknown>;
    const env = envWithNs({ marker: "stub" }, base as never);
    expect((env as unknown as Record<string, unknown>).URL).toBe("https://x");
    expect((env as unknown as Record<string, unknown>).DB).toBe("kept");
    const stub = ((env as unknown as Record<string, unknown>).STUDIO as { get: (id: string) => Record<string, unknown> }).get("ignored");
    expect(stub.marker).toBe("stub");
  });
});
