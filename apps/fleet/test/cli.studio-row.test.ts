import { describe, expect, it } from "vitest";
import type { StudioStatus } from "../src/studio/types";
import { row } from "./helpers/studio-row";
import { STUDIO_STATES, parseStudioStatus, parseStudioStatusArray } from "../cli/studio-row";

// Board task #436 (sweep-10 F1, parent #429): one guarded decoder behind the
// CLI's bare `as StudioStatus` casts. Every CLI read of a /studio/ route
// trusted the response shape with zero runtime check — a Worker older or
// newer than the CLI during a deploy window answers a different row shape,
// `state` reads undefined, and downstream branches silently (worst:
// cli/fleet.ts's destroy race reading `state === "stopped"` off an
// unvalidated cast to pick destroy-vs-refuse). This is the decoder's unit
// table: pass-through on valid (the SAME reference, so callers keep every
// field the decoder does not name), null on any miss, never a throw.
//
// Runs under bun test (the plan's own lane) and vitest (its default glob
// picks up test/*.test.ts) alike: only describe/expect/it, no runner-specific
// import — same reason test/cli.diag.test.ts names.

const MINIMAL: StudioStatus = { id: "acme-os--maestro", state: "stopped", error: null } as StudioStatus;

describe("STUDIO_STATES — the four states the CLI branches on", () => {
  it("is exactly the StudioState union, in order", () => {
    expect(STUDIO_STATES).toEqual(["provisioning", "running", "degraded", "stopped"]);
  });
});

describe("parseStudioStatus — one untrusted wire row", () => {
  it("a valid minimal row decodes to the SAME reference", () => {
    const input: StudioStatus = { ...MINIMAL };
    const out = parseStudioStatus(input);
    expect(out).toBe(input);
  });

  it("a valid full row (the shared fixture) decodes to the SAME reference", () => {
    const input = row();
    const out = parseStudioStatus(input);
    expect(out).toBe(input);
  });

  it("a state value outside the union is null, never a rebuild", () => {
    const bad = { ...MINIMAL, state: "booting" };
    expect(parseStudioStatus(bad)).toBeNull();
  });

  it("a missing id is null", () => {
    const bad = { state: "stopped", error: null } as unknown;
    expect(parseStudioStatus(bad)).toBeNull();
  });

  it("a non-string id is null", () => {
    const bad = { ...MINIMAL, id: 42 } as unknown;
    expect(parseStudioStatus(bad)).toBeNull();
  });

  it("a non-string non-null error is null", () => {
    const bad = { ...MINIMAL, error: 3 } as unknown;
    expect(parseStudioStatus(bad)).toBeNull();
  });

  it("an absent error is null — the field the CLI prints is not optional", () => {
    const bad = { id: "acme-os--maestro", state: "stopped" } as unknown;
    expect(parseStudioStatus(bad)).toBeNull();
  });

  it("a non-object is null (string, number, null, undefined)", () => {
    expect(parseStudioStatus("x")).toBeNull();
    expect(parseStudioStatus(7)).toBeNull();
    expect(parseStudioStatus(null)).toBeNull();
    expect(parseStudioStatus(undefined)).toBeNull();
  });

  it("an array is null — a listing handed to the single-row decoder is a miss", () => {
    expect(parseStudioStatus([MINIMAL])).toBeNull();
  });

  it("throws nothing on any input shape", () => {
    const cases: unknown[] = [
      MINIMAL, row(), { ...MINIMAL, state: "booting" }, { state: "stopped", error: null },
      { ...MINIMAL, id: 42 }, { ...MINIMAL, error: 3 }, { id: "acme-os--maestro", state: "stopped" },
      "x", 7, null, undefined, [MINIMAL], [], { id: null, state: null, error: null },
    ];
    for (const c of cases) {
      expect(() => parseStudioStatus(c)).not.toThrow();
    }
  });
});

describe("parseStudioStatusArray — one listing route's whole body", () => {
  it("an array of two valid rows decodes to the same two references", () => {
    const a = row();
    const b = row({ id: "beta--pilot", state: "running" });
    const out = parseStudioStatusArray([a, b]);
    expect(out).toEqual([a, b]);
    expect(out![0]).toBe(a);
    expect(out![1]).toBe(b);
  });

  it("an empty array decodes to an empty array — an empty fleet is a valid listing", () => {
    expect(parseStudioStatusArray([])).toEqual([]);
  });

  it("one invalid element rejects the whole array", () => {
    const out = parseStudioStatusArray([row(), { ...MINIMAL, state: "booting" }]);
    expect(out).toBeNull();
  });

  it("a single bad element in an array of non-rows is null", () => {
    expect(parseStudioStatusArray(["x"])).toBeNull();
  });

  it("a non-array is null", () => {
    expect(parseStudioStatusArray(MINIMAL)).toBeNull();
    expect(parseStudioStatusArray(null)).toBeNull();
    expect(parseStudioStatusArray(undefined)).toBeNull();
    expect(parseStudioStatusArray("{}")).toBeNull();
  });

  it("throws nothing on any input shape", () => {
    const cases: unknown[] = [
      [], [row()], [row(), { bad: true }], MINIMAL, null, undefined, "x", 7,
      [{ id: 1, state: "running", error: null }],
    ];
    for (const c of cases) {
      expect(() => parseStudioStatusArray(c)).not.toThrow();
    }
  });
});
