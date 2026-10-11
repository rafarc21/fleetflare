// Issue #364 (deep-modules sweep 4, F4): characterization of the shared
// chunked encoder BEFORE the four src copies (github/api.ts, studio/blueprint.ts,
// studio/sandbox-api.ts, studio/gh-wrapper.ts) migrate onto it — a wrong
// chunk bound or a dropped TextEncoder step must fail here first, not in a
// GitHub Contents API call mid-PR.
import { describe, expect, test } from "bun:test";
import { bytesToBase64, base64EncodeUtf8 } from "../../src/base64";

/** Independent oracle: no String.fromCharCode spread, no 0x8000 chunking —
 *  bun's own atob + TextDecoder and Buffer, so a bug in the module's loop
 *  cannot pass by being reproduced in the test. */
function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe("bytesToBase64 (chunked binary encode)", () => {
  test("empty bytes encode to the empty base64 string", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });

  test("ASCII bytes round-trip byte-exact", () => {
    const bytes = Uint8Array.from("hello fleetflare".repeat(4), (c) => c.charCodeAt(0));
    const out = bytesToBase64(bytes);
    expect(Buffer.compare(decode(out), bytes)).toBe(0);
  });

  test("arbitrary high bytes (0x00-0xff) round-trip byte-exact", () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const out = bytesToBase64(bytes);
    expect(Buffer.compare(decode(out), bytes)).toBe(0);
  });

  test("sizes at, below and above the 0x8000 chunk boundary all round-trip byte-exact", () => {
    // 32767/32768/32769 pin the boundary itself: an off-by-one in the
    // subarray bound corrupts exactly these, and nothing else.
    for (const size of [32767, 32768, 32769, 0x10000]) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
      const out = bytesToBase64(bytes);
      expect(Buffer.compare(decode(out), bytes)).toBe(0);
    }
  });

  test("a 100k-char payload encodes without a call-stack blowup and round-trips", () => {
    const bytes = new TextEncoder().encode("x".repeat(100_000));
    const out = bytesToBase64(bytes);
    expect(Buffer.compare(decode(out), bytes)).toBe(0);
  });

  test("matches bun's own Buffer base64 for a byte array", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("base64EncodeUtf8 (string → UTF-8-safe base64)", () => {
  test("ASCII string matches plain btoa", () => {
    expect(base64EncodeUtf8("plain ascii")).toBe(btoa("plain ascii"));
  });

  test("Latin-1 text survives (bare btoa accepts but must not corrupt é/ü)", () => {
    const s = "café über maß";
    expect(new TextDecoder().decode(decode(base64EncodeUtf8(s)))).toBe(s);
  });

  test("CJK and emoji encode without throwing and decode losslessly", () => {
    const s = "你好世界 🌍✅ box-drawing ─│┌";
    expect(new TextDecoder().decode(decode(base64EncodeUtf8(s)))).toBe(s);
  });

  test("empty string encodes to empty", () => {
    expect(base64EncodeUtf8("")).toBe("");
  });

  test("100k-char multi-byte string: no throw, lossless decode", () => {
    const s = "¿ñ好".repeat(33_334);
    const out = base64EncodeUtf8(s);
    expect(new TextDecoder().decode(decode(out))).toBe(s);
  });

  test("matches Buffer's base64 of the TextEncoder bytes", () => {
    const s = "mixed ascii + 中文 + emoji 🚀";
    expect(base64EncodeUtf8(s)).toBe(Buffer.from(new TextEncoder().encode(s)).toString("base64"));
  });
});
