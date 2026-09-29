import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { inflateZlib, InflateError } from "../../src/write-proxy/inflate";

// Issue #7 Task 1: own zlib inflater must report bytes consumed so the pack
// parser can find the next entry. Checked against node:zlib output.

const enc = new TextEncoder();
const JUNK = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x78]);

function withJunk(c: Uint8Array): Uint8Array {
  const out = new Uint8Array(c.length + JUNK.length);
  out.set(c);
  out.set(JUNK, c.length);
  return out;
}

const repetitive = enc.encode("acmeclient example-org line\n".repeat(5000));
const inputs: Array<[string, Uint8Array]> = [
  ["empty", new Uint8Array(0)],
  ["text", enc.encode("hello acmeclient from example-org\nsecond line\n")],
  ["random 200KB", new Uint8Array(randomBytes(200 * 1024))],
  ["repetitive", repetitive],
];

describe("inflateZlib", () => {
  for (const level of [0, 1, 9]) {
    for (const [name, input] of inputs) {
      test(`level ${level} ${name}: round-trips, next = compressed length`, () => {
        const c = new Uint8Array(deflateSync(input, { level }));
        const r = inflateZlib(withJunk(c), 0, 1 << 24);
        expect(Buffer.from(r.data).equals(Buffer.from(input))).toBe(true);
        expect(r.next).toBe(c.length);
      });
    }
  }

  test("honours a non-zero offset", () => {
    const input = enc.encode("offset case");
    const c = new Uint8Array(deflateSync(input));
    const buf = new Uint8Array(3 + c.length);
    buf.set(c, 3);
    const r = inflateZlib(buf, 3, 1000);
    expect(new TextDecoder().decode(r.data)).toBe("offset case");
    expect(r.next).toBe(3 + c.length);
  });

  test("corrupt adler32 throws", () => {
    const c = new Uint8Array(deflateSync(enc.encode("adler check")));
    c[c.length - 1] ^= 0xff;
    expect(() => inflateZlib(c, 0, 1000)).toThrow(InflateError);
  });

  test("maxOut smaller than output throws", () => {
    const c = new Uint8Array(deflateSync(repetitive, { level: 9 }));
    expect(() => inflateZlib(c, 0, repetitive.length - 1)).toThrow(InflateError);
  });

  test("bad header throws", () => {
    const c = new Uint8Array(deflateSync(enc.encode("hdr")));
    const badCm = c.slice(); badCm[0] = 0x77;
    expect(() => inflateZlib(badCm, 0, 1000)).toThrow(InflateError);
    const badCheck = c.slice(); badCheck[1] ^= 0x01;
    expect(() => inflateZlib(badCheck, 0, 1000)).toThrow(InflateError);
    const fdict = new Uint8Array([0x78, 0xbb, 0, 0, 0, 0]);
    expect(() => inflateZlib(fdict, 0, 1000)).toThrow(InflateError);
  });

  test("truncated stream throws InflateError", () => {
    const c = new Uint8Array(deflateSync(repetitive, { level: 9 }));
    for (const cut of [1, 3, 10, Math.floor(c.length / 2)]) {
      expect(() => inflateZlib(c.subarray(0, c.length - cut), 0, 1 << 24)).toThrow(InflateError);
    }
  });
});
