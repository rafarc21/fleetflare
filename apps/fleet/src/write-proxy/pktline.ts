// Git smart-HTTP receive-pack pkt-lines (issue #7): rewrite the ref
// advertisement caps, parse a push request fail-closed, forge a refusal
// report-status. Pure TS, no imports: runs in workerd and bun.

export class PktError extends Error {}

export const ZERO_OID = "0".repeat(40);
export const FLUSH = new Uint8Array([0x30, 0x30, 0x30, 0x30]);

const enc = new TextEncoder();
const dec = new TextDecoder();

export function pkt(s: string | Uint8Array): Uint8Array {
  const data = typeof s === "string" ? enc.encode(s) : s;
  const n = data.length + 4;
  if (n > 65520) throw new PktError("pkt too long");
  const out = new Uint8Array(n);
  out.set(enc.encode(n.toString(16).padStart(4, "0")));
  out.set(data, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// One pkt at `off`: data null = flush. Throws on bad length.
function readPkt(body: Uint8Array, off: number): { data: Uint8Array | null; next: number } {
  if (off + 4 > body.length) throw new PktError("truncated pkt");
  const hex = dec.decode(body.subarray(off, off + 4));
  if (!/^[0-9a-f]{4}$/.test(hex)) throw new PktError("bad pkt length");
  const n = parseInt(hex, 16);
  if (n === 0) return { data: null, next: off + 4 };
  if (n < 4) throw new PktError("bad pkt length");
  if (off + n > body.length) throw new PktError("pkt overflow");
  return { data: body.subarray(off + 4, off + n), next: off + n };
}

function keepCap(c: string): boolean {
  return c !== "push-options" && c !== "report-status-v2" && !c.startsWith("push-cert");
}

export function rewriteReceivePackAdvert(body: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  let off = 0;
  let done = false;
  while (off < body.length) {
    const start = off;
    const { data, next } = readPkt(body, off);
    off = next;
    const nul = data && !done ? data.indexOf(0) : -1;
    if (!data || nul < 0) {
      out.push(body.subarray(start, next));
      continue;
    }
    let rest = dec.decode(data.subarray(nul + 1));
    const nl = rest.endsWith("\n") ? "\n" : "";
    if (nl) rest = rest.slice(0, -1);
    const caps = rest.split(" ").filter((c) => c && keepCap(c));
    if (!caps.includes("no-thin")) caps.push("no-thin");
    out.push(pkt(concat([data.subarray(0, nul + 1), enc.encode(caps.join(" ") + nl)])));
    done = true;
  }
  if (!done) throw new PktError("no capabilities in advert");
  return concat(out);
}

export interface PushCommand {
  old: string;
  new: string;
  ref: string;
}

const OID = /^[0-9a-f]{40}$/;

export function parseReceivePackRequest(body: Uint8Array): {
  commands: PushCommand[];
  caps: string[];
  pack: Uint8Array | null;
} {
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  let off = 0;
  for (;;) {
    const { data, next } = readPkt(body, off);
    off = next;
    if (!data) break;
    let line = dec.decode(data);
    if (line.endsWith("\n")) line = line.slice(0, -1);
    if (commands.length === 0) {
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        caps = line.slice(nul + 1).split(" ").filter(Boolean);
        line = line.slice(0, nul);
      }
    } else if (line.includes("\0")) throw new PktError("bad command line");
    if (line.startsWith("shallow ")) throw new PktError("shallow push refused");
    const [old, nw, ref, ...extra] = line.split(" ");
    if (!OID.test(old ?? "") || !OID.test(nw ?? "") || !ref || extra.length)
      throw new PktError("bad command line");
    commands.push({ old, new: nw, ref });
  }
  if (commands.length === 0) throw new PktError("no commands");
  if (caps.some((c) => c === "push-options" || c.startsWith("push-cert")))
    throw new PktError("push options or signed push refused");
  const rest = body.subarray(off);
  const allDelete = commands.every((c) => c.new === ZERO_OID);
  if (allDelete) {
    if (rest.length) throw new PktError("unexpected data after delete");
    return { commands, caps, pack: null };
  }
  if (rest.length < 4 || dec.decode(rest.subarray(0, 4)) !== "PACK")
    throw new PktError("missing pack");
  return { commands, caps, pack: rest };
}

export function refusalReport(refs: string[], message: string, caps: string[]): Uint8Array {
  const msg = message.replace(/\r?\n|\r/g, " ");
  const report = concat([pkt("unpack ok\n"), ...refs.map((r) => pkt(`ng ${r} ${msg}\n`)), FLUSH]);
  const max = caps.includes("side-band-64k") ? 65515 : caps.includes("side-band") ? 995 : 0;
  if (!max) return report;
  const out: Uint8Array[] = [];
  const band = (n: number, b: Uint8Array) => {
    for (let i = 0; i < b.length; i += max) out.push(pkt(concat([new Uint8Array([n]), b.subarray(i, i + max)])));
  };
  band(2, enc.encode(msg + "\n"));
  band(1, report);
  out.push(FLUSH);
  return concat(out);
}
