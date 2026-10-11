// Pins the shared fakeStorage helper's contract (issue #371, sweep-3 S3-F1):
// a Map-backed DurableObjectStorage fake whose `get` returns EXACTLY what was
// put — the #103 lesson: a stored null must read back null, never undefined,
// because real DO storage never makes that conversion and a fake that did hid
// the only lock shape a live studio holds between operations.
import { describe, it, expect } from "vitest";
import { STATUS_KEY } from "../../src/studio/provision";
import { fakeStorage } from "./do-storage";

describe("fakeStorage — the shared Map-backed DO-storage fake (#371)", () => {
  it("an empty fake: get on any key resolves to undefined", async () => {
    const s = fakeStorage();
    expect(await s.get(STATUS_KEY)).toBeUndefined();
    expect(await s.get("never-written")).toBeUndefined();
  });

  it("a seeded fake: get(STATUS_KEY) resolves to that exact object", async () => {
    const row = { id: "fleetflare--web-studio", state: "running" };
    const s = fakeStorage({ [STATUS_KEY]: row });
    expect(await s.get(STATUS_KEY)).toBe(row);
  });

  it("a stored null reads back as null, never undefined (#103)", async () => {
    const s = fakeStorage({ k: null });
    expect(await s.get("k")).toBe(null);
  });

  it("put then get round-trips any value", async () => {
    const s = fakeStorage();
    const row = { state: "stopped", nested: { deep: [1, 2, 3] } };
    await s.put(STATUS_KEY, row);
    expect(await s.get(STATUS_KEY)).toEqual(row);
    await s.put("string-key", "plain string");
    expect(await s.get("string-key")).toBe("plain string");
    await s.put("null-key", null);
    expect(await s.get("null-key")).toBe(null);
  });

  it("exposes the live Map: put writes land on it, and pre-seeding the map is visible to get", async () => {
    const s = fakeStorage();
    await s.put(STATUS_KEY, { state: "running" });
    expect(s.map).toBeInstanceOf(Map);
    expect(s.map.get(STATUS_KEY)).toEqual({ state: "running" });

    s.map.set("pre-seeded", 42);
    expect(await s.get("pre-seeded")).toBe(42);
  });

  it("put returns a promise resolving to undefined", async () => {
    const s = fakeStorage();
    expect(await s.put(STATUS_KEY, null)).toBeUndefined();
  });
});
