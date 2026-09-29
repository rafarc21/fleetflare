// Issue #7: zlib (RFC 1950) + DEFLATE (RFC 1951) inflater that reports how
// many input bytes the stream consumed. A packfile is zlib streams back to
// back with no lengths, so the pack parser needs `next` to find the next
// entry; DecompressionStream cannot give it. Pure TS: loads in workerd + bun.
// Fail closed: every malformed or out-of-bounds input throws InflateError.

export class InflateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InflateError";
  }
}

interface Tree { counts: Uint16Array; symbols: Uint16Array }

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildTree(lengths: Uint8Array, n: number): Tree {
  const counts = new Uint16Array(16);
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) throw new InflateError("over-subscribed huffman code");
  }
  const offs = new Uint16Array(16);
  for (let len = 1, sum = 0; len < 16; len++) { offs[len] = sum; sum += counts[len]; }
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

const FIXED_LIT = (() => {
  const l = new Uint8Array(288);
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
  return buildTree(l, 288);
})();
const FIXED_DIST = buildTree(new Uint8Array(30).fill(5), 30);

export function inflateZlib(buf: Uint8Array, offset: number, maxOut: number): { data: Uint8Array; next: number } {
  let pos = offset;
  let tag = 0;
  let bits = 0;

  const byte = (): number => {
    if (pos < 0 || pos >= buf.length) throw new InflateError("unexpected end of input");
    return buf[pos++];
  };
  const getBits = (n: number): number => {
    while (bits < n) { tag |= byte() << bits; bits += 8; }
    const v = tag & ((1 << n) - 1);
    tag >>>= n;
    bits -= n;
    return v;
  };
  const decodeSym = (t: Tree): number => {
    let sum = 0, cur = 0, len = 0;
    do {
      cur = 2 * cur + getBits(1);
      if (++len > 15) throw new InflateError("invalid huffman code");
      sum += t.counts[len];
      cur -= t.counts[len];
    } while (cur >= 0);
    return t.symbols[sum + cur];
  };

  let out = new Uint8Array(Math.min(maxOut, 1024));
  let outLen = 0;
  const ensure = (extra: number): void => {
    const need = outLen + extra;
    if (need > maxOut) throw new InflateError("inflated output exceeds limit");
    if (need <= out.length) return;
    let cap = out.length || 1;
    while (cap < need) cap *= 2;
    const grown = new Uint8Array(Math.min(cap, maxOut));
    grown.set(out.subarray(0, outLen));
    out = grown;
  };

  const cmf = byte();
  const flg = byte();
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7) throw new InflateError("bad zlib header: compression method");
  if (((cmf << 8) | flg) % 31 !== 0) throw new InflateError("bad zlib header: check bits");
  if (flg & 0x20) throw new InflateError("bad zlib header: preset dictionary");

  const inflateBlock = (lit: Tree, dist: Tree): void => {
    for (;;) {
      const sym = decodeSym(lit);
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
        continue;
      }
      if (sym === 256) return;
      const li = sym - 257;
      if (li >= 29) throw new InflateError("invalid length symbol");
      const length = LEN_BASE[li] + getBits(LEN_EXTRA[li]);
      const di = decodeSym(dist);
      if (di >= 30) throw new InflateError("invalid distance symbol");
      const d = DIST_BASE[di] + getBits(DIST_EXTRA[di]);
      if (d > outLen) throw new InflateError("distance too far back");
      ensure(length);
      for (let i = 0; i < length; i++, outLen++) out[outLen] = out[outLen - d];
    }
  };

  const dynamicTrees = (): [Tree, Tree] => {
    const hlit = getBits(5) + 257;
    const hdist = getBits(5) + 1;
    const hclen = getBits(4) + 4;
    if (hlit > 286 || hdist > 30) throw new InflateError("too many huffman codes");
    const cl = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = getBits(3);
    const clTree = buildTree(cl, 19);
    const lengths = new Uint8Array(hlit + hdist);
    for (let i = 0; i < hlit + hdist;) {
      const sym = decodeSym(clTree);
      let rep: number, val: number;
      if (sym < 16) { lengths[i++] = sym; continue; }
      if (sym === 16) {
        if (i === 0) throw new InflateError("repeat with no previous length");
        val = lengths[i - 1]; rep = 3 + getBits(2);
      } else if (sym === 17) { val = 0; rep = 3 + getBits(3); }
      else if (sym === 18) { val = 0; rep = 11 + getBits(7); }
      else throw new InflateError("invalid code length symbol");
      if (i + rep > hlit + hdist) throw new InflateError("code lengths overflow");
      lengths.fill(val, i, i + rep);
      i += rep;
    }
    if (lengths[256] === 0) throw new InflateError("missing end-of-block code");
    return [buildTree(lengths.subarray(0, hlit), hlit), buildTree(lengths.subarray(hlit), hdist)];
  };

  let final = 0;
  while (!final) {
    final = getBits(1);
    const type = getBits(2);
    if (type === 0) {
      tag = 0; bits = 0;
      const len = byte() | (byte() << 8);
      const nlen = byte() | (byte() << 8);
      if ((len ^ 0xffff) !== nlen) throw new InflateError("stored block length mismatch");
      if (pos + len > buf.length) throw new InflateError("unexpected end of input");
      ensure(len);
      out.set(buf.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
    } else if (type === 1) {
      inflateBlock(FIXED_LIT, FIXED_DIST);
    } else if (type === 2) {
      const [lit, dist] = dynamicTrees();
      inflateBlock(lit, dist);
    } else {
      throw new InflateError("invalid block type");
    }
  }

  tag = 0; bits = 0;
  const want = ((byte() << 24) | (byte() << 16) | (byte() << 8) | byte()) >>> 0;
  const data = out.slice(0, outLen);
  if (adler32(data) !== want) throw new InflateError("adler32 mismatch");
  return { data, next: pos };
}

function adler32(d: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < d.length;) {
    const end = Math.min(i + 5552, d.length);
    for (; i < end; i++) { a += d[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
