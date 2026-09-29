import { describe, it, expect } from "vitest";
import { inflateZlib } from "../src/write-proxy/inflate";

// Issue #7 Task 1: the inflater must load and run inside workerd too. Fixtures
// produced once by node:zlib deflateSync level 9 (one fixed-Huffman block,
// one dynamic-Huffman block).

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const FIXED = "78da4b4cce4d4dcec94ccd2b5148ad48cc2dc849d5cd2f4a57481c151e7ac2a979295c00e89daf7a";
const DYNAMIC =
  "78da6dd54b6ac3401045d1b957a10d04ba7efd598e312204ec389840b2fc0ca3c7d558170407e9d5f5f6d86ff78ffdf37b6bdbfe7b7d7cddf7b7e7eb7d7b3d7fb676b9fe3f5eb610d831983111f831183510c431e8a323c86350ab1094049608fa31c80804e318443982790c7c1882750c6c51d284d2da09a5583a294d2c57d2d2047376629a688e494d13ced1c869e2d99d9e26a095043511cd4e5113d298247521f5455257523bf93cc5d482a62ea6455217d23548ea423a17495d48a791d4857404495d487b91d485b40649434873923484341b494348c34f7e7921f5a46988a9759a869a92348494a021a0cb091a535f41d010d0d1099a4de78da069ba6f044dd7812368862edcc988a64e1c41b374e3289a5d478ea629a666344d310d92a690ae2269351d399296e9c891b4f42c359296de252769e961ca93c3543a72242dfd4827494b6f532369e971729ad6bafc012bf6a666";

describe("inflateZlib (workerd)", () => {
  it("decodes a fixed-Huffman fixture", () => {
    const c = hex(FIXED);
    const r = inflateZlib(c, 0, 4096);
    expect(new TextDecoder().decode(r.data)).toBe("acmeclient example-org ".repeat(20) + "end\n");
    expect(r.next).toBe(c.length);
  });

  it("decodes a dynamic-Huffman fixture", () => {
    let want = "";
    for (let i = 0; i < 60; i++) want += `acmeclient ${(i * 7919) % 1000} example-org row ${i}\n`;
    const c = hex(DYNAMIC);
    const r = inflateZlib(c, 0, 4096);
    expect(new TextDecoder().decode(r.data)).toBe(want);
    expect(r.next).toBe(c.length);
  });
});
