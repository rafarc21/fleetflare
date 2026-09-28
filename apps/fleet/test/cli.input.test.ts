import { describe, expect, it } from "vitest";
import { classifyInput } from "../cli/input";

describe("classifyInput", () => {
  it("a standalone ctrl-] byte (0x1d) classifies as escape", () => {
    expect(classifyInput(new Uint8Array([0x1d]))).toBe("escape");
  });

  it("a standalone ctrl-v byte (0x16) classifies as paste", () => {
    expect(classifyInput(new Uint8Array([0x16]))).toBe("paste");
  });

  it("a standalone ordinary byte classifies as null (forward)", () => {
    expect(classifyInput(new Uint8Array([0x61]))).toBe(null); // 'a'
  });

  it("a multi-byte chunk containing 0x1d is never intercepted — forwards untouched", () => {
    expect(classifyInput(new Uint8Array([0x61, 0x1d, 0x62]))).toBe(null);
    expect(classifyInput(new Uint8Array([0x1d, 0x62]))).toBe(null); // 0x1d as the first byte of a burst
  });

  it("a multi-byte chunk containing 0x16 is never intercepted — forwards untouched", () => {
    expect(classifyInput(new Uint8Array([0x61, 0x16, 0x62]))).toBe(null);
    expect(classifyInput(new Uint8Array([0x16, 0x62]))).toBe(null);
  });

  it("a real terminal paste (plain text, arrives as one multi-byte chunk) is never intercepted", () => {
    const pasted = new TextEncoder().encode("hello world, pasted in one go");
    expect(classifyInput(pasted)).toBe(null);
  });

  it("an empty chunk classifies as null", () => {
    expect(classifyInput(new Uint8Array([]))).toBe(null);
  });

  it("two control bytes back to back is a 2-byte chunk, not two standalone keypresses — null", () => {
    expect(classifyInput(new Uint8Array([0x1d, 0x1d]))).toBe(null);
    expect(classifyInput(new Uint8Array([0x16, 0x16]))).toBe(null);
  });
});
