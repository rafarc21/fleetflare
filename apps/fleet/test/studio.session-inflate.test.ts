import { describe, it, expect } from "vitest";
import { INFLATE_PROBE, sessionStats } from "../src/studio/burn";
import { syncSessionTick, tarAndStatCmd, singleReadCmd, BURN_KEY, type SessionSyncDeps, type SessionSyncStorage } from "../src/studio/session-sync";

/**
 * Issue #176 review, measured in real workerd (1.20260730.1): its
 * DecompressionStream has NO backpressure — the caller may keep writing
 * "without reading", filling its internal buffer. Feeding 64 KiB slices did
 * not bound that buffer: a default reader drains ~4 KiB a turn, so on
 * acme-os--maestro (9.1 MiB gz) the source was fully fed when the reader had
 * taken 0.6 of 31.5 MiB — the buffer held ~the whole raw tar. A BYOB reader
 * into one reused 1 MiB view keeps pace (31.5/31.5 when fed). Pinned HERE,
 * in the workerd pool, because bun's runtime behaves differently.
 */
const MiB = 1024 * 1024;

function tarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number) => h.set(new TextEncoder().encode(s), off);
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(size.toString(8).padStart(11, "0") + "\0", 124);
  put("14660000000\0", 136);
  put("0", 156);
  put("ustar  \0", 257);
  put("        ", 148);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

/** A gz'd tar of `files` jsonl members of `perFile` raw bytes each, built streaming. */
async function snapshot(files: number, perFile: number): Promise<{ gz: Uint8Array; raw: number }> {
  const cs = new CompressionStream("gzip") as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  const writer = cs.writable.getWriter();
  const out: Uint8Array[] = [];
  const drain = (async () => {
    const r = cs.readable.getReader();
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      out.push(value);
    }
  })();
  let raw = 0;
  let seed = 11;
  const word = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return ["read", "wrote", "tests", "bun", "check", "fleet", "lead", "studio", String(seed % 99991)][seed % 9];
  };
  for (let f = 0; f < files; f++) {
    const lines: string[] = [];
    let size = 0;
    while (size < perFile) {
      const l = JSON.stringify({ type: "assistant", message: { usage: { output_tokens: 1 }, content: Array.from({ length: 60 }, word).join(" ") } }) + "\n";
      lines.push(l);
      size += l.length;
    }
    const body = new TextEncoder().encode(lines.join(""));
    const name = `.claude/projects/-workspace-fleetflare/${String(f).padStart(8, "0")}-1111-4222-8333-444444444444.jsonl`;
    await writer.write(tarHeader(name, body.length));
    await writer.write(body);
    await writer.write(new Uint8Array((512 - (body.length % 512)) % 512));
    raw += 512 + body.length + ((512 - (body.length % 512)) % 512);
  }
  await writer.write(new Uint8Array(1024));
  raw += 1024;
  await writer.close();
  await drain;
  const gz = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of out) {
    gz.set(c, o);
    o += c.length;
  }
  return { gz, raw };
}

describe("#176 review — in workerd, the reader keeps pace with the inflate (BYOB into a reused view)", () => {
  it("when the gz source is fully fed, the reader has already taken all but ≤ 2 MiB of the raw tar", async () => {
    const { gz, raw } = await snapshot(6, 4 * MiB);
    expect(raw).toBeGreaterThan(20 * MiB);
    let consumedWhenFed: number | null = null;
    INFLATE_PROBE.onSourceDone = (consumed) => {
      consumedWhenFed = consumed;
    };
    try {
      await sessionStats(gz);
    } finally {
      INFLATE_PROBE.onSourceDone = undefined;
    }
    expect(consumedWhenFed).not.toBeNull();
    expect(raw - consumedWhenFed!).toBeLessThanOrEqual(2 * MiB);
  }, 120_000);
});

describe("#176 review — the sync tick's burn never runs the whole-text reader", () => {
  // Behavioural, not a module mock (vi.mock does not reach session-sync's own
  // import in this pool — a mocked version of this test passed with the
  // whole-text reader wired back in). Every streaming read goes through
  // walkGzipTar, which reports each fully-fed source: sessionStats walks once,
  // burnIncrement twice. The whole-text reader never walks.
  it("one tick = three streaming walks (the guard's stats + burn's two passes), and burn is recorded", async () => {
    const { gz } = await snapshot(1, 64 * 1024);
    let b64 = "";
    for (let i = 0; i < gz.length; i += 0x8000) b64 += String.fromCharCode(...gz.subarray(i, i + 0x8000));
    b64 = btoa(b64);
    const map = new Map<string, unknown>();
    const storage = {
      get: (async (k: string) => map.get(k)) as SessionSyncStorage["get"],
      put: (async (k: string | Record<string, unknown>, v?: unknown) => {
        for (const [key, val] of Object.entries(typeof k === "string" ? { [k]: v } : k)) map.set(key, val);
      }) as SessionSyncStorage["put"],
    } as SessionSyncStorage;
    const deps = {
      exec: async (cmd: string) => {
        // #202: tarAndStatCmd now prints TWO lines — the tar's `stat -c %s` and
        // the excludes file's `stat -c %Y` (the tar-start watermark). 1790251200
        // is this test's own clock, 2026-09-24T12:00:00Z.
        if (cmd === tarAndStatCmd()) return { code: 0, stdout: `${gz.length}\n1790251200`, stderr: "" };
        if (cmd === singleReadCmd()) return { code: 0, stdout: b64, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      r2Put: async () => {},
      r2List: async () => [],
      r2Delete: async () => {},
      now: () => new Date("2026-09-24T12:00:00.000Z"),
      notify: async () => {},
      burnAlertThresholdTokens: 0,
    } as unknown as SessionSyncDeps;

    let walks = 0;
    INFLATE_PROBE.onSourceDone = () => {
      walks++;
    };
    try {
      await syncSessionTick(deps, storage, "fleetflare--pilot");
    } finally {
      INFLATE_PROBE.onSourceDone = undefined;
    }

    expect(walks).toBe(3);
    const burn = map.get(BURN_KEY) as { turns: number } | undefined;
    expect(burn?.turns).toBeGreaterThan(0);
  });
});
