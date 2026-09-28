import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  syncSessionTick, SESSION_MARK_KEY, SESSION_GUARD_KEY, SESSION_DAILY_DATE_KEY, SESSION_FORCE_KEY,
  type SessionSyncDeps, type SessionSyncStorage, type SessionGuard,
} from "../src/studio/session-sync";
import {
  sessionStats, newestMark, poorerThan, SessionArchiveFormatError, type SessionMark,
} from "../src/studio/burn";
import {
  sessionLatestKey, sessionDailyKey, sessionDisplacedKey, sessionSupersededKey, SESSION_DISPLACED_KEEPERS,
} from "../src/studio/archive";
import {
  runSessionRestore, restorePartPath, CONTAINER_HAS_PROJECTS_CMD, STATUS_KEY, SESSION_RESTORE_MANIFEST_PATH,
  type ProvisionDeps, type StudioStorage,
} from "../src/studio/provision";
import { mirrorBurnToRegistry, clearSessionGuard } from "../src/studio/do";
import { destroyWithSync } from "../src/studio/destroy";
import type { StudioStatus } from "../src/studio/types";
import type { Burn } from "../src/studio/burn";

// Issue #94 (#85 PR2): a blank or poorer session never overwrites a rich
// `latest`, and restore falls back to the daily keeper when `latest` is the
// poorer one. Every fixture below is a REAL gzip'd ustar archive built
// in-test, the same bytes shape tarAndStatCmd's `tar -czf` hands the Worker.

const ID = "websites--pilot";
const NOW = "2026-09-24T09:52:00.000Z";
const PROJ = ".claude/projects/-workspace-websites";
const OLD = `${PROJ}/11111111-1111-1111-1111-111111111111.jsonl`;
const NEW = `${PROJ}/22222222-2222-2222-2222-222222222222.jsonl`;

// ---------------------------------------------------------------------------
// Real tar + gzip fixtures
// ---------------------------------------------------------------------------

const BLOCK = 512;

function pad(bytes: Uint8Array): Uint8Array {
  const rem = bytes.length % BLOCK;
  if (rem === 0) return bytes;
  const out = new Uint8Array(bytes.length + (BLOCK - rem));
  out.set(bytes);
  return out;
}

function field(buf: Uint8Array, off: number, value: string, len: number): void {
  const enc = new TextEncoder().encode(value);
  buf.set(enc.subarray(0, Math.min(enc.length, len)), off);
}

function octal(buf: Uint8Array, off: number, value: number, len: number): void {
  field(buf, off, value.toString(8).padStart(len - 1, "0"), len);
}

function header(name: string, size: number, type: string, mtime: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  field(h, 0, name.slice(0, 100), 100);
  octal(h, 100, 0o644, 8);
  octal(h, 108, 0, 8);
  octal(h, 116, 0, 8);
  octal(h, 124, size, 12);
  octal(h, 136, mtime, 12);
  h.set(new TextEncoder().encode("        "), 148);
  h[156] = type.charCodeAt(0);
  field(h, 257, "ustar", 6);
  field(h, 263, "00", 2);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  field(h, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return h;
}

type Entry = { name: string; content: string; mtime?: number };

function tar(entries: Entry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const body = new TextEncoder().encode(e.content);
    const mtime = e.mtime ?? 1_790_000_000;
    if (e.name.length > 100) {
      blocks.push(header("././@LongLink", e.name.length + 1, "L", 0));
      blocks.push(pad(new TextEncoder().encode(`${e.name}\0`)));
    }
    blocks.push(header(e.name, body.length, "0", mtime), pad(body));
  }
  blocks.push(new Uint8Array(BLOCK), new Uint8Array(BLOCK));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const cs = new CompressionStream("gzip") as unknown as {
    readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  }).pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `n` complete jsonl lines, timestamps one minute apart from `startMin`. */
function lines(n: number, startMin = 0): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.UTC(2026, 8, 24, 8, startMin + i)).toISOString();
    out += `${JSON.stringify({ type: i % 2 ? "assistant" : "user", uuid: `u${i}`, timestamp: ts })}\n`;
  }
  return out;
}

async function session(files: Entry[]): Promise<Uint8Array<ArrayBuffer>> {
  return gzip(tar([{ name: ".claude.json", content: '{"synthetic":true}' }, ...files]));
}

function paddedLen(n: number): number {
  const rem = n % BLOCK;
  return rem === 0 ? n : n + (BLOCK - rem);
}

/**
 * Board #140 review item 4: a real gzip'd tar, but cut off partway through
 * the LAST entry's content block — never reaches its own end-of-archive
 * marker (the two trailing all-zero blocks `tar()` always appends). Same
 * `.claude.json`-first layout `session()` uses, so `earlierFiles` +
 * `truncatedFile` mirror a real session snapshot whose newest member was
 * still mid-write when the upload was cut off (a network blip, a bad
 * upload, a partial local write).
 */
async function truncatedSession(earlierFiles: Entry[], truncatedFile: Entry): Promise<Uint8Array<ArrayBuffer>> {
  const raw = tar([{ name: ".claude.json", content: '{"synthetic":true}' }, ...earlierFiles, truncatedFile]);
  let offset = paddedLen(new TextEncoder().encode('{"synthetic":true}').length) + BLOCK;
  for (const f of earlierFiles) offset += BLOCK + paddedLen(new TextEncoder().encode(f.content).length);
  offset += BLOCK; // truncatedFile's own header, intact
  const bodyLen = new TextEncoder().encode(truncatedFile.content).length;
  const cutAt = offset + Math.floor(bodyLen / 2); // stop partway through its content
  return gzip(raw.subarray(0, cutAt));
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeStorage(seed: Record<string, unknown> = {}): SessionSyncStorage & StudioStorage & {
  map: Map<string, unknown>;
} {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    map,
    get: (async (key: string) => map.get(key)) as SessionSyncStorage["get"] & StudioStorage["get"],
    put: (async (k: string | Record<string, unknown>, v?: unknown) => {
      const entries = typeof k === "string" ? { [k]: v } : k;
      for (const [key, val] of Object.entries(entries)) map.set(key, val);
    }) as SessionSyncStorage["put"] & StudioStorage["put"],
    delete: (async (key: string) => map.delete(key)) as NonNullable<SessionSyncStorage["delete"]>,
  };
}

function fakeDeps(candidate: Uint8Array, opts: { r2?: Map<string, Uint8Array>; now?: string } = {}): SessionSyncDeps & {
  r2: Map<string, Uint8Array>; deleted: string[];
} {
  const r2 = opts.r2 ?? new Map<string, Uint8Array>();
  const deleted: string[] = [];
  return {
    r2,
    deleted,
    exec: async (cmd: string) => {
      if (cmd.startsWith("mkdir -p")) return { code: 0, stdout: `${candidate.length}\n1758067200`, stderr: "" }; // #202: size + tar-start watermark
      return { code: 0, stdout: b64(candidate), stderr: "" };
    },
    r2Put: async (key, bytes) => {
      r2.set(key, bytes);
    },
    r2Get: async (key) => (r2.get(key) as Uint8Array<ArrayBuffer> | undefined) ?? null,
    r2List: async (prefix) => [...r2.keys()].filter((k) => k.startsWith(prefix)),
    r2Delete: async (keys) => {
      for (const k of keys) {
        deleted.push(k);
        r2.delete(k);
      }
    },
    now: () => new Date(opts.now ?? NOW),
    notify: async () => {},
    burnAlertThresholdTokens: 0,
  };
}

const RICH_MARK: SessionMark = { file: OLD, lines: 10, lastTs: "2026-09-24T08:09:00.000Z" };

// ---------------------------------------------------------------------------
// sessionStats / newestMark / poorerThan — pure, over real archives
// ---------------------------------------------------------------------------

describe("sessionStats — per-file complete-line counts from a real gzip'd tar", () => {
  it("counts complete lines per jsonl member, reads the last line's timestamp, ignores non-jsonl", async () => {
    const gz = await session([
      { name: OLD, content: lines(10) },
      { name: NEW, content: `${lines(3, 30)}{"partial":` }, // torn tail line never counted
    ]);
    const stats = await sessionStats(gz);
    expect(Object.keys(stats).sort()).toEqual([OLD, NEW].sort());
    expect(stats[OLD].lines).toBe(10);
    expect(stats[OLD].lastTs).toBe("2026-09-24T08:09:00.000Z");
    expect(stats[NEW].lines).toBe(3);
    expect(stats[NEW].lastTs).toBe("2026-09-24T08:32:00.000Z");
  });

  it("handles GNU longname members (real session paths exceed 100 bytes)", async () => {
    const long = `${PROJ}/${"x".repeat(120)}.jsonl`;
    const stats = await sessionStats(await session([{ name: long, content: lines(4) }]));
    expect(stats[long].lines).toBe(4);
  });

  it("newestMark picks the file whose last entry is latest", async () => {
    const stats = await sessionStats(await session([
      { name: OLD, content: lines(10) },
      { name: NEW, content: lines(2, 60) },
    ]));
    expect(newestMark(stats)).toEqual({ file: NEW, lines: 2, lastTs: "2026-09-24T09:01:00.000Z" });
    expect(newestMark({})).toBeNull();
  });

  it("poorerThan: missing newest file or fewer lines is poorer; equal or more is not", () => {
    const stat = (n: number) => ({ lines: n, mtime: 0, lastTs: null });
    expect(poorerThan({}, RICH_MARK)).toMatch(/no session files/);
    expect(poorerThan({ [NEW]: stat(50) }, RICH_MARK)).toMatch(/missing/);
    expect(poorerThan({ [OLD]: stat(5) }, RICH_MARK)).toMatch(/5 < 10/);
    expect(poorerThan({ [OLD]: stat(10) }, RICH_MARK)).toBeNull();
    expect(poorerThan({ [OLD]: stat(11) }, RICH_MARK)).toBeNull();
  });

  // Board #140 review item 4: the stream running out before the tar's own
  // end-of-archive block is a TRUNCATED archive, not a complete-but-short
  // one — before this fix, sessionStats returned whatever partial stats it
  // had accumulated, silently.
  it("a stream that ends before the tar's end-of-archive block throws SessionArchiveFormatError (truncated, not short)", async () => {
    const gz = await truncatedSession(
      [{ name: OLD, content: lines(10) }],
      { name: NEW, content: lines(5, 30) },
    );
    await expect(sessionStats(gz)).rejects.toThrow(SessionArchiveFormatError);
    await expect(sessionStats(gz)).rejects.toThrow(/truncated/);
  });
});

describe("sessionDisplacedKey — R2 key shape", () => {
  it("lives under sessions/<id>/displaced/<ts>.tar.gz, outside the dated keeper namespace", () => {
    expect(sessionDisplacedKey(ID, NOW)).toBe(`sessions/${ID}/displaced/${NOW}.tar.gz`);
  });
});

// ---------------------------------------------------------------------------
// syncSessionTick — the guard
// ---------------------------------------------------------------------------

describe("syncSessionTick — a blank or poorer candidate never replaces a rich latest", () => {
  it("blank candidate (no jsonl at all): latest untouched, candidate displaced, guard recorded, no daily keeper", async () => {
    const rich = new Uint8Array([9, 9, 9]);
    const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), rich]]);
    const deps = fakeDeps(await session([]), { r2 });
    const storage = fakeStorage({ [SESSION_MARK_KEY]: RICH_MARK });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await syncSessionTick(deps, storage, ID);

    expect(r2.get(sessionLatestKey(ID))).toBe(rich);
    expect(res.skipped).toBe("displaced");
    expect(res.displaced).toBe(sessionDisplacedKey(ID, NOW));
    expect(r2.has(sessionDisplacedKey(ID, NOW))).toBe(true);
    expect(r2.has(sessionDailyKey(ID, "2026-09-24"))).toBe(false);
    expect(storage.map.get(SESSION_DAILY_DATE_KEY)).toBeUndefined();
    const guard = storage.map.get(SESSION_GUARD_KEY) as SessionGuard;
    expect(guard).toMatchObject({ at: NOW, key: sessionDisplacedKey(ID, NOW) });
    expect(guard.reason).toMatch(/no session files/);
    expect(storage.map.get(SESSION_MARK_KEY)).toEqual(RICH_MARK); // baseline unchanged
    expect(err).toHaveBeenCalledWith(expect.stringContaining("KEPT latest"));
    err.mockRestore();
  });

  it("poorer candidate (newest file has fewer lines) is displaced too", async () => {
    const rich = new Uint8Array([9]);
    const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), rich]]);
    const deps = fakeDeps(await session([{ name: OLD, content: lines(5) }]), { r2 });
    const storage = fakeStorage({ [SESSION_MARK_KEY]: RICH_MARK });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await syncSessionTick(deps, storage, ID);

    expect(res.skipped).toBe("displaced");
    expect(r2.get(sessionLatestKey(ID))).toBe(rich);
    expect((storage.map.get(SESSION_GUARD_KEY) as SessionGuard).reason).toMatch(/5 < 10/);
    vi.restoreAllMocks();
  });

  it("no baseline in DO yet: seeds it from R2 latest, then refuses a blank candidate (the post-rollout case)", async () => {
    const rich = await session([{ name: OLD, content: lines(10) }]);
    const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), rich]]);
    const deps = fakeDeps(await session([]), { r2 });
    const storage = fakeStorage();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await syncSessionTick(deps, storage, ID);

    expect(res.skipped).toBe("displaced");
    expect(r2.get(sessionLatestKey(ID))).toBe(rich);
    vi.restoreAllMocks();
  });

  it("displaced objects are pruned to SESSION_DISPLACED_KEEPERS and never counted as daily keepers", async () => {
    const r2 = new Map<string, Uint8Array>([
      [sessionLatestKey(ID), new Uint8Array([9])],
      [sessionDailyKey(ID, "2026-09-23"), new Uint8Array([1])],
      [sessionDisplacedKey(ID, "2026-09-24T09:00:00.000Z"), new Uint8Array([1])],
      [sessionDisplacedKey(ID, "2026-09-24T09:05:00.000Z"), new Uint8Array([1])],
      [sessionDisplacedKey(ID, "2026-09-24T09:10:00.000Z"), new Uint8Array([1])],
    ]);
    const deps = fakeDeps(await session([]), { r2 });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await syncSessionTick(deps, fakeStorage({ [SESSION_MARK_KEY]: RICH_MARK }), ID);

    const displaced = [...r2.keys()].filter((k) => k.includes("/displaced/")).sort();
    expect(displaced).toHaveLength(SESSION_DISPLACED_KEEPERS);
    expect(displaced.at(-1)).toBe(sessionDisplacedKey(ID, NOW));
    expect(r2.has(sessionDailyKey(ID, "2026-09-23"))).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("syncSessionTick — legitimate candidates still upload", () => {
  it("same session growing: uploads, baseline advances", async () => {
    const cand = await session([{ name: OLD, content: lines(12) }]);
    const deps = fakeDeps(cand);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: RICH_MARK });

    const res = await syncSessionTick(deps, storage, ID);

    expect(res.skipped).toBeUndefined();
    expect(deps.r2.get(sessionLatestKey(ID))).toEqual(cand);
    expect(storage.map.get(SESSION_MARK_KEY)).toMatchObject({ file: OLD, lines: 12 });
  });

  it("new session alongside the old one: uploads, baseline moves to the new file", async () => {
    const cand = await session([{ name: OLD, content: lines(10) }, { name: NEW, content: lines(3, 60) }]);
    const deps = fakeDeps(cand);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: RICH_MARK });

    await syncSessionTick(deps, storage, ID);

    expect(deps.r2.get(sessionLatestKey(ID))).toEqual(cand);
    expect(storage.map.get(SESSION_MARK_KEY)).toMatchObject({ file: NEW, lines: 3 });
  });

  it("Claude's 30-day cleanup removed an OLD file: only the newest is compared, so it uploads", async () => {
    const cand = await session([{ name: NEW, content: lines(4, 60) }]);
    const deps = fakeDeps(cand);
    const storage = fakeStorage({
      [SESSION_MARK_KEY]: { file: NEW, lines: 3, lastTs: "2026-09-24T09:02:00.000Z" } satisfies SessionMark,
    });

    await syncSessionTick(deps, storage, ID);

    expect(deps.r2.get(sessionLatestKey(ID))).toEqual(cand);
  });

  it("a good tick after a displaced one clears the guard record", async () => {
    const cand = await session([{ name: OLD, content: lines(11) }]);
    const deps = fakeDeps(cand);
    const storage = fakeStorage({
      [SESSION_MARK_KEY]: RICH_MARK,
      [SESSION_GUARD_KEY]: { at: NOW, key: "k", reason: "r" } satisfies SessionGuard,
    });

    await syncSessionTick(deps, storage, ID);

    expect(storage.map.get(SESSION_GUARD_KEY)).toBeNull();
  });

  it("no baseline and no R2 latest (brand-new studio): uploads and records a baseline", async () => {
    const cand = await session([{ name: OLD, content: lines(2) }]);
    const deps = fakeDeps(cand);
    const storage = fakeStorage();

    await syncSessionTick(deps, storage, ID);

    expect(deps.r2.get(sessionLatestKey(ID))).toEqual(cand);
    expect(storage.map.get(SESSION_MARK_KEY)).toMatchObject({ file: OLD, lines: 2 });
  });
});

// ---------------------------------------------------------------------------
// mirrorBurnToRegistry — the guard record reaches the status row
// ---------------------------------------------------------------------------

describe("mirrorBurnToRegistry — guard record lands on StudioStatus.sessionGuard", () => {
  it("copies SESSION_GUARD_KEY onto the row fleet ls reads", async () => {
    const guard: SessionGuard = { at: NOW, key: sessionDisplacedKey(ID, NOW), reason: "missing x" };
    const burn: Burn = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, window5hStart: NOW, window5hOutput: 0 };
    const storage = fakeStorage({
      [STATUS_KEY]: { id: ID } as StudioStatus, burn, [SESSION_GUARD_KEY]: guard,
    });
    const recorded: StudioStatus[] = [];

    await mirrorBurnToRegistry(storage, async (s) => {
      recorded.push(s);
    });

    expect(recorded[0].sessionGuard).toEqual(guard);
  });
});

// ---------------------------------------------------------------------------
// runSessionRestore — falls back to the newest daily keeper
// ---------------------------------------------------------------------------

function restoreDeps(r2: Map<string, Uint8Array>): ProvisionDeps & { writes: { path: string; bytes: Uint8Array }[] } {
  const writes: { path: string; bytes: Uint8Array }[] = [];
  return {
    writes,
    sbExec: async (cmd: string) => ({
      code: 0, stdout: cmd === CONTAINER_HAS_PROJECTS_CMD ? "no\n" : "", stderr: "",
    }),
    recordStudio: async () => {},
    now: () => NOW,
    fetchBlueprintFile: async () => "",
    r2Get: async (key) => (r2.get(key) as Uint8Array<ArrayBuffer> | undefined) ?? null,
    r2List: async (prefix) => [...r2.keys()].filter((k) => k.startsWith(prefix)),
    writeFile: async (path, bytes) => {
      writes.push({ path, bytes });
    },
  };
}

describe("runSessionRestore — daily keeper fallback", () => {
  it("latest poorer than the newest keeper: restores the keeper and says so", async () => {
    const keeper = await session([{ name: OLD, content: lines(10) }]);
    const r2 = new Map<string, Uint8Array>([
      [sessionLatestKey(ID), await session([])],
      [sessionDailyKey(ID, "2026-09-23"), await session([{ name: OLD, content: lines(4) }])],
      [sessionDailyKey(ID, "2026-09-24"), keeper],
      [sessionDisplacedKey(ID, NOW), await session([{ name: OLD, content: lines(1) }])],
    ]);
    const deps = restoreDeps(r2);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await runSessionRestore(deps, ID);

    expect(res).toEqual({ plan: "restore", parts: 1, restore: "restored", source: "daily 2026-09-24" });
    expect(deps.writes[0]).toEqual({ path: restorePartPath(0), bytes: keeper });
    vi.restoreAllMocks();
  });

  it("latest missing entirely, keeper present: restores the keeper", async () => {
    const keeper = await session([{ name: OLD, content: lines(10) }]);
    const deps = restoreDeps(new Map([[sessionDailyKey(ID, "2026-09-24"), keeper]]));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await runSessionRestore(deps, ID);

    expect(res).toEqual({ plan: "restore", parts: 1, restore: "restored", source: "daily 2026-09-24" });
    expect(deps.writes[0].bytes).toEqual(keeper);
    vi.restoreAllMocks();
  });

  it("latest at least as rich as the keeper: restores latest", async () => {
    const latest = await session([{ name: OLD, content: lines(12) }]);
    const deps = restoreDeps(new Map([
      [sessionLatestKey(ID), latest],
      [sessionDailyKey(ID, "2026-09-24"), await session([{ name: OLD, content: lines(10) }])],
    ]));

    const res = await runSessionRestore(deps, ID);

    expect(res).toEqual({ plan: "restore", parts: 1, restore: "restored", source: "latest" });
    expect(deps.writes[0].bytes).toEqual(latest);
  });

  // Board #140 review item 4: a truncated `latest` (its newest member cut
  // off mid-write) is now a SessionArchiveFormatError, so it falls back to
  // the keeper the same way a bad-magic or corrupted-compressed-data
  // `latest` already does.
  it("latest is truncated mid-write (its newest member's content cuts off before the end-of-archive block): falls back to the keeper", async () => {
    const truncatedLatest = await truncatedSession(
      [{ name: OLD, content: lines(10) }],
      { name: NEW, content: lines(5, 30) },
    );
    const keeper = await session([{ name: OLD, content: lines(10) }]);
    const deps = restoreDeps(new Map([
      [sessionLatestKey(ID), truncatedLatest],
      [sessionDailyKey(ID, "2026-09-24"), keeper],
    ]));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await runSessionRestore(deps, ID);

    expect(res).toEqual({ plan: "restore", parts: 1, restore: "restored", source: "daily 2026-09-24" });
    expect(deps.writes[0].bytes).toEqual(keeper);
    vi.restoreAllMocks();
  });
});

// Board #140 (#94 follow-up, verifier nit): a genuinely corrupt `latest`
// (not merely poorer, actually UNREADABLE) must still fall back to the
// keeper exactly as before — this is the one class of throw
// pickRestoreSource's narrowed catch (SessionArchiveFormatError only) is
// SUPPOSED to swallow. The behaviour these two pin is unchanged from before
// the fix; what changed is that the fix no longer ALSO swallows a throw that
// is not this class (see studio.burn.test.ts's own SessionArchiveFormatError
// coverage for that half). Issue #228 item 3: this comment used to claim that
// half was "not reachable here ... which the fix's own design ... makes
// impossible to produce through this public surface" — that was WRONG:
// asFormatError (burn.ts) only narrows an actual `TypeError` (a decompressor
// rejection) into SessionArchiveFormatError; it rethrows every OTHER error
// type completely unconverted (see that function's own doc comment), and
// that path IS real and reachable through this exact public surface — see
// studio.burn.test.ts's own pin of a non-TypeError propagating unconverted
// (issue #228 item 2 / #191 review scope-add) for a genuine demonstration.
describe("runSessionRestore — a genuinely corrupt latest still falls back to the keeper (#140)", () => {
  it("latest is not gzip at all (bad magic): falls back to the keeper", async () => {
    const keeper = await session([{ name: OLD, content: lines(10) }]);
    const deps = restoreDeps(new Map([
      [sessionLatestKey(ID), new Uint8Array([1, 2, 3, 4])],
      [sessionDailyKey(ID, "2026-09-24"), keeper],
    ]));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await runSessionRestore(deps, ID);

    expect(res).toEqual({ plan: "restore", parts: 1, restore: "restored", source: "daily 2026-09-24" });
    expect(deps.writes[0].bytes).toEqual(keeper);
    vi.restoreAllMocks();
  });

  it("latest has a real gzip header but corrupted compressed data: falls back to the keeper", async () => {
    const keeper = await session([{ name: OLD, content: lines(10) }]);
    const latestBytes = await session([{ name: OLD, content: lines(5) }]);
    const corrupted = new Uint8Array(latestBytes);
    for (let i = 10; i < Math.min(corrupted.length, 30); i++) corrupted[i] ^= 0xff;
    const deps = restoreDeps(new Map([
      [sessionLatestKey(ID), corrupted],
      [sessionDailyKey(ID, "2026-09-24"), keeper],
    ]));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await runSessionRestore(deps, ID);

    expect(res).toEqual({ plan: "restore", parts: 1, restore: "restored", source: "daily 2026-09-24" });
    expect(deps.writes[0].bytes).toEqual(keeper);
    vi.restoreAllMocks();
  });
});

// Board #140 review item 1: pickRestoreSource's catch (provision.ts:1550)
// narrows to SessionArchiveFormatError ONLY — anything else must propagate
// and abort the restore, never silently fall back to the keeper. The two
// tests above cover the "swallow" half (a genuine format error DOES fall
// back); this covers the "propagate" half, which had no test at all before
// this fix (reverting the catch to an unconditional `.catch(() => null)`
// left the suite green).
describe("runSessionRestore — a non-format decompression failure propagates, never falls back (#140 review item 1)", () => {
  it("a TypeError thrown by DecompressionStream's first construction rejects runSessionRestore before the keeper is ever read", async () => {
    const latest = await session([{ name: OLD, content: lines(10) }]);
    const keeper = await session([{ name: OLD, content: lines(3) }]);
    const r2 = new Map<string, Uint8Array>([
      [sessionLatestKey(ID), latest],
      [sessionDailyKey(ID, "2026-09-24"), keeper],
    ]);

    // Throws TypeError on the FIRST `new DecompressionStream("gzip")` this
    // test's code path reaches (sessionStats's own, inside pickRestoreSource
    // — `latest` above was built with the REAL CompressionStream before this
    // stub is installed, so building the fixture itself never touches
    // DecompressionStream at all), then delegates every later construction
    // to the real thing.
    let calls = 0;
    const RealDecompressionStream = DecompressionStream;
    function StubbedDecompressionStream(this: unknown, format: ConstructorParameters<typeof DecompressionStream>[0]) {
      calls++;
      if (calls === 1) throw new TypeError("stubbed: forced decompression failure");
      return new RealDecompressionStream(format);
    }
    vi.stubGlobal("DecompressionStream", StubbedDecompressionStream as unknown as typeof DecompressionStream);

    const r2GetSpy = vi.fn(async (key: string) => (r2.get(key) as Uint8Array<ArrayBuffer> | undefined) ?? null);
    const r2ListSpy = vi.fn(async (prefix: string) => [...r2.keys()].filter((k) => k.startsWith(prefix)));
    const writes: { path: string; bytes: Uint8Array }[] = [];
    const deps: ProvisionDeps = {
      sbExec: async (cmd: string) => ({ code: 0, stdout: cmd === CONTAINER_HAS_PROJECTS_CMD ? "no\n" : "", stderr: "" }),
      recordStudio: async () => {},
      now: () => NOW,
      fetchBlueprintFile: async () => "",
      r2Get: r2GetSpy,
      r2List: r2ListSpy,
      writeFile: async (path, bytes) => { writes.push({ path, bytes }); },
    };

    try {
      await expect(runSessionRestore(deps, ID)).rejects.toThrow(TypeError);

      // R2 reads: `latest` only — pickRestoreSource's own keeper-fallback
      // r2List/r2Get calls are never reached, because the error propagates
      // out of `sessionStats(latest)` before that code runs.
      expect(r2GetSpy).toHaveBeenCalledTimes(1);
      expect(r2GetSpy).toHaveBeenCalledWith(sessionLatestKey(ID));
      expect(r2ListSpy).not.toHaveBeenCalled();
      // The restore never proceeds far enough to write anything.
      expect(writes).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("runSessionRestore -> sync guard hand-off", () => {
  it("restoring a keeper resets the guard baseline to the keeper, so the next sync of that content uploads", async () => {
    // latest holds no session at all (blank tar), the keeper holds the real
    // one, and the DO still carries a stale baseline. Without the hand-off
    // the guard displaces every sync of the restored history.
    const blank = await session([]);
    const keeper = await session([{ name: OLD, content: lines(10) }]);
    const r2 = new Map<string, Uint8Array>([
      [sessionLatestKey(ID), blank],
      [sessionDailyKey(ID, "2026-09-24"), keeper],
    ]);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: { file: NEW, lines: 1, lastTs: null } satisfies SessionMark });
    const marks: (SessionMark | null)[] = [];
    const deps = { ...restoreDeps(r2), recordRestoredMark: async (m: SessionMark | null) => {
      marks.push(m);
      await storage.put(SESSION_MARK_KEY, m!);
    } };
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await runSessionRestore(deps, ID);
    expect(marks).toEqual([{ file: OLD, lines: 10, lastTs: "2026-09-24T08:09:00.000Z" }]);

    const sync = fakeDeps(await session([{ name: OLD, content: lines(11) }]), { r2 });
    const res = await syncSessionTick(sync, storage, ID);
    expect(res.skipped).toBeUndefined();
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// PR #118 review fixes
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

describe("runSessionRestore — an older keeper never beats a newer latest (review item 1)", () => {
  it("latest holds a NEWER session (moved on) without the keeper's file: restores latest, logs, mark = NEW", async () => {
    const latest = await session([{ name: NEW, content: lines(600, 100) }]);
    const keeper = await session([{ name: OLD, content: lines(10) }]);
    const deps = restoreDeps(new Map([
      [sessionLatestKey(ID), latest],
      [sessionDailyKey(ID, "2026-09-24"), keeper],
    ]));
    const marks: (SessionMark | null)[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await runSessionRestore({ ...deps, recordRestoredMark: async (m) => void marks.push(m) }, ID);

    expect(res).toEqual({ plan: "restore", parts: 1, restore: "restored", source: "latest" });
    expect(deps.writes[0].bytes).toEqual(latest);
    expect(marks[0]?.file).toBe(NEW);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("restored from latest"));
    vi.restoreAllMocks();
  });

  it("latest has fewer lines in the keeper's file than the keeper: still latest (no line count tells blank from moved on)", async () => {
    const latest = await session([{ name: OLD, content: lines(3) }]);
    const deps = restoreDeps(new Map([
      [sessionLatestKey(ID), latest],
      [sessionDailyKey(ID, "2026-09-24"), await session([{ name: OLD, content: lines(10) }])],
    ]));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await runSessionRestore(deps, ID);

    expect(res.source).toBe("latest");
    expect(deps.writes[0].bytes).toEqual(latest);
    vi.restoreAllMocks();
  });

  it("latest unreadable (not gzip): restores the keeper", async () => {
    const keeper = await session([{ name: OLD, content: lines(10) }]);
    const deps = restoreDeps(new Map([
      [sessionLatestKey(ID), new Uint8Array([1, 2, 3])],
      [sessionDailyKey(ID, "2026-09-24"), keeper],
    ]));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await runSessionRestore(deps, ID);

    expect(res.source).toBe("daily 2026-09-24");
    expect(deps.writes[0].bytes).toEqual(keeper);
    vi.restoreAllMocks();
  });

  it("a keeper with no jsonl loses to a latest that has one", async () => {
    const latest = await session([{ name: OLD, content: lines(3) }]);
    const deps = restoreDeps(new Map([
      [sessionLatestKey(ID), latest],
      [sessionDailyKey(ID, "2026-09-24"), await session([])],
    ]));

    const res = await runSessionRestore(deps, ID);

    expect(res.source).toBe("latest");
    expect(deps.writes[0].bytes).toEqual(latest);
  });
});

describe("runSessionRestore — keeper lookup failures fall back to latest (review item 2)", () => {
  it("r2List throws: latest still staged", async () => {
    const latest = await session([]);
    const deps = restoreDeps(new Map([[sessionLatestKey(ID), latest]]));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await runSessionRestore({ ...deps, r2List: async () => { throw new Error("R2 list 500"); } }, ID);

    expect(res).toMatchObject({ plan: "restore", source: "latest" });
    expect(deps.writes[0].bytes).toEqual(latest);
    vi.restoreAllMocks();
  });

  it("keeper r2Get throws: latest still staged", async () => {
    const latest = await session([]);
    const r2 = new Map<string, Uint8Array>([
      [sessionLatestKey(ID), latest],
      [sessionDailyKey(ID, "2026-09-24"), await session([{ name: OLD, content: lines(10) }])],
    ]);
    const deps = restoreDeps(r2);
    const get = deps.r2Get!;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await runSessionRestore({
      ...deps,
      r2Get: async (k) => {
        if (k !== sessionLatestKey(ID)) throw new Error("R2 get 500");
        return get(k);
      },
    }, ID);

    expect(res).toMatchObject({ plan: "restore", source: "latest" });
    expect(deps.writes[0].bytes).toEqual(latest);
    vi.restoreAllMocks();
  });
});

describe("runSessionRestore — mark recorded before the manifest (review item 8)", () => {
  it("recordRestoredMark runs after the parts and before the manifest write", async () => {
    const latest = await session([{ name: OLD, content: lines(3) }]);
    const order: string[] = [];
    const deps = restoreDeps(new Map([[sessionLatestKey(ID), latest]]));

    await runSessionRestore({
      ...deps,
      writeFile: async (path) => void order.push(path),
      recordRestoredMark: async () => void order.push("mark"),
    }, ID);

    expect(order).toEqual([restorePartPath(0), "mark", SESSION_RESTORE_MANIFEST_PATH]);
  });
});

describe("syncSessionTick — seeding the baseline (review items 3, 4)", () => {
  it("R2 GET of latest throws: the tick throws, latest untouched, nothing displaced", async () => {
    const rich = new Uint8Array([9]);
    const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), rich]]);
    const deps = fakeDeps(await session([]), { r2 });
    deps.r2Get = async () => { throw new Error("R2 get 500"); };

    await expect(syncSessionTick(deps, fakeStorage(), ID)).rejects.toThrow("R2 get 500");

    expect([...r2.keys()]).toEqual([sessionLatestKey(ID)]);
    expect(r2.get(sessionLatestKey(ID))).toBe(rich);
  });

  it("the seeded mark is persisted: 3 refused ticks read R2 latest once", async () => {
    const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), await session([{ name: OLD, content: lines(10) }])]]);
    const storage = fakeStorage();
    let gets = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      const deps = fakeDeps(await session([]), { r2, now: `2026-09-24T10:0${i}:00.000Z` });
      const get = deps.r2Get!;
      deps.r2Get = async (k) => {
        if (k === sessionLatestKey(ID)) gets++;
        return get(k);
      };
      expect((await syncSessionTick(deps, storage, ID)).skipped).toBe("displaced");
    }
    expect(gets).toBe(1);
    vi.restoreAllMocks();
  });
});

describe("syncSessionTick — 30-day cleanup of the baseline file (review item 5)", () => {
  it("baseline file 40 days old is gone, new session present: uploads", async () => {
    const now = new Date(NOW);
    const oldTs = new Date(now.getTime() - 40 * DAY).toISOString();
    const cand = await session([{ name: NEW, content: lines(2, 60) }]);
    const deps = fakeDeps(cand);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: { file: OLD, lines: 900, lastTs: oldTs } satisfies SessionMark });

    const res = await syncSessionTick(deps, storage, ID);

    expect(res.skipped).toBeUndefined();
    expect(deps.r2.get(sessionLatestKey(ID))).toEqual(cand);
  });

  it("a baseline file under 30 days old that goes missing is still refused", async () => {
    const recent = new Date(new Date(NOW).getTime() - 20 * DAY).toISOString();
    const deps = fakeDeps(await session([{ name: NEW, content: lines(2, 60) }]));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await syncSessionTick(deps, fakeStorage({
      [SESSION_MARK_KEY]: { file: OLD, lines: 9, lastTs: recent } satisfies SessionMark,
    }), ID);

    expect(res.skipped).toBe("displaced");
    vi.restoreAllMocks();
  });
});

describe("newestMark — real-world file shapes (review items 6, 7)", () => {
  it("a live file ending in a timestamp-less line is still newest (its mtime stands in)", async () => {
    const live = `${lines(5, 0)}{"type":"last-prompt","lastPrompt":"x"}\n`;
    const stats = await sessionStats(await session([
      { name: OLD, content: lines(10, 0), mtime: 1_790_230_000 }, // ends 08:09Z
      { name: NEW, content: live, mtime: 1_790_240_000 }, // 2026-09-24T...Z, after 08:09Z
    ]));
    const mark = newestMark(stats);
    expect(mark?.file).toBe(NEW);
    expect(mark?.lastTs).toBe(new Date(1_790_240_000 * 1000).toISOString());
  });

  it("prefers the main session file over a newer subagents/ file", async () => {
    const sub = `${PROJ}/22222222-2222-2222-2222-222222222222/subagents/agent-a1.jsonl`;
    const stats = await sessionStats(await session([
      { name: OLD, content: lines(10) },
      { name: sub, content: lines(4, 120) },
    ]));
    expect(newestMark(stats)?.file).toBe(OLD);
  });

  it("name order is not time order: the later timestamp wins, not the later name", async () => {
    const zzz = `${PROJ}/zzzzzzzz.jsonl`;
    const aaa = `${PROJ}/aaaaaaaa.jsonl`;
    const stats = await sessionStats(await session([
      { name: zzz, content: lines(10, 0) },
      { name: aaa, content: lines(2, 200) },
    ]));
    expect(newestMark(stats)?.file).toBe(aaa);
  });
});

describe("syncSessionTick — surviving mutants (review item 7)", () => {
  it("an unreadable candidate is refused when a baseline exists", async () => {
    const deps = fakeDeps(new Uint8Array([1, 2, 3, 4]));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await syncSessionTick(deps, fakeStorage({ [SESSION_MARK_KEY]: RICH_MARK }), ID);

    expect(res.skipped).toBe("displaced");
    expect(deps.r2.has(sessionLatestKey(ID))).toBe(false);
    vi.restoreAllMocks();
  });

  it("daily-write prune with 3 displaced + 7 keepers keeps 7 keepers and the displaced", async () => {
    const r2 = new Map<string, Uint8Array>();
    for (let d = 17; d <= 23; d++) r2.set(sessionDailyKey(ID, `2026-09-${d}`), new Uint8Array([1]));
    for (const t of ["09:00", "09:05", "09:10"]) r2.set(sessionDisplacedKey(ID, `2026-09-24T${t}:00.000Z`), new Uint8Array([1]));
    const deps = fakeDeps(await session([{ name: OLD, content: lines(11) }]), { r2 });

    const res = await syncSessionTick(deps, fakeStorage({ [SESSION_MARK_KEY]: RICH_MARK }), ID);

    expect(res.dailyWritten).toBe(true);
    const keepers = [...r2.keys()].filter((k) => /\/\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(k)).sort();
    expect(keepers).toHaveLength(7);
    expect(keepers[0]).toBe(sessionDailyKey(ID, "2026-09-18"));
    expect([...r2.keys()].filter((k) => k.includes("/displaced/"))).toHaveLength(3);
  });
});

describe("syncSessionTick — coordination edges", () => {
  it("#120 worktree-session adoption: root-key copy (same content, fresh mtime) uploads and becomes the baseline", async () => {
    const wt = `${PROJ}--claude-worktrees-x/33333333-3333-3333-3333-333333333333.jsonl`;
    const root = `${PROJ}/33333333-3333-3333-3333-333333333333.jsonl`;
    const body = lines(8);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: { file: wt, lines: 8, lastTs: "2026-09-24T08:07:00.000Z" } satisfies SessionMark });
    const deps = fakeDeps(await session([
      { name: wt, content: body, mtime: 1_790_230_000 },
      { name: root, content: body, mtime: 1_790_250_000 },
    ]));

    const res = await syncSessionTick(deps, storage, ID);

    expect(res.skipped).toBeUndefined();
    expect((storage.map.get(SESSION_MARK_KEY) as SessionMark).file).toBe(root);
  });

  it("a blank candidate is refused even when the baseline is past the 30-day cleanup age", async () => {
    const oldTs = new Date(new Date(NOW).getTime() - 40 * DAY).toISOString();
    const deps = fakeDeps(await session([]));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await syncSessionTick(deps, fakeStorage({
      [SESSION_MARK_KEY]: { file: OLD, lines: 900, lastTs: oldTs } satisfies SessionMark,
    }), ID);

    expect(res.skipped).toBe("displaced");
    vi.restoreAllMocks();
  });
});

describe("syncSessionTick — baseline tracked by session id, not path (maestro addendum)", () => {
  it("claude MOVES the transcript into a worktree project key (same id, new folder): same session, uploads, baseline follows", async () => {
    const moved = `${PROJ}--claude-worktrees-row-tells-truth/11111111-1111-1111-1111-111111111111.jsonl`;
    const cand = await session([{ name: moved, content: lines(12) }]); // OLD's path is gone
    const deps = fakeDeps(cand);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: RICH_MARK });

    const res = await syncSessionTick(deps, storage, ID);

    expect(res.skipped).toBeUndefined();
    expect(deps.r2.get(sessionLatestKey(ID))).toEqual(cand);
    expect(storage.map.get(SESSION_MARK_KEY)).toMatchObject({ file: moved, lines: 12 });
  });

  it("the moved session with FEWER lines is still refused", async () => {
    const moved = `${PROJ}--claude-worktrees-x/11111111-1111-1111-1111-111111111111.jsonl`;
    const deps = fakeDeps(await session([{ name: moved, content: lines(4) }]));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await syncSessionTick(deps, fakeStorage({ [SESSION_MARK_KEY]: RICH_MARK }), ID);

    expect(res.skipped).toBe("displaced");
    vi.restoreAllMocks();
  });

  it("a subagents/ file sharing the id never stands in for the main session", async () => {
    const sub = `${PROJ}/99999999/subagents/11111111-1111-1111-1111-111111111111.jsonl`;
    const deps = fakeDeps(await session([{ name: sub, content: lines(50) }]));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await syncSessionTick(deps, fakeStorage({ [SESSION_MARK_KEY]: RICH_MARK }), ID);

    expect(res.skipped).toBe("displaced");
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// PR #118 fix pass 2
// ---------------------------------------------------------------------------

describe("syncSessionTick — real GNU tar order for a #120 copy (fix pass 2, item 2)", () => {
  it("worktree original listed FIRST (492 lines), root copy after (497), mark = root copy 497: uploads", async () => {
    const id = "44444444-4444-4444-4444-444444444444.jsonl";
    const wt = `${PROJ}--claude-worktrees-x/${id}`;
    const root = `${PROJ}/${id}`;
    const deps = fakeDeps(await session([
      { name: wt, content: lines(492) },
      { name: root, content: lines(497) },
    ]));
    const storage = fakeStorage({ [SESSION_MARK_KEY]: { file: root, lines: 497, lastTs: "2026-09-24T16:16:00.000Z" } satisfies SessionMark });

    const res = await syncSessionTick(deps, storage, ID);

    expect(res.skipped).toBeUndefined();
    expect(deps.r2.has(sessionLatestKey(ID))).toBe(true);
  });
});

describe("runSessionRestore — keeper fetched only when latest holds no session (fix pass 2, item 4)", () => {
  it("latest has a session: the keeper is never read (restore peak stays one tar)", async () => {
    const latest = await session([{ name: NEW, content: lines(5, 60) }]);
    const r2 = new Map<string, Uint8Array>([
      [sessionLatestKey(ID), latest],
      [sessionDailyKey(ID, "2026-09-24"), await session([{ name: OLD, content: lines(10) }])],
    ]);
    const deps = restoreDeps(r2);
    const got: string[] = [];
    const get = deps.r2Get!;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await runSessionRestore({ ...deps, r2Get: async (k) => (got.push(k), get(k)) }, ID);

    expect(res.source).toBe("latest");
    expect(got).toEqual([sessionLatestKey(ID)]);
    vi.restoreAllMocks();
  });
});

describe("StudioDO wiring for #94 (source-pinned — the class cannot be constructed here, fix pass 2 item 3)", () => {
  const src: string = env.TEST_STUDIO_DO_SRC;

  function methodBody(signature: string): string {
    const start = src.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  }", start));
  }

  it("deps() lists R2 keys for the keeper fallback", () => {
    expect(methodBody("  private deps(): ProvisionDeps {")).toMatch(
      /r2List: async \(prefix: string\) => \{\s*const listed = await this\.env\.STUDIO_ARCHIVE\.list\(\{ prefix \}\);\s*return listed\.objects\.map\(\(o\) => o\.key\);/,
    );
  });

  it("deps() stores a restored mark and deletes the baseline when the restore has none", () => {
    const body = methodBody("  private deps(): ProvisionDeps {");
    expect(body).toMatch(/recordRestoredMark: async \(mark: SessionMark \| null\) => \{/);
    expect(body).toContain("if (mark) await this.ctx.storage.put(SESSION_MARK_KEY, mark);");
    expect(body).toContain("else await this.ctx.storage.delete(SESSION_MARK_KEY);");
  });

  // Board #140 (HOLD fix): a restore is itself a fresh, deliberate baseline
  // event — recordRestoredMark must cancel any pending force-upload
  // override, or an override armed before the restore would survive to
  // force-upload the very next ORDINARY sync tick with zero comparison.
  it("deps() cancels the pending force-upload override on every restore", () => {
    const body = methodBody("  private deps(): ProvisionDeps {");
    expect(body).toContain("await this.ctx.storage.delete(SESSION_FORCE_KEY);");
  });

  it("syncDeps() reads R2 latest to seed the guard baseline", () => {
    expect(methodBody("  private syncDeps(")).toMatch(
      /r2Get: async \(key: string\) => \{\s*const obj = await this\.env\.STUDIO_ARCHIVE\.get\(key\);\s*return obj \? new Uint8Array\(await obj\.arrayBuffer\(\)\) : null;/,
    );
  });

  it("the DO's own clearSessionGuard() method delegates to the free function", () => {
    expect(src).toContain("async clearSessionGuard(): Promise<StudioStatus> {");
    const body = methodBody("  async clearSessionGuard(): Promise<StudioStatus> {");
    expect(body).toContain("await clearSessionGuard(this.ctx.storage, (s) => recordStudio(this.env, s));");
  });
});

// ---------------------------------------------------------------------------
// Board #140 HOLD fix: syncSessionTick's one-shot force-upload override.
// Maestro's blocker on #192: clearSessionGuard deleting the mark let
// seedMark re-derive an IDENTICAL mark from R2's own current `latest` —
// the same `latest` every candidate had been losing to — so the tick right
// after clearSessionGuard still displaced the same candidate for the same
// reason. These tests pin the actual fix: SESSION_FORCE_KEY, armed by
// clearSessionGuard, makes the NEXT tick skip the comparison entirely
// (never reading a mark to compare against at all), with a safety-net copy
// of the old `latest` preserved first.
// ---------------------------------------------------------------------------

describe("syncSessionTick — the one-shot force-upload override (#140 HOLD fix)", () => {
  it("(a) the frozen case: an unforced tick is still displaced; after clearSessionGuard the next tick uploads, and the OLD latest survives under sessions/<id>/superseded/<iso>.tar.gz", async () => {
    const latest = await session([{ name: OLD, content: lines(10) }]);
    const latestMark = newestMark(await sessionStats(latest))!;
    const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), latest]]);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: latestMark });
    const candidate = await session([{ name: NEW, content: lines(2) }]);

    // Confirms the setup: unforced, this candidate is still displaced —
    // exactly today's (pre-fix) behavior.
    const displaced = await syncSessionTick(fakeDeps(candidate, { r2 }), storage, ID);
    expect(displaced.skipped).toBe("displaced");
    expect(r2.get(sessionLatestKey(ID))).toEqual(latest);

    await clearSessionGuard(storage, async () => {});

    const forcedNow = "2026-09-24T10:00:00.000Z";
    const res = await syncSessionTick(fakeDeps(candidate, { r2, now: forcedNow }), storage, ID);

    expect(res.skipped).toBeUndefined();
    expect(r2.get(sessionLatestKey(ID))).toEqual(candidate);
    // Safety net: the OLD latest, preserved intact, byte-for-byte.
    expect(r2.get(sessionSupersededKey(ID, forcedNow))).toEqual(latest);
    expect(storage.map.get(SESSION_MARK_KEY)).toEqual(newestMark(await sessionStats(candidate)));
    expect(storage.map.get(SESSION_GUARD_KEY)).toBeNull();
    expect(storage.map.get(SESSION_FORCE_KEY)).toBeUndefined(); // one-shot, consumed
  });

  it("(b) a blank candidate right after clearSessionGuard is still displaced, the override stays armed, and the next non-blank candidate is the one that force-uploads", async () => {
    const latest = await session([{ name: OLD, content: lines(10) }]);
    const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), latest]]);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: newestMark(await sessionStats(latest))! });
    await clearSessionGuard(storage, async () => {});

    const blank = await session([]); // no jsonl members at all
    const blankRes = await syncSessionTick(fakeDeps(blank, { r2 }), storage, ID);
    expect(blankRes.skipped).toBe("displaced");
    expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true); // still armed
    expect(r2.get(sessionLatestKey(ID))).toEqual(latest); // untouched

    const candidate = await session([{ name: NEW, content: lines(2) }]);
    const res = await syncSessionTick(fakeDeps(candidate, { r2 }), storage, ID);
    expect(res.skipped).toBeUndefined();
    expect(r2.get(sessionLatestKey(ID))).toEqual(candidate);
    expect(storage.map.get(SESSION_FORCE_KEY)).toBeUndefined();
  });

  it("(c) one-shot: after the forced upload consumes the override, a later poorer candidate is displaced normally again", async () => {
    const latest = await session([{ name: OLD, content: lines(10) }]);
    const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), latest]]);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: newestMark(await sessionStats(latest))! });
    await clearSessionGuard(storage, async () => {});

    const forcedCandidate = await session([{ name: NEW, content: lines(2) }]);
    const forced = await syncSessionTick(fakeDeps(forcedCandidate, { r2 }), storage, ID);
    expect(forced.skipped).toBeUndefined();

    // Poorer than the FRESHLY-set mark (NEW at 2 lines) — the override must
    // not still be armed, or this would force-upload again instead.
    const poorer = await session([{ name: NEW, content: lines(1) }]);
    const res = await syncSessionTick(fakeDeps(poorer, { r2 }), storage, ID);
    expect(res.skipped).toBe("displaced");
  });

  it("(d) a restore while the override is armed cancels it — a later ordinary tick with a poorer candidate is displaced, not force-uploaded", async () => {
    const latest = await session([{ name: OLD, content: lines(10) }]);
    const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), latest]]);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: newestMark(await sessionStats(latest))! });
    await clearSessionGuard(storage, async () => {});
    expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);

    // Mirrors do.ts's real recordRestoredMark wiring: sets the restored
    // mark AND unconditionally cancels any pending override (see
    // studio.backup-guard.test.ts's "deps() cancels the pending
    // force-upload override on every restore" source-pinned test above for
    // proof the REAL closure does this too).
    const recordRestoredMark = async (mark: SessionMark | null) => {
      if (mark) await storage.put(SESSION_MARK_KEY, mark);
      await storage.delete?.(SESSION_FORCE_KEY);
    };
    await recordRestoredMark({ file: OLD, lines: 20, lastTs: "2026-09-24T09:00:00.000Z" });
    expect(storage.map.get(SESSION_FORCE_KEY)).toBeUndefined();

    const poorer = await session([{ name: OLD, content: lines(3) }]);
    const res = await syncSessionTick(fakeDeps(poorer, { r2 }), storage, ID);
    expect(res.skipped).toBe("displaced");
  });

  // Issue #228 item 1: this exact case (armed override + the NEXT candidate
  // turns out unreadable) was already handled correctly by the code — the
  // `if (!candidate) reason = "candidate unreadable";` branch above displaces
  // it and leaves SESSION_FORCE_KEY armed, same as any other unreadable
  // candidate — but NOTHING pinned it. A mutation that force-uploaded an
  // unreadable candidate anyway (skipping the `!candidate` check) passed the
  // whole suite before this test existed.
  it("(f) an armed override still displaces a genuinely unreadable candidate (not a force-upload) — the override stays armed, latest is untouched", async () => {
    const latest = await session([{ name: OLD, content: lines(10) }]);
    const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), latest]]);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: newestMark(await sessionStats(latest))! });
    await clearSessionGuard(storage, async () => {});
    expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Same technique the "latest is not gzip at all (bad magic)" restore
      // test above uses for an unreadable candidate — not a valid gzip
      // stream at all.
      const unreadable = new Uint8Array([1, 2, 3, 4]);
      const res = await syncSessionTick(fakeDeps(unreadable, { r2 }), storage, ID);

      expect(res.skipped).toBe("displaced");
      expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true); // still armed
      expect(r2.get(sessionLatestKey(ID))).toEqual(latest); // untouched
    } finally {
      errSpy.mockRestore();
    }
  });

  it("no r2Get wired: refuses to force (logged), falling through to the ordinary comparison instead of uploading with no safety net", async () => {
    const latest = await session([{ name: OLD, content: lines(10) }]);
    const storage = fakeStorage({ [SESSION_MARK_KEY]: newestMark(await sessionStats(latest))! });
    await clearSessionGuard(storage, async () => {});
    const candidate = await session([{ name: NEW, content: lines(2) }]);
    const deps = { ...fakeDeps(candidate), r2Get: undefined };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await syncSessionTick(deps, storage, ID);

    expect(res.skipped).toBe("displaced"); // ordinary comparison: candidate is poorer than the stored mark
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("cannot force upload, no r2Get available"))).toBe(true);
    errSpy.mockRestore();
  });

  // Issue #228 HOLD fix round, item 4: `SessionSyncStorage.delete` is a
  // required property, closing a latent bug (a port without `delete`
  // silently never consumes the override — every later tick force-uploads
  // forever, no comparison ever run again). Pinned against the BARE port
  // type: `delete` required means `{ get, put }` alone cannot satisfy
  // `SessionSyncStorage` at all, so the `@ts-expect-error` below is load-
  // bearing — flip `delete` back to optional and this line's own
  // `@ts-expect-error` becomes unused (TS2578), which fails `bun run check`
  // rather than silently passing.
  it("delete is required: a port that cannot consume the override does not compile", () => {
    const { get, put } = fakeStorage();
    // @ts-expect-error — without delete, an armed override is never consumed and every tick force-uploads.
    const port: SessionSyncStorage = { get, put };
    void port;
  });
});

// ---------------------------------------------------------------------------
// Board #140 (#94 follow-up, HOLD fix): clearSessionGuard — the operator's
// escape from a sync guard stuck comparing every candidate against a
// stale/wrong baseline. The ORIGINAL #140 design deleted SESSION_MARK_KEY,
// expecting the next tick to re-seed a fresh mark from R2's own `latest` —
// held in review (#192) because that re-seed reads the SAME `latest` every
// candidate has been losing to, so the freshly re-seeded mark is identical
// to what was deleted and the very next tick displaces the very next
// candidate for the very same reason: a complete no-op in the frozen case
// this verb exists for. The fix instead ARMS SESSION_FORCE_KEY, a one-shot
// override the next `syncSessionTick` reads to skip the comparison entirely
// for exactly one tick — see that function's own describe block below for
// full coverage of the tick-side half, and session-sync.ts's own doc
// comment for the complete design. This block covers only clearSessionGuard
// itself: it still nulls SESSION_GUARD_KEY and mirrors the clear onto
// StudioStatus.sessionGuard immediately, unchanged from before.
// ---------------------------------------------------------------------------

describe("clearSessionGuard (#140)", () => {
  it("arms the force-upload override, leaves the mark untouched, nulls the guard, and mirrors the clear onto the row immediately", async () => {
    const storage = fakeStorage({
      [SESSION_MARK_KEY]: { file: OLD, lines: 10, lastTs: NOW },
      [SESSION_GUARD_KEY]: { at: NOW, key: sessionDisplacedKey(ID, NOW), reason: "candidate poorer than latest" },
      [STATUS_KEY]: {
        id: ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
        burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
        sessionGuard: { at: NOW, key: sessionDisplacedKey(ID, NOW), reason: "candidate poorer than latest" },
      } as StudioStatus,
    });
    const recorded: StudioStatus[] = [];

    const result = await clearSessionGuard(
      storage, async (s) => { recorded.push(s); }, () => new Date("2026-09-24T10:00:00.000Z"),
    );

    expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);
    // Unlike the original design, the mark itself is left exactly as it
    // was — the override changes what the NEXT tick does, not what the
    // mark currently holds.
    expect(storage.map.get(SESSION_MARK_KEY)).toEqual({ file: OLD, lines: 10, lastTs: NOW });
    expect(storage.map.get(SESSION_GUARD_KEY)).toBeNull();
    expect(result?.sessionGuard).toBeNull();
    expect((storage.map.get(STATUS_KEY) as StudioStatus).sessionGuard).toBeNull();
    // Issue #228 item 5: the arm-time now rides the same row write.
    expect(result?.sessionForceArmedAt).toBe("2026-09-24T10:00:00.000Z");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].sessionGuard).toBeNull();
    expect(recorded[0].sessionForceArmedAt).toBe("2026-09-24T10:00:00.000Z");
  });

  // Issue #228 item 5: the oversize branch still skips clearing the
  // sessionGuard record (unchanged: issue #176's own ruling that an oversize
  // refusal is not a stale guard this override can resolve) but the override
  // is armed regardless — the row must say so even here.
  it("oversize refusal: still stamps sessionForceArmedAt, but leaves the oversize sessionGuard record alone", async () => {
    const oversizeGuard = { at: NOW, key: "", reason: "oversize: …", tarBytes: 40 * 1024 * 1024, capBytes: 32 * 1024 * 1024 };
    const storage = fakeStorage({
      [SESSION_GUARD_KEY]: oversizeGuard,
      [STATUS_KEY]: {
        id: ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
        burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
        sessionGuard: oversizeGuard,
      } as StudioStatus,
    });
    const recorded: StudioStatus[] = [];

    const result = await clearSessionGuard(
      storage, async (s) => { recorded.push(s); }, () => new Date("2026-09-24T10:05:00.000Z"),
    );

    expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);
    expect(storage.map.get(SESSION_GUARD_KEY)).toEqual(oversizeGuard); // untouched
    expect(result?.sessionGuard).toEqual(oversizeGuard); // untouched
    expect(result?.sessionForceArmedAt).toBe("2026-09-24T10:05:00.000Z");
    expect(recorded[0].sessionForceArmedAt).toBe("2026-09-24T10:05:00.000Z");
  });

  // Issue #228 item 5: this used to be a true no-op (no row write at all)
  // before StudioStatus.sessionForceArmedAt existed — now `clearSessionGuard`
  // ALWAYS arms the override (the `storage.put(SESSION_FORCE_KEY, true)`
  // above runs unconditionally), so the row must always say so, even for a
  // studio with no PRIOR guard refusal to clear alongside it.
  it("a studio with no guard state at all still stamps sessionForceArmedAt and records the row (issue #228 item 5)", async () => {
    const storage = fakeStorage({
      [STATUS_KEY]: {
        id: ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
        burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      } as StudioStatus,
    });
    const recorded: StudioStatus[] = [];

    const result = await clearSessionGuard(
      storage, async (s) => { recorded.push(s); }, () => new Date("2026-09-24T10:00:00.000Z"),
    );

    expect(result?.state).toBe("running");
    expect(result?.sessionForceArmedAt).toBe("2026-09-24T10:00:00.000Z");
    expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].sessionForceArmedAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("no row at all yet: arms the override, returns null, never throws", async () => {
    const storage = fakeStorage({ [SESSION_MARK_KEY]: { file: OLD, lines: 3, lastTs: NOW } });
    const recorded: StudioStatus[] = [];

    const result = await clearSessionGuard(storage, async (s) => { recorded.push(s); });

    expect(result).toBeNull();
    expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);
    expect(storage.map.get(SESSION_MARK_KEY)).toEqual({ file: OLD, lines: 3, lastTs: NOW });
    expect(recorded).toHaveLength(0);
  });

  it("calling it twice before any tick runs is idempotent: the second call just re-arms the same override", async () => {
    const storage = fakeStorage();
    const recorded: StudioStatus[] = [];

    await clearSessionGuard(storage, async (s) => { recorded.push(s); });
    await clearSessionGuard(storage, async (s) => { recorded.push(s); });

    expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #228 item 5: an armed override survives straight into a destroy — the
// destroy's OWN pre-teardown sync is the tick that consumes it. destroy.ts's
// own doc comment (right above its syncSessionTick call) documents this as
// intentional: the studio's LAST session before destruction gets
// force-uploaded (bypassing the mark/poorerThan comparison), with the OLD
// `latest` safely preserved under its own `superseded/` key from that same
// forced upload — never a silent displacement of a candidate an operator
// specifically asked to let through.
// ---------------------------------------------------------------------------

describe("destroyWithSync consumes an armed clear-session-guard override on its own pre-teardown sync (#228 item 5)", () => {
  it("arming the override then destroying force-uploads the studio's last session — the old latest survives under sessions/<id>/superseded/<iso>.tar.gz", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const latest = await session([{ name: OLD, content: lines(10) }]);
      const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), latest]]);
      const storage = fakeStorage({ [SESSION_MARK_KEY]: newestMark(await sessionStats(latest))! });
      await clearSessionGuard(storage, async () => {});
      expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);

      // Poorer than the mark — this would normally be DISPLACED, never
      // force-uploaded, if the override were not armed.
      const poorerCandidate = await session([{ name: NEW, content: lines(1) }]);
      const destroy = vi.fn(async () => {});
      const recordStudioFn = vi.fn(async () => {});
      const forcedNow = "2026-09-24T10:00:00.000Z";

      const result = await destroyWithSync(
        fakeDeps(poorerCandidate, { r2, now: forcedNow }), storage, ID, destroy, recordStudioFn,
        "websites", async () => "unused/blueprint-repo", async () => {},
      );

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(result.state).toBe("stopped");
      // Forced, not displaced: the candidate IS the new latest, and the old
      // latest survives intact under its own superseded/ key.
      expect(r2.get(sessionLatestKey(ID))).toEqual(poorerCandidate);
      expect(r2.get(sessionSupersededKey(ID, forcedNow))).toEqual(latest);
      expect(storage.map.get(SESSION_FORCE_KEY)).toBeUndefined(); // consumed
    } finally {
      errSpy.mockRestore();
    }
  });

  // Issue #228 HOLD fix, item 1: the bug the maestro review's repro names —
  // `clearSessionGuard` stamps STATUS_KEY.sessionForceArmedAt with T, this
  // destroy's own pre-teardown sync consumes SESSION_FORCE_KEY (proven by
  // the test just above), but before the fix NOTHING told STATUS_KEY so.
  // Both the `stopped` row this function persists AND the row it hands to
  // `recordStudioFn` (the registry mirror) kept sessionForceArmedAt = T
  // forever — a destroyed studio's row never sees another sync tick
  // (mirrorBurnToRegistry, the only other place that clears it) to
  // self-heal, so `fleet ls` printed "force-next-sync armed since <T>" for
  // an override that was already spent.
  it("(item 1a) an alive destroy that consumes the override clears sessionForceArmedAt on both the persisted row and the last recorded (registry) row", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const latest = await session([{ name: OLD, content: lines(10) }]);
      const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), latest]]);
      const storage = fakeStorage({
        [SESSION_MARK_KEY]: newestMark(await sessionStats(latest))!,
        [STATUS_KEY]: {
          id: ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
          burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
        } as StudioStatus,
      });
      const armedAt = "2026-09-24T09:00:00.000Z";
      await clearSessionGuard(storage, async () => {}, () => new Date(armedAt));
      expect((storage.map.get(STATUS_KEY) as StudioStatus).sessionForceArmedAt).toBe(armedAt);

      const poorerCandidate = await session([{ name: NEW, content: lines(1) }]);
      const destroy = vi.fn(async () => {});
      const recorded: StudioStatus[] = [];
      const recordStudioFn = async (s: StudioStatus) => { recorded.push(s); };
      const forcedNow = "2026-09-24T10:00:00.000Z";

      const result = await destroyWithSync(
        fakeDeps(poorerCandidate, { r2, now: forcedNow }), storage, ID, destroy, recordStudioFn,
        "websites", async () => "unused/blueprint-repo", async () => {},
      );

      expect(storage.map.get(SESSION_FORCE_KEY)).toBeUndefined(); // consumed
      expect(result.state).toBe("stopped");
      expect(result.sessionForceArmedAt).toBeNull();
      expect((storage.map.get(STATUS_KEY) as StudioStatus).sessionForceArmedAt).toBeNull();
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.at(-1)!.sessionForceArmedAt).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  // Issue #228 HOLD fix, item 1(b): the opposite case, proving the fix is
  // conditional, not a blanket clear. A container that never answers (or was
  // never running) means destroyWithSync's pre-teardown sync never runs at
  // all — SESSION_FORCE_KEY is never touched, so the armed stamp is still
  // completely accurate and must survive untouched.
  it("(item 1b) a destroy whose container is not running never syncs, so the armed key and stamp both survive untouched", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const storage = fakeStorage({
        [STATUS_KEY]: {
          id: ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
          burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
        } as StudioStatus,
      });
      const armedAt = "2026-09-24T09:00:00.000Z";
      await clearSessionGuard(storage, async () => {}, () => new Date(armedAt));
      expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);

      const destroy = vi.fn(async () => {});
      const recorded: StudioStatus[] = [];
      const recordStudioFn = async (s: StudioStatus) => { recorded.push(s); };

      const result = await destroyWithSync(
        fakeDeps(await session([])), storage, ID, destroy, recordStudioFn,
        "websites", async () => "unused/blueprint-repo", async () => {},
        { containerRunning: () => false },
      );

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(result.state).toBe("stopped");
      // Never touched: no sync ran, so nothing consumed the override.
      expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);
      expect(result.sessionForceArmedAt).toBe(armedAt);
      expect(recorded.at(-1)!.sessionForceArmedAt).toBe(armedAt);
    } finally {
      errSpy.mockRestore();
    }
  });

  // Issue #228 HOLD fix round 3, item (1c): the guard case test 1b's own
  // "container not running" shape does not reach — an ALIVE container's
  // pre-teardown sync DOES run here, but the candidate is BLANK, which
  // syncSessionTick refuses (displaces, never force-uploads) even with the
  // override armed. clearConsumedForceStamp must only fire when the sync
  // actually CONSUMED the override, never unconditionally alongside "a sync
  // ran" — a mutant that clears the stamp any time the sync block executes,
  // regardless of outcome, passes every other test in this file (none of
  // them exercise "sync ran, but displaced instead of forced") and only
  // fails here.
  it("(item 1c) an alive destroy whose sync displaces a blank candidate: the override and its stamp both survive untouched", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const latest = await session([{ name: OLD, content: lines(10) }]);
      const r2 = new Map<string, Uint8Array>([[sessionLatestKey(ID), latest]]);
      const storage = fakeStorage({
        [SESSION_MARK_KEY]: newestMark(await sessionStats(latest))!,
        [STATUS_KEY]: {
          id: ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
          burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
        } as StudioStatus,
      });
      const armedAt = "2026-09-24T09:00:00.000Z";
      await clearSessionGuard(storage, async () => {}, () => new Date(armedAt));
      expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);

      const blankCandidate = await session([]);
      const destroy = vi.fn(async () => {});
      const recorded: StudioStatus[] = [];
      const recordStudioFn = async (s: StudioStatus) => { recorded.push(s); };

      const result = await destroyWithSync(
        fakeDeps(blankCandidate, { r2 }), storage, ID, destroy, recordStudioFn,
        "websites", async () => "unused/blueprint-repo", async () => {},
      );

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(result.state).toBe("stopped");
      // Displaced, not forced: latest is untouched, and nothing was consumed.
      expect(r2.get(sessionLatestKey(ID))).toEqual(latest);
      expect(storage.map.get(SESSION_FORCE_KEY)).toBe(true);
      expect(result.sessionForceArmedAt).toBe(armedAt);
      expect(recorded.at(-1)!.sessionForceArmedAt).toBe(armedAt);
    } finally {
      errSpy.mockRestore();
    }
  });
});
