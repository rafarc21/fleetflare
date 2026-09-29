// Issue #7 (spec 5.6): everything a push carries, as one text for scanText.
// Ref names, commit + tag raw text, blob text, full tree paths from each
// commit root (walk stops at out-of-pack subtrees), plus every in-pack tree's
// entry names. BOM-marked UTF-16 blobs also as UTF-16. Malformed trees or
// commits, or a non-UTF-8 `encoding` header, throw: caller refuses the push.

import type { GitObject } from "./pack";

interface TreeEntry { mode: string; name: string; oid: string }

const MAX_PATHS = 2_000_000;

function parseTree(data: Uint8Array): TreeEntry[] {
  const dec = new TextDecoder();
  const out: TreeEntry[] = [];
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    if (sp <= p) throw new Error("malformed tree: mode");
    for (let i = p; i < sp; i++) if (data[i] < 0x30 || data[i] > 0x37) throw new Error("malformed tree: mode");
    const nul = data.indexOf(0x00, sp + 1);
    if (nul <= sp + 1) throw new Error("malformed tree: name");
    if (nul + 21 > data.length) throw new Error("malformed tree: oid");
    const oid = Array.from(data.subarray(nul + 1, nul + 21), (x) => x.toString(16).padStart(2, "0")).join("");
    out.push({ mode: dec.decode(data.subarray(p, sp)), name: dec.decode(data.subarray(sp + 1, nul)), oid });
    p = nul + 21;
  }
  return out;
}

function utf16(data: Uint8Array, le: boolean): string {
  const units = new Uint16Array(data.length >> 1);
  for (let i = 0; i < units.length; i++) {
    units[i] = le ? data[2 * i] | (data[2 * i + 1] << 8) : (data[2 * i] << 8) | data[2 * i + 1];
  }
  let out = "";
  for (let i = 0; i < units.length; i += 0x8000) out += String.fromCharCode(...units.subarray(i, i + 0x8000));
  return out;
}

/** A commit or tag may declare another encoding GitHub then honors; its bytes
 *  would not read as the text the patterns match. Refused. */
function assertUtf8Header(raw: string): void {
  const head = raw.slice(0, raw.indexOf("\n\n") < 0 ? raw.length : raw.indexOf("\n\n"));
  const m = /^encoding (.*)$/m.exec(head);
  if (m && !/^utf-?8$/i.test(m[1].trim())) throw new Error("commit or tag encoding other than UTF-8 cannot be scanned");
}

export function pushText(refs: string[], objects: GitObject[]): string {
  const dec = new TextDecoder(); // non-fatal by default: bad UTF-8 becomes U+FFFD
  const parts: string[] = [...refs];
  const trees = new Map<string, TreeEntry[]>();
  for (const o of objects) {
    if (o.type === "tree") {
      const entries = parseTree(o.data);
      trees.set(o.oid, entries);
      for (const e of entries) parts.push(e.name);
    } else {
      if (o.type === "commit" || o.type === "tag") assertUtf8Header(dec.decode(o.data));
      parts.push(dec.decode(o.data));
      // GitHub renders a BOM-marked UTF-16 file as text; scan it as such too.
      const bom = o.type === "blob" && o.data.length >= 2 ? (o.data[0] << 8) | o.data[1] : 0;
      if (bom === 0xfffe || bom === 0xfeff) parts.push(utf16(o.data.subarray(2), bom === 0xfffe));
    }
  }

  const walked = new Set<string>();
  let paths = 0;
  const walk = (oid: string, prefix: string): void => {
    const key = `${oid}:${prefix}`;
    if (walked.has(key)) return;
    walked.add(key);
    const entries = trees.get(oid);
    if (!entries) return;
    for (const e of entries) {
      if (++paths > MAX_PATHS) throw new Error("too many tree paths");
      const path = prefix + e.name;
      parts.push(path);
      if (e.mode === "40000") walk(e.oid, path + "/");
    }
  };
  for (const o of objects) {
    if (o.type !== "commit") continue;
    const m = /^tree ([0-9a-f]{40})\n/.exec(dec.decode(o.data.subarray(0, 46)));
    if (!m) throw new Error("malformed commit: tree line");
    walk(m[1], "");
  }
  return parts.join("\n");
}
