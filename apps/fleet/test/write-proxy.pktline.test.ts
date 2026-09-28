import { describe, it, expect } from "vitest";
import {
  PktError,
  ZERO_OID,
  parseReceivePackRequest,
  refusalReport,
  rewriteReceivePackAdvert,
} from "../src/write-proxy/pktline";

// Issue #7: receive-pack pkt-line handling for the server-side leak gate.
// Expected bytes are hand-built here, not via the module's own pkt().

const enc = new TextEncoder();
const dec = new TextDecoder();

function hand(s: string): string {
  const n = enc.encode(s).length + 4;
  return n.toString(16).padStart(4, "0") + s;
}

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("rewriteReceivePackAdvert", () => {
  it("rewrites caps on first ref, leaves other lines alone", () => {
    const caps =
      "report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta push-options object-format=sha1 agent=github/x";
    const body =
      hand("# service=git-receive-pack\n") +
      "0000" +
      hand(`${A} refs/heads/main\0${caps}\n`) +
      hand(`${B} refs/heads/dev\n`) +
      "0000";
    const out = dec.decode(rewriteReceivePackAdvert(enc.encode(body)));
    const want =
      hand("# service=git-receive-pack\n") +
      "0000" +
      hand(
        `${A} refs/heads/main\0report-status delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 agent=github/x no-thin\n`,
      ) +
      hand(`${B} refs/heads/dev\n`) +
      "0000";
    expect(out).toBe(want);
  });

  it("drops push-cert and keeps existing no-thin", () => {
    const body =
      hand("# service=git-receive-pack\n") +
      "0000" +
      hand(`${A} refs/heads/main\0report-status push-cert=abc no-thin\n`) +
      "0000";
    const out = dec.decode(rewriteReceivePackAdvert(enc.encode(body)));
    expect(out).toContain("\0report-status no-thin\n");
  });

  it("handles empty-repo advert", () => {
    const body =
      hand("# service=git-receive-pack\n") +
      "0000" +
      hand(`${ZERO_OID} capabilities^{}\0report-status push-options side-band-64k\n`) +
      "0000";
    const out = dec.decode(rewriteReceivePackAdvert(enc.encode(body)));
    expect(out).toBe(
      hand("# service=git-receive-pack\n") +
        "0000" +
        hand(`${ZERO_OID} capabilities^{}\0report-status side-band-64k no-thin\n`) +
        "0000",
    );
  });

  it("throws on malformed length", () => {
    expect(() => rewriteReceivePackAdvert(enc.encode("zz12abc"))).toThrow(PktError);
    expect(() => rewriteReceivePackAdvert(enc.encode("0002"))).toThrow(PktError);
    expect(() => rewriteReceivePackAdvert(enc.encode("00ffshort"))).toThrow(PktError);
  });

  it("throws when no caps line", () => {
    const body = hand("# service=git-receive-pack\n") + "0000" + hand(`${A} refs/heads/main\n`) + "0000";
    expect(() => rewriteReceivePackAdvert(enc.encode(body))).toThrow(PktError);
  });
});

function concat(...parts: (string | Uint8Array)[]): Uint8Array {
  const bs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bs) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

describe("parseReceivePackRequest", () => {
  const PACK = concat("PACK", new Uint8Array([0, 0, 0, 2, 0, 0, 0, 0, 1, 2, 3]));

  it("parses two commands and the pack", () => {
    const body = concat(
      hand(`${A} ${B} refs/heads/main\0 report-status side-band-64k agent=git/2\n`),
      hand(`${ZERO_OID} ${C} refs/heads/new`),
      "0000",
      PACK,
    );
    const r = parseReceivePackRequest(body);
    expect(r.commands).toEqual([
      { old: A, new: B, ref: "refs/heads/main" },
      { old: ZERO_OID, new: C, ref: "refs/heads/new" },
    ]);
    expect(r.caps).toEqual(["report-status", "side-band-64k", "agent=git/2"]);
    expect(r.pack).toEqual(PACK);
  });

  it("delete-only push has null pack", () => {
    const body = concat(hand(`${A} ${ZERO_OID} refs/heads/gone\0report-status\n`), "0000");
    const r = parseReceivePackRequest(body);
    expect(r.pack).toBeNull();
    expect(r.commands[0].ref).toBe("refs/heads/gone");
  });

  it("refuses push-options and push-cert caps", () => {
    for (const cap of ["push-options", "push-cert=x"]) {
      const body = concat(hand(`${A} ${B} refs/heads/main\0report-status ${cap}\n`), "0000", PACK);
      expect(() => parseReceivePackRequest(body)).toThrow(PktError);
    }
  });

  it("refuses non-delete without pack", () => {
    const body = concat(hand(`${A} ${B} refs/heads/main\0report-status\n`), "0000");
    expect(() => parseReceivePackRequest(body)).toThrow(PktError);
  });

  it("refuses delete-only with trailing bytes, junk pack, shallow, bad oid, no commands", () => {
    const bad = [
      concat(hand(`${A} ${ZERO_OID} refs/heads/x\0report-status\n`), "0000", PACK),
      concat(hand(`${A} ${B} refs/heads/x\0report-status\n`), "0000", "JUNK"),
      concat(hand(`shallow ${A}\n`), hand(`${A} ${B} refs/heads/x\0report-status\n`), "0000", PACK),
      concat(hand(`${A.slice(1)} ${B} refs/heads/x\0report-status\n`), "0000", PACK),
      concat("0000", PACK),
    ];
    for (const b of bad) expect(() => parseReceivePackRequest(b)).toThrow(PktError);
  });
});

describe("refusalReport", () => {
  it("plain report-status", () => {
    const out = dec.decode(refusalReport(["refs/heads/x"], "blocked", ["report-status"]));
    expect(out).toBe("000eunpack ok\n" + "001cng refs/heads/x blocked\n" + "0000");
  });

  it("strips newlines from message", () => {
    const out = dec.decode(refusalReport(["refs/heads/x"], "a\nb", ["report-status"]));
    expect(out).toContain("ng refs/heads/x a b\n");
  });

  it("side-band-64k wraps report in band 1 after band-2 message", () => {
    const out = refusalReport(["refs/heads/x"], "blocked", ["report-status", "side-band-64k"]);
    const inner = "000eunpack ok\n" + "001cng refs/heads/x blocked\n" + "0000";
    const want = concat("000d\x02blocked\n", "0033\x01" + inner, "0000");
    expect(out).toEqual(want);
  });

  it("side-band splits band 1 into 995-byte chunks", () => {
    const refs = Array.from({ length: 60 }, (_, i) => `refs/heads/branch-${i}`);
    const out = dec.decode(refusalReport(refs, "blocked", ["report-status", "side-band"]));
    // band-2 pkt, then band-1 pkts each <= 1000 bytes
    let i = 0;
    let inner = "";
    const bands: number[] = [];
    while (i < out.length) {
      const n = parseInt(out.slice(i, i + 4), 16);
      if (n === 0) {
        i += 4;
        continue;
      }
      expect(n).toBeLessThanOrEqual(1000);
      const band = out.charCodeAt(i + 4);
      bands.push(band);
      if (band === 1) inner += out.slice(i + 5, i + n);
      i += n;
    }
    expect(bands[0]).toBe(2);
    expect(bands.filter((b) => b === 1).length).toBeGreaterThan(1);
    expect(inner.startsWith("000eunpack ok\n")).toBe(true);
    expect(inner.endsWith("0000")).toBe(true);
    expect(out.endsWith("0000")).toBe(true);
  });
});
