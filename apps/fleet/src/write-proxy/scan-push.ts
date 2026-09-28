// Issue #7 (spec 5.6): everything a push carries, as one text for scanText.
// Ref names, commit + tag raw text, blob text, full tree paths from each
// commit root (walk stops at out-of-pack subtrees), plus every in-pack tree's
// entry names. Malformed trees or commits throw: caller refuses the push.

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
      parts.push(dec.decode(o.data));
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
