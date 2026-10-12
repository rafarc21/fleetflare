import { describe, expect, it } from "vitest";
import { shortId } from "../src/events/schema";

describe("shortId", () => {
  it("returns 8 characters", () => {
    expect(shortId()).toHaveLength(8);
  });

  it("is hex — makeEvent id tail vocabulary", () => {
    expect(shortId()).toMatch(/^[0-9a-f]{8}$/);
  });

  it("does not repeat across calls", () => {
    const ids = new Set(Array.from({ length: 200 }, shortId));
    expect(ids.size).toBe(200);
  });
});
