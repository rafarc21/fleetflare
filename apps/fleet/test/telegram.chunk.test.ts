import { describe, expect, it } from "vitest";
import { chunk } from "../src/telegram/chunk";

describe("chunk", () => {
  it("returns a short message unchanged, as one piece", () => {
    expect(chunk("hello")).toEqual(["hello"]);
  });

  it("never emits a piece longer than the limit", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    for (const piece of chunk(text, 100)) {
      expect(piece.length).toBeLessThanOrEqual(100);
    }
  });

  it("prefers to split on a newline", () => {
    const text = "aaaa\nbbbb\ncccc";
    expect(chunk(text, 10)).toEqual(["aaaa\nbbbb", "cccc"]);
  });

  it("hard-splits a single line longer than the limit", () => {
    const pieces = chunk("x".repeat(25), 10);
    expect(pieces).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("drops nothing — pieces rejoin to the original", () => {
    const text = "alpha\nbeta\ngamma\ndelta";
    expect(chunk(text, 12).join("\n")).toBe(text);
  });

  it("returns an empty array for empty input", () => {
    expect(chunk("")).toEqual([]);
  });

  it("preserves a blank line between two lines", () => {
    expect(chunk("a\n\nb").join("\n")).toBe("a\n\nb");
  });

  it("preserves a leading newline", () => {
    expect(chunk("\nabc").join("\n")).toBe("\nabc");
  });

  it("never returns zero pieces for input that has characters", () => {
    // chunk("\n\n\n") returning [] makes sendMessage deliver nothing, silently.
    expect(chunk("\n\n\n").length).toBeGreaterThan(0);
    expect(chunk("\n\n\n").join("\n")).toBe("\n\n\n");
  });

  it("keeps a blank line that falls on a chunk boundary", () => {
    const text = "aaaaaaaaaa\n\nbbbbbbbbbb";
    expect(chunk(text, 10).join("\n")).toBe(text);
  });
});
