import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { gzipSync, gunzipSync, createGzip } from "node:zlib";
import * as burn from "../../src/studio/burn";
import { SESSION_TOTAL_MAX } from "../../src/studio/archive";
import { runSessionRestore } from "../../src/studio/provision";

/**
 * Issue #176: a session snapshot must never be inflated whole inside the
 * Durable Object (128 MB isolate cap; an OOM resets the isolate, no catch
 * runs, and every retry reads the same bytes — the studio wedges).
 *
 * MEASURED on main (V8 live set, gc'd heapUsed + external, 16 real R2
 * snapshots): restore ≈ gz + raw, the sync tick ≈ 4.1 × raw — 128 MiB at
 * acme-os--maestro's 9.1 MiB gz once workerd's whole-written-chunk
 * inflate (#118/#140) is counted. SESSION_TOTAL_MAX was 64 MiB.
 *
 * So: every gunzip is FED in GUNZIP_SLICE slices (workerd inflates a whole
 * written chunk at once, off-heap), and nothing holds the raw tar or a
 * member's whole text. Pinned here two ways: the largest write into any
 * DecompressionStream, and the live-set peak over the held input for a
 * synthetic snapshot AT the cap.
 */
const MiB = 1024 * 1024;
const SLICE = 64 * 1024;
/** Peak live bytes allowed ON TOP of the gz input the caller already holds. */
const BUDGET = 16 * MiB;

// --- a probe around DecompressionStream --------------------------------------
const Orig = globalThis.DecompressionStream;
let maxWrite = 0;
let peak = 0;
let base = 0;
function live(): number {
  Bun.gc(true);
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}
function sample(): void {
  const v = live();
  if (v > peak) peak = v;
}
/**
 * #256: one forced full gc per inflated chunk was ~29,000 per sync-read pass,
 * and a full gc while Bun's threaded zlib is mid-stream can break it (below).
 * Sampling once per MiB of output keeps the probe far finer than the 16 MiB
 * budget with ~1/200 of the gcs.
 */
const SAMPLE_EVERY = MiB;
let sinceSample = 0;
/**
 * #256: the RETAINED set at the start, not garbage still being freed. After
 * Bun.gc(true) returns, external ArrayBuffer stores keep being released for a
 * while -- longer on a loaded host. Measured (Ubuntu 24.04, 8 busy loops):
 * baselines 31-55 MiB above the retained set (the snapshot build's garbage),
 * 322 MiB (the control's). So: gc and yield until two readings agree. Only
 * the baseline waits; samples inside the pipe stay synchronous (an awaiting
 * sample lets the inflater run ahead, no backpressure: 145-400 MiB measured).
 */
async function settledLive(): Promise<number> {
  let prev = live();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const v = live();
    if (Math.abs(v - prev) < 256 * 1024) return v;
    prev = v;
  }
  return prev;
}
/**
 * #256: every DecompressionStream the probe makes stays reachable until the
 * test ends. The probe keeps only its readable/writable; a forced full gc (one
 * per chunk, above) could collect the object itself and Bun's native zlib
 * with it, mid-stream: "gzip decompression failed:" (Z_BUF_ERROR, empty
 * message) at ~5 MiB fed, in ~half the processes under load. Pinned, the
 * failure rate fell to ~1 process in 6; with the per-MiB sampling below, the
 * forced gcs are ~1/200 as many.
 */
const pinned = new Set<unknown>();
beforeEach(() => {
  maxWrite = 0;
  globalThis.DecompressionStream = class {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(format: string) {
      const d = new Orig(format as "gzip") as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
      pinned.add(d);
      // #256: no extra pipes -- each write goes straight to d's writer and is
      // awaited, each read comes straight off d's reader, cancel passes through.
      const w = d.writable.getWriter();
      this.writable = new WritableStream<Uint8Array>({
        write(c) {
          if (c.byteLength > maxWrite) maxWrite = c.byteLength;
          return w.write(c);
        },
        close: () => w.close(),
        abort: (reason) => w.abort(reason),
      });
      const r = d.readable.getReader();
      this.readable = new ReadableStream<Uint8Array>(
        {
          async pull(ctl) {
            const { done, value } = await r.read();
            if (done) return ctl.close();
            sinceSample += value.byteLength;
            if (sinceSample >= SAMPLE_EVERY) {
              sinceSample = 0;
              sample();
            }
            ctl.enqueue(value);
          },
          cancel: (reason) => r.cancel(reason),
        },
        { highWaterMark: 0 },
      );
    }
  } as unknown as typeof DecompressionStream;
});
afterEach(() => {
  globalThis.DecompressionStream = Orig;
  pinned.clear();
});

async function peakOver(fn: () => Promise<unknown>): Promise<number> {
  sinceSample = 0;
  base = await settledLive();
  peak = base;
  const held = await fn();
  sample();
  void held;
  return peak - base;
}

// --- a synthetic snapshot, built streaming ------------------------------------
function header(name: string, size: number, type = "0"): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number) => h.set(new TextEncoder().encode(s), off);
  put(name.slice(0, 100), 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(size.toString(8).padStart(11, "0") + "\0", 124);
  put(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
  put(type, 156);
  put("ustar  \0", 257);
  put("        ", 148);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
function pad(n: number): Uint8Array {
  return new Uint8Array((512 - (n % 512)) % 512);
}

const WORDS = "the lead read a file then wrote tests ran bun check fixed a bug in the harness and pushed a branch for review with notes".split(" ");
let seed = 7;
function rnd(n: number): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
}
function line(i: number): string {
  const words = Array.from({ length: 40 + rnd(80) }, () => WORDS[rnd(WORDS.length)] + (rnd(9) === 0 ? String(rnd(99999)) : ""));
  const assistant = i % 3 === 0;
  return JSON.stringify(
    assistant
      ? { type: "assistant", timestamp: `2026-09-24T10:${String(i % 60).padStart(2, "0")}:00Z`, message: { usage: { input_tokens: 10 + (i % 7), output_tokens: 3 + (i % 5) }, content: words.join(" ") } }
      : { type: "user", timestamp: `2026-09-24T10:${String(i % 60).padStart(2, "0")}:00Z`, message: { content: words.join(" ") } },
  ) + "\n";
}

/** A gz'd tar of jsonl members, roughly `targetGz` bytes, never holding the raw tar. */
async function synthSnapshot(targetGz: number): Promise<Uint8Array> {
  const gz = createGzip({ level: 6 });
  const out: Buffer[] = [];
  let outLen = 0;
  gz.on("data", (b: Buffer) => {
    out.push(b);
    outLen += b.length;
  });
  const write = (b: Uint8Array) => new Promise<void>((r) => (gz.write(b) ? r() : gz.once("drain", r)));
  let file = 0;
  let i = 0;
  while (outLen < targetGz) {
    // One session file of ~4 MiB raw, then the next: a long session + more.
    const lines: string[] = [];
    let size = 0;
    while (size < 4 * MiB) {
      const l = line(i++);
      lines.push(l);
      size += Buffer.byteLength(l);
    }
    const body = new TextEncoder().encode(lines.join(""));
    const name = `.claude/projects/-workspace-fleetflare/${String(file++).padStart(8, "0")}-1111-4222-8333-444444444444.jsonl`;
    await write(header(name, body.length));
    await write(body);
    await write(pad(body.length));
    await new Promise((r) => setImmediate(r));
  }
  await write(new Uint8Array(1024));
  // #320: 'end' (readable side: every compressed byte delivered to 'data'),
  // not end(cb) ('finish': input accepted). Under host load the trailer's
  // 'data' landed after 'finish' and the fixture came back truncated.
  const ended = new Promise<void>((r) => gz.once("end", () => r()));
  gz.end();
  await ended;
  return new Uint8Array(Buffer.concat(out));
}

function smallSnapshot(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = new TextEncoder().encode(text);
    if (name.length > 100) {
      const ln = new TextEncoder().encode(name + "\0");
      parts.push(header("././@LongLink", ln.length, "L"), ln, pad(ln.length));
    }
    parts.push(header(name, body.length), body, pad(body.length));
  }
  parts.push(new Uint8Array(1024));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

// --- the tests ----------------------------------------------------------------
describe("#176 — gunzip is fed in 64 KiB slices: workerd never inflates a whole snapshot at once", () => {
  const snap = () =>
    smallSnapshot({ ".claude/projects/-workspace-fleetflare/0f0f0f0f-1111-4222-8333-444444444444.jsonl": Array.from({ length: 4000 }, (_, i) => line(i)).join("") });

  test("sessionStats", async () => {
    const gz = snap();
    expect(gz.length).toBeGreaterThan(SLICE);
    await burn.sessionStats(gz);
    expect(maxWrite).toBeGreaterThan(0);
    expect(maxWrite).toBeLessThanOrEqual(SLICE);
  });

  test("the burn increment", async () => {
    const gz = snap();
    await burn.burnIncrement({ fileOffsets: {} }, gz);
    expect(maxWrite).toBeGreaterThan(0);
    expect(maxWrite).toBeLessThanOrEqual(SLICE);
  });
});

describe("#176 — the burn increment streams, and counts EXACTLY what the whole-text parser counted", () => {
  const ROOT = ".claude/projects/-workspace-fleetflare/b1c006ac-dd42-48a7-a063-90400c353858.jsonl";
  const WT = ".claude/projects/-workspace-fleetflare--claude-worktrees-x/b1c006ac-dd42-48a7-a063-90400c353858.jsonl";
  const OTHER = ".claude/projects/-workspace-fleetflare/0f0f0f0f-1111-4222-8333-444444444444.jsonl";
  // Memoized: line() advances a global LCG, so the SAME range must be the SAME text.
  const ALL = Array.from({ length: 200 }, (_, i) => line(i));
  const lines = (from: number, to: number) => ALL.slice(from, to).join("");
  const cases: Record<string, { prev: burn.BurnCursor; files: Record<string, string> }> = {
    "first tick, several files, a partial last line and a malformed line": {
      prev: { fileOffsets: {} },
      files: { [OTHER]: lines(0, 50) + "not json\n" + "[1,2]\n\n" + '{"type":"assistant","message":{"usage":{"output_tokens":9}}}', [WT]: lines(50, 90) },
    },
    "incremental: stored offsets, new lines only": {
      prev: { fileOffsets: { [burn.pathMapKey(OTHER)]: lines(0, 30).length } },
      files: { [OTHER]: lines(0, 60) },
    },
    "#154 rule (f): a legacy-seeded offset far past the file's current end holds there, no reset to 0": {
      prev: { fileOffsets: { [OTHER]: 10_000_000 } },
      files: { [OTHER]: lines(0, 20) },
    },
    "pre-#154 cursor (no fileHashes): a same-key sibling is trusted on LENGTH alone despite genuinely diverged content": {
      prev: { fileOffsets: { [WT]: lines(0, 40).length } },
      files: { [WT]: lines(0, 40), [ROOT]: lines(100, 150) },
    },
    "non-ASCII text: offsets are UTF-16 code units, split across slices": {
      prev: { fileOffsets: {} },
      files: { [OTHER]: Array.from({ length: 3000 }, (_, i) => JSON.stringify({ type: i % 2 ? "assistant" : "user", message: { usage: { output_tokens: 1 }, content: "Ω 日本語 ✓ — 😀 ".repeat(20) } }) + "\n").join("") },
    },
  };
  for (const [name, c] of Object.entries(cases)) {
    test(name, async () => {
      const gz = smallSnapshot(c.files);
      const expected = burn.parseUsageIncrement(c.prev, await burn.extractJsonlMembers(gz));
      expect(await burn.burnIncrement(c.prev, gz)).toEqual(expected);
    });
  }

  test("#130 adopt copy: the root copy INHERITS the worktree file's counted prefix — only its new lines count", async () => {
    // The worktree original (fully counted) and its root-key copy share the
    // SAME bytes up to that offset; the copy then grows. Over 64 KiB and
    // non-ASCII, so the fingerprint crosses slices and UTF-16 surrogates.
    const turn = (i: number) =>
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 2, output_tokens: 3 }, content: `Ω 日本語 ✓ — 😀 turn ${i} `.repeat(8) } }) + "\n";
    const base = Array.from({ length: 400 }, (_, i) => turn(i)).join("");
    const added = Array.from({ length: 20 }, (_, i) => turn(1000 + i)).join("");
    expect(new TextEncoder().encode(base).length).toBeGreaterThan(64 * 1024);
    const prev: burn.BurnCursor = { fileOffsets: { [WT]: base.length } };
    const gz = smallSnapshot({ [WT]: base, [ROOT]: base + added });

    const got = await burn.burnIncrement(prev, gz);

    expect(got).toEqual(burn.parseUsageIncrement(prev, await burn.extractJsonlMembers(gz)));
    expect(got.delta).toEqual({ turns: 20, inputTokens: 40, outputTokens: 60, costUsd: 0 });
    expect(got.cursor.fileOffsets[burn.pathMapKey(ROOT)]).toBe(base.length + added.length);
  });
});

describe("#176 — a snapshot AT SESSION_TOTAL_MAX stays inside a pinned peak budget", () => {
  let gz: Uint8Array;
  // #256: built BEFORE any baseline, its buffer touched, then settled. A
  // typed array's backing store is only counted as an ArrayBuffer once
  // something reads `.buffer` -- here the code under test's first
  // gz.subarray(). Measured: baseline arrayBuffers 0.0 MiB, then +33.8 MiB
  // (heap +34) 0.5 MiB into the feed: a 35 MiB "peak" of pure accounting.
  // Whether that jump fell before or after the baseline was the flake.
  beforeAll(async () => {
    gz = await synthSnapshot(SESSION_TOTAL_MAX);
    // #320: the fixture must be a COMPLETE gzip, or every read below fails
    // with "burn: gzip decompression failed:" and blames the code under test.
    // Measured under host load (Linux lane, load1 ~100): 4 of 20 builds came
    // back truncated ("unexpected end of file").
    expect(() => gunzipSync(gz)).not.toThrow();
    void gz.buffer;
    for (let i = 0; i < 5; i++) await settledLive();
  }, 300_000);
  const atCap = async () => gz;

  test("sessionStats + the burn increment (the sync tick's two reads)", async () => {
    await atCap();
    const delta = await peakOver(async () => [await burn.sessionStats(gz), await burn.burnIncrement({ fileOffsets: {} }, gz)]);
    console.log(`#176 sync reads: gz ${(gz.length / MiB).toFixed(1)} MiB, peak over input ${(delta / MiB).toFixed(1)} MiB`);
    expect(delta).toBeLessThanOrEqual(BUDGET);

    // Control: the probe can SEE a held tar. The whole-text reader main's
    // sync tick used, on the same snapshot, must blow the same budget.
    const control = await peakOver(() => burn.extractJsonlMembers(gz));
    console.log(`#176 control (main's whole-text read): peak over input ${(control / MiB).toFixed(1)} MiB`);
    expect(control).toBeGreaterThan(BUDGET);
  }, 300_000);

  test("runSessionRestore (fresh container, restore from latest)", async () => {
    await atCap();
    const delta = await peakOver(() =>
      runSessionRestore(
        {
          sbExec: async (c: string) => ({ code: 0, stdout: c.includes("[ -d ~/.claude/projects ]") ? "no" : "", stderr: "" }),
          r2Get: async () => gz,
          r2List: async () => [],
          writeFile: async () => {
            sample();
          },
          recordRestoredMark: async () => {},
        } as unknown as Parameters<typeof runSessionRestore>[0],
        "fleetflare--pilot",
      ),
    );
    console.log(`#176 restore: gz ${(gz.length / MiB).toFixed(1)} MiB, peak over input ${(delta / MiB).toFixed(1)} MiB, largest gunzip write ${maxWrite} B`);
    expect(delta).toBeLessThanOrEqual(BUDGET);
    // Bun inflates as it goes; workerd inflates a whole written chunk at once
    // (#118/#140), so the write size is what bounds the restore there.
    expect(maxWrite).toBeLessThanOrEqual(SLICE);
  }, 300_000);
});
