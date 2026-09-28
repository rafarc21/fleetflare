// Issue #7: git packfile parser for the receive-pack leak gate. Resolves every
// entry (OFS/REF deltas included) to a full object so the scanner sees real
// content. Fail closed: bad framing, trailer, sizes, or a delta base outside
// this pack (thin pack) throws PackError. Pure TS: loads in workerd + bun.

import { inflateZlib } from "./inflate";

export type GitObjectType = "commit" | "tree" | "blob" | "tag";
export interface GitObject { type: GitObjectType; data: Uint8Array; oid: string }

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

const TYPES: Record<number, GitObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

type Entry =
  | { kind: "full"; type: GitObjectType; data: Uint8Array }
  | { kind: "ofs"; baseIdx: number; delta: Uint8Array }
  | { kind: "ref"; baseOid: string; delta: Uint8Array };

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function sha1(d: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", d as Uint8Array<ArrayBuffer>));
}

async function objectOid(type: GitObjectType, data: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`${type} ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head);
  all.set(data, head.length);
  return hex(await sha1(all));
}

export async function parsePack(pack: Uint8Array, limits: { maxInflated: number }): Promise<GitObject[]> {
  if (pack.length < 32) throw new PackError("pack too short");
  const body = pack.subarray(0, pack.length - 20);
  if (body[0] !== 0x50 || body[1] !== 0x41 || body[2] !== 0x43 || body[3] !== 0x4b) throw new PackError("bad pack magic");
  const u32 = (p: number) => ((body[p] << 24) | (body[p + 1] << 16) | (body[p + 2] << 8) | body[p + 3]) >>> 0;
  const version = u32(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const count = u32(8);

  let pos = 12;
  let budget = limits.maxInflated;
  const spend = (n: number) => {
    budget -= n;
    if (budget < 0) throw new PackError("inflated size exceeds limit");
  };
  const byte = (): number => {
    if (pos >= body.length) throw new PackError("truncated pack");
    return body[pos++];
  };

  const entries: Entry[] = [];
  const offsetIdx = new Map<number, number>();
  for (let n = 0; n < count; n++) {
    const start = pos;
    let c = byte();
    const t = (c >> 4) & 7;
    let size = c & 0x0f;
    let mul = 16;
    while (c & 0x80) {
      c = byte();
      size += (c & 0x7f) * mul;
      mul *= 128;
      if (size > limits.maxInflated || mul > 2 ** 56) throw new PackError("inflated size exceeds limit");
    }
    let base: { ofs: number } | { oid: string } | null = null;
    if (t === 6) {
      c = byte();
      let ofs = c & 0x7f;
      while (c & 0x80) {
        c = byte();
        ofs = (ofs + 1) * 128 + (c & 0x7f);
        if (ofs > start) throw new PackError("delta base offset out of range");
      }
      base = { ofs: start - ofs };
    } else if (t === 7) {
      if (pos + 20 > body.length) throw new PackError("truncated pack");
      base = { oid: hex(body.subarray(pos, pos + 20)) };
      pos += 20;
    } else if (!TYPES[t]) {
      throw new PackError(`invalid object type ${t}`);
    }
    spend(size);
    let data: Uint8Array;
    try {
      const r = inflateZlib(body, pos, size);
      data = r.data;
      pos = r.next;
    } catch (e) {
      throw new PackError(`bad zlib stream: ${(e as Error).message}`);
    }
    if (data.length !== size) throw new PackError("inflated size does not match header");
    offsetIdx.set(start, n);
    if (base === null) entries.push({ kind: "full", type: TYPES[t], data });
    else if ("ofs" in base) {
      const baseIdx = offsetIdx.get(base.ofs);
      if (baseIdx === undefined || base.ofs >= start) throw new PackError("delta base offset is not an earlier entry");
      entries.push({ kind: "ofs", baseIdx, delta: data });
    } else entries.push({ kind: "ref", baseOid: base.oid, delta: data });
  }
  if (pos !== body.length) throw new PackError("unexpected data after last entry");
  if (hex(await sha1(body)) !== hex(pack.subarray(body.length))) throw new PackError("pack trailer checksum mismatch");

  const resolved: (GitObject | null)[] = new Array(count).fill(null);
  const byOid = new Map<string, GitObject>();
  const settle = async (i: number, type: GitObjectType, data: Uint8Array) => {
    const obj = { type, data, oid: await objectOid(type, data) };
    resolved[i] = obj;
    byOid.set(obj.oid, obj);
  };
  for (let i = 0; i < count; i++) {
    const e = entries[i];
    if (e.kind === "full") await settle(i, e.type, e.data);
  }
  let pending = entries.filter((e) => e.kind !== "full").length;
  while (pending > 0) {
    let progress = 0;
    for (let i = 0; i < count; i++) {
      const e = entries[i];
      if (resolved[i] || e.kind === "full") continue;
      const baseObj = e.kind === "ofs" ? resolved[e.baseIdx] : byOid.get(e.baseOid) ?? null;
      if (!baseObj) continue;
      await settle(i, baseObj.type, applyDelta(baseObj.data, e.delta, spend));
      progress++;
    }
    if (progress === 0) throw new PackError("delta base not in pack");
    pending -= progress;
  }
  return resolved as GitObject[];
}

function applyDelta(base: Uint8Array, delta: Uint8Array, spend: (n: number) => void): Uint8Array {
  let p = 0;
  const byte = (): number => {
    if (p >= delta.length) throw new PackError("truncated delta");
    return delta[p++];
  };
  const varint = (): number => {
    let v = 0, mul = 1, c: number;
    do {
      c = byte();
      v += (c & 0x7f) * mul;
      mul *= 128;
      if (mul > 2 ** 56) throw new PackError("delta size overflow");
    } while (c & 0x80);
    return v;
  };
  if (varint() !== base.length) throw new PackError("delta source size mismatch");
  const size = varint();
  spend(size);
  const out = new Uint8Array(size);
  let o = 0;
  while (p < delta.length) {
    const op = byte();
    if (op & 0x80) {
      let off = 0, len = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) off += byte() * 2 ** (8 * b);
      for (let b = 0; b < 3; b++) if (op & (0x10 << b)) len += byte() << (8 * b);
      if (len === 0) len = 0x10000;
      if (off + len > base.length || o + len > size) throw new PackError("delta copy out of bounds");
      out.set(base.subarray(off, off + len), o);
      o += len;
    } else if (op) {
      if (p + op > delta.length || o + op > size) throw new PackError("delta insert out of bounds");
      out.set(delta.subarray(p, p + op), o);
      p += op;
      o += op;
    } else {
      throw new PackError("reserved delta opcode");
    }
  }
  if (o !== size) throw new PackError("delta result size mismatch");
  return out;
}
