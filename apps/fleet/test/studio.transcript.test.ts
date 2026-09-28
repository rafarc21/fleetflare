import { describe, it, expect, vi } from "vitest";
import {
  shipTranscriptTick, shipTickCmd, rotateCmd, decodeTailPreview,
  SECTION_BOOTID, SECTION_STAT, SECTION_CHUNK, SECTION_TAIL, SECTION_INCARNATION,
  TRANSCRIPT_LOG_PATH, TRANSCRIPT_BOOT_ID_PATH,
  TRANSCRIPT_MANIFEST_KEY, TRANSCRIPT_TAIL_KEY, TRANSCRIPT_BOOT_ID_KEY,
  type ShipDeps, type TranscriptStorage,
} from "../src/studio/transcript";
import { chunkKey, TRANSCRIPT_PULL_MAX, HOT_TAIL_BYTES, type TranscriptManifest } from "../src/studio/archive";
import {
  INCARNATION_PATH, SESSION_FOUND_SECTION, SESSION_CONTINUE_SECTION, SESSION_CWD_SECTION,
} from "../src/studio/observed";
import {
  SECTION_PANE, parsePaneSection, readShipTickActivity,
  SECTION_ACTIVITY_HOOK, parseActivityHookSection, readShipTickHookHeartbeat,
  SECTION_MEMGUARD, parseMemguardSection, readShipTickMemguardKills,
} from "../src/studio/transcript";
import { REAL_PILOT_PANE } from "./fixtures/rate-limit-panes";

// A live StudioDO cannot be constructed under vitest-pool-workers (see
// src/studio/do.ts's own header) — do.ts's real shipTranscript() is a thin
// wrapper around shipTranscriptTick, so this file targets that exported pure
// function directly, the same split test/studio.refresh.test.ts and
// test/studio.provision.test.ts (the *WithStorage tests) already use.
//
// Fleet Spawn P3, Task 5 (R-P3-5, exec consolidation): this file was
// rewritten wholesale around the new shipTickCmd/rotateCmd shape (down from
// the old statAndBootIdCmd/readChunkCmd/hotTailCmd trio). Every invariant the
// PRE-consolidation suite pinned still has an assertion here — see
// task-5-report.md's old-test -> new-test table for the full mapping; the
// short version, repeated at each describe block below: offset math, binary
// safety, rotation-only-when-fully-shipped, the rotation TOCTOU gate,
// date-roll seq reset, boot-id/belt generation-marker resets, and
// failure-isolation/retry-safety all still hold, adapted to the new
// exec shape (fewer, differently-shaped `deps.exec()` calls) — never
// weakened.

const STUDIO_ID = "websites--pilot";
const TODAY = "2026-08-16";

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

/**
 * Same shape as provision.ts's own StudioStorage fake in
 * test/studio.refresh.test.ts: an in-memory Map behind the keyed-overload
 * port, `get` cast once (see that file's comment for why `put` needs no cast
 * but `get` does), plus a `putKeys` log so "manifest never written"
 * (failure-isolation) is a positive assertion, not just "still whatever it
 * was seeded as".
 *
 * Fix round: `failNextPutFor` — set to a key to make the VERY NEXT `put` for
 * that exact key throw once (auto-clearing itself), then behave normally
 * again. Backs the "manifest-write failure is retry-safe" coverage below —
 * the one place this file needs to inject a storage failure that is NOT
 * `r2Put` (already covered) or an exec failure.
 *
 * Fix round 2: `put` now also handles the multi-key object form (real DO
 * storage's own `put<T>(entries: Record<string,T>)` overload —
 * TranscriptStorage mirrors it, see that interface's own doc comment).
 * Normalized to a single `entries` map either way so ONE code path checks
 * `failNextPutFor` and writes — checked against ALL keys BEFORE writing ANY
 * of them, mirroring real multi-key put's all-or-nothing semantics, so a
 * fake failure can hit the atomic form too rather than silently only
 * understanding single-key calls (which would make the atomic write a
 * no-op in this fake instead of a real, observable effect).
 */
function fakeStorage(
  seed?: { manifest?: TranscriptManifest; tail?: string; bootId?: string },
): TranscriptStorage & { putKeys: string[]; failNextPutFor: string | null } {
  const map = new Map<string, TranscriptManifest | string>();
  if (seed?.manifest) map.set(TRANSCRIPT_MANIFEST_KEY, seed.manifest);
  if (seed?.tail !== undefined) map.set(TRANSCRIPT_TAIL_KEY, seed.tail);
  if (seed?.bootId !== undefined) map.set(TRANSCRIPT_BOOT_ID_KEY, seed.bootId);
  const putKeys: string[] = [];
  const storage = {
    putKeys,
    failNextPutFor: null as string | null,
    get: (async (key: string) => map.get(key)) as TranscriptStorage["get"],
    put: (async (
      keyOrEntries: string | Record<string, TranscriptManifest | string>,
      value?: TranscriptManifest | string,
    ) => {
      const entries: Record<string, TranscriptManifest | string> =
        typeof keyOrEntries === "string" ? { [keyOrEntries]: value! } : keyOrEntries;
      for (const key of Object.keys(entries)) {
        if (storage.failNextPutFor === key) {
          storage.failNextPutFor = null;
          throw new Error(`storage.put(${key}) failed: simulated`);
        }
      }
      for (const [key, v] of Object.entries(entries)) {
        putKeys.push(key);
        map.set(key, v);
      }
    }) as TranscriptStorage["put"],
  };
  return storage;
}

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

/** UTF-8 aware, for fixtures with real text (terminal output is not
 *  Latin1-only — claude's own TUI uses box-drawing/Unicode) — same shape as
 *  src/studio/blueprint.ts's base64EncodeUtf8. Plain `btoa(str)` throws
 *  outright on any character outside Latin1. */
function b64Utf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

/**
 * Builds the exact delimited stdout `shipTickCmd`'s real shell script would
 * produce, from plain option fields — the fake exec's default path for the
 * consolidated command below. Mirrors the command's OWN section-emission
 * rule exactly: CHUNK/TAIL are only emitted when `stat` parses to a finite,
 * non-negative size (the command's `if [ "$FLEET_SIZE" -ge 0 ]` guard) —
 * anything else (a negative sentinel, or unparseable) omits them entirely,
 * the same "no-file" shape the parser must treat identically to the
 * marker-missing case. Issue #85: the INCARNATION section is UNCONDITIONAL
 * (before the same `if` guard, mirroring shipTickCmd's own placement),
 * `incarnation` defaults to "" the same way every other field here defaults
 * to "absent".
 */
function synthesizeTickStdout(
  opts: { stat?: string; bootId?: string; read?: string; tail?: string; incarnation?: string },
): string {
  const stat = opts.stat ?? "-1";
  const lines = [
    SECTION_BOOTID, opts.bootId ?? "", SECTION_STAT, stat,
    SECTION_INCARNATION, opts.incarnation ?? "",
  ];
  const size = Number.parseInt(stat, 10);
  if (Number.isFinite(size) && size >= 0) {
    lines.push(SECTION_CHUNK, opts.read ?? "", SECTION_TAIL, opts.tail ?? "");
  }
  return lines.join("\n");
}

/**
 * Routes by command shape, not call order — matches this feature's own
 * command builders exactly: `shipTickCmd`'s output always starts with
 * "FLEET_FRESH_BOOT_ID=" (its very first assignment); `rotateCmd` is the
 * only other command this file ever issues, so anything else routes there.
 * Defaults (no file, no bytes) so a test only has to override what it cares
 * about. `now` is folded in here too since ShipDeps bundles all three.
 *
 * `rawTickStdout` — escape hatch for the consolidated-parser matrix tests
 * below: bypasses `synthesizeTickStdout` entirely and returns this exact
 * string, so a test can construct partial/malformed/garbage output directly
 * rather than only what a well-formed tick could ever produce.
 */
function fakeDeps(opts: {
  stat?: string; bootId?: string; read?: string; tail?: string; incarnation?: string;
  rawTickStdout?: string; tickCode?: number; tickStderr?: string;
  rotateMarker?: "ROTATED" | "SKIPPED"; rotateCode?: number; rotateStderr?: string;
  now?: string;
  r2Throws?: boolean;
} = {}): ShipDeps & { execCalls: string[]; puts: { key: string; bytes: Uint8Array }[] } {
  const execCalls: string[] = [];
  const puts: { key: string; bytes: Uint8Array }[] = [];
  return {
    execCalls,
    puts,
    exec: async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.startsWith("FLEET_FRESH_BOOT_ID=")) {
        const stdout = opts.rawTickStdout ?? synthesizeTickStdout(opts);
        return { code: opts.tickCode ?? 0, stdout, stderr: opts.tickStderr ?? "" };
      }
      return {
        code: opts.rotateCode ?? 0,
        stdout: opts.rotateMarker ?? "ROTATED",
        stderr: opts.rotateStderr ?? "",
      };
    },
    r2Put: async (key: string, bytes: Uint8Array) => {
      if (opts.r2Throws) throw new Error("r2 put failed: bucket unavailable");
      puts.push({ key, bytes });
    },
    now: fixedNow(opts.now ?? `${TODAY}T12:00:00.000Z`),
  };
}

// ---------------------------------------------------------------------------

describe("shipTickCmd / rotateCmd — exact shell shapes", () => {
  it("shipTickCmd reads boot-id then stat, both delimited, always attempted", () => {
    const cmd = shipTickCmd(0, undefined);
    expect(cmd).toContain(`cat ${TRANSCRIPT_BOOT_ID_PATH} 2>/dev/null || echo ''`);
    expect(cmd).toContain(`stat -c %s ${TRANSCRIPT_LOG_PATH} 2>/dev/null || echo -1`);
    expect(cmd).toContain(`echo '${SECTION_BOOTID}'`);
    expect(cmd).toContain(`echo '${SECTION_STAT}'`);
    // Ordering: boot-id read before stat, both before the conditional body.
    expect(cmd.indexOf(SECTION_BOOTID)).toBeLessThan(cmd.indexOf(SECTION_STAT));
    expect(cmd.indexOf(SECTION_STAT)).toBeLessThan(cmd.indexOf(SECTION_CHUNK));
    expect(cmd.indexOf(SECTION_CHUNK)).toBeLessThan(cmd.indexOf(SECTION_TAIL));
  });

  it("embeds the given manifest offset literally, and reads the chunk 1-indexed (offset+1) capped at TRANSCRIPT_PULL_MAX", () => {
    expect(shipTickCmd(0, undefined)).toContain("FLEET_EFF=0");
    expect(shipTickCmd(500, undefined)).toContain("FLEET_EFF=500");
    expect(shipTickCmd(0, undefined)).toContain(
      `tail -c +$((FLEET_EFF+1)) ${TRANSCRIPT_LOG_PATH} | head -c ${TRANSCRIPT_PULL_MAX} | base64`,
    );
  });

  it("embeds a stored boot-id (single-quoted) for the shell's own comparison; omits one when undefined", () => {
    expect(shipTickCmd(0, "abc-123")).toContain("FLEET_STORED_BOOT_ID='abc-123'");
    expect(shipTickCmd(0, undefined)).toContain("FLEET_STORED_BOOT_ID=''");
  });

  it("reads HOT_TAIL_BYTES for the tail section, plain base64, no truncate", () => {
    const cmd = shipTickCmd(0, undefined);
    expect(cmd).toContain(`tail -c ${HOT_TAIL_BYTES} ${TRANSCRIPT_LOG_PATH} | base64`);
    expect(cmd).not.toContain("truncate");
  });

  it("rotateCmd re-stats and gates the truncate on <= shippedSize, printing a marker either way — no hot-tail read at all", () => {
    const cmd = rotateCmd(999);
    expect(cmd).toBe(
      `if [ "$(stat -c %s ${TRANSCRIPT_LOG_PATH} 2>/dev/null || echo -1)" -le 999 ]; then ` +
      `truncate -s 0 ${TRANSCRIPT_LOG_PATH} && echo ROTATED; else echo SKIPPED; fi`,
    );
    expect(cmd).not.toContain("tail -c");
    expect(cmd).not.toContain("base64");
  });

  it("base64's alphabet never contains '-' — the FLEET-*-marker collision this file's parser relies on being impossible", () => {
    // Exhaustive: every byte value, in every rotation of a base64 group (so
    // every possible output CHARACTER position is exercised, not just byte
    // 0), never produces a '-'.
    for (let n = 0; n < 256; n++) {
      for (let pad = 0; pad < 3; pad++) {
        const bytes = pad === 0 ? [n] : pad === 1 ? [n, 0] : [n, 0, 0];
        const encoded = btoa(String.fromCharCode(...bytes));
        expect(encoded).not.toContain("-");
      }
    }
    expect(SECTION_BOOTID).toContain("-");
    expect(SECTION_STAT).toContain("-");
    expect(SECTION_CHUNK).toContain("-");
    expect(SECTION_TAIL).toContain("-");
  });
});

describe("shipTranscriptTick — no-file skip", () => {
  // Old: "absent file (stat -> -1) returns {skipped:'no-file'} and issues no
  // read/tail exec" — execCalls length was 1 (only the combined stat+bootid
  // exec) under the pre-consolidation 3-exec model. New: still exactly ONE
  // exec (the consolidated shipTickCmd), and its own CHUNK/TAIL sections are
  // never even emitted (shipTickCmd's own `if` guard) — same "no read/tail
  // attempted" invariant, now expressed as "one exec, whose body never
  // reaches the conditional part" rather than "no second/third exec".
  it("absent file (stat -> -1) returns {skipped:'no-file'} and issues exactly one exec", async () => {
    const deps = fakeDeps({ stat: "-1" });
    const storage = fakeStorage();
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(result).toEqual({ shipped: 0, rotated: false, incarnationToken: "", skipped: "no-file" });
    expect(deps.execCalls).toHaveLength(1);
    expect(deps.execCalls[0]).toBe(shipTickCmd(0, undefined));
    expect(storage.putKeys).toHaveLength(0); // no manifest/tail/boot-id write at all
  });

  // Old: "empty/garbage stat output is also treated as no-file, not a
  // crash". New: same outcome, via the consolidated parser's STAT-section
  // handling (see the "consolidated parser matrix" describe block below for
  // the full missing/malformed-section coverage this maps into).
  it("empty/garbage stat output is also treated as no-file, not a crash", async () => {
    const deps = fakeDeps({ stat: "" });
    const result = await shipTranscriptTick(deps, fakeStorage(), STUDIO_ID);
    expect(result.skipped).toBe("no-file");
  });
});

describe("shipTranscriptTick — offset math across two ticks", () => {
  // Old: asserted `deps1.execCalls[1]` (the SECOND of 2-3 execs) equalled
  // readChunkCmd(offset). New: there is only ever one exec per non-rotating
  // tick, so the equivalent assertion pins `execCalls[0]` against
  // shipTickCmd(offset, storedBootId) directly — proving the CORRECT offset
  // literal was embedded in the one command actually sent.
  it("tick 1 ships from offset 0, seeds the manifest; tick 2 ships from the persisted offset", async () => {
    const storage = fakeStorage(); // nothing shipped yet — the NEVER_SHIPPED sentinel path

    const bytes1 = Array.from({ length: 100 }, (_, i) => i);
    const deps1 = fakeDeps({ stat: "100", read: b64(bytes1), now: `${TODAY}T12:00:00.000Z` });
    const r1 = await shipTranscriptTick(deps1, storage, STUDIO_ID);

    expect(r1.shipped).toBe(100);
    expect(r1.rotated).toBe(false);
    expect(deps1.execCalls).toHaveLength(1);
    expect(deps1.execCalls[0]).toBe(shipTickCmd(0, undefined)); // offset 0 -> FLEET_EFF=0
    expect(deps1.puts).toHaveLength(1);
    expect(deps1.puts[0].key).toBe(chunkKey(STUDIO_ID, TODAY, 0)); // first chunk of a fresh manifest is seq 0
    expect(deps1.puts[0].bytes).toEqual(new Uint8Array(bytes1));

    const manifestAfter1 = await storage.get(TRANSCRIPT_MANIFEST_KEY);
    expect(manifestAfter1).toEqual({ seq: 0, offset: 100, date: TODAY });

    // Tick 2: 150 more bytes have landed (size 250), same day.
    const bytes2 = Array.from({ length: 150 }, (_, i) => (200 + i) % 256);
    const deps2 = fakeDeps({ stat: "250", read: b64(bytes2), now: `${TODAY}T12:00:30.000Z` });
    const r2 = await shipTranscriptTick(deps2, storage, STUDIO_ID);

    expect(r2.shipped).toBe(150);
    expect(deps2.execCalls[0]).toBe(shipTickCmd(100, undefined)); // resumes from the PERSISTED offset
    expect(deps2.puts[0].key).toBe(chunkKey(STUDIO_ID, TODAY, 1)); // seq advances within the same day
    expect(deps2.puts[0].bytes).toEqual(new Uint8Array(bytes2));

    const manifestAfter2 = await storage.get(TRANSCRIPT_MANIFEST_KEY);
    expect(manifestAfter2).toEqual({ seq: 1, offset: 250, date: TODAY });
  });

  // Old: "zero new bytes... expect(deps.execCalls).toHaveLength(2); // stat
  // + hot-tail only, no read call" — the OLD model skipped issuing a SEPARATE
  // read exec at all when size===offset. New: shipTickCmd always attempts
  // the chunk section whenever the file exists (simpler shell, one fewer
  // branch) — `tail -c +(offset+1)` on a file of exactly `offset` bytes
  // naturally returns empty output, so the CHUNK section is present but
  // empty rather than absent. The invariant this preserves — no R2 put, no
  // manifest advance, hot tail still refreshed — is asserted directly
  // instead of via exec count, which is no longer the right signal (there is
  // only ever one exec here regardless of whether there was anything new).
  it("zero new bytes (size == offset): no R2 put, manifest untouched, hot tail still refreshed, exactly one exec", async () => {
    const storage = fakeStorage({ manifest: { seq: 3, offset: 500, date: TODAY } });
    const deps = fakeDeps({ stat: "500", tail: b64([1, 2, 3]) });
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);

    expect(result.shipped).toBe(0);
    expect(deps.puts).toHaveLength(0);
    expect(deps.execCalls).toHaveLength(1);
    expect(deps.execCalls[0]).toBe(shipTickCmd(500, undefined));
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual({ seq: 3, offset: 500, date: TODAY });
    expect(await storage.get(TRANSCRIPT_TAIL_KEY)).toBe(String.fromCharCode(1, 2, 3));
  });
});

describe("shipTranscriptTick — binary-safe round-trip", () => {
  it("bytes including 0x00 and 0xff survive the base64 exec path byte-for-byte", async () => {
    const raw = [0x00, 0xff, 0x10, 0x00, 0xff, 0x7f, 0x80, 0x01, 0xfe];
    const deps = fakeDeps({ stat: String(raw.length), read: b64(raw) });
    const storage = fakeStorage();
    await shipTranscriptTick(deps, storage, STUDIO_ID);

    expect(deps.puts).toHaveLength(1);
    expect(Array.from(deps.puts[0].bytes)).toEqual(raw);
  });

  it("decodes correctly even when the container wraps base64 at 76 columns (GNU coreutils default)", async () => {
    const raw = Array.from({ length: 120 }, (_, i) => i % 256);
    const wrapped = b64(raw).replace(/(.{76})/g, "$1\n"); // simulate coreutils' own default wrap
    const deps = fakeDeps({ stat: String(raw.length), read: wrapped });
    await shipTranscriptTick(deps, fakeStorage(), STUDIO_ID);
    expect(Array.from(deps.puts[0].bytes)).toEqual(raw);
  });
});

describe("shipTranscriptTick — rotation only when fully shipped", () => {
  it("over threshold but NOT fully shipped this tick (backlog exceeds the pull cap): no rotation, no second exec", async () => {
    const storage = fakeStorage({ manifest: { seq: 0, offset: 0, date: TODAY } });
    // stat reports a huge file; the fake "read" only returns a small slice
    // (standing in for a real tail|head capped at TRANSCRIPT_PULL_MAX) — the
    // cursor is nowhere near caught up, so rotation must not fire.
    const deps = fakeDeps({ stat: "100000000", read: b64([1, 2, 3, 4, 5]) });
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);

    expect(result.rotated).toBe(false);
    expect(deps.execCalls).toHaveLength(1); // no rotateCmd issued at all
    expect((await storage.get(TRANSCRIPT_MANIFEST_KEY))?.offset).toBe(5);
  });

  it("over threshold AND fully caught up this tick: rotates via a SECOND exec, offset reset", async () => {
    const startOffset = 67_108_800; // ROTATION_THRESHOLD_BYTES (67_108_864) - 64
    const storage = fakeStorage({ manifest: { seq: 5, offset: startOffset, date: TODAY } });
    const finalBytes = Array.from({ length: 64 }, (_, i) => i);
    const deps = fakeDeps({
      stat: "67108864", // exactly ROTATION_THRESHOLD_BYTES
      read: b64(finalBytes), // the last 64 bytes needed to fully catch up
      rotateMarker: "ROTATED", // the fake's own re-stat-passes case
    });
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);

    expect(result.rotated).toBe(true);
    expect(deps.execCalls).toHaveLength(2);
    expect(deps.execCalls[0]).toBe(shipTickCmd(startOffset, undefined));
    expect(deps.execCalls[1]).toBe(rotateCmd(startOffset + 64)); // gated on THIS tick's confirmed-shipped size

    const finalManifest = await storage.get(TRANSCRIPT_MANIFEST_KEY);
    expect(finalManifest).toEqual({ seq: 6, offset: 0, date: TODAY }); // seq/date preserved, offset reset
  });

  it("fully caught up but UNDER threshold: never rotates, regardless of catch-up", async () => {
    const storage = fakeStorage({ manifest: { seq: 0, offset: 0, date: TODAY } });
    const deps = fakeDeps({ stat: "10", read: b64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(result.rotated).toBe(false);
    expect(deps.execCalls).toHaveLength(1);
  });
});

describe("shipTranscriptTick — rotation TOCTOU (re-stat immediately before truncate)", () => {
  it("aborted when the file grew past what was shipped this tick: not truncated, offset NOT reset, result.rotated is false — next tick retries naturally", async () => {
    const startOffset = 67_108_800;
    const storage = fakeStorage({ manifest: { seq: 5, offset: startOffset, date: TODAY } });
    const finalBytes = Array.from({ length: 64 }, (_, i) => i); // catches up exactly to ROTATION_THRESHOLD_BYTES
    const deps = fakeDeps({
      stat: "67108864", read: b64(finalBytes),
      rotateMarker: "SKIPPED", // simulates: rotateCmd's OWN re-stat found the file had grown further
    });
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);

    expect(result.rotated).toBe(false); // rotation was ATTEMPTED (over threshold + fully shipped) but did not happen
    expect(deps.execCalls).toHaveLength(2);
    expect(deps.execCalls[1]).toBe(rotateCmd(startOffset + 64)); // gated on this tick's own confirmed-shipped size

    // The ship itself (seq 5->6, offset caught up) is still fully persisted —
    // only the offset-reset-to-0 that a REAL rotation would add is missing,
    // because truncate never actually ran (the file was never touched).
    // Resetting offset here anyway would make the next tick re-ship bytes
    // still physically sitting in the file — a duplicate, not a loss.
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual({ seq: 6, offset: startOffset + 64, date: TODAY });
  });
});

describe("shipTranscriptTick — date-roll seq reset", () => {
  it("a ship on a new UTC date resets seq to 0 under the new date's key prefix", async () => {
    const storage = fakeStorage({ manifest: { seq: 5, offset: 1000, date: "2026-08-15" } });
    const deps = fakeDeps({ stat: "1050", read: b64(Array(50).fill(7)), now: "2026-08-16T00:00:05.000Z" });
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);

    expect(result.shipped).toBe(50);
    expect(deps.puts[0].key).toBe(chunkKey(STUDIO_ID, "2026-08-16", 0));
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual({ seq: 0, offset: 1050, date: "2026-08-16" });
  });

  it("same UTC date across ticks never resets seq", async () => {
    const storage = fakeStorage({ manifest: { seq: 5, offset: 1000, date: TODAY } });
    const deps = fakeDeps({ stat: "1010", read: b64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), now: `${TODAY}T23:59:59.000Z` });
    await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(deps.puts[0].key).toBe(chunkKey(STUDIO_ID, TODAY, 6));
  });
});

describe("shipTranscriptTick — hot tail stored", () => {
  it("stores the decoded hot-tail preview under transcriptTail every non-skipped tick", async () => {
    const preview = "line one\nline two — the live pane\n";
    const deps = fakeDeps({
      stat: "20", read: b64(Array.from({ length: 20 }, (_, i) => 65 + i)),
      tail: b64Utf8(preview),
    });
    const storage = fakeStorage();
    await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(await storage.get(TRANSCRIPT_TAIL_KEY)).toBe(preview);
  });

  it("hot tail is refreshed even on a zero-new-bytes tick", async () => {
    const storage = fakeStorage({ manifest: { seq: 0, offset: 40, date: TODAY } });
    const deps = fakeDeps({ stat: "40", tail: btoa("still the same tail") });
    await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(await storage.get(TRANSCRIPT_TAIL_KEY)).toBe("still the same tail");
  });
});

// ---------------------------------------------------------------------------
// Fleet Spawn P3, Task 5: U+FFFD boundary trim. decodeTailPreview is tested
// directly (pure function) plus once through the full tick, below.
// ---------------------------------------------------------------------------
describe("decodeTailPreview — U+FFFD boundary trim", () => {
  it("a clean boundary (starts on a real character) is left untouched", () => {
    const bytes = new TextEncoder().encode("hello € world"); // "€" mid-string, no cut
    expect(decodeTailPreview(bytes)).toBe("hello € world");
  });

  it("trims a single orphaned continuation byte (the tail of a 2-byte sequence)", () => {
    // "é" = 0xC3 0xA9 — keep only the trailing continuation byte 0xA9.
    const bytes = new Uint8Array([0xa9, 0x68, 0x69]); // orphan + "hi"
    expect(decodeTailPreview(bytes)).toBe("hi");
    expect(decodeTailPreview(bytes)).not.toContain("�");
  });

  // Fleet Spawn P3, Task 6 fold: the middle of the three orphan counts. The
  // 1-orphan (2-byte "é") and 3-orphan (4-byte, worst case) cases bracket
  // the loop above and below; 2 orphans from a 3-BYTE sequence is the one
  // arithmetic the bracket does not pin — and it is the common one in
  // practice, since 3-byte sequences cover the whole BMP above Latin-1 (box
  // drawing, CJK, the arrows a TUI paints its panes with).
  it("trims 2 orphaned continuation bytes (a 3-byte sequence cut after its lead byte)", () => {
    // "€" = E2 82 AC — keep only the two trailing continuation bytes.
    const euro = new TextEncoder().encode("€");
    expect(euro).toHaveLength(3);
    const bytes = new Uint8Array([...euro.subarray(1), ...new TextEncoder().encode("rest")]);
    expect(decodeTailPreview(bytes)).toBe("rest");
    expect(decodeTailPreview(bytes)).not.toContain("�");
  });

  it("trims up to 3 orphaned continuation bytes (worst case: a 4-byte sequence missing its lead byte)", () => {
    const bytes = new Uint8Array([0x80, 0x80, 0x80, ...new TextEncoder().encode("clean")]);
    expect(decodeTailPreview(bytes)).toBe("clean");
    expect(decodeTailPreview(bytes)).not.toContain("�");
  });

  it("HOT_TAIL_BYTES-sized slice, split exactly at the 8192 boundary mid-character, decodes with no U+FFFD", () => {
    // "\u{1F600}" (grinning face) = F0 9F 98 80, 4 bytes. Simulate: only the
    // LAST 2 bytes survived a `tail -c HOT_TAIL_BYTES` cut landing exactly
    // inside it (its lead byte + first continuation byte belong to the
    // portion of the file that read excludes) — the orphan is therefore the
    // very FIRST thing in the slice, exactly as a real `tail -c` cut would
    // produce it, padded out to genuinely be HOT_TAIL_BYTES long so this
    // fixture represents "the last 8192 bytes of a real file," not a short
    // standalone snippet.
    const emoji = new TextEncoder().encode("\u{1F600}");
    const orphan = emoji.subarray(2); // [0x98, 0x80]
    const rest = new TextEncoder().encode(" the rest of the pane\n");
    const filler = new Uint8Array(HOT_TAIL_BYTES - orphan.length - rest.length).fill(0x2e); // '.'
    const bytes = new Uint8Array(HOT_TAIL_BYTES);
    bytes.set(orphan, 0);
    bytes.set(filler, orphan.length);
    bytes.set(rest, orphan.length + filler.length);
    expect(bytes.length).toBe(HOT_TAIL_BYTES);

    const decoded = decodeTailPreview(bytes);
    expect(decoded).not.toContain("�");
    expect(decoded.startsWith(".")).toBe(true); // orphan trimmed, lands right on the filler
    expect(decoded.endsWith(" the rest of the pane\n")).toBe(true);
  });

  it("wired through a full tick: a tail section whose bytes orphan-split a character produces no U+FFFD in storage", async () => {
    const emoji = new TextEncoder().encode("\u{1F600}");
    const orphanTail = new Uint8Array([...emoji.subarray(2), ...new TextEncoder().encode("ok")]);
    const storage = fakeStorage();
    const deps = fakeDeps({ stat: "5", read: b64([1, 2, 3, 4, 5]), tail: btoa(String.fromCharCode(...orphanTail)) });
    await shipTranscriptTick(deps, storage, STUDIO_ID);
    const preview = await storage.get(TRANSCRIPT_TAIL_KEY);
    expect(preview).not.toContain("�");
    expect(preview).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Fix round (Critical): container-recycle offset staleness. DO storage
// survives a recycle; the container filesystem (and therefore
// TRANSCRIPT_LOG_PATH) does not — see shipTranscriptTick's own doc comment
// for the two-guard design (boot-id identity check + a size-only belt).
//
// Fleet Spawn P3, Task 5: these tests now ALSO pin execCalls[0] against
// shipTickCmd(manifest.offset, storedBootId) directly (the literals actually
// sent), on top of the pre-existing resulting-behavior assertions — proving
// both halves of shipTickCmd's own "shell mirrors JS" equivalence argument:
// the RIGHT parameters went in, and the RIGHT ship behavior came out.
// ---------------------------------------------------------------------------
describe("shipTranscriptTick — container-recycle offset staleness (generation marker)", () => {
  it("a changed boot-id resets offset to 0 and ships from the start of the NEW file, while seq stays monotonic (never reset)", async () => {
    // offset(1000) < size(2000) deliberately — the belt check
    // (`offset > size`) would NOT fire on its own here, so a failure of
    // THIS test isolates the boot-id mechanism specifically, not the belt.
    const storage = fakeStorage({ manifest: { seq: 5, offset: 1000, date: TODAY }, bootId: "old-boot-uuid" });
    const freshBytes = [1, 2, 3, 4, 5];
    const deps = fakeDeps({ stat: "2000", bootId: "new-boot-uuid", read: b64(freshBytes) });

    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);

    expect(deps.execCalls[0]).toBe(shipTickCmd(1000, "old-boot-uuid")); // the literals actually sent
    expect(result.shipped).toBe(5);
    // seq CONTINUES (5 -> 6) rather than resetting to 0: a reused seq could
    // silently overwrite an R2 chunk that still holds pre-recycle content.
    expect(deps.puts[0].key).toBe(chunkKey(STUDIO_ID, TODAY, 6));
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual({ seq: 6, offset: 5, date: TODAY });
    expect(await storage.get(TRANSCRIPT_BOOT_ID_KEY)).toBe("new-boot-uuid"); // the new generation is now recorded
  });

  it("an unchanged boot-id leaves the persisted offset alone — normal continuation is undisturbed", async () => {
    const storage = fakeStorage({ manifest: { seq: 5, offset: 500, date: TODAY }, bootId: "same-boot-uuid" });
    const deps = fakeDeps({ stat: "600", bootId: "same-boot-uuid", read: b64(Array(100).fill(9)) });
    await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(deps.execCalls[0]).toBe(shipTickCmd(500, "same-boot-uuid"));
    expect(storage.putKeys).not.toContain(TRANSCRIPT_BOOT_ID_KEY); // unchanged value -> no rewrite
  });

  it("grow-past-race: a new boot-id where the fresh file has ALREADY grown past the stale offset still ships from 0, not from the stale (numerically-valid-looking) offset", async () => {
    // The trap this specifically guards against: offset(500_000) < size(600_000)
    // looks exactly like ordinary continuation to a size-only check — a
    // boot-id-blind implementation would read from 500_000 and permanently
    // skip everything between byte 0 and 500_000 of the NEW file, since that
    // range belongs to a file that no longer exists (the OLD one).
    const storage = fakeStorage({ manifest: { seq: 2, offset: 500_000, date: TODAY }, bootId: "old-uuid" });
    const deps = fakeDeps({ stat: "600000", bootId: "new-uuid", read: b64([7, 7, 7]) });
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(deps.execCalls[0]).toBe(shipTickCmd(500_000, "old-uuid"));
    expect(result.shipped).toBe(3); // ships the fake's canned bytes, read from the corrected (0) offset
    expect(deps.puts[0].key).toBe(chunkKey(STUDIO_ID, TODAY, 3));
  });

  it("belt: offset > size resets to 0 even with no boot-id change (or none ever recorded) — a path the marker alone would miss", async () => {
    const storage = fakeStorage({ manifest: { seq: 1, offset: 900, date: TODAY } }); // no bootId seeded at all
    const deps = fakeDeps({ stat: "50", read: b64([1, 2]) }); // file is now smaller than the stored offset
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(deps.execCalls[0]).toBe(shipTickCmd(900, undefined));
    expect(result.shipped).toBe(2);
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual({ seq: 2, offset: 2, date: TODAY });
  });

  it("first-ever tick (no stored boot-id) just seeds transcriptBootId — no spurious reset (offset is already 0)", async () => {
    const storage = fakeStorage(); // NEVER_SHIPPED sentinel, no bootId
    const deps = fakeDeps({ stat: "10", bootId: "first-uuid", read: b64(Array(10).fill(1)) });
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(result.shipped).toBe(10);
    expect(await storage.get(TRANSCRIPT_BOOT_ID_KEY)).toBe("first-uuid");
  });

  // -------------------------------------------------------------------------
  // Fix round 2 (Critical residual): the exact two-tick race the reviewer
  // reproduced. A "detection tick" that finds the post-recycle file at 0
  // bytes must persist the offset reset ATOMICALLY with the new boot-id, not
  // only if/when a later tick happens to ship bytes.
  // -------------------------------------------------------------------------
  it("a detection tick that ships 0 bytes still persists the reset ATOMICALLY with the boot-id — the next tick, once the file has grown past the stale offset, ships from 0 with nothing skipped", async () => {
    const storage = fakeStorage({ manifest: { seq: 2, offset: 1_000_000, date: TODAY }, bootId: "old-uuid" });

    // Tick 1: the recycle just happened — pipe-pane already recreated the
    // (still empty) file and bring-up already wrote the new boot-id, but
    // claude hasn't produced a byte yet. A real, expected interleave: pipe-
    // pane opens the file before claude's first output, and this 30s tick is
    // fully decoupled from recycle timing.
    const deps1 = fakeDeps({ stat: "0", bootId: "new-uuid" });
    const r1 = await shipTranscriptTick(deps1, storage, STUDIO_ID);

    expect(r1.shipped).toBe(0); // nothing to ship yet — size===offset===0
    // This is the exact assertion the PRIOR fix round's code would have
    // failed: it persisted only the boot-id, leaving the manifest at its
    // stale 1_000_000 offset until (if ever) a later tick happened to ship
    // bytes in the SAME tick the mismatch was detected.
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual({ seq: 2, offset: 0, date: TODAY });
    expect(await storage.get(TRANSCRIPT_BOOT_ID_KEY)).toBe("new-uuid");

    // Tick 2: the file has since grown to 500 bytes — all of it new content
    // in the POST-recycle file (which never existed at the stale 1_000_000
    // offset). Boot-id is unchanged from tick 1 (same container, no further
    // recycle) — a boot-id-blind (or partially-persisted) implementation
    // would now read "boot-ids match, offset 1_000_000 looks fine" and skip
    // everything.
    const freshBytes = Array.from({ length: 500 }, (_, i) => i % 256);
    const deps2 = fakeDeps({ stat: "500", bootId: "new-uuid", read: b64(freshBytes) });
    const r2 = await shipTranscriptTick(deps2, storage, STUDIO_ID);

    expect(r2.shipped).toBe(500);
    expect(deps2.execCalls[0]).toBe(shipTickCmd(0, "new-uuid")); // NOT shipTickCmd(1_000_000, ...) — nothing was skipped
    expect(deps2.puts[0].bytes).toEqual(new Uint8Array(freshBytes));
  });

  // -------------------------------------------------------------------------
  // Fix round 2 (New breakage): a durably-unreadable boot-id must not be
  // compared against a stored one at all — see bootIdChanged's own doc
  // comment for why doing so would loop forever (stored never updates when
  // fresh stays "", so the mismatch would re-fire every single tick).
  // -------------------------------------------------------------------------
  it("a durably-unreadable boot-id (fresh '' across ticks) does not loop: no reset, no boot-id write, warns each tick, shipping continues at the current offset", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const storage = fakeStorage({ manifest: { seq: 4, offset: 200, date: TODAY }, bootId: "known-uuid" });

      // Tick 1: boot-id file unreadable this tick (e.g. a transient fs
      // hiccup) — NOT a real recycle; the container/file otherwise continues
      // normally. `bootId` omitted from fakeDeps -> "" per its own default.
      const deps1 = fakeDeps({ stat: "300", read: b64(Array(100).fill(1)) });
      const r1 = await shipTranscriptTick(deps1, storage, STUDIO_ID);

      expect(r1.shipped).toBe(100);
      expect(deps1.execCalls[0]).toBe(shipTickCmd(200, "known-uuid")); // continues from the KNOWN offset, not reset to 0
      expect(await storage.get(TRANSCRIPT_BOOT_ID_KEY)).toBe("known-uuid"); // untouched — never overwritten with ""
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain(STUDIO_ID);

      // Tick 2: STILL unreadable. The bug this closes: the prior fix round's
      // code would have read bootIdChanged("known-uuid", "") as true AGAIN
      // (stored was never updated to ""), resetting and re-shipping from 0 —
      // an unbounded duplicate-chunk loop, one more each tick forever.
      const deps2 = fakeDeps({ stat: "400", read: b64(Array(100).fill(2)) });
      const r2 = await shipTranscriptTick(deps2, storage, STUDIO_ID);

      expect(r2.shipped).toBe(100);
      expect(deps2.execCalls[0]).toBe(shipTickCmd(300, "known-uuid")); // continues from tick 1's real advance, not 0 again
      expect(warnSpy).toHaveBeenCalledTimes(2); // once per affected tick, no more
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Fleet Spawn P3, Task 5: consolidated parser matrix — all sections present,
// each missing in turn, and garbage. See transcript.ts's parseShipTickSections
// for the exact missing-section postures this pins.
// ---------------------------------------------------------------------------
describe("shipTranscriptTick — consolidated parser matrix (partial/malformed ship-tick output)", () => {
  it("all sections present, well-formed: ships, stores tail, no throw (baseline)", async () => {
    const deps = fakeDeps({ stat: "5", read: b64([1, 2, 3, 4, 5]), tail: b64([9, 9]) });
    const result = await shipTranscriptTick(deps, fakeStorage(), STUDIO_ID);
    expect(result.shipped).toBe(5);
  });

  it("garbage output (no markers at all, exec exit 0): treated as no-file — not a crash, nothing persisted", async () => {
    const deps = fakeDeps({ rawTickStdout: "not even close to the expected shape\nsome other noise" });
    const storage = fakeStorage();
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(result).toEqual({ shipped: 0, rotated: false, incarnationToken: "", skipped: "no-file" });
    expect(storage.putKeys).toHaveLength(0);
  });

  it("BOOTID section missing (STAT/CHUNK/TAIL present): treated as an unreadable boot-id — warns, ships from the stored offset, no reset", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = [SECTION_STAT, "10", SECTION_CHUNK, b64(Array(10).fill(1)), SECTION_TAIL, b64([1])].join("\n");
      const storage = fakeStorage({ manifest: { seq: 0, offset: 0, date: TODAY }, bootId: "known-uuid" });
      const deps = fakeDeps({ rawTickStdout: raw });
      const result = await shipTranscriptTick(deps, storage, STUDIO_ID);
      expect(result.shipped).toBe(10);
      expect(warnSpy).toHaveBeenCalledTimes(1); // same "unreadable boot-id" posture as a genuinely empty BOOTID line
      expect(await storage.get(TRANSCRIPT_BOOT_ID_KEY)).toBe("known-uuid"); // untouched
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("STAT section missing (BOOTID present): same posture as garbage/negative stat — skipped no-file, nothing persisted", async () => {
    const raw = [SECTION_BOOTID, "some-uuid"].join("\n"); // no STAT, no CHUNK, no TAIL
    const storage = fakeStorage();
    const result = await shipTranscriptTick(fakeDeps({ rawTickStdout: raw }), storage, STUDIO_ID);
    expect(result).toEqual({ shipped: 0, rotated: false, incarnationToken: "", skipped: "no-file" });
    expect(storage.putKeys).toHaveLength(0);
  });

  // Old: "a non-zero read exit throws and leaves the manifest untouched".
  // New equivalent: the read exec no longer exists standalone — its closest
  // analogue is the CHUNK section being absent from an otherwise-successful
  // (exit 0) consolidated exec, which is exactly what a malformed/truncated
  // response would look like. Same throw wording, same "nothing persisted"
  // outcome.
  it("STAT valid (size > offset) but CHUNK section missing: throws 'transcript read failed', nothing persisted", async () => {
    const seeded: TranscriptManifest = { seq: 1, offset: 0, date: TODAY };
    const storage = fakeStorage({ manifest: seeded });
    const raw = [SECTION_BOOTID, "", SECTION_STAT, "10"].join("\n"); // no CHUNK, no TAIL
    const deps = fakeDeps({ rawTickStdout: raw });
    await expect(shipTranscriptTick(deps, storage, STUDIO_ID)).rejects.toThrow("transcript read failed");
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual(seeded); // untouched
  });

  // Old: "a non-zero hot-tail/truncate exit throws even though the ship
  // itself already succeeded" — manifest write from the ship stays, only the
  // tail write is missing. New equivalent, same observable shape: TAIL
  // section absent from an otherwise-valid response — the CHUNK-driven ship
  // already parsed and persisted before the TAIL check runs, so it is not
  // rolled back; only the (never-reached) tail write and rotation are
  // missing.
  it("STAT+CHUNK valid but TAIL section missing: throws 'transcript hot-tail read failed' AFTER the chunk-driven ship already persisted", async () => {
    const storage = fakeStorage();
    const raw = [SECTION_BOOTID, "", SECTION_STAT, "5", SECTION_CHUNK, b64([1, 2, 3, 4, 5])].join("\n"); // no TAIL
    const deps = fakeDeps({ rawTickStdout: raw });
    await expect(shipTranscriptTick(deps, storage, STUDIO_ID)).rejects.toThrow("transcript hot-tail read failed");
    // The ship portion's own manifest write already landed before the
    // missing-TAIL check ran — that write is not rolled back.
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual({ seq: 0, offset: 5, date: TODAY });
    expect(await storage.get(TRANSCRIPT_TAIL_KEY)).toBeUndefined();
  });

  it("a CHUNK line merely CONTAINING marker-shaped letters (no dashes — impossible in real base64, per the alphabet test above) is read as plain content, not mistaken for a boundary", async () => {
    // "FLEET" is spellable in valid base64 (F/L/E/T are all in the alphabet)
    // — this proves the parser's exact-LINE-equality match (never a
    // substring/`.includes` check) does not false-positive on a content line
    // that happens to contain marker-ish letters. Combined with the alphabet
    // test above (real base64 can never contain the "-" that makes a marker
    // a marker), this closes the "collision" question from both directions:
    // no real content can equal a marker, and even letters a marker shares
    // are handled correctly.
    const chunkB64 = "FLEETFLEETFLEETFLEET"; // valid base64 alphabet, decodes to 15 real bytes
    const expectedBytes = Array.from(atob(chunkB64), (c) => c.charCodeAt(0));
    const raw = [SECTION_BOOTID, "", SECTION_STAT, String(expectedBytes.length), SECTION_CHUNK, chunkB64, SECTION_TAIL, ""].join("\n");
    const deps = fakeDeps({ rawTickStdout: raw });
    const result = await shipTranscriptTick(deps, fakeStorage(), STUDIO_ID);
    expect(result.shipped).toBe(expectedBytes.length);
    expect(Array.from(deps.puts[0].bytes)).toEqual(expectedBytes);
  });
});

describe("shipTranscriptTick — failure isolation", () => {
  // Old: "a throwing r2Put leaves the manifest UNCHANGED" — unchanged by the
  // exec-shape rewrite (r2Put failure is orthogonal to exec structure).
  it("a throwing r2Put leaves the manifest UNCHANGED — no partial advance", async () => {
    const seeded: TranscriptManifest = { seq: 2, offset: 500, date: TODAY };
    const storage = fakeStorage({ manifest: seeded });
    const deps = fakeDeps({ stat: "600", read: b64(Array(100).fill(1)), r2Throws: true });

    await expect(shipTranscriptTick(deps, storage, STUDIO_ID)).rejects.toThrow("r2 put failed");

    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual(seeded); // exactly the seeded value, untouched
    expect(storage.putKeys).toHaveLength(0); // storage.put was never reached for this tick at all
  });

  // Old: "a non-zero stat exit throws (distinct from the file-absent -1
  // sentinel, which exits 0)". New: stat is no longer a separable exec — a
  // non-zero exit of the ONE consolidated exec is the direct analogue, and
  // (Fleet Spawn P3, Task 5, documented atomicity tightening) now aborts the
  // WHOLE tick rather than any one sub-step: nothing is parsed or persisted.
  it("a non-zero ship-tick exec exit throws (distinct from the file-absent -1 sentinel, which exits 0) — nothing persisted", async () => {
    const seeded: TranscriptManifest = { seq: 1, offset: 10, date: TODAY };
    const storage = fakeStorage({ manifest: seeded });
    const deps = fakeDeps({ rawTickStdout: "boom", tickCode: 1 });
    await expect(shipTranscriptTick(deps, storage, STUDIO_ID)).rejects.toThrow("transcript ship tick failed");
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual(seeded); // untouched
    expect(storage.putKeys).toHaveLength(0);
  });

  // New (Fleet Spawn P3, Task 5, R-P3-5 truncate-label fix): the rotation
  // exec's own failure message no longer says "hot-tail read failed" — it
  // does no hot-tail read at all in the new split, so its message is now
  // accurate ("transcript rotation failed") for everything that could make
  // IT fail. Mirrors the OLD "ship already succeeded, later step's failure
  // doesn't roll it back" shape, now anchored to the one exec boundary that
  // still genuinely exists (rotation).
  it("a non-zero rotation exec exit throws 'transcript rotation failed' (never 'hot-tail read failed') even though the ship+tail already succeeded", async () => {
    const startOffset = 67_108_800;
    const storage = fakeStorage({ manifest: { seq: 5, offset: startOffset, date: TODAY } });
    const finalBytes = Array.from({ length: 64 }, (_, i) => i);
    const deps = fakeDeps({
      stat: "67108864", read: b64(finalBytes), tail: b64([1, 2, 3]),
      rotateCode: 1, rotateStderr: "permission denied",
    });
    await expect(shipTranscriptTick(deps, storage, STUDIO_ID)).rejects.toThrow("transcript rotation failed");
    await expect(shipTranscriptTick(fakeDeps({
      stat: "67108864", read: b64(finalBytes), tail: b64([1, 2, 3]), rotateCode: 1, rotateStderr: "permission denied",
    }), fakeStorage({ manifest: { seq: 5, offset: startOffset, date: TODAY } }), STUDIO_ID))
      .rejects.not.toThrow("hot-tail read failed");

    // The ship+tail already succeeded and are NOT rolled back — only the
    // rotation-added offset reset is missing, since truncate never ran.
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual({ seq: 6, offset: startOffset + 64, date: TODAY });
    expect(await storage.get(TRANSCRIPT_TAIL_KEY)).toBe(String.fromCharCode(1, 2, 3));
  });
});

// ---------------------------------------------------------------------------
// Fix round (Important): the failure-ordering trace argued informally in
// task-2-report.md's self-review, now pinned as a real test — r2Put success
// followed by a storage.put(manifest) throw must be retry-safe, not a lost
// or duplicated chunk.
// ---------------------------------------------------------------------------
describe("shipTranscriptTick — manifest-write failure is retry-safe (overwrite-idempotent)", () => {
  it("r2Put succeeds but storage.put(manifest) throws: the NEXT tick re-ships the SAME seq to the SAME R2 key with the SAME bytes", async () => {
    const storage = fakeStorage();
    storage.failNextPutFor = TRANSCRIPT_MANIFEST_KEY;
    const bytes = [10, 20, 30, 40, 50];

    const deps1 = fakeDeps({ stat: String(bytes.length), read: b64(bytes) });
    await expect(shipTranscriptTick(deps1, storage, STUDIO_ID)).rejects.toThrow(
      `storage.put(${TRANSCRIPT_MANIFEST_KEY}) failed`,
    );
    expect(deps1.puts).toHaveLength(1); // r2Put DID fire once, successfully, before the throw
    expect(deps1.puts[0].key).toBe(chunkKey(STUDIO_ID, TODAY, 0));
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toBeUndefined(); // never actually persisted

    // Tick 2: the container's file is unchanged from tick 1's point of view
    // (nothing was truly shipped, so nothing was consumed) — storage is no
    // longer configured to fail.
    const deps2 = fakeDeps({ stat: String(bytes.length), read: b64(bytes) });
    const result2 = await shipTranscriptTick(deps2, storage, STUDIO_ID);

    expect(result2.shipped).toBe(bytes.length);
    expect(deps2.puts).toHaveLength(1);
    expect(deps2.puts[0].key).toBe(chunkKey(STUDIO_ID, TODAY, 0)); // SAME key as the failed attempt
    expect(deps2.puts[0].bytes).toEqual(new Uint8Array(bytes)); // SAME bytes — a harmless R2 overwrite, not corruption
    expect(await storage.get(TRANSCRIPT_MANIFEST_KEY)).toEqual({ seq: 0, offset: bytes.length, date: TODAY });
  });
});

// ---------------------------------------------------------------------------
// Issue #85 — the incarnation section: read unconditionally, newline-safe,
// carries the folded-in adoption write.
// ---------------------------------------------------------------------------
describe("shipTickCmd / shipTranscriptTick — incarnation section (issue #85)", () => {
  it("shipTickCmd's command reads the incarnation file unconditionally, before the file-exists guard, via a captured-then-echoed read (maestro correction #2)", () => {
    const cmd = shipTickCmd(0, undefined);
    const incarnationIdx = cmd.indexOf(INCARNATION_PATH);
    const guardIdx = cmd.indexOf(`if [ "$FLEET_SIZE" -ge 0 ]`);
    expect(incarnationIdx).toBeGreaterThan(0);
    expect(incarnationIdx).toBeLessThan(guardIdx);
    // Never a bare `cat FILE || echo ''` glued straight into stdout — always
    // captured into a shell variable first.
    expect(cmd).not.toMatch(new RegExp(`cat ${INCARNATION_PATH}[^)]*\\|\\| echo`));
  });

  it("shipTickCmd, given an adoption token, conditionally writes it only when the file is empty, in the SAME command (maestro correction #6)", () => {
    const cmd = shipTickCmd(0, undefined, "adopt-tok-1234");
    expect(cmd).toContain("adopt-tok-1234");
    expect(cmd).toContain("if [ -z \"$FLEET_INC\" ]");
    expect(cmd).toContain("mv");
  });

  it("shipTranscriptTick returns the container's incarnation token, present case", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [
        SECTION_BOOTID, "", SECTION_STAT, "-1",
        SECTION_INCARNATION, "abc-123e4567-e89b-12d3-a456-426614174000",
      ].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.incarnationToken).toBe("abc-123e4567-e89b-12d3-a456-426614174000");
  });

  it("shipTranscriptTick returns an empty incarnation token when the file is absent", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.incarnationToken).toBe("");
  });

  it("shipTranscriptTick passes the adoption token through to shipTickCmd", async () => {
    const execCalls: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      execCalls.push(cmd);
      return {
        code: 0,
        stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"),
        stderr: "",
      };
    });
    const storage = fakeStorage({});
    await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID, "adopt-xyz");
    expect(execCalls[0]).toBe(shipTickCmd(0, undefined, "adopt-xyz"));
  });

  it("shipTickCmd folds the pane-lead probe into the SAME command only when adopting (maestro correction #7)", () => {
    const steadyState = shipTickCmd(0, undefined);
    const adopting = shipTickCmd(0, undefined, "adopt-tok-1234");
    expect(steadyState).not.toContain(SESSION_FOUND_SECTION);
    expect(adopting).toContain(SESSION_FOUND_SECTION);
  });

  it("shipTranscriptTick parses adoptionProbe from the combined stdout only when adopting", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [
        SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "adopt-tok-1234",
        SESSION_FOUND_SECTION, "yes", SESSION_CONTINUE_SECTION, "yes", SESSION_CWD_SECTION, "/workspace/websites",
      ].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick(
      { exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID, "adopt-tok-1234",
    );
    expect(result.adoptionProbe).toEqual({ ok: true, found: true, hasContinue: true, cwd: "/workspace/websites", leadAgeS: null, error: null });
  });

  it("shipTranscriptTick never sets adoptionProbe on a steady-state tick (no adoptionToken)", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "existing-tok"].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.adoptionProbe).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #221, Task 3 — SECTION_PANE on the ship tick (PR3a's B1 leg: one
// pane frame folded into the EXISTING shipTickCmd exec, no sleep, no second
// exec). See docs/superpowers/specs/2026-09-24-row-tells-truth-design.md.
// ---------------------------------------------------------------------------
describe("shipTickCmd — SECTION_PANE (issue #221)", () => {
  it("emits exactly one capture-pane invocation, no sleep, on both steady-state and adoption ticks", () => {
    for (const cmd of [shipTickCmd(0, undefined), shipTickCmd(0, undefined, "adopt-tok-1234")]) {
      expect(cmd.match(/capture-pane/g)).toHaveLength(1);
      expect(cmd).not.toContain("sleep");
      expect(cmd).toContain(`echo '${SECTION_PANE}'`);
    }
  });

  it("pipes the capture straight to base64, addressed by name, never selecting/attaching", () => {
    const cmd = shipTickCmd(0, undefined);
    expect(cmd).toMatch(/capture-pane -p -t studio:claude[^|]*\| base64/);
  });
});

describe("parsePaneSection (issue #221)", () => {
  it("round-trips a real fixture pane through base64", () => {
    const b64 = b64Utf8(REAL_PILOT_PANE);
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64,
    ].join("\n");
    expect(parsePaneSection(stdout)).toBe(REAL_PILOT_PANE);
  });

  it("returns undefined when SECTION_PANE is absent — a pre-feature container (old image), never a throw", () => {
    const stdout = [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n");
    expect(() => parsePaneSection(stdout)).not.toThrow();
    expect(parsePaneSection(stdout)).toBeUndefined();
  });

  it("returns an empty string when the section is present but empty (tmux gone)", () => {
    const stdout = [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "", SECTION_PANE, ""].join("\n");
    expect(parsePaneSection(stdout)).toBe("");
  });

  it("still parses correctly ahead of the CHUNK/TAIL sections on a file-present tick", () => {
    const b64 = btoa("hello pane");
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "0", SECTION_INCARNATION, "",
      SECTION_PANE, b64, SECTION_CHUNK, "", SECTION_TAIL, "",
    ].join("\n");
    expect(parsePaneSection(stdout)).toBe("hello pane");
  });
});

describe("readShipTickActivity (issue #221)", () => {
  it("absent SECTION_PANE yields undefined, never a throw", () => {
    const stdout = [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n");
    expect(() => readShipTickActivity(stdout)).not.toThrow();
    expect(readShipTickActivity(stdout)).toBeUndefined();
  });

  it("an empty pane section yields unknown, reason 'pane empty'", () => {
    const stdout = [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "", SECTION_PANE, ""].join("\n");
    expect(readShipTickActivity(stdout)).toEqual({ kind: "unknown", reason: "pane empty" });
  });

  it("a torn/malformed pane section (invalid base64) never throws — degrades to the same 'pane empty' verdict", () => {
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "not valid base64!!! ***",
    ].join("\n");
    expect(() => readShipTickActivity(stdout)).not.toThrow();
    expect(readShipTickActivity(stdout)).toEqual({ kind: "unknown", reason: "pane empty" });
  });

  it("a real frame delegates to readActivityFrame", () => {
    const workingPane = REAL_PILOT_PANE.replace("✻ Cogitated for 0s", "✻ Cogitating… (3s · esc to interrupt)");
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(workingPane),
    ].join("\n");
    expect(readShipTickActivity(stdout)).toEqual({ kind: "working" });
  });
});

describe("shipTranscriptTick — pane verdict wiring (issue #221)", () => {
  it("result.paneVerdict reflects the SECTION_PANE content of the SAME exec", async () => {
    const idlePane = ["⏺ Done.", "", "─".repeat(68), "❯ ", "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [
        SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
        SECTION_PANE, b64Utf8(idlePane),
      ].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.paneVerdict).toEqual({ kind: "idle" });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("result.paneVerdict is undefined on an old-image tick with no SECTION_PANE at all", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.paneVerdict).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #221 (PR3b), Task 2 — SECTION_ACTIVITY_HOOK, appended as the very
// LAST section shipTickCmd emits (after the existing if/fi block), so
// parsePaneSection's/parseShipTickSections' own "next known marker, or end
// of stdout" boundary logic needs exactly two surgical fixes rather than a
// rewrite — see this file's own header and the plan doc
// (docs/superpowers/plans/2026-09-25-pr3b-hook-heartbeat.md, Task 2) for why.
// ---------------------------------------------------------------------------
describe("shipTickCmd — SECTION_ACTIVITY_HOOK (issue #221, PR3b)", () => {
  it("emits SECTION_ACTIVITY_HOOK exactly once, no sleep, no second exec, on both steady-state and adoption ticks", () => {
    for (const cmd of [shipTickCmd(0, undefined), shipTickCmd(0, undefined, "adopt-tok-1234")]) {
      expect(cmd.match(new RegExp(SECTION_ACTIVITY_HOOK, "g"))).toHaveLength(1);
      expect(cmd).not.toContain("sleep");
    }
  });

  it("the activity-hook section comes AFTER the file-exists if/fi block, unconditionally", () => {
    const cmd = shipTickCmd(0, undefined);
    const ifIdx = cmd.indexOf('if [ "$FLEET_SIZE" -ge 0 ]');
    const hookIdx = cmd.indexOf(`echo '${SECTION_ACTIVITY_HOOK}'`);
    expect(ifIdx).toBeGreaterThan(-1);
    expect(hookIdx).toBeGreaterThan(ifIdx);
  });
});

describe("parsePaneSection / parseShipTickSections — regression: still correct now that SECTION_ACTIVITY_HOOK follows them (issue #221, PR3b)", () => {
  it("parsePaneSection still ends at SECTION_CHUNK when the file exists, activity-hook trailing after TAIL", () => {
    const b64 = btoa("hello pane");
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "0", SECTION_INCARNATION, "",
      SECTION_PANE, b64, SECTION_CHUNK, "", SECTION_TAIL, "",
      SECTION_ACTIVITY_HOOK, btoa(JSON.stringify({ state: "working", at: "2026-09-25T12:00:00.000Z" })),
    ].join("\n");
    expect(parsePaneSection(stdout)).toBe("hello pane");
  });

  it("parsePaneSection ends at SECTION_ACTIVITY_HOOK when CHUNK/TAIL are absent (no-file tick)", () => {
    const b64 = b64Utf8(REAL_PILOT_PANE);
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64,
      SECTION_ACTIVITY_HOOK, btoa(JSON.stringify({ state: "idle", at: "2026-09-25T12:00:00.000Z" })),
    ].join("\n");
    expect(parsePaneSection(stdout)).toBe(REAL_PILOT_PANE);
  });
});

describe("parseActivityHookSection (issue #221, PR3b)", () => {
  it("round-trips a real heartbeat JSON through base64", () => {
    const raw = JSON.stringify({ state: "working", at: "2026-09-25T12:00:00.000Z" });
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "", SECTION_ACTIVITY_HOOK, btoa(raw),
    ].join("\n");
    expect(parseActivityHookSection(stdout)).toBe(raw);
  });

  it("returns undefined when the marker itself is absent — a pre-feature container, never a throw", () => {
    const stdout = [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n");
    expect(() => parseActivityHookSection(stdout)).not.toThrow();
    expect(parseActivityHookSection(stdout)).toBeUndefined();
  });

  it("returns an empty string when the section is present but empty (no heartbeat file yet)", () => {
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "", SECTION_ACTIVITY_HOOK, "",
    ].join("\n");
    expect(parseActivityHookSection(stdout)).toBe("");
  });
});

describe("readShipTickHookHeartbeat (issue #221, PR3b)", () => {
  it("absent section -> undefined", () => {
    const stdout = [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n");
    expect(readShipTickHookHeartbeat(stdout)).toBeUndefined();
  });

  it("empty section -> null (no evidence this tick, not a throw)", () => {
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "", SECTION_ACTIVITY_HOOK, "",
    ].join("\n");
    expect(readShipTickHookHeartbeat(stdout)).toBeNull();
  });

  it("malformed JSON in the section -> null, never a throw", () => {
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "", SECTION_ACTIVITY_HOOK, btoa("not json"),
    ].join("\n");
    expect(() => readShipTickHookHeartbeat(stdout)).not.toThrow();
    expect(readShipTickHookHeartbeat(stdout)).toBeNull();
  });

  it("a valid heartbeat parses through", () => {
    const raw = JSON.stringify({ state: "idle", at: "2026-09-25T12:00:00.000Z" });
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "", SECTION_ACTIVITY_HOOK, btoa(raw),
    ].join("\n");
    expect(readShipTickHookHeartbeat(stdout)).toEqual({ state: "idle", at: "2026-09-25T12:00:00.000Z" });
  });
});

describe("shipTranscriptTick — hook heartbeat wiring (issue #221, PR3b)", () => {
  it("result.hookHeartbeat reflects the SAME exec's own SECTION_ACTIVITY_HOOK, full-return path", async () => {
    const idlePane = ["⏺ Done.", "", "─".repeat(68), "❯ ", "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
    const raw = JSON.stringify({ state: "working", at: "2026-09-25T12:00:00.500Z" });
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [
        SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
        SECTION_PANE, b64Utf8(idlePane),
        SECTION_ACTIVITY_HOOK, btoa(raw),
      ].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.hookHeartbeat).toEqual({ state: "working", at: "2026-09-25T12:00:00.500Z" });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("result.hookHeartbeat is undefined on an old-image tick with no SECTION_ACTIVITY_HOOK at all", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.hookHeartbeat).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #311 — SECTION_MEMGUARD on the ship tick: the SAME "fold into the
// existing 30s exec, no new exec" B1 leg PR3a already used for SECTION_PANE,
// now reading container/memguard.ts's already-shipped kill log
// (`${MEMGUARD_LOG:-${FLEET_WORKSPACE:-/workspace}/.fleet/memguard.log}` —
// PR #336 round 2, item 3: honours a studio that overrides MEMGUARD_LOG
// directly, not only one that overrides FLEET_WORKSPACE). See docs/
// superpowers/specs/2026-09-24-row-tells-truth-design.md, "PR3 addendum
// (issue #311)".
// ---------------------------------------------------------------------------
describe("shipTickCmd — SECTION_MEMGUARD (issue #311)", () => {
  it("tails the memguard log, base64'd, guarded so a missing file cannot fail the tick", () => {
    for (const cmd of [shipTickCmd(0, undefined), shipTickCmd(0, undefined, "adopt-tok-1234")]) {
      expect(cmd).toContain(`echo '${SECTION_MEMGUARD}'`);
      expect(cmd).toMatch(/tail -n \d+ .*memguard\.log.* 2>\/dev\/null \| base64/);
    }
  });

  // PR #336 round 2, item 3 — round 1 only honoured FLEET_WORKSPACE; a
  // studio that overrides MEMGUARD_LOG directly (container/memguard.ts's own
  // FIRST-priority env var, memguard.ts:537) would have this section
  // silently tail the wrong file. MUTANT: reverting to the FLEET_WORKSPACE-
  // only path turns this red.
  it("honours a MEMGUARD_LOG override, not only FLEET_WORKSPACE", () => {
    const cmd = shipTickCmd(0, undefined);
    expect(cmd).toContain("${MEMGUARD_LOG:-${FLEET_WORKSPACE:-/workspace}/.fleet/memguard.log}");
  });

  it("issues no new exec — the memguard fragment rides the SAME chained command as SECTION_PANE", () => {
    // Reuses cmd-syntax.test.ts's own bash -n coverage indirectly (that file
    // asserts every builder here stays syntactically valid); this test pins
    // that SECTION_MEMGUARD is textually inside the ONE string shipTickCmd
    // returns, never a second command a caller would have to exec separately.
    const cmd = shipTickCmd(0, undefined);
    const paneIdx = cmd.indexOf(`echo '${SECTION_PANE}'`);
    const memguardIdx = cmd.indexOf(`echo '${SECTION_MEMGUARD}'`);
    expect(paneIdx).toBeGreaterThan(-1);
    expect(memguardIdx).toBeGreaterThan(paneIdx);
  });
});

describe("parsePaneSection — unaffected by the new SECTION_MEMGUARD marker (issue #311)", () => {
  it("still ends the pane slice at SECTION_MEMGUARD when present", () => {
    const b64 = b64Utf8(REAL_PILOT_PANE);
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64, SECTION_MEMGUARD, "",
    ].join("\n");
    expect(parsePaneSection(stdout)).toBe(REAL_PILOT_PANE);
  });

  it("still round-trips when SECTION_MEMGUARD is absent (old-shaped stdout, unchanged behavior)", () => {
    const b64 = b64Utf8(REAL_PILOT_PANE);
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64,
    ].join("\n");
    expect(parsePaneSection(stdout)).toBe(REAL_PILOT_PANE);
  });
});

describe("parseMemguardSection (issue #311)", () => {
  it("round-trips a real memguard.ts-shaped kill line through base64", () => {
    const line =
      "2026-09-25T09:12:03.500Z SIGKILL pid=42 comm=vitest rss_mib=612 avail_mib=88 total_mib=11930 source=cgroup cmd=vitest run";
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(""), SECTION_MEMGUARD, b64Utf8(line),
    ].join("\n");
    expect(parseMemguardSection(stdout)).toBe(line);
  });

  it("returns undefined when SECTION_MEMGUARD is absent — a pre-feature Worker build, never a throw", () => {
    const stdout = [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n");
    expect(() => parseMemguardSection(stdout)).not.toThrow();
    expect(parseMemguardSection(stdout)).toBeUndefined();
  });

  it("returns an empty string when the log file does not exist yet — present marker, no bytes", () => {
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(""), SECTION_MEMGUARD, "",
    ].join("\n");
    expect(parseMemguardSection(stdout)).toBe("");
  });

  it("still parses correctly ahead of CHUNK/TAIL on a file-present tick", () => {
    const line = "2026-09-25T09:00:00.000Z SIGTERM pid=1 comm=a rss_mib=1 avail_mib=1 total_mib=1 source=meminfo cmd=a";
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "0", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(""), SECTION_MEMGUARD, b64Utf8(line), SECTION_CHUNK, "", SECTION_TAIL, "",
    ].join("\n");
    expect(parseMemguardSection(stdout)).toBe(line);
  });
});

describe("readShipTickMemguardKills (issue #311) — mutant proof (a): a real kill must always surface", () => {
  it("absent SECTION_MEMGUARD yields undefined, never a throw", () => {
    const stdout = [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n");
    expect(() => readShipTickMemguardKills(stdout)).not.toThrow();
    expect(readShipTickMemguardKills(stdout)).toBeUndefined();
  });

  it("an empty memguard section yields an empty array, not undefined", () => {
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(""), SECTION_MEMGUARD, "",
    ].join("\n");
    expect(readShipTickMemguardKills(stdout)).toEqual([]);
  });

  it("a real kill line in the section parses into a MemguardKillLogEntry", () => {
    const line =
      "2026-09-25T09:12:03.500Z SIGKILL pid=42 comm=vitest rss_mib=612 avail_mib=88 total_mib=11930 source=cgroup cmd=vitest run";
    const stdout = [
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(""), SECTION_MEMGUARD, b64Utf8(line),
    ].join("\n");
    const kills = readShipTickMemguardKills(stdout);
    expect(kills).toHaveLength(1);
    expect(kills?.[0]).toMatchObject({ signal: "SIGKILL", pid: 42, comm: "vitest" });
  });
});

describe("shipTranscriptTick — memguard kill wiring (issue #311)", () => {
  it("result.memguardKills reflects the SECTION_MEMGUARD content of the SAME exec", async () => {
    const line =
      "2026-09-25T09:12:03.500Z SIGKILL pid=42 comm=vitest rss_mib=612 avail_mib=88 total_mib=11930 source=cgroup cmd=vitest run";
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [
        SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
        SECTION_PANE, b64Utf8(""), SECTION_MEMGUARD, b64Utf8(line),
      ].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.memguardKills).toHaveLength(1);
    expect(result.memguardKills?.[0]).toMatchObject({ signal: "SIGKILL", pid: 42 });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("result.memguardKills is undefined on an old-Worker-shaped stdout with no SECTION_MEMGUARD at all", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.memguardKills).toBeUndefined();
  });
});
