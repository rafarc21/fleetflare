// Session snapshot reader — the gzip->tar->jsonl byte-stream half of the
// studio session stats feature, split out of burn.ts (issue #449, sweep 6
// finding F3: two knowledge areas under one roof). Everything here reads a
// gzip'd session tar in bounded memory and derives per-file counters/stats;
// the usage-accounting half (cursors, offset rule, burnIncrement) still
// lives in ./burn.ts. This file imports NOTHING from ./burn.ts — the
// dependency arrow points one way (burn.ts imports the walker from here),
// pinned by test/bun/session-stats-cycle.test.ts. Pure computation only,
// no storage/exec/telegram I/O; import-safe under vitest-pool-workers,
// same as burn.ts.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Minimal ustar (POSIX/GNU tar) reader — *.jsonl members only, no dependency
// ---------------------------------------------------------------------------

const TAR_BLOCK = 512;

function readCString(bytes: Uint8Array, start: number, len: number): string {
  const stop = Math.min(start + len, bytes.length);
  let end = start;
  while (end < stop && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(start, end));
}

function readOctalField(bytes: Uint8Array, start: number, len: number): number {
  const raw = readCString(bytes, start, len).trim();
  if (raw === "") return 0;
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parses raw (already-decompressed) tar bytes, returning every REGULAR FILE
 * member whose name ends in ".jsonl", decoded to text and keyed by its full
 * in-archive path — everything else (directories, `.claude.json`, any other
 * member) is skipped without its content ever being decoded to text at all.
 * The parser never stores or inspects message CONTENT beyond deciding "is
 * this a `.jsonl` member" from its NAME — counters, never content, is this
 * whole feature's own constraint (design Plane 4: "parse in-memory, never
 * store parsed PII beyond counters").
 *
 * Handles GNU tar's longname extension (typeflag 'L', the
 * "././@LongLink"-named header GNU tar emits for any member name over the
 * ustar format's 100-byte `name` field): this is not a hypothetical edge
 * case for this feature — real claude session paths
 * (`.claude/projects/<escaped-cwd>/<session-uuid>.jsonl`) routinely exceed
 * 100 bytes, and the studio container's base image
 * (docker.io/cloudflare/sandbox, a Debian-family image) ships GNU tar, whose
 * DEFAULT archive format uses this extension (not POSIX prefix/name
 * splitting) for any such name. An 'L' header's own `size` gives the real
 * name's length; its CONTENT block (not its 100-byte `name` field, which
 * GNU tar itself only ever fills with the "././@LongLink" sentinel) is where
 * the real name lives. Neither PAX extended headers nor any other GNU
 * extension type is handled — genuinely out of scope for "minimal," and this
 * reader stays tolerant of them regardless (an unrecognized typeflag is
 * simply skipped, its content bytes correctly stepped over via the header's
 * own size field, never crashing the parse).
 *
 * Stops at the first all-zero 512-byte block (the standard tar
 * end-of-archive marker). Never trusts a member's declared `size` to reach
 * further than the bytes actually given (`contentEnd` clamps to
 * `tarBytes.length`) — a truncated/corrupt archive is read as far as it
 * goes, not walked off the end of the buffer.
 */
export function readJsonlMembersFromTar(tarBytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + TAR_BLOCK <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker

    const size = readOctalField(header, 124, 12);
    const typeflag = header[156];
    offset += TAR_BLOCK;
    const contentStart = offset;
    const contentEnd = Math.min(contentStart + size, tarBytes.length);
    const paddedSize = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (typeflag === 0x4c /* 'L' */) {
      pendingLongName = readCString(tarBytes, contentStart, size);
    } else {
      const rawName = readCString(header, 0, 100);
      const prefix = readCString(header, 345, 155);
      const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
      pendingLongName = null;

      const isRegularFile = typeflag === 0x30 /* '0' */ || typeflag === 0 /* '\0' */;
      if (isRegularFile && name.endsWith(".jsonl")) {
        out.set(name, decoder.decode(tarBytes.subarray(contentStart, contentEnd)));
      }
    }

    offset += paddedSize;
  }

  return out;
}

/** gzip -> tar -> jsonl members. The bytes session-sync.ts's `syncSessionTick`
 *  already holds in memory post-ship (`bytes`) are GZIP-compressed (its own
 *  `tarAndStatCmd` runs `tar -czf`), not raw tar — `DecompressionStream` is a
 *  standard Workers-runtime Web API (same category of "runtime-native, not
 *  an added dependency" as this feature's own `atob`/`crypto.subtle.digest`
 *  elsewhere), used here exactly once to unwrap that compression before
 *  handing raw bytes to `readJsonlMembersFromTar`. */
/**
 * Board #140: genuine gzip/tar corruption — bad magic, a stream the
 * decompressor rejects, or a tar that ends before its end-of-archive block.
 * pickRestoreSource falls back to a daily keeper ONLY on this; any other
 * error (transient, unexpected) propagates and aborts the restore.
 */
export class SessionArchiveFormatError extends Error {}

/** A decompressor rejection (workerd throws TypeError "Decompression
 *  failed.") becomes a SessionArchiveFormatError; anything else is rethrown
 *  unrelabelled (#140 review item 5). */
async function asFormatError<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof TypeError) throw new SessionArchiveFormatError(`burn: gzip decompression failed: ${err.message}`);
    throw err;
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await asFormatError(new Response(inflateSliced(bytes)).arrayBuffer()));
}

/** Whole-text extraction: tests' reference for burnIncrement. Production never
 *  calls it — it holds the raw tar and every member's text (issue #176). */
export async function extractJsonlMembers(gzipTarBytes: Uint8Array): Promise<Map<string, string>> {
  const tarBytes = await gunzip(gzipTarBytes);
  return readJsonlMembersFromTar(tarBytes);
}

// ---------------------------------------------------------------------------
// Issue #176: gunzip FED in slices, tar WALKED as it inflates
// ---------------------------------------------------------------------------
// MEASURED (V8 live set, gc'd heapUsed + external, 16 real R2 snapshots):
// restore held gz + raw, the sync tick ~4.1 x raw — 128 MiB at
// acme-os--maestro's 9.1 MiB gz — once workerd's own behaviour is counted:
// it inflates a WHOLE written chunk at once, off-heap (#118/#140), and every
// gunzip here used to write the entire snapshot as one chunk. An OOM resets
// the isolate, no catch runs, and every retry reads the same bytes.

/** Largest chunk ever written into a DecompressionStream. */
export const GUNZIP_SLICE = 65_536;

/** The one reused view walkGzipTar reads the inflated tar into. */
const INFLATE_READ_VIEW = 1_048_576;

/** Test seam: told how many inflated bytes the reader had consumed at the
 *  moment the gz source was fully fed (#176 review). Production never sets it. */
export const INFLATE_PROBE: { onSourceDone?: (consumed: number) => void } = {};

/**
 * The decompressed bytes of `gz`, fed GUNZIP_SLICE at a time and only as the
 * pipe pulls (highWaterMark 0).
 *
 * Slicing alone does NOT bound memory in workerd (#176 review, measured on
 * workerd 1.20260730.1): its DecompressionStream has no backpressure, so the
 * pipe writes the next slice as soon as the last write settles, and each
 * inflated slice waits in its internal buffer until read. A default reader
 * drains ~4 KiB a turn — acme-os--maestro's source was fully fed when the
 * reader had taken 0.6 of 31.5 MiB. What bounds it is the READER keeping
 * pace: walkGzipTar reads BYOB into a 1 MiB view (31.5/31.5 when fed).
 */
function inflateSliced(gz: Uint8Array, onFed?: () => void): ReadableStream<Uint8Array> {
  // Cheap magic-byte check (RFC 1952) before touching DecompressionStream: a
  // clear error for "not gzip", and no workerd "incomplete data" log noise.
  if (gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) {
    throw new SessionArchiveFormatError("burn: not a gzip stream (bad magic header)");
  }
  // @cloudflare/workers-types types .writable as WritableStream<ArrayBuffer |
  // ArrayBufferView>, which pipeThrough's invariant generic refuses for
  // Uint8Array although it is accepted at runtime; a structural cast closes it.
  const ds = new DecompressionStream("gzip") as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  let off = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (off >= gz.length) {
          controller.close();
          return;
        }
        controller.enqueue(gz.subarray(off, off + GUNZIP_SLICE));
        off += GUNZIP_SLICE;
        // Fully fed: the last slice is in. The walker may cancel at the tar's
        // end block before the close above is ever reached.
        if (off >= gz.length) onFed?.();
      },
    },
    { highWaterMark: 0 },
  ).pipeThrough(ds);
}

/** What walkGzipTar hands a member's content to; `end` once it is complete. */
export type MemberSink = { data(slice: Uint8Array): void; end(): void };

/** GNU longnames longer than this are not session paths; kept truncated. */
const LONGNAME_CAP = 65_536;

/**
 * One streaming pass over a gzip'd tar: `onMember(name, header)` for every
 * member (same naming rules as readJsonlMembersFromTar: GNU 'L' longnames,
 * ustar prefix), whose sink, if any, receives the content in order. Never
 * holds more than a slice of the tar; stops at the end-of-archive block.
 */
export async function walkGzipTar(gz: Uint8Array, onMember: (name: string, header: Uint8Array) => MemberSink | null): Promise<void> {
  let consumed = 0;
  const inflated = inflateSliced(gz, () => INFLATE_PROBE.onSourceDone?.(consumed));
  // BYOB into ONE reused view (see inflateSliced): no sink keeps a slice of
  // it — each copies what it needs (concat, TextDecoder, the header and
  // longname buffers). The default reader only where BYOB is unsupported
  // (bun's DecompressionStream); workerd's supports it.
  // Structural: workers-types and the DOM/node lib disagree on the reader
  // classes; these two methods are all the walk uses.
  type Result = { done: boolean; value?: Uint8Array };
  type ByobReader = { read(view: Uint8Array): Promise<Result>; cancel(): Promise<void> };
  type PlainReader = { read(): Promise<Result>; cancel(): Promise<void> };
  let byob = null as ByobReader | null;
  let plain = null as PlainReader | null;
  try {
    byob = inflated.getReader({ mode: "byob" }) as unknown as ByobReader;
  } catch {
    plain = inflated.getReader() as unknown as PlainReader;
  }
  let buffer: ArrayBuffer = new ArrayBuffer(INFLATE_READ_VIEW);
  const read = async (): Promise<Uint8Array | null> => {
    if (plain) {
      const { done, value } = await asFormatError(plain.read());
      return done || !value ? null : value;
    }
    // The view is built outside the conversion: only the read itself is the
    // decompressor's to reject.
    const view = new Uint8Array(buffer);
    const { done, value } = await asFormatError(byob!.read(view));
    if (done || !value) return null;
    buffer = value.buffer as ArrayBuffer;
    return value;
  };
  const cancel = () => (plain ?? byob!).cancel().catch(() => {});
  const head = new Uint8Array(TAR_BLOCK);
  let headLen = 0;
  let remaining = 0;
  let padding = 0;
  let sink: MemberSink | null = null;
  let longName: Uint8Array | null = null;
  let longLen = 0;
  let pendingLongName: string | null = null;
  let ended = false;

  const finish = () => {
    if (longName) {
      pendingLongName = readCString(longName, 0, longLen);
      longName = null;
    }
    sink?.end();
    sink = null;
  };

  while (!ended) {
    const value = await read();
    if (!value) break;
    consumed += value.length;
    let off = 0;
    while (off < value.length && !ended) {
      if (remaining > 0) {
        const take = Math.min(remaining, value.length - off);
        const slice = value.subarray(off, off + take);
        if (longName) {
          const room = Math.min(take, LONGNAME_CAP - longLen);
          if (room > 0) longName.set(slice.subarray(0, room), longLen);
          longLen += Math.max(room, 0);
        } else sink?.data(slice);
        off += take;
        remaining -= take;
        if (remaining === 0) finish();
        continue;
      }
      if (padding > 0) {
        const skip = Math.min(padding, value.length - off);
        off += skip;
        padding -= skip;
        continue;
      }
      const take = Math.min(TAR_BLOCK - headLen, value.length - off);
      head.set(value.subarray(off, off + take), headLen);
      headLen += take;
      off += take;
      if (headLen < TAR_BLOCK) continue;
      headLen = 0;
      if (head.every((b) => b === 0)) {
        ended = true;
        break;
      }
      const size = readOctalField(head, 124, 12);
      const typeflag = head[156];
      remaining = size;
      padding = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK - size;
      if (typeflag === 0x4c /* 'L' */) {
        longName = new Uint8Array(Math.min(size, LONGNAME_CAP));
        longLen = 0;
      } else {
        const rawName = readCString(head, 0, 100);
        const prefix = readCString(head, 345, 155);
        const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
        pendingLongName = null;
        sink = onMember(name, head);
      }
      if (size === 0) finish();
    }
  }
  if (ended) {
    await cancel();
    return;
  }
  // The gzip stream ran out before the tar's own end-of-archive block: a
  // truncated archive, not a short one (#140 review item 4).
  throw new SessionArchiveFormatError("burn: gzip stream ended before tar end-of-archive block (truncated)");
}

export function isJsonlFile(name: string, header: Uint8Array): boolean {
  const typeflag = header[156];
  return (typeflag === 0x30 /* '0' */ || typeflag === 0) && name.endsWith(".jsonl");
}

// ---------------------------------------------------------------------------
// Issue #94: session richness — the sync guard's and restore fallback's view
// of a snapshot, computed in one streaming pass (walkGzipTar), never the raw
// tar in memory.
// ---------------------------------------------------------------------------

/** One jsonl member: complete lines, tar mtime (seconds), and the top-level
 *  `timestamp` of its last complete line (null if that line was over
 *  STATS_LINE_CAP or carried none). Counters only, never content. */
export type SessionFileStat = { lines: number; mtime: number; lastTs: string | null };
export type SessionStats = Record<string, SessionFileStat>;
/** The one file the guard compares against: the snapshot's newest session. */
export type SessionMark = { file: string; lines: number; lastTs: string | null };

/** A last line longer than this is counted but not parsed for its timestamp. */
const STATS_LINE_CAP = 1_048_576;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function lastTimestamp(line: Uint8Array | null): string | null {
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(line));
    return isPlainObject(parsed) && typeof parsed.timestamp === "string" ? parsed.timestamp : null;
  } catch {
    return null;
  }
}

/**
 * Per-jsonl-member stats of a gzip'd tar, in one streaming pass. Same member
 * rules as readJsonlMembersFromTar (regular files ending `.jsonl`, GNU
 * longname honoured); a trailing line with no newline is not counted,
 * matching parseUsageIncrement's "complete lines only". Throws on a non-gzip
 * input (bad magic).
 */
export async function sessionStats(gzipTarBytes: Uint8Array): Promise<SessionStats> {
  const out: SessionStats = {};
  await walkGzipTar(gzipTarBytes, (name, header) => {
    if (!isJsonlFile(name, header)) return null;
    const stat: SessionFileStat = { lines: 0, mtime: readOctalField(header, 136, 12), lastTs: null };
    let line: Uint8Array = new Uint8Array(0);
    let over = false;
    let last: Uint8Array | null = null;
    return {
      data(slice) {
        let start = 0;
        for (;;) {
          const nl = slice.indexOf(0x0a, start);
          const seg = slice.subarray(start, nl === -1 ? slice.length : nl);
          if (!over) {
            if (line.length + seg.length > STATS_LINE_CAP) {
              over = true;
              line = new Uint8Array(0);
            } else if (seg.length > 0) {
              line = concat(line, seg);
            }
          }
          if (nl === -1) return;
          stat.lines++;
          if (!over) last = line;
          line = new Uint8Array(0);
          over = false;
          start = nl + 1;
        }
      },
      end() {
        stat.lastTs = lastTimestamp(last);
        out[name] = stat;
      },
    };
  });
  return out;
}

/** Issue #94 review: Claude's own transcript cleanup (`cleanupPeriodDays`,
 *  default 30) may delete the baseline file; past this age its absence is
 *  cleanup, not a blank session. */
export const SESSION_CLEANUP_MS = 30 * 86_400_000;

/** A file's time for ordering: its last entry's timestamp, else its tar
 *  mtime (newer Claude builds end live files with timestamp-less lines, and
 *  a restored or copied file keeps or gets a real mtime). */
function effectiveTs(s: SessionFileStat): string {
  return s.lastTs ?? new Date(s.mtime * 1000).toISOString();
}

/**
 * The snapshot's newest MAIN session file (a `subagents/` transcript only
 * when no main file exists): latest effective time, then tar mtime, then
 * name — deterministic. `lastTs` on the mark is that effective time.
 * `null` when the snapshot holds no session file at all.
 */
export function newestMark(stats: SessionStats): SessionMark | null {
  const all = Object.entries(stats);
  const main = all.filter(([name]) => !name.includes("/subagents/"));
  let best: [string, SessionFileStat] | null = null;
  for (const entry of main.length > 0 ? main : all) {
    if (!best) {
      best = entry;
      continue;
    }
    const [name, s] = entry;
    const [bName, b] = best;
    const ts = effectiveTs(s);
    const bTs = effectiveTs(b);
    if (ts > bTs || (ts === bTs && (s.mtime > b.mtime || (s.mtime === b.mtime && name > bName)))) best = entry;
  }
  return best ? { file: best[0], lines: best[1].lines, lastTs: effectiveTs(best[1]) } : null;
}

/** A session file's id: its basename (`<session-uuid>.jsonl`). */
function sessionIdOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Issue #94 (maestro addendum): the stat for `file`'s SESSION, found by id
 * rather than path — Claude moves a transcript to a new project key when a
 * lead enters a worktree (same id, new folder), and #120 copies one back.
 * A `subagents/` file never stands in for a main one. Several matches (a
 * copy beside its original) → the one with the most lines.
 */
function sameSession(stats: SessionStats, file: string): SessionFileStat | undefined {
  const id = sessionIdOf(file);
  const sub = file.includes("/subagents/");
  let best: SessionFileStat | undefined;
  for (const [name, s] of Object.entries(stats)) {
    if (sessionIdOf(name) !== id || name.includes("/subagents/") !== sub) continue;
    if (!best || s.lines > best.lines) best = s;
  }
  return best;
}

/**
 * Why `stats` is poorer than the snapshot `mark` was taken from, or null if
 * it is not. Only the mark's own session (by id, see sameSession) is
 * compared: a new session alongside it never counts as poorer, and neither
 * does its absence once the mark is older than SESSION_CLEANUP_MS at `now`
 * (Claude's cleanup removed it). A snapshot with no session file at all is
 * always poorer.
 */
export function poorerThan(stats: SessionStats, mark: SessionMark, now?: Date): string | null {
  if (Object.keys(stats).length === 0) return `no session files (baseline ${mark.file})`;
  const s = sameSession(stats, mark.file);
  if (!s) {
    const age = now && mark.lastTs ? now.getTime() - Date.parse(mark.lastTs) : Number.NaN;
    if (age > SESSION_CLEANUP_MS) return null;
    return `missing newest session file ${mark.file}`;
  }
  if (s.lines < mark.lines) return `newest session file ${mark.file} has fewer lines (${s.lines} < ${mark.lines})`;
  return null;
}
