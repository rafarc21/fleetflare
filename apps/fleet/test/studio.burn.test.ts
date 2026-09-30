import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  parseUsageIncrement, burnIncrement, rollWindow, shouldAlert, freshBurn,
  readJsonlMembersFromTar, extractJsonlMembers, sessionStats, SessionArchiveFormatError,
  pruneCursor, pruneCursorForSize, CURSOR_PRUNE_MS, CURSOR_PERSIST_SOFT_CAP_BYTES, CURSOR_PERSIST_TARGET_BYTES,
  pathMapKey, __setPathMapKeyForTest,
  type BurnCursor, type Burn,
} from "../src/studio/burn";
import { BURN_WINDOW_MS } from "../src/studio/archive";
import {
  syncSessionTick, BURN_CURSOR_KEY, BURN_KEY, BURN_ALERTED_WINDOW_KEY, SESSION_DAILY_DATE_KEY,
  SESSION_MARK_KEY, SESSION_BURN_WATERMARK_KEY, SESSION_FORCE_KEY, SESSION_GUARD_KEY,
  BURN_PERSIST_ERROR_KEY,
  type SessionSyncDeps, type SessionSyncStorage,
} from "../src/studio/session-sync";
import { mirrorBurnToRegistry } from "../src/studio/do";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import { recordStudio } from "../src/studio/registry";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

// P2 plane 4 (token monitor) — docs/superpowers/specs/2026-08-16-studio-memory-p2-design.md,
// ruling R-P2-4. Fixture jsonl shape below is SYNTHESIZED, not copied: derived
// by inspecting (jq, structure only — never printing message content) a real
// session file under ~/.claude/projects for its field names, per the task's
// own instruction. Observed real shape (claude-fable-5, this machine, this
// session's own jsonl):
//   {"type":"assistant","message":{"role":"assistant","model":"...",
//    "content":[...],"usage":{"input_tokens":N,"output_tokens":N,
//    "cache_creation_input_tokens":N,"cache_read_input_tokens":N,...}},
//    "timestamp":"...","uuid":"...", ...many other top-level fields}
//   {"type":"user","message":{"role":"user","content":[...]}, ...}
// Real files also carry types with no usage at all: "summary", "system",
// "ai-title", "attachment", "file-history-delta", "file-history-snapshot",
// "frame-link", "last-prompt", "mode", "permission-mode", "pr-link",
// "queue-operation" — none of these carry `.message.usage`. No `cost`/
// `costUSD` field was found anywhere in the real file (R-P2-4's own text
// calls out "usage/cost fields" as its assumption; observed reality is
// usage-only) — parseUsageIncrement below still tolerates an optional
// `usage.cost_usd`/`usage.costUSD` if a future claude version adds one, but
// real fixtures here never populate it, matching observed reality.

// ---------------------------------------------------------------------------
// Fixture jsonl line builders — synthetic content only, shaped like the real
// fields above, never real conversation text.
// ---------------------------------------------------------------------------

function assistantLine(usage: { input_tokens?: number; output_tokens?: number; cost_usd?: number } | null, text = "synthetic reply"): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    model: "claude-fable-5",
    content: [{ type: "text", text }],
  };
  if (usage) message.usage = usage;
  return JSON.stringify({ type: "assistant", message, timestamp: "2026-08-16T00:00:00.000Z" });
}

function userLine(text = "synthetic prompt"): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

function summaryLine(): string {
  return JSON.stringify({ type: "summary", summary: "synthetic summary", leafUuid: "00000000-0000-0000-0000-000000000000" });
}

// ---------------------------------------------------------------------------
// parseUsageIncrement — usage present / absent / garbage / giant line
// ---------------------------------------------------------------------------

describe("parseUsageIncrement — tolerant parsing", () => {
  it("usage present: sums input/output tokens, counts one turn", () => {
    const file = "session-a.jsonl";
    const jsonlByFile = new Map([[file, `${assistantLine({ input_tokens: 120, output_tokens: 40 })}\n`]]);
    const { delta, parseSkips, cursor } = parseUsageIncrement({ fileOffsets: {} }, jsonlByFile);
    expect(delta).toEqual({ turns: 1, inputTokens: 120, outputTokens: 40, costUsd: 0 });
    expect(parseSkips).toBe(0);
    expect(cursor.fileOffsets[pathMapKey(file)]).toBeGreaterThan(0);
  });

  it("optional cost field, when present, is summed too (forward-compatible; real fixtures never populate it)", () => {
    const file = "session-cost.jsonl";
    const jsonlByFile = new Map([[file, `${assistantLine({ input_tokens: 1, output_tokens: 1, cost_usd: 0.0123 })}\n`]]);
    const { delta } = parseUsageIncrement({ fileOffsets: {} }, jsonlByFile);
    expect(delta.costUsd).toBeCloseTo(0.0123);
  });

  it("assistant line WITHOUT a usage key at all: counts the turn, contributes zero tokens — not a parseSkip", () => {
    const file = "session-b.jsonl";
    const jsonlByFile = new Map([[file, `${assistantLine(null)}\n`]]);
    const { delta, parseSkips } = parseUsageIncrement({ fileOffsets: {} }, jsonlByFile);
    expect(delta).toEqual({ turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(parseSkips).toBe(0);
  });

  it("usage object present but missing individual fields: each missing field is zero, not a skip", () => {
    const file = "session-c.jsonl";
    const jsonlByFile = new Map([[file, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 7 } } })}\n`]]);
    const { delta, parseSkips } = parseUsageIncrement({ fileOffsets: {} }, jsonlByFile);
    expect(delta).toEqual({ turns: 1, inputTokens: 7, outputTokens: 0, costUsd: 0 });
    expect(parseSkips).toBe(0);
  });

  it("non-assistant lines (user, summary, and every other real event type) contribute zero and are never counted as turns or skips", () => {
    const file = "session-d.jsonl";
    const otherTypes = ["system", "ai-title", "attachment", "file-history-delta", "mode", "permission-mode"].map((t) =>
      JSON.stringify({ type: t }),
    );
    const lines = [userLine(), summaryLine(), ...otherTypes].join("\n") + "\n";
    const jsonlByFile = new Map([[file, lines]]);
    const { delta, parseSkips } = parseUsageIncrement({ fileOffsets: {} }, jsonlByFile);
    expect(delta).toEqual({ turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(parseSkips).toBe(0);
  });

  it("garbage (invalid JSON) line: skipped and counted, does not poison the other valid lines in the same file", () => {
    const file = "session-e.jsonl";
    const lines = [
      assistantLine({ input_tokens: 10, output_tokens: 5 }),
      "not-json-at-all {{{ broken ]][",
      assistantLine({ input_tokens: 1, output_tokens: 1 }),
    ].join("\n") + "\n";
    const jsonlByFile = new Map([[file, lines]]);
    const { delta, parseSkips } = parseUsageIncrement({ fileOffsets: {} }, jsonlByFile);
    expect(delta).toEqual({ turns: 2, inputTokens: 11, outputTokens: 6, costUsd: 0 });
    expect(parseSkips).toBe(1);
  });

  it("valid JSON that isn't an object (a bare number/array/string line) is also an unknown-shape skip", () => {
    const file = "session-f.jsonl";
    const lines = ["42", '"just a string"', "[1,2,3]", assistantLine({ input_tokens: 3, output_tokens: 2 })].join("\n") + "\n";
    const jsonlByFile = new Map([[file, lines]]);
    const { delta, parseSkips } = parseUsageIncrement({ fileOffsets: {} }, jsonlByFile);
    expect(delta).toEqual({ turns: 1, inputTokens: 3, outputTokens: 2, costUsd: 0 });
    expect(parseSkips).toBe(3);
  });

  it("blank lines are ignored (no skip, no crash) — trailing-newline artifacts are ordinary", () => {
    const file = "session-g.jsonl";
    const jsonlByFile = new Map([[file, `${assistantLine({ input_tokens: 1, output_tokens: 1 })}\n\n\n`]]);
    const { delta, parseSkips } = parseUsageIncrement({ fileOffsets: {} }, jsonlByFile);
    expect(delta).toEqual({ turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 });
    expect(parseSkips).toBe(0);
  });

  it("giant line: a huge assistant content string still parses correctly and counts exactly once", () => {
    const file = "session-h.jsonl";
    const hugeText = "x".repeat(500_000);
    const line = assistantLine({ input_tokens: 999, output_tokens: 111 }, hugeText);
    expect(line.length).toBeGreaterThan(500_000);
    const jsonlByFile = new Map([[file, `${line}\n`]]);
    const { delta, parseSkips } = parseUsageIncrement({ fileOffsets: {} }, jsonlByFile);
    expect(delta).toEqual({ turns: 1, inputTokens: 999, outputTokens: 111, costUsd: 0 });
    expect(parseSkips).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Incremental cursor — the core "re-parse never double-counts" contract.
  // -------------------------------------------------------------------------

  it("incremental: a second parse over the SAME unchanged content yields an all-zero delta", () => {
    const file = "session-i.jsonl";
    const content = `${assistantLine({ input_tokens: 10, output_tokens: 5 })}\n`;
    const r1 = parseUsageIncrement({ fileOffsets: {} }, new Map([[file, content]]));
    expect(r1.delta).toEqual({ turns: 1, inputTokens: 10, outputTokens: 5, costUsd: 0 });

    const r2 = parseUsageIncrement(r1.cursor, new Map([[file, content]]));
    expect(r2.delta).toEqual({ turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(r2.parseSkips).toBe(0);
  });

  it("incremental: a file that grew since the last parse only counts the NEW lines, never the old ones again", () => {
    const file = "session-j.jsonl";
    const line1 = assistantLine({ input_tokens: 10, output_tokens: 5 });
    const line2 = assistantLine({ input_tokens: 20, output_tokens: 8 });
    const tick1Content = `${line1}\n`;
    const r1 = parseUsageIncrement({ fileOffsets: {} }, new Map([[file, tick1Content]]));
    expect(r1.delta).toEqual({ turns: 1, inputTokens: 10, outputTokens: 5, costUsd: 0 });

    // Whole-directory re-tar (session-sync.ts's own design: every tick ships
    // the FULL file, not an append) — tick 2's content is tick 1's content
    // plus a newly appended, now-complete line.
    const tick2Content = `${line1}\n${line2}\n`;
    const r2 = parseUsageIncrement(r1.cursor, new Map([[file, tick2Content]]));
    expect(r2.delta).toEqual({ turns: 1, inputTokens: 20, outputTokens: 8, costUsd: 0 });
    expect(r2.parseSkips).toBe(0);

    // Combined across both ticks: exactly line1 + line2, never line1 twice.
    const totalInput = r1.delta.inputTokens + r2.delta.inputTokens;
    const totalOutput = r1.delta.outputTokens + r2.delta.outputTokens;
    expect(totalInput).toBe(30);
    expect(totalOutput).toBe(13);
  });

  it("incremental: a trailing line with no newline yet (in-flight write / torn snapshot, R-P2-3) is left uncounted until a later parse completes it", () => {
    const file = "session-k.jsonl";
    const line1 = assistantLine({ input_tokens: 10, output_tokens: 5 });
    const line2 = assistantLine({ input_tokens: 20, output_tokens: 8 });
    // tick1: line2 is present but NOT terminated by a newline — a snapshot
    // taken mid-write of the second line.
    const tornPrefix = line2.slice(0, line2.length - 15);
    const tick1Content = `${line1}\n${tornPrefix}`;
    const r1 = parseUsageIncrement({ fileOffsets: {} }, new Map([[file, tick1Content]]));
    expect(r1.delta).toEqual({ turns: 1, inputTokens: 10, outputTokens: 5, costUsd: 0 });
    expect(r1.parseSkips).toBe(0); // the torn tail is not even attempted, not a skip

    // tick2: the SAME torn prefix, now completed with a trailing newline —
    // tick1's content is a strict prefix of tick2's, matching how a growing
    // append-only file actually behaves.
    const tick2Content = `${line1}\n${line2}\n`;
    const r2 = parseUsageIncrement(r1.cursor, new Map([[file, tick2Content]]));
    expect(r2.delta).toEqual({ turns: 1, inputTokens: 20, outputTokens: 8, costUsd: 0 });
  });

  it("incremental: two independent files each keep their own offset", () => {
    const fileA = "a.jsonl";
    const fileB = "b.jsonl";
    const lineA1 = assistantLine({ input_tokens: 1, output_tokens: 1 });
    const lineB1 = assistantLine({ input_tokens: 2, output_tokens: 2 });
    const r1 = parseUsageIncrement({ fileOffsets: {} }, new Map([
      [fileA, `${lineA1}\n`],
      [fileB, `${lineB1}\n`],
    ]));
    expect(r1.delta).toEqual({ turns: 2, inputTokens: 3, outputTokens: 3, costUsd: 0 });

    // Only file A grows this tick; file B is handed back unchanged.
    const lineA2 = assistantLine({ input_tokens: 5, output_tokens: 5 });
    const r2 = parseUsageIncrement(r1.cursor, new Map([
      [fileA, `${lineA1}\n${lineA2}\n`],
      [fileB, `${lineB1}\n`],
    ]));
    expect(r2.delta).toEqual({ turns: 1, inputTokens: 5, outputTokens: 5, costUsd: 0 });
  });

  it("belt: a file shorter than its stored offset (rotation/replacement) resets to 0 instead of throwing or going negative", () => {
    const file = "session-l.jsonl";
    const staleCursor: BurnCursor = { fileOffsets: { [file]: 999_999 } };
    const content = `${assistantLine({ input_tokens: 4, output_tokens: 2 })}\n`;
    const { delta, parseSkips } = parseUsageIncrement(staleCursor, new Map([[file, content]]));
    expect(delta).toEqual({ turns: 1, inputTokens: 4, outputTokens: 2, costUsd: 0 });
    expect(parseSkips).toBe(0);
  });

  // Fix round (Important, reviewer-reproduced): the belt's reset used to
  // only get PERSISTED once a complete line was found — a shrink
  // immediately followed by an in-flight (no-newline-yet) tick left the
  // STALE, oversized offset sitting in the returned cursor, and once the
  // file regrew past it, the belt's own "shorter than stored offset" check
  // stopped tripping, silently skipping every real line from 0 up to the
  // stale value — forever. Reviewer's own repro shape: 23/71 turns counted
  // (68% silent loss). This is that exact mechanism, scaled down.
  it("shrink-then-regrow: a stale cursor from a shrink-with-no-complete-line tick must not permanently skip content once the file regrows past it", () => {
    const file = "session-shrink.jsonl";
    const turn = (n: number) => assistantLine({ input_tokens: n, output_tokens: n });

    // Tick 1: 5 real turns, ending complete — establishes a real, sizeable
    // stored offset to later go stale.
    const tick1Content = Array.from({ length: 5 }, (_, i) => `${turn(i + 1)}\n`).join("");
    const r1 = parseUsageIncrement({ fileOffsets: {} }, new Map([[file, tick1Content]]));
    expect(r1.delta.turns).toBe(5);
    const staleOffset = r1.cursor.fileOffsets[pathMapKey(file)];
    expect(staleOffset).toBe(tick1Content.length);

    // Tick 2: the file shrinks to something SHORTER than staleOffset, AND
    // ends with no trailing newline yet (an in-flight write) — the belt
    // fires (storedOffset > text.length) but there is no complete line to
    // otherwise trigger an offset write.
    const shrunkIncomplete = '{"type":"ass'; // shorter than staleOffset, deliberately no \n
    expect(shrunkIncomplete.length).toBeLessThan(staleOffset);
    const r2 = parseUsageIncrement(r1.cursor, new Map([[file, shrunkIncomplete]]));
    expect(r2.delta).toEqual({ turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(r2.cursor.fileOffsets[pathMapKey(file)]).toBe(0); // the fix: the reset is persisted immediately, not left stale

    // Tick 3: the file regrows — LONGER than staleOffset (the old,
    // pre-fix-would-be-stale value), fresh real turns from position 0,
    // complete. Must exceed staleOffset for real, or this wouldn't actually
    // exercise the bug (pre-fix, the belt would still trip on a SHORTER
    // regrowth and self-correct).
    const tick3Content = Array.from({ length: 6 }, (_, i) => `${turn(100 + i)}\n`).join("");
    expect(tick3Content.length).toBeGreaterThan(staleOffset);
    const r3 = parseUsageIncrement(r2.cursor, new Map([[file, tick3Content]]));

    // The correct answer: a full recount of tick3's content alone (nothing
    // carries over from tick1/tick2 — position 0 in tick3 is unrelated
    // content). Comparing against an independent from-scratch parse proves
    // nothing between 0 and the old stale offset was silently skipped.
    const fullRecount = parseUsageIncrement({ fileOffsets: {} }, new Map([[file, tick3Content]]));
    expect(r3.delta).toEqual(fullRecount.delta);
    expect(r3.delta.turns).toBe(6);
    expect(r3.parseSkips).toBe(0);
  });

  it("a brand new file not present in the prior cursor starts at offset 0", () => {
    const file = "session-m.jsonl";
    const content = `${assistantLine({ input_tokens: 9, output_tokens: 3 })}\n`;
    const { delta } = parseUsageIncrement({ fileOffsets: { "other.jsonl": 500 } }, new Map([[file, content]]));
    expect(delta).toEqual({ turns: 1, inputTokens: 9, outputTokens: 3, costUsd: 0 });
  });

  it("empty jsonlByFile map: zero delta, zero skips, cursor unchanged", () => {
    const { delta, parseSkips, cursor } = parseUsageIncrement({ fileOffsets: { a: 10 } }, new Map());
    expect(delta).toEqual({ turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(parseSkips).toBe(0);
    expect(cursor.fileOffsets).toEqual({ a: 10 });
  });
});

// ---------------------------------------------------------------------------
// rollWindow — 5h rolling window
// ---------------------------------------------------------------------------

describe("rollWindow — 5h window start/output tracking", () => {
  const T0 = "2026-08-16T00:00:00.000Z";

  it("within the window: totals accumulate and window5hStart/window5hOutput accumulate too", () => {
    const burn = freshBurn(new Date(T0));
    const next = rollWindow(burn, { turns: 1, inputTokens: 100, outputTokens: 40, costUsd: 0 }, new Date(T0));
    expect(next).toEqual({
      turns: 1, inputTokens: 100, outputTokens: 40, costUsd: 0,
      window5hStart: T0, window5hOutput: 40,
    });

    const later = new Date(new Date(T0).getTime() + 60_000);
    const next2 = rollWindow(next, { turns: 1, inputTokens: 10, outputTokens: 5, costUsd: 0 }, later);
    expect(next2.turns).toBe(2);
    expect(next2.inputTokens).toBe(110);
    expect(next2.outputTokens).toBe(45);
    expect(next2.window5hStart).toBe(T0); // unchanged — still inside the window
    expect(next2.window5hOutput).toBe(45); // accumulated
  });

  it("cumulative totals (turns/inputTokens/outputTokens/costUsd) NEVER reset, even across a window roll", () => {
    const burn = freshBurn(new Date(T0));
    const afterFirstWindow = rollWindow(burn, { turns: 3, inputTokens: 300, outputTokens: 90, costUsd: 1.2 }, new Date(T0));
    const rollTime = new Date(new Date(T0).getTime() + BURN_WINDOW_MS);
    const afterRoll = rollWindow(afterFirstWindow, { turns: 1, inputTokens: 10, outputTokens: 4, costUsd: 0.1 }, rollTime);
    expect(afterRoll.turns).toBe(4); // cumulative
    expect(afterRoll.inputTokens).toBe(310);
    expect(afterRoll.outputTokens).toBe(94);
    expect(afterRoll.costUsd).toBeCloseTo(1.3);
    expect(afterRoll.window5hOutput).toBe(4); // window bucket itself DID reset
  });

  it("exactly at the BURN_WINDOW_MS boundary: rolls (window5hStart moves to `now`, window5hOutput resets to just this delta)", () => {
    expect(BURN_WINDOW_MS).toBe(18_000_000); // 5h, pinned by archive.ts (task's own spec authority)
    const burn: Burn = { turns: 5, inputTokens: 500, outputTokens: 200, costUsd: 0, window5hStart: T0, window5hOutput: 200 };
    const boundary = new Date(new Date(T0).getTime() + BURN_WINDOW_MS);
    const next = rollWindow(burn, { turns: 1, inputTokens: 1, outputTokens: 9, costUsd: 0 }, boundary);
    expect(next.window5hStart).toBe(boundary.toISOString());
    expect(next.window5hOutput).toBe(9); // reset, not 200+9
  });

  it("one millisecond BEFORE the boundary: does not roll", () => {
    const burn: Burn = { turns: 5, inputTokens: 500, outputTokens: 200, costUsd: 0, window5hStart: T0, window5hOutput: 200 };
    const justBefore = new Date(new Date(T0).getTime() + BURN_WINDOW_MS - 1);
    const next = rollWindow(burn, { turns: 1, inputTokens: 1, outputTokens: 9, costUsd: 0 }, justBefore);
    expect(next.window5hStart).toBe(T0); // unchanged
    expect(next.window5hOutput).toBe(209); // accumulated, not reset
  });

  it("well past the boundary (a long-idle studio) still rolls to `now`, not to some intermediate window", () => {
    const burn: Burn = { turns: 1, inputTokens: 10, outputTokens: 10, costUsd: 0, window5hStart: T0, window5hOutput: 10 };
    const wayLater = new Date(new Date(T0).getTime() + BURN_WINDOW_MS * 3 + 5000);
    const next = rollWindow(burn, { turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 }, wayLater);
    expect(next.window5hStart).toBe(wayLater.toISOString());
    expect(next.window5hOutput).toBe(1);
  });
});

describe("freshBurn", () => {
  it("all counters zero, window starts at the given time", () => {
    const now = new Date("2026-08-16T12:00:00.000Z");
    expect(freshBurn(now)).toEqual({
      turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
      window5hStart: "2026-08-16T12:00:00.000Z", window5hOutput: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// shouldAlert — once per window, reset on window roll
// ---------------------------------------------------------------------------

describe("shouldAlert — once per window, streak-reset on window roll", () => {
  const burn: Burn = {
    turns: 10, inputTokens: 1000, outputTokens: 5000, costUsd: 0,
    window5hStart: "2026-08-16T00:00:00.000Z", window5hOutput: 5000,
  };

  it("threshold 0 (off) never alerts, regardless of output", () => {
    expect(shouldAlert(burn, 0, null)).toBe(false);
  });

  it("negative/absurd threshold values are treated as off, not as 'always alert'", () => {
    expect(shouldAlert(burn, -1, null)).toBe(false);
    expect(shouldAlert(burn, Number.NaN, null)).toBe(false);
  });

  it("below threshold: no alert", () => {
    expect(shouldAlert(burn, 10_000, null)).toBe(false);
  });

  it("at or above threshold, never alerted this window: alerts", () => {
    expect(shouldAlert(burn, 5000, null)).toBe(true); // exactly at threshold
    expect(shouldAlert(burn, 4000, null)).toBe(true); // over threshold
  });

  it("already alerted for the CURRENT window: does not alert again, even if output grew further", () => {
    const grown = { ...burn, window5hOutput: 9000 };
    expect(shouldAlert(grown, 4000, burn.window5hStart)).toBe(false);
  });

  it("a window roll (different window5hStart) resets the streak — alerts again even though the marker is non-null", () => {
    const rolledBurn: Burn = { ...burn, window5hStart: "2026-08-16T05:00:00.000Z", window5hOutput: 6000 };
    // alreadyAlertedWindow still points at the OLD (pre-roll) window start.
    expect(shouldAlert(rolledBurn, 4000, burn.window5hStart)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ustar reader — extracts only *.jsonl members
// ---------------------------------------------------------------------------

const TAR_BLOCK = 512;

function padTo512(bytes: Uint8Array): Uint8Array {
  const rem = bytes.length % TAR_BLOCK;
  if (rem === 0) return bytes;
  const out = new Uint8Array(bytes.length + (TAR_BLOCK - rem));
  out.set(bytes);
  return out;
}

function writeField(buf: Uint8Array, offset: number, value: string, fieldLen: number): void {
  const enc = new TextEncoder().encode(value);
  buf.set(enc.subarray(0, Math.min(enc.length, fieldLen)), offset);
}

function writeOctalField(buf: Uint8Array, offset: number, value: number, fieldLen: number): void {
  const octal = value.toString(8).padStart(fieldLen - 1, "0");
  writeField(buf, offset, octal, fieldLen);
}

/** A tiny, correct-enough ustar/GNU-tar header writer — test-only, mirrors
 *  exactly what real `tar` (GNU tar, the container's own base image) writes:
 *  a 100-byte name, an octal size field, a typeflag byte, and a real,
 *  correctly-computed checksum (computed with the checksum field itself
 *  treated as 8 spaces, per the ustar spec) so a real `tar`/`gzip -t` could
 *  independently validate output built by this helper. */
function tarHeader(name: string, size: number, typeflag: string): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK);
  writeField(header, 0, name.slice(0, 100), 100);
  writeOctalField(header, 100, 0o644, 8);
  writeOctalField(header, 108, 0, 8);
  writeOctalField(header, 116, 0, 8);
  writeOctalField(header, 124, size, 12);
  writeOctalField(header, 136, 0, 12);
  header.set(new TextEncoder().encode("        "), 148); // chksum: 8 spaces while summing
  header[156] = typeflag.charCodeAt(0);
  writeField(header, 257, "ustar", 6);
  writeField(header, 263, "00", 2);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += header[i];
  writeField(header, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return header;
}

/** GNU longname ("././@LongLink") extension for names over the 100-byte
 *  ustar field — real GNU tar's default for exactly this case (verified:
 *  this feature's real session paths, e.g.
 *  ".claude/projects/-Users-.../f3e42eb8-....jsonl", routinely exceed 100
 *  bytes), so the reader under test MUST handle this, not just plain ustar. */
function tarEntryBlocks(name: string, content: string): Uint8Array[] {
  const contentBytes = new TextEncoder().encode(content);
  const blocks: Uint8Array[] = [];
  if (name.length > 100) {
    const nameBytes = padTo512(new TextEncoder().encode(`${name}\0`));
    blocks.push(tarHeader("././@LongLink", name.length + 1, "L"));
    blocks.push(nameBytes);
    blocks.push(tarHeader(name.slice(0, 100), contentBytes.length, "0"));
  } else {
    blocks.push(tarHeader(name, contentBytes.length, "0"));
  }
  blocks.push(padTo512(contentBytes));
  return blocks;
}

function buildTar(entries: { name: string; content: string; dir?: boolean }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    if (e.dir) {
      blocks.push(tarHeader(e.name, 0, "5"));
    } else {
      blocks.push(...tarEntryBlocks(e.name, e.content));
    }
  }
  blocks.push(new Uint8Array(TAR_BLOCK), new Uint8Array(TAR_BLOCK)); // end-of-archive marker
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  // Same structural-cast reasoning as burn.ts's own gunzip() — see its doc
  // comment: @cloudflare/workers-types' CompressionStream.writable is typed
  // WritableStream<ArrayBuffer | ArrayBufferView>, which TS won't
  // structurally match against pipeThrough's expected
  // WritableStream<Uint8Array> despite being compatible at runtime.
  const cs = new CompressionStream("gzip") as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("readJsonlMembersFromTar — plain (already-decompressed) tar bytes", () => {
  it("extracts only *.jsonl members, ignoring a non-jsonl file and a directory entry", () => {
    const tar = buildTar([
      { name: ".claude.json", content: '{"synthetic":true}' },
      { name: ".claude/projects", content: "", dir: true },
      { name: ".claude/projects/proj/session.jsonl", content: `${assistantLine({ input_tokens: 1, output_tokens: 1 })}\n` },
    ]);
    const members = readJsonlMembersFromTar(tar);
    expect([...members.keys()]).toEqual([".claude/projects/proj/session.jsonl"]);
    expect(members.get(".claude/projects/proj/session.jsonl")).toContain('"type":"assistant"');
  });

  it("extracts multiple jsonl members, each keyed by its own path", () => {
    const tar = buildTar([
      { name: "a.jsonl", content: "line-a\n" },
      { name: "b.jsonl", content: "line-b\n" },
    ]);
    const members = readJsonlMembersFromTar(tar);
    expect(members.get("a.jsonl")).toBe("line-a\n");
    expect(members.get("b.jsonl")).toBe("line-b\n");
  });

  it("GNU longname extension: a path over 100 bytes is extracted under its FULL, untruncated name", () => {
    const longName = ".claude/projects/-Users-example-code-fleetflare-fleetflare-agency-worktrees-35-terminal-watch/f3e42eb8-65d8-4620-80a8-6ecd9a070ef0.jsonl";
    expect(longName.length).toBeGreaterThan(100);
    const content = `${assistantLine({ input_tokens: 3, output_tokens: 2 })}\n`;
    const tar = buildTar([{ name: longName, content }]);
    const members = readJsonlMembersFromTar(tar);
    expect([...members.keys()]).toEqual([longName]);
    expect(members.get(longName)).toBe(content);
  });

  it("an empty archive (just the end-of-archive marker) yields an empty map, no crash", () => {
    const tar = buildTar([]);
    expect(readJsonlMembersFromTar(tar)).toEqual(new Map());
  });

  it("a tar with no jsonl members at all yields an empty map", () => {
    const tar = buildTar([{ name: ".claude.json", content: "{}" }]);
    expect(readJsonlMembersFromTar(tar)).toEqual(new Map());
  });
});

describe("extractJsonlMembers — the real shape session-sync.ts hands off (gzip-compressed tar)", () => {
  it("gunzips then extracts, round-tripping through the same CompressionStream/DecompressionStream pair the Worker runtime provides (no external dependency)", async () => {
    const content = `${assistantLine({ input_tokens: 42, output_tokens: 8 })}\n`;
    const tar = buildTar([
      { name: ".claude.json", content: "{}" },
      { name: ".claude/projects/proj/session.jsonl", content },
    ]);
    const gz = await gzipBytes(tar);
    const members = await extractJsonlMembers(gz);
    expect([...members.keys()]).toEqual([".claude/projects/proj/session.jsonl"]);
    expect(members.get(".claude/projects/proj/session.jsonl")).toBe(content);
  });

  // HOLD fix round NIT (optional): burn.ts's private `gunzip` (its own
  // `asFormatError(new Response(inflateSliced(bytes)).arrayBuffer())` wrap)
  // is the ONLY thing `extractJsonlMembers` calls to decompress — but
  // `extractJsonlMembers` is itself a test-only path (see this describe
  // block's own doc comment above: "production never calls it", #176).
  // `sessionStats` exercises the identical corrupted-payload case, but
  // through the streaming `walkGzipTar`/`inflateSliced` path, not through
  // this monolithic `gunzip` — so nothing pinned `gunzip`'s OWN wrap before
  // this test, and a mutant dropping just that wrap survived the suite.
  it("a real gzip magic header but corrupted compressed data rejects SessionArchiveFormatError, not a raw decompressor TypeError", async () => {
    const tar = buildTar([{ name: "a.jsonl", content: "line\n" }]);
    const gz = await gzipBytes(tar);
    // Same technique as the "sessionStats — every throw is a
    // SessionArchiveFormatError" describe block's own corrupted-data test
    // above: keep the magic header (bytes 0-1) so the cheap check passes,
    // flip bits well into the compressed payload so DecompressionStream
    // still sees a COMPLETE stream but rejects it as corrupt.
    const corrupted = new Uint8Array(gz);
    for (let i = 10; i < Math.min(corrupted.length, 30); i++) corrupted[i] ^= 0xff;
    await expect(extractJsonlMembers(corrupted)).rejects.toBeInstanceOf(SessionArchiveFormatError);
  });
});

// ---------------------------------------------------------------------------
// Board #140 (#94 follow-up): sessionStats/gunzip's throws are now ALL
// SessionArchiveFormatError — the ONE class of failure that genuinely means
// "these bytes are not a readable gzip/tar", so a caller (provision.ts's
// pickRestoreSource) can narrow its catch to exactly that and let anything
// else (a transient Worker exception, a future bug) propagate instead of
// silently swapping a perfectly good `latest` for stale daily-keeper history.
// ---------------------------------------------------------------------------

describe("sessionStats — every throw is a SessionArchiveFormatError (#140)", () => {
  it("bad magic header (not gzip at all)", async () => {
    await expect(sessionStats(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(SessionArchiveFormatError);
  });

  it("too short to even carry a magic header", async () => {
    await expect(sessionStats(new Uint8Array([0x1f]))).rejects.toBeInstanceOf(SessionArchiveFormatError);
  });

  it("a real gzip magic header, but corrupted compressed data — the decompressor itself rejects the stream", async () => {
    const tar = buildTar([{ name: "a.jsonl", content: "line\n" }]);
    const gz = await gzipBytes(tar);
    // Keep the magic header (bytes 0-1) so the cheap check passes; flip bits
    // well into the compressed payload so DecompressionStream still sees a
    // COMPLETE stream (same total length) but rejects it as corrupt, rather
    // than truncating (which workerd logs as noisy "incomplete data" —
    // gunzip's own doc comment already documents that distinct case).
    const corrupted = new Uint8Array(gz);
    for (let i = 10; i < Math.min(corrupted.length, 30); i++) corrupted[i] ^= 0xff;
    await expect(sessionStats(corrupted)).rejects.toBeInstanceOf(SessionArchiveFormatError);
  });

  it("valid, complete gzip/tar never throws at all", async () => {
    const tar = buildTar([{ name: "a.jsonl", content: "line\n" }]);
    const gz = await gzipBytes(tar);
    await expect(sessionStats(gz)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #228 item 2 (#191 review scope-add): the describe block above's own
// title — "every throw is a SessionArchiveFormatError" — is true for every
// INPUT it actually tests (bad magic, truncated, corrupted compressed data),
// but it is NOT a claim that burn.ts's private asFormatError helper converts
// every possible error type. It converts exactly one: a decompressor
// rejection `TypeError` (workerd's own "Decompression failed."). Anything
// else raised while gunzip's `.arrayBuffer()` call or walkGzipTar's own
// stream `.read()` calls are in flight — both wrapped by the SAME shared
// asFormatError — rethrows completely unconverted (see that function's own
// doc comment). Until this test, NOTHING pinned that half directly: a
// mutation that made asFormatError convert every error type, not just
// TypeError, passed the whole suite, and it matters downstream — restore's
// source picker (provision.ts's pickRestoreSource) treats a
// SessionArchiveFormatError as "fall back to the daily keeper" and anything
// else as "abort the restore" (see test/studio.backup-guard.test.ts's own
// "a non-format decompression failure propagates, never falls back" describe
// block for that half, which only ever exercised a TypeError thrown at
// DecompressionStream's CONSTRUCTION — outside asFormatError's wrap entirely,
// never a non-TypeError raised INSIDE the wrapped read itself).
// ---------------------------------------------------------------------------

describe("asFormatError (burn.ts) narrows ONLY TypeError — a different error type propagates unconverted (#228 item 2)", () => {
  it("a non-TypeError raised while the inflated stream is read is NOT turned into a SessionArchiveFormatError", async () => {
    // A bespoke DecompressionStream stand-in whose readable side is forced
    // into an error state — with something other than the TypeError a real
    // decompressor rejection would raise — the instant anything is piped
    // into its writable side. walkGzipTar's own stream read (wrapped in
    // asFormatError) is what observes this rejection.
    class ErroringDecompressionStream {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      constructor() {
        let ctrl!: ReadableStreamDefaultController<Uint8Array>;
        this.readable = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
        this.writable = new WritableStream<Uint8Array>({
          write: () => {
            ctrl.error(new RangeError("synthetic: not a decompression TypeError"));
          },
        });
      }
    }
    vi.stubGlobal("DecompressionStream", ErroringDecompressionStream as unknown as typeof DecompressionStream);
    try {
      // Only the two magic bytes matter — ErroringDecompressionStream never
      // looks at the rest of the stream.
      const bogusGzip = new Uint8Array([0x1f, 0x8b, 0, 0, 0, 0, 0, 0, 0, 0]);
      await expect(sessionStats(bogusGzip)).rejects.toThrow(RangeError);
      await expect(sessionStats(bogusGzip)).rejects.not.toBeInstanceOf(SessionArchiveFormatError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring — syncSessionTick parses burn post-success, persists to DO storage,
// alerts via the injected telegram notify.
// ---------------------------------------------------------------------------

const STUDIO_ID = "websites--pilot";
/** Review round 3 (#202): the container epoch the fake tar/stat command below
 *  reports as the start of its tar. */
const TAR_STARTED_AT = 1_758_067_200;

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

/** Same in-memory Map-backed fake pattern test/studio.session.test.ts's own
 *  fakeSessionStorage uses, widened for this task's three new keys — kept
 *  local rather than imported, matching this feature's established
 *  per-file-fakes convention (see that file's own doc comment). */
/**
 * Fix round (ruled-in minor): `put` now also handles the multi-key object
 * form (`SessionSyncStorage`'s new atomic overload for the cursor+burn
 * pair) — same technique test/studio.transcript.test.ts's own `fakeStorage`
 * already established for TranscriptStorage's identical multi-key overload
 * (see that file's doc comment): normalized to a single `entries` map
 * either way, so one code path writes regardless of which calling
 * convention `syncSessionTick` used.
 */
function fakeBurnStorage(seed?: {
  burnCursor?: BurnCursor; burn?: Burn; burnAlertedWindow?: string; status?: StudioStatus;
  sessionMark?: { file: string; lines: number; lastTs: string | null };
}): SessionSyncStorage & StudioStorage & { putKeys: string[] } {
  const map = new Map<string, unknown>();
  if (seed?.burnCursor) map.set(BURN_CURSOR_KEY, seed.burnCursor);
  if (seed?.burn) map.set(BURN_KEY, seed.burn);
  if (seed?.burnAlertedWindow !== undefined) map.set(BURN_ALERTED_WINDOW_KEY, seed.burnAlertedWindow);
  if (seed?.status) map.set(STATUS_KEY, seed.status);
  if (seed?.sessionMark) map.set(SESSION_MARK_KEY, seed.sessionMark);
  const putKeys: string[] = [];
  return {
    putKeys,
    get: (async (key: string) => map.get(key)) as SessionSyncStorage["get"] & StudioStorage["get"],
    put: (async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      const entries: Record<string, unknown> =
        typeof keyOrEntries === "string" ? { [keyOrEntries]: value } : keyOrEntries;
      for (const [key, v] of Object.entries(entries)) {
        putKeys.push(key);
        map.set(key, v);
      }
    }) as SessionSyncStorage["put"] & StudioStorage["put"],
    // Issue #228 item 4: SessionSyncStorage.delete is now required — this
    // fake never arms/consumes SESSION_FORCE_KEY itself, so a trivial
    // Map-backed delete is enough to satisfy the interface structurally.
    delete: (async (key: string) => map.delete(key)) as NonNullable<SessionSyncStorage["delete"]>,
  };
}

/** Builds a real gzip'd tar containing one jsonl member with the given raw
 *  jsonl text, and wires a SessionSyncDeps whose exec fakes tarAndStatCmd /
 *  singleReadCmd against it — so syncSessionTick's OWN `bytes` (the thing it
 *  hands to burn parsing "post-success") is the exact real shape production
 *  ships: gzip(tar(...)). */
async function fakeSyncDepsWithJsonl(
  jsonlText: string,
  opts: {
    now?: string; notify?: SessionSyncDeps["notify"]; burnAlertThresholdTokens?: number;
    /** Review round 3 (#202): the second line the real tar/stat command
     *  prints — the excludes file's mtime, i.e. the container epoch this tar
     *  started at. This is the value a tick may adopt as its burn watermark. */
    tarStartedAt?: number;
  } = {},
): Promise<SessionSyncDeps & { execCalls: string[]; puts: { key: string; bytes: Uint8Array }[]; notified: string[] }> {
  const tar = buildTar([{ name: ".claude/projects/proj/session.jsonl", content: jsonlText }]);
  const gz = await gzipBytes(tar);
  const b64 = bytesToBase64(gz);
  const execCalls: string[] = [];
  const puts: { key: string; bytes: Uint8Array }[] = [];
  const notified: string[] = [];
  return {
    execCalls,
    puts,
    notified,
    exec: async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.startsWith("mkdir -p")) {
        return { code: 0, stdout: `${gz.length}\n${opts.tarStartedAt ?? TAR_STARTED_AT}`, stderr: "" };
      }
      return { code: 0, stdout: b64, stderr: "" };
    },
    r2Put: async (key: string, bytes: Uint8Array) => {
      puts.push({ key, bytes });
    },
    r2List: async () => [],
    r2Delete: async () => {},
    now: fixedNow(opts.now ?? "2026-08-16T12:00:00.000Z"),
    notify: opts.notify ?? (async (message: string) => {
      notified.push(message);
    }),
    burnAlertThresholdTokens: opts.burnAlertThresholdTokens ?? 0,
  };
}

describe("syncSessionTick — burn parsing wired in post-success", () => {
  it("after a successful sync, DO storage gains a burn summary matching the jsonl's usage", async () => {
    const jsonl = `${assistantLine({ input_tokens: 55, output_tokens: 21 })}\n`;
    const deps = await fakeSyncDepsWithJsonl(jsonl);
    const storage = fakeBurnStorage();

    await syncSessionTick(deps, storage, STUDIO_ID);

    const burn = await storage.get(BURN_KEY);
    expect(burn).toBeDefined();
    expect(burn!.turns).toBe(1);
    expect(burn!.inputTokens).toBe(55);
    expect(burn!.outputTokens).toBe(21);
    expect(burn!.window5hOutput).toBe(21);
    const cursor = await storage.get(BURN_CURSOR_KEY);
    expect(cursor).toBeDefined();
  });

  it("two consecutive ticks (the session file grew) never double-count — total matches both lines combined", async () => {
    const line1 = assistantLine({ input_tokens: 10, output_tokens: 4 });
    const line2 = assistantLine({ input_tokens: 20, output_tokens: 6 });
    const storage = fakeBurnStorage();

    const deps1 = await fakeSyncDepsWithJsonl(`${line1}\n`);
    await syncSessionTick(deps1, storage, STUDIO_ID);
    expect((await storage.get(BURN_KEY))!.inputTokens).toBe(10);

    const deps2 = await fakeSyncDepsWithJsonl(`${line1}\n${line2}\n`);
    await syncSessionTick(deps2, storage, STUDIO_ID);
    const burn2 = await storage.get(BURN_KEY);
    expect(burn2!.turns).toBe(2);
    expect(burn2!.inputTokens).toBe(30); // 10 + 20, never 10 + 30
    expect(burn2!.outputTokens).toBe(10);
  });

  it("a parseSkip (garbage line mixed in) does not fail the sync tick — the tick's own SyncResult still reports success", async () => {
    const jsonl = `${assistantLine({ input_tokens: 1, output_tokens: 1 })}\nnot json {{\n`;
    const deps = await fakeSyncDepsWithJsonl(jsonl);
    const storage = fakeBurnStorage();
    const result = await syncSessionTick(deps, storage, STUDIO_ID);
    expect(result.skipped).toBeUndefined();
    expect(result.bytes).toBeGreaterThan(0);
    const burn = await storage.get(BURN_KEY);
    expect(burn!.turns).toBe(1);
  });

  it("alert: crossing the threshold notifies once via deps.notify, and persists the alerted-window marker", async () => {
    const jsonl = `${assistantLine({ input_tokens: 1, output_tokens: 5000 })}\n`;
    const deps = await fakeSyncDepsWithJsonl(jsonl, { burnAlertThresholdTokens: 1000 });
    const storage = fakeBurnStorage();

    await syncSessionTick(deps, storage, STUDIO_ID);

    expect(deps.notified).toHaveLength(1);
    expect(deps.notified[0]).toContain(STUDIO_ID);
    const marker = await storage.get(BURN_ALERTED_WINDOW_KEY);
    const burn = await storage.get(BURN_KEY);
    expect(marker).toBe(burn!.window5hStart);
  });

  it("alert: a second tick within the SAME window does not notify again", async () => {
    const storage = fakeBurnStorage();
    const line = assistantLine({ input_tokens: 1, output_tokens: 5000 });

    const deps1 = await fakeSyncDepsWithJsonl(`${line}\n`, { burnAlertThresholdTokens: 1000, now: "2026-08-16T12:00:00.000Z" });
    await syncSessionTick(deps1, storage, STUDIO_ID);
    expect(deps1.notified).toHaveLength(1);

    const line2 = assistantLine({ input_tokens: 1, output_tokens: 200 });
    const deps2 = await fakeSyncDepsWithJsonl(`${line}\n${line2}\n`, {
      burnAlertThresholdTokens: 1000, now: "2026-08-16T12:05:00.000Z", // 5 min later, same 5h window
    });
    await syncSessionTick(deps2, storage, STUDIO_ID);
    expect(deps2.notified).toHaveLength(0); // still the same window — no repeat alert
  });

  it("alert: threshold 0 (off) never notifies even with a huge burn", async () => {
    const jsonl = `${assistantLine({ input_tokens: 1, output_tokens: 999_999 })}\n`;
    const deps = await fakeSyncDepsWithJsonl(jsonl, { burnAlertThresholdTokens: 0 });
    const storage = fakeBurnStorage();
    await syncSessionTick(deps, storage, STUDIO_ID);
    expect(deps.notified).toHaveLength(0);
  });

  it("burn parsing is advisory: a throwing extraction (corrupt gzip bytes) is caught internally and never fails the sync tick that already succeeded", async () => {
    const execCalls: string[] = [];
    const deps: SessionSyncDeps = {
      exec: async (cmd: string) => {
        execCalls.push(cmd);
        if (cmd.startsWith("mkdir -p")) return { code: 0, stdout: `4\n${TAR_STARTED_AT}`, stderr: "" };
        return { code: 0, stdout: btoa("\x00\x01\x02\x03"), stderr: "" }; // not a valid gzip stream
      },
      r2Put: async () => {},
      r2List: async () => [],
      r2Delete: async () => {},
      now: fixedNow("2026-08-16T12:00:00.000Z"),
      notify: async () => {},
      burnAlertThresholdTokens: 0,
    };
    const storage = fakeBurnStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await syncSessionTick(deps, storage, STUDIO_ID);
      expect(result.bytes).toBe(4); // the sync itself still succeeded
      expect(errSpy).toHaveBeenCalled(); // burn parsing's own failure was logged
    } finally {
      errSpy.mockRestore();
    }
    // ... and the watermark did NOT move: the next tick must still admit
    // everything this one failed to account for.
    expect(await storage.get(SESSION_BURN_WATERMARK_KEY)).toBeUndefined();
  });
});

/** Same real-gzip'd-tar fixture pattern as fakeSyncDepsWithJsonl above,
 *  generalized to an arbitrary set of member paths (including none at all) —
 *  issue #258's pruning wiring test needs a SECOND tick whose tar drops a
 *  path entirely, which a single fixed jsonlText fixture cannot express. */
async function fakeSyncDepsWithFiles(
  files: Record<string, string>,
  opts: { now?: string } = {},
): Promise<SessionSyncDeps> {
  const tar = buildTar(Object.entries(files).map(([name, content]) => ({ name, content })));
  const gz = await gzipBytes(tar);
  const b64 = bytesToBase64(gz);
  return {
    exec: async (cmd: string) => {
      if (cmd.startsWith("mkdir -p")) return { code: 0, stdout: `${gz.length}\n${TAR_STARTED_AT}`, stderr: "" };
      return { code: 0, stdout: b64, stderr: "" };
    },
    r2Put: async () => {},
    r2List: async () => [],
    r2Delete: async () => {},
    now: fixedNow(opts.now ?? "2026-08-16T12:00:00.000Z"),
    notify: async () => {},
    burnAlertThresholdTokens: 0,
  };
}

describe("syncSessionTick — burn cursor pruning is wired into the real tick (issue #258)", () => {
  const PATH = ".claude/projects/proj/session.jsonl";

  it("a path absent from the tar for >= CURSOR_PRUNE_MS is pruned from the NEXT tick's persisted cursor", async () => {
    const storage = fakeBurnStorage();
    const line = assistantLine({ input_tokens: 1, output_tokens: 1 });

    await syncSessionTick(await fakeSyncDepsWithFiles({ [PATH]: `${line}\n` }, { now: "2026-08-16T12:00:00.000Z" }), storage, STUDIO_ID);
    expect((await storage.get(BURN_CURSOR_KEY))!.fileOffsets[pathMapKey(PATH)]).toBeGreaterThan(0);

    // The path is gone from the SECOND tick's tar entirely, CURSOR_PRUNE_MS +
    // 1s of wall clock later.
    const later = new Date(Date.parse("2026-08-16T12:00:00.000Z") + CURSOR_PRUNE_MS + 1_000).toISOString();
    await syncSessionTick(await fakeSyncDepsWithFiles({}, { now: later }), storage, STUDIO_ID);

    expect((await storage.get(BURN_CURSOR_KEY))!.fileOffsets[pathMapKey(PATH)]).toBeUndefined();
  });

  it("a path absent from the tar for UNDER the threshold is retained", async () => {
    const storage = fakeBurnStorage();
    const line = assistantLine({ input_tokens: 1, output_tokens: 1 });

    await syncSessionTick(await fakeSyncDepsWithFiles({ [PATH]: `${line}\n` }, { now: "2026-08-16T12:00:00.000Z" }), storage, STUDIO_ID);

    const under = new Date(Date.parse("2026-08-16T12:00:00.000Z") + CURSOR_PRUNE_MS - 1_000).toISOString();
    await syncSessionTick(await fakeSyncDepsWithFiles({}, { now: under }), storage, STUDIO_ID);

    expect((await storage.get(BURN_CURSOR_KEY))!.fileOffsets[pathMapKey(PATH)]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #258 (fix 3): a failed burn cursor/burn PERSIST (storage.put itself
// rejecting — e.g. "value too large") used to be indistinguishable from an
// ordinary parse failure: the same generic "burn parsing failed" log line,
// and no row-visible signal at all. That is worse than a parse failure — the
// tick actually COMPUTED a correct delta and then LOST it, silently, forever
// (the next tick's prevCursor/prevBurn read the same stale storage values
// right back). This is now its own distinct, greppable failure path.
//
// Issue #258 round-2 review (MED): it rides its OWN key
// (`BURN_PERSIST_ERROR_KEY`), not `SESSION_GUARD_KEY` — round 1 reused
// `SESSION_GUARD_KEY` (the one channel already mirrored to the registry row),
// but that key already means something ELSE ("session sync REFUSED a
// poorer/blank candidate") and a displaced candidate is STILL parsed for burn
// on the very same tick (see `syncSessionTick`'s own doc comment) — so a
// persist failure on a displaced tick clobbered the guard's own
// just-written refusal record, and an operator/automated recovery reading a
// burn-persist-failure reason where a displaced-snapshot refusal belongs
// could `clearSessionGuard` believing it is unsticking a stuck guard,
// force-uploading straight past the poorer-snapshot check the guard exists
// to protect. Own key: the two failure modes now coexist without either
// masking the other.
// ---------------------------------------------------------------------------

describe("syncSessionTick — a failed burn cursor/burn persist is visible, not silently swallowed (issue #258)", () => {
  it("storage.put rejecting the cursor+burn pair: distinct log text, BURN_PERSIST_ERROR_KEY records it, watermark does not advance", async () => {
    const jsonl = `${assistantLine({ input_tokens: 1, output_tokens: 1 })}\n`;
    const deps = await fakeSyncDepsWithJsonl(jsonl);
    const base = fakeBurnStorage();
    const storage: SessionSyncStorage & StudioStorage & { putKeys: string[] } = {
      ...base,
      put: (async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
        if (typeof keyOrEntries !== "string" && BURN_CURSOR_KEY in keyOrEntries) {
          throw new Error("DO storage put failed: value too large");
        }
        return (base.put as (k: string | Record<string, unknown>, v?: unknown) => Promise<void>)(keyOrEntries, value);
      }) as SessionSyncStorage["put"] & StudioStorage["put"],
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof syncSessionTick>>;
    let calls: string[];
    try {
      result = await syncSessionTick(deps, storage, STUDIO_ID);
    } finally {
      calls = errSpy.mock.calls.map((c) => String(c[0]));
      errSpy.mockRestore();
    }
    // The sync itself (the session tar ship) still succeeded — burn is advisory.
    expect(result.bytes).toBeGreaterThan(0);
    // A distinct, searchable message — never the generic "burn parsing
    // failed" text every OTHER burn failure in this describe block logs.
    expect(calls.some((c) => c.toLowerCase().includes("persist failed"))).toBe(true);
    // Issue #258 round-2: its OWN key — never SESSION_GUARD_KEY (see this
    // describe block's own header comment).
    const persistError = await storage.get(BURN_PERSIST_ERROR_KEY);
    expect(persistError).toBeTruthy();
    expect(persistError!.reason.toLowerCase()).toContain("persist");
    // Nothing about a burn-persist failure means "session sync refused" —
    // SESSION_GUARD_KEY must stay untouched.
    expect(await storage.get(SESSION_GUARD_KEY)).toBeUndefined();
    // The burn state this tick computed was genuinely never made durable.
    expect(await storage.get(BURN_KEY)).toBeUndefined();
    // ...and the watermark must NOT advance: the next tick still has to admit
    // everything this one failed to actually persist.
    expect(await storage.get(SESSION_BURN_WATERMARK_KEY)).toBeUndefined();
  });

  it("a successful persist on the NEXT tick clears a stale BURN_PERSIST_ERROR_KEY from an earlier failed one", async () => {
    const jsonl = `${assistantLine({ input_tokens: 1, output_tokens: 1 })}\n`;
    const base = fakeBurnStorage();
    let fail = true;
    const storage: SessionSyncStorage & StudioStorage & { putKeys: string[] } = {
      ...base,
      put: (async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
        if (fail && typeof keyOrEntries !== "string" && BURN_CURSOR_KEY in keyOrEntries) {
          throw new Error("DO storage put failed: value too large");
        }
        return (base.put as (k: string | Record<string, unknown>, v?: unknown) => Promise<void>)(keyOrEntries, value);
      }) as SessionSyncStorage["put"] & StudioStorage["put"],
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await syncSessionTick(await fakeSyncDepsWithJsonl(jsonl), storage, STUDIO_ID);
    } finally {
      errSpy.mockRestore();
    }
    expect(await storage.get(BURN_PERSIST_ERROR_KEY)).toBeTruthy();

    fail = false;
    await syncSessionTick(await fakeSyncDepsWithJsonl(jsonl, { now: "2026-08-16T12:05:00.000Z" }), storage, STUDIO_ID);
    expect(await storage.get(BURN_PERSIST_ERROR_KEY)).toBeNull();
  });

  it("BLOCKER-adjacent collision (issue #258 round-2, MED): a burn-persist failure on a DISPLACED tick does not clobber that same tick's own displaced-snapshot guard record", async () => {
    // A displaced tick: the candidate (empty tar, no session files at all) is
    // poorer than the seeded baseline mark, so syncSessionTick's own guard
    // branch writes a "no session files" refusal to SESSION_GUARD_KEY — AND
    // still runs parseBurn over the very same (displaced) bytes afterward
    // (see syncSessionTick's own doc comment: "a displaced candidate is
    // still a real snapshot... so burn parses it").
    const storage = fakeBurnStorage({
      sessionMark: { file: ".claude/projects/proj/session.jsonl", lines: 5, lastTs: "2026-08-16T00:00:00.000Z" },
    });
    const base = storage.put;
    const storageWithFailingBurnPut: SessionSyncStorage & StudioStorage & { putKeys: string[] } = {
      ...storage,
      put: (async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
        if (typeof keyOrEntries !== "string" && BURN_CURSOR_KEY in keyOrEntries) {
          throw new Error("DO storage put failed: value too large");
        }
        return (base as (k: string | Record<string, unknown>, v?: unknown) => Promise<void>)(keyOrEntries, value);
      }) as SessionSyncStorage["put"] & StudioStorage["put"],
    };
    const deps = await fakeSyncDepsWithFiles({}, { now: "2026-08-16T12:00:00.000Z" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof syncSessionTick>>;
    try {
      result = await syncSessionTick(deps, storageWithFailingBurnPut, STUDIO_ID);
    } finally {
      errSpy.mockRestore();
    }
    expect(result.skipped).toBe("displaced");
    // The displaced-snapshot guard record — written by THIS tick — must
    // survive the SAME tick's own burn-persist failure.
    const guard = await storage.get(SESSION_GUARD_KEY);
    expect(guard).toBeTruthy();
    expect(guard!.reason.toLowerCase()).toContain("no session files");
    // And the persist failure is independently visible on its own key.
    const persistError = await storage.get(BURN_PERSIST_ERROR_KEY);
    expect(persistError).toBeTruthy();
    expect(persistError!.reason.toLowerCase()).toContain("persist");
  });
});

// ---------------------------------------------------------------------------
// The burn watermark, over a REAL gzip'd tar (issue #202, review round 3).
// test/studio.session.test.ts holds the "never advances" half of this
// contract; these are the two paths on which it DOES advance.
// ---------------------------------------------------------------------------

describe("syncSessionTick — the burn watermark advances after a successful parse", () => {
  it("stores the epoch the command printed, and only AFTER the cursor+burn pair is durable", async () => {
    const jsonl = `${assistantLine({ input_tokens: 1, output_tokens: 3 })}\n`;
    const deps = await fakeSyncDepsWithJsonl(jsonl);
    const storage = fakeBurnStorage();

    await syncSessionTick(deps, storage, STUDIO_ID);

    expect(await storage.get(SESSION_BURN_WATERMARK_KEY)).toBe(TAR_STARTED_AT);
    // Ordering matters: a crash between the pair and this write leaves an
    // OLD watermark, which only over-admits next tick (the cursor dedupes).
    // The reverse order would skip a tail forever.
    expect(storage.putKeys.indexOf(SESSION_BURN_WATERMARK_KEY))
      .toBeGreaterThan(storage.putKeys.indexOf(BURN_CURSOR_KEY));
  });

  it("each tick adopts its OWN tar's epoch, never a stale one", async () => {
    const storage = fakeBurnStorage();
    const line = assistantLine({ input_tokens: 1, output_tokens: 1 });

    await syncSessionTick(await fakeSyncDepsWithJsonl(`${line}\n`, { tarStartedAt: 1_758_000_000 }), storage, STUDIO_ID);
    expect(await storage.get(SESSION_BURN_WATERMARK_KEY)).toBe(1_758_000_000);

    await syncSessionTick(await fakeSyncDepsWithJsonl(`${line}\n${line}\n`, { tarStartedAt: 1_758_000_300 }), storage, STUDIO_ID);
    expect(await storage.get(SESSION_BURN_WATERMARK_KEY)).toBe(1_758_000_300);
  });

  it("a DISPLACED tick advances it too — the guard refused to overwrite `latest`, but burn still parsed those very bytes", async () => {
    const jsonl = `${assistantLine({ input_tokens: 1, output_tokens: 9 })}\n`;
    const deps = await fakeSyncDepsWithJsonl(jsonl, { now: "2026-08-16T12:00:00.000Z" });
    // A baseline claiming far more lines than the candidate has: the guard
    // writes the candidate aside instead of over `latest`.
    const storage = fakeBurnStorage({
      sessionMark: { file: ".claude/projects/proj/session.jsonl", lines: 500, lastTs: "2026-08-16T11:59:00.000Z" },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await syncSessionTick(deps, storage, STUDIO_ID)).skipped).toBe("displaced");
    } finally {
      errSpy.mockRestore();
    }
    expect((await storage.get(BURN_KEY))!.outputTokens).toBe(9); // burn really did parse
    expect(await storage.get(SESSION_BURN_WATERMARK_KEY)).toBe(TAR_STARTED_AT);
  });
});

// ---------------------------------------------------------------------------
// mirrorBurnToRegistry (do.ts) — DO-storage burn -> StudioStatus.burn -> registry
// ---------------------------------------------------------------------------

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

describe("mirrorBurnToRegistry", () => {
  it("copies DO storage's burn onto StudioStatus.burn and calls recordStudio", async () => {
    const burn: Burn = { turns: 3, inputTokens: 300, outputTokens: 90, costUsd: 0, window5hStart: "2026-08-16T00:00:00.000Z", window5hOutput: 90 };
    const storage = fakeBurnStorage({ status: status(), burn });
    const recorded: StudioStatus[] = [];

    await mirrorBurnToRegistry(storage, async (s) => {
      recorded.push(s);
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].burn).toEqual(burn);
    // Issue #228 item 5: sessionForceArmedAt now always rides this same
    // write — null here since SESSION_FORCE_KEY was never armed.
    // Issue #115: freshSessionPending rides the same write too — false here
    // since FRESH_SESSION_PENDING_KEY was never armed.
    expect(await storage.get(STATUS_KEY)).toEqual({ ...status(), burn, sessionForceArmedAt: null, freshSessionPending: false });
  });

  it("no status ever stored yet: skips silently, never calls recordStudio", async () => {
    const burn: Burn = freshBurn(new Date());
    const storage = fakeBurnStorage({ burn }); // no status seeded
    const recordFn = vi.fn(async () => {});
    await mirrorBurnToRegistry(storage, recordFn);
    expect(recordFn).not.toHaveBeenCalled();
  });

  it("no burn ever parsed yet: skips silently, leaves status untouched", async () => {
    const storage = fakeBurnStorage({ status: status() }); // no burn seeded
    const recordFn = vi.fn(async () => {});
    await mirrorBurnToRegistry(storage, recordFn);
    expect(recordFn).not.toHaveBeenCalled();
  });

  // Issue #228 item 5: an armed force-next-sync override was previously
  // invisible on `fleet ls`/`fleet inspect` — StudioStatus.sessionForceArmedAt
  // (mirrored here, the same bridge sessionGuard already crosses) closes
  // that gap. Read directly from SESSION_FORCE_KEY's own storage presence
  // (do.ts's own doc comment on this function explains why), not threaded in
  // as a parameter — self-healing regardless of which syncSessionTick call
  // site most recently armed or consumed it.
  it("SESSION_FORCE_KEY armed: mirrors the already-stamped sessionForceArmedAt through unchanged", async () => {
    const burn: Burn = freshBurn(new Date());
    const storage = fakeBurnStorage({ status: status({ sessionForceArmedAt: "2026-09-24T10:00:00.000Z" }), burn });
    await storage.put(SESSION_FORCE_KEY, true);
    const recorded: StudioStatus[] = [];

    await mirrorBurnToRegistry(storage, async (s) => { recorded.push(s); });

    expect(recorded[0].sessionForceArmedAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("SESSION_FORCE_KEY absent (a tick already consumed it): clears a stale sessionForceArmedAt to null", async () => {
    const burn: Burn = freshBurn(new Date());
    const storage = fakeBurnStorage({ status: status({ sessionForceArmedAt: "2026-09-24T10:00:00.000Z" }), burn });
    // SESSION_FORCE_KEY deliberately never armed on this storage.
    const recorded: StudioStatus[] = [];

    await mirrorBurnToRegistry(storage, async (s) => { recorded.push(s); });

    expect(recorded[0].sessionForceArmedAt).toBeNull();
  });

  // Issue #258 round-3: round 2 wired the WRITE side (parseBurn puts
  // BURN_PERSIST_ERROR_KEY, mirrorBurnToRegistry copies it) but this specific
  // copy had no direct test coverage of its own — every existing assertion
  // above exercises sessionGuard/sessionForceArmedAt, never this field.
  it("BURN_PERSIST_ERROR_KEY present: copies it onto StudioStatus.burnPersistError", async () => {
    const burn: Burn = freshBurn(new Date());
    const storage = fakeBurnStorage({ status: status(), burn });
    await storage.put(BURN_PERSIST_ERROR_KEY, { at: "2026-09-25T00:00:00.000Z", reason: "burn cursor/burn persist failed: value too large" });
    const recorded: StudioStatus[] = [];

    await mirrorBurnToRegistry(storage, async (s) => { recorded.push(s); });

    expect(recorded[0].burnPersistError).toEqual({ at: "2026-09-25T00:00:00.000Z", reason: "burn cursor/burn persist failed: value too large" });
  });

  it("BURN_PERSIST_ERROR_KEY null (a later persist succeeded): copies null through, not the row's stale prior value", async () => {
    const burn: Burn = freshBurn(new Date());
    const storage = fakeBurnStorage({ status: status({ burnPersistError: { at: "2026-09-24T00:00:00.000Z", reason: "stale" } }), burn });
    await storage.put(BURN_PERSIST_ERROR_KEY, null);
    const recorded: StudioStatus[] = [];

    await mirrorBurnToRegistry(storage, async (s) => { recorded.push(s); });

    expect(recorded[0].burnPersistError).toBeNull();
  });

  it("BURN_PERSIST_ERROR_KEY never written: leaves the row's own burnPersistError untouched", async () => {
    const burn: Burn = freshBurn(new Date());
    const storage = fakeBurnStorage({ status: status(), burn });
    const recorded: StudioStatus[] = [];

    await mirrorBurnToRegistry(storage, async (s) => { recorded.push(s); });

    expect(recorded[0].burnPersistError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Numbers-only registry assertion — the end-to-end scrub-boundary proof.
// ---------------------------------------------------------------------------

describe("numbers-only: message content never reaches the registry row, even through the full parse -> burn -> registry pipeline", () => {
  it("a jsonl fixture with a token-shaped string in message content produces a registry row containing NO such string", async () => {
    const secretShaped = "sk-ant-api03-FAKE-NOT-REAL-1234567890abcdef";
    const line = assistantLine({ input_tokens: 12, output_tokens: 34 }, `here is a fake token-shaped string: ${secretShaped}`);
    const tar = buildTar([{ name: ".claude/projects/proj/session.jsonl", content: `${line}\n` }]);
    const gz = await gzipBytes(tar);

    const jsonlByFile = await extractJsonlMembers(gz);
    // Sanity: the secret-shaped string genuinely IS present in the extracted
    // member text at this point — proving the test would catch a real leak,
    // not passing vacuously because the string was never there to begin with.
    expect([...jsonlByFile.values()].some((t) => t.includes(secretShaped))).toBe(true);

    const { delta } = parseUsageIncrement({ fileOffsets: {} }, jsonlByFile);
    const burn = rollWindow(freshBurn(new Date("2026-08-16T00:00:00.000Z")), delta, new Date("2026-08-16T00:00:00.000Z"));
    expect(JSON.stringify(burn)).not.toContain(secretShaped); // burn itself: numbers + one ISO string only

    const registryStudioId = "websites--burn-numbers-only";
    await recordStudio(env as unknown as Env, status({ id: registryStudioId, burn }));

    const row = await env.DB
      .prepare(`SELECT value FROM fleet_state WHERE key = ?`)
      .bind(`studio:${registryStudioId}`)
      .first<{ value: string }>();
    expect(row?.value).toBeDefined();
    expect(row!.value).not.toContain(secretShaped);
    expect(row!.value).not.toContain("here is a fake token-shaped string");

    // And the numbers themselves DID make it through — this isn't passing
    // because burn was silently dropped.
    const parsed = JSON.parse(row!.value) as StudioStatus;
    expect(parsed.burn?.inputTokens).toBe(12);
    expect(parsed.burn?.outputTokens).toBe(34);
  });

  it("registry.ts's own defensive reconstruction: a burn object with a rogue extra string field is stripped down to the known numeric/ISO shape", async () => {
    const rogue = { turns: 1, inputTokens: 2, outputTokens: 3, costUsd: 0, window5hStart: "2026-08-16T00:00:00.000Z", window5hOutput: 3, sneaky: "sk-ant-shouldnotpersist" } as unknown as Burn;
    const id = "websites--burn-rogue-field";
    await recordStudio(env as unknown as Env, status({ id, burn: rogue }));
    const row = await env.DB.prepare(`SELECT value FROM fleet_state WHERE key = ?`).bind(`studio:${id}`).first<{ value: string }>();
    expect(row!.value).not.toContain("sneaky");
    expect(row!.value).not.toContain("shouldnotpersist");
    const parsed = JSON.parse(row!.value) as StudioStatus;
    expect(parsed.burn).toEqual({ turns: 1, inputTokens: 2, outputTokens: 3, costUsd: 0, window5hStart: "2026-08-16T00:00:00.000Z", window5hOutput: 3 });
  });
});

// Issue #130: the worktree-session adopt (PR #120) copies a lead's transcript
// into the root project key. The burn cursor is keyed by in-archive path, so
// the copy was a NEW path read from offset 0: the first sync tick after an
// adopt re-counted the whole transcript (measured on the production tar:
// ~201,602 output tokens / 140 turns counted twice).
describe("parseUsageIncrement — an adopted copy of a counted transcript adds nothing (issue #130)", () => {
  const W = ".claude/projects/-workspace-fleetflare--claude-worktrees-wt1/b1c006ac-dd42-48a7-a063-90400c353858.jsonl";
  const R = ".claude/projects/-workspace-fleetflare/b1c006ac-dd42-48a7-a063-90400c353858.jsonl";
  const turn = (out: number) => JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1, output_tokens: out } } }) + "\n";
  const text = turn(100) + turn(200) + turn(300);

  it("a copied transcript adds 0 turns and 0 tokens", () => {
    const prev = { fileOffsets: { [W]: text.length } };
    const { delta, cursor } = parseUsageIncrement(prev, new Map([[W, text], [R, text]]));
    expect(delta).toEqual({ turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(cursor.fileOffsets[pathMapKey(R)]).toBe(text.length);
  });

  it("what claude appends to the copy after the adopt is counted exactly once", () => {
    const prev = { fileOffsets: { [W]: text.length } };
    const first = parseUsageIncrement(prev, new Map([[W, text], [R, text]]));
    const second = parseUsageIncrement(first.cursor, new Map([[W, text], [R, text + turn(7)]]));
    expect(second.delta).toEqual({ turns: 1, inputTokens: 1, outputTokens: 7, costUsd: 0 });
  });

  it("only the counted prefix is inherited: uncounted worktree lines are still counted once, via the copy", () => {
    const counted = turn(100);
    const prev = { fileOffsets: { [W]: counted.length } };
    const { delta } = parseUsageIncrement(prev, new Map([[W, counted], [R, text]]));
    expect(delta.outputTokens).toBe(500);
  });

  it("a same-name file whose content differs is not deduped — counted in full", () => {
    const other = turn(9);
    // #154: over a cursor this code wrote itself, the divergence is caught by
    // the fingerprint at the session's own `counted` — see the hash-pin test.
    const first = parseUsageIncrement({ fileOffsets: {} }, new Map([[W, text]]));
    const { delta } = parseUsageIncrement(first.cursor, new Map([[W, text], [R, other + other + other + other]]));
    expect(delta.outputTokens).toBe(36);
  });

  it("#154 rule (i): on the ONE tick that migrates a pre-#154 cursor, a same-session path is trusted on LENGTH", () => {
    // A pre-#154 cursor carries an offset but no fingerprint, so nothing about
    // it is verifiable. The rule trusts it on length for that single tick —
    // deliberately, because the alternative is re-counting every studio's
    // whole live transcript on the deploy that lands #154 (M1/M2/M3 below).
    // From the next tick the entry is hashed and a divergence is caught.
    const other = turn(9);
    const legacy = { fileOffsets: { [W]: text.length } };
    const migrating = parseUsageIncrement(legacy, new Map([[W, text], [R, other + other + other + other]]));
    expect(migrating.delta.outputTokens).toBe(0);
    // #258: `sessions` is now persisted under a short structural id, not the
    // literal session key string (see burn.ts's `sessionMapKey`) — one entry
    // for this one session either way, its hash half non-empty once a real
    // (not hashless) entry replaces the migration seed.
    const entries = Object.values(migrating.cursor.sessions ?? {});
    expect(entries).toHaveLength(1);
    const encoded = entries[0]!;
    expect(encoded.slice(encoded.indexOf(":") + 1).length).toBeGreaterThan(0);
  });

  it("an unrelated new session file is counted in full", () => {
    const N = ".claude/projects/-workspace-fleetflare/0f0f0f0f-1111-4222-8333-444444444444.jsonl";
    const prev = { fileOffsets: { [W]: text.length } };
    const { delta } = parseUsageIncrement(prev, new Map([[W, text], [N, text]]));
    expect(delta.outputTokens).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// Issue #154. #120 (the block above) keyed the fix to a SIBLING with the same
// basename living in the SAME tick's map, inheriting that sibling's PREVIOUS
// offset. Five shapes measured on a real transcript (2026-09-24, claude
// 2.1.224) still over-count, because either no sibling is present (claude
// moved the file itself), or the sibling's previous offset is the wrong
// number, or the file shrank so the prefix check cannot run at all. A
// transcript's identity is its path INSIDE its project key, taken from the tar
// NAME; the project key is only where that transcript happened to live when a
// tick saw it. Numbers below are the verifier's own, to the token.
//
// Every shape runs twice over the very same bytes: through the whole-text
// reference `parseUsageIncrement`, and through the STREAMING production
// `burnIncrement` over a real gzip'd tar (the shape session-sync.ts hands it,
// burn.ts:burnIncrement is what the sync tick actually calls). The two are
// asserted equal result-for-result as well — the fix is worthless if only the
// reference has it (PR #173 round-1's own defect).
// ---------------------------------------------------------------------------

const SID = "b1c006ac-dd42-48a7-a063-90400c353858";
const RK = ".claude/projects/-workspace-fleetflare";
// A realistic worktree-checkout-shaped project key (76 chars) — the kind
// claude actually escapes a worktree cwd into (e.g. this very fix's own
// checkout), NOT the short bare-root key `RK` above. `RK` alone understates
// `fileOffsets`' real cost: that map is keyed by the FULL literal path,
// project-key prefix included, so a short fixture key hides how much a real
// worktree deployment's longer prefix costs (issue #258 round-4 review).
const RK_WORKTREE = ".claude/projects/-workspace-fleetflare--claude-worktrees-fix-258-burn-cursor";
const ROOT = `${RK}/${SID}.jsonl`;
const WT1 = `.claude/projects/-workspace-fleetflare--claude-worktrees-wt1/${SID}.jsonl`;
const WT2 = `.claude/projects/-workspace-fleetflare--claude-worktrees-wt2/${SID}.jsonl`;
const OTHER = `${RK}/0f0f0f0f-1111-4222-8333-444444444444.jsonl`;
// The REAL subagent layout, as claude writes it (40 of 40 files on a live
// container): the parent session's uuid is a DIRECTORY, and the file itself is
// `agent-<hex>`. Its own in-file `sessionId` is the PARENT's uuid, which is why
// identity must come from the name.
const SUB_A = `${RK}/${SID}/subagents/agent-a1fee8492e1832af3.jsonl`;
const SUB_B = `${RK}/${SID}/subagents/agent-a3d3e799acf79a88c.jsonl`;
const WF_C = `${RK}/${SID}/subagents/workflows/wf_69b1da0e-a0c/agent-a6c0e8e56741f00e5.jsonl`;
// PR #173's own fixture layout, which matches zero real files — kept only to
// prove it now falls back to a safe full re-count rather than a silent skip.
const FAKE_SUB = `${RK}/subagents/${SID}.jsonl`;

let burnSeq = 0;
/** One assistant line per output-token count, each with its own uuid — real
 *  transcript lines carry a top-level `sessionId` and an adopt COPY keeps it
 *  byte for byte, so the fixtures carry it too: the guards below are only
 *  honest if a copy and a coincidence look identical from inside the file. */
const turn154 = (outTokens: number): string =>
  `${JSON.stringify({
    type: "assistant",
    sessionId: SID,
    uuid: `synthetic-${burnSeq++}`,
    message: { role: "assistant", model: "claude-fable-5", usage: { input_tokens: 1, output_tokens: outTokens } },
  })}\n`;
const text154 = (...outs: number[]): string => outs.map(turn154).join("");

/** One tick's tar: member name -> whole content, in TAR ORDER. */
type Tick = { files: [string, string][]; output: number };
type Shape = { prev?: BurnCursor; ticks: Tick[] };

const gzTick = async (files: [string, string][]): Promise<Uint8Array> =>
  gzipBytes(buildTar(files.map(([name, content]) => ({ name, content }))));

/**
 * Runs one shape's ticks through the reference and the production path over
 * identical bytes, asserting each tick's output-token delta AND that the two
 * implementations agree on the entire result (cursor, delta, parseSkips).
 */
async function bothEngines(shape: Shape): Promise<void> {
  let refCursor: BurnCursor = shape.prev ?? { fileOffsets: {} };
  let prodCursor: BurnCursor = shape.prev ?? { fileOffsets: {} };
  for (const [i, tick] of shape.ticks.entries()) {
    const gz = await gzTick(tick.files);
    const reference = parseUsageIncrement(refCursor, await extractJsonlMembers(gz));
    const production = await burnIncrement(prodCursor, gz);
    expect({ tick: i, output: reference.delta.outputTokens }).toEqual({ tick: i, output: tick.output });
    expect({ tick: i, output: production.delta.outputTokens }).toEqual({ tick: i, output: tick.output });
    expect(production).toEqual(reference);
    refCursor = reference.cursor;
    prodCursor = production.cursor;
  }
}

describe("burn cursor — a moved, re-adopted, shrunken or subagent transcript counts each line once (issue #154)", () => {
  // -- the five measured shapes, plus PR #173's own four guards ------------
  it("rename + append before the first sync (claude's own worktree move): 3,000, not 204,602", async () => {
    const head = text154(200_000, 1_602);
    await bothEngines({ ticks: [
      { files: [[ROOT, head]], output: 201_602 },
      { files: [[WT1, head + text154(3_000)]], output: 3_000 },
    ] });
  });

  it("tail written after the last sync, then adopt: 55,714, not 111,428", async () => {
    const head = text154(145_888);
    const grown = head + text154(55_714);
    await bothEngines({ ticks: [
      { files: [[WT1, head]], output: 145_888 },
      { files: [[WT1, grown], [ROOT, grown]], output: 55_714 },
    ] });
  });

  it("tail then adopt, the ROOT copy FIRST in the tar: still 55,714", async () => {
    const head = text154(145_888);
    const grown = head + text154(55_714);
    await bothEngines({ ticks: [
      { files: [[WT1, head]], output: 145_888 },
      { files: [[ROOT, grown], [WT1, grown]], output: 55_714 },
    ] });
  });

  it("live re-adopt (the copy is first seen mid-write): 0, not 55,714", async () => {
    const full = text154(55_714);
    const torn = full.slice(0, 40);
    expect(torn).not.toContain("\n");
    await bothEngines({ ticks: [
      { files: [[WT1, full]], output: 55_714 },
      { files: [[WT1, full], [ROOT, torn]], output: 0 },
      { files: [[WT1, full], [ROOT, full]], output: 0 },
    ] });
  });

  it("move to another worktree after resume: 30, not 3,030", async () => {
    const head = text154(3_000);
    await bothEngines({ ticks: [
      { files: [[ROOT, head]], output: 3_000 },
      { files: [[WT1, head]], output: 0 },
      { files: [[WT2, head + text154(30)]], output: 30 },
    ] });
  });

  it("shrink on re-adopt (a truncated copy lands over the counted file): 0, not 201,632", async () => {
    const head = text154(201_632);
    await bothEngines({ ticks: [
      { files: [[ROOT, head + text154(30)]], output: 201_662 },
      { files: [[ROOT, head]], output: 0 },
    ] });
  });

  it("after a shrink, a regrown file still counts the lines the session never had counted, exactly once", async () => {
    const head = text154(1_000);
    const full = head + text154(30);
    await bothEngines({ ticks: [
      { files: [[ROOT, full]], output: 1_030 },
      { files: [[ROOT, head]], output: 0 },
      { files: [[ROOT, full + text154(7)]], output: 7 },
    ] });
  });

  it("migration: a cursor persisted in the OLD path-keyed shape resumes after a move — no spike, no skipped line", async () => {
    const head = text154(120_000);
    const grown = head + text154(240);
    await bothEngines({
      prev: { fileOffsets: { [WT1]: head.length } }, // exactly what the shipped code left in DO storage
      ticks: [
        { files: [[ROOT, grown]], output: 240 },
        { files: [[ROOT, grown]], output: 0 },
      ],
    });
  });

  // -------------------------------------------------------------------------
  // Issue #258 round-2 review, BLOCKER 1: `decodeSessionCursor` must accept a
  // LEGACY (pre-#258) `sessions` entry — a plain `{counted, hash}` object,
  // keyed by the literal session key string — not just the new compact wire
  // STRING keyed by `sessionMapKey`. Every cursor sitting in every deployed
  // studio's DO storage right now is exactly this legacy shape; the moment
  // this feature deploys, the very first tick that reads an existing
  // `sessions` entry through the pre-fix decoder throws
  // (`TypeError: s.indexOf is not a function`) inside `resolveOffsets`'s own
  // eager decode loop — BEFORE any per-member logic runs, so it bites
  // regardless of which files that tick's tar actually holds.
  // session-sync.ts's outer catch (parseBurn) swallows it silently: burn
  // counting stops FLEET-WIDE on deploy, with no signal.
  //
  // LEGACY_CURSOR below is not a guess at the shape: it is the LITERAL JSON
  // `parseUsageIncrement` produced when run FOR REAL against commit
  // 22c4cc1 ("fix(studio): burn cursor keyed by project-relative path +
  // prefix fingerprint... — #154 (#173)"), the last commit before #258's own
  // encoding-shrink work — over the exact MAIN_TEXT/SUB_TEXT content below.
  // Regenerate by checking out that commit's burn.ts (archive.ts is
  // unchanged between there and here) and calling its own
  // `parseUsageIncrement({ fileOffsets: {} }, new Map([[ROOT, MAIN_TEXT],
  // [SUB_A, SUB_TEXT]])).cursor`.
  // -------------------------------------------------------------------------

  function legacyLine(uuid: string, outTokens: number): string {
    return `${JSON.stringify({
      type: "assistant", sessionId: SID, uuid,
      message: { role: "assistant", model: "claude-fable-5", usage: { input_tokens: 1, output_tokens: outTokens } },
    })}\n`;
  }

  const MAIN_TEXT = `${legacyLine("legacy-u1", 50)}${legacyLine("legacy-u2", 40)}`;
  const SUB_TEXT = `${legacyLine("legacy-u3", 10)}`;

  // Genuinely produced by pre-#258 (commit 22c4cc1) burn.ts's own
  // parseUsageIncrement — see this block's own header comment.
  const LEGACY_CURSOR: BurnCursor = {
    fileOffsets: {
      [ROOT]: 386,
      [SUB_A]: 193,
    },
    fileHashes: {
      [ROOT]: "1xquv2p:1iqais5",
      [SUB_A]: "6ggohk:135la98",
    },
    // The OLD shape — `Record<string, SessionCursor>` keyed by the LITERAL
    // session key string, not `sessionMapKey`'s short id, and each entry a
    // plain object, not `encodeSessionCursor`'s compact wire string. Cast
    // through `unknown`: this is deliberately NOT the shape
    // `BurnCursor.sessions`'s own TS type currently declares — a live
    // studio's DO storage holds exactly this regardless of what a freshly
    // deployed reader's type says it expects.
    sessions: {
      [SID]: { counted: 386, hash: "1xquv2p:1iqais5" },
      [`${SID}/subagents/agent-a1fee8492e1832af3`]: { counted: 193, hash: "6ggohk:135la98" },
    } as unknown as Record<string, string>,
  };

  describe("decodeSessionCursor — BLOCKER: a legacy (pre-#258) {counted, hash} object must not crash the reader (issue #258 round-2)", () => {
    it("parseUsageIncrement: a real pre-#258 cursor is read without throwing, and counting resumes past its own offset (no reset, no spike)", () => {
      const grownMain = MAIN_TEXT + legacyLine("legacy-u4", 77);
      const { delta, parseSkips } = parseUsageIncrement(LEGACY_CURSOR, new Map([[ROOT, grownMain], [SUB_A, SUB_TEXT]]));
      expect(parseSkips).toBe(0);
      // Exactly the ONE new line's own tokens — not a full re-count (386+193
      // bytes' worth) and not zero (the legacy offset silently trusted past
      // the new line too).
      expect(delta).toEqual({ turns: 1, inputTokens: 1, outputTokens: 77, costUsd: 0 });
    });

    it("burnIncrement (streaming production path): same real pre-#258 cursor, same result as the reference", async () => {
      const grownMain = MAIN_TEXT + legacyLine("legacy-u4", 77);
      const gz = await gzipBytes(buildTar([{ name: ROOT, content: grownMain }, { name: SUB_A, content: SUB_TEXT }]));
      const production = await burnIncrement(LEGACY_CURSOR, gz);
      expect(production.delta).toEqual({ turns: 1, inputTokens: 1, outputTokens: 77, costUsd: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #258 round-4 review (finding 1 / finding 2): a FORCED `pathMapKey`
  // collision, combined with the compaction pass's own single-path-session
  // property, used to bypass rule (c)'s fingerprint check entirely (blind
  // trust-by-length) — the fail-safe argument `pathMapKey`'s own doc comment
  // makes was never actually exercised by a real collision anywhere in this
  // suite. `__setPathMapKeyForTest` is the seam: real collision odds are far
  // too small to hit by picking literal strings (that IS the argument this
  // suite is trying to prove), so this forces one instead of merely asserting
  // the math.
  // ---------------------------------------------------------------------------
  describe("pathMapKey collision fail-safe, FORCED (issue #258 round-4 review, findings 1 & 2)", () => {
    const P1 = `${RK}/sess-collide-one/agent-p1.jsonl`; // session "sess-collide-one/agent-p1"
    const P2 = `${RK}/sess-collide-two/agent-p2.jsonl`; // session "sess-collide-two/agent-p2" — unrelated to P1

    it("a compacted single-path session's leftover offset is NOT blindly inherited by an unrelated path forced onto the same pathMapKey id", async () => {
      __setPathMapKeyForTest(() => "forced-collision-id"); // every path this test touches maps to the SAME id
      try {
        // Tick 0: P1 alone — a single-path session, so resolveOffsets' own
        // compaction pass strips fileHashes["forced-collision-id"] at the end
        // of this very tick (entry.counted === fileOffsets[pid] holds for
        // every ordinary single-path session — see the compaction pass's own
        // doc comment). `prev.pathSession["forced-collision-id"]` is left
        // pointing at P1's session, permanently, until pruned.
        const p1Body = text154(10);
        // Tick 1: P2 alone — a WHOLLY different, never-before-seen session
        // that happens to collide with P1's id. Long enough that
        // `length >= stored` (P1's leftover offset) is satisfied, so rule (c)
        // actually reaches the branch this bug lived in rather than
        // short-circuiting past it for an unrelated reason.
        const p2Body = text154(100, 200, 300);
        expect(p2Body.length).toBeGreaterThan(p1Body.length); // the gate this test needs to actually exercise
        await bothEngines({ ticks: [
          { files: [[P1, p1Body]], output: 10 },
          // The bug (pre-round-4-fix): P2 silently inherits P1's stored
          // offset with ZERO content verification (`want === undefined`, no
          // `prev.pathSession` check), starting partway through its own real
          // content instead of at 0 — an under-count. The fix: rule (c)
          // refuses to trust by length once `prev.pathSession[pid]` shows
          // this id has a real (merely unreadable-from-here) fingerprint
          // history, so P2 falls through to rule (g) — full recount, 600.
          { files: [[P2, p2Body]], output: 600 },
        ] });
      } finally {
        __setPathMapKeyForTest(null); // MUST restore — module-level singleton
      }
    });

    it("sanity: the SAME two ticks, with the real (non-colliding) pathMapKey, already count correctly — the forced seam above is what's under test, not the fixture", async () => {
      const p1Body = text154(10);
      const p2Body = text154(100, 200, 300);
      await bothEngines({ ticks: [
        { files: [[P1, p1Body]], output: 10 },
        { files: [[P2, p2Body]], output: 600 },
      ] });
    });
  });

  it("guard: an unrelated session with IDENTICAL bytes (same embedded sessionId, its own transcript uuid) is counted in FULL", async () => {
    const body = text154(55_714);
    await bothEngines({ ticks: [
      { files: [[ROOT, body]], output: 55_714 },
      { files: [[ROOT, body], [OTHER, body]], output: 55_714 },
    ] });
  });

  it("guard: PR #173's own `<project>/subagents/<uuid>.jsonl` fixture layout (zero real files) is counted in FULL", async () => {
    const body = text154(55_714);
    await bothEngines({ ticks: [
      { files: [[ROOT, body]], output: 55_714 },
      { files: [[ROOT, body], [FAKE_SUB, body]], output: 55_714 },
    ] });
  });

  it("guard: a REAL-layout subagent transcript, whose every line carries the PARENT's sessionId, is counted in FULL", async () => {
    const body = text154(55_714);
    await bothEngines({ ticks: [
      { files: [[ROOT, body]], output: 55_714 },
      { files: [[ROOT, body], [SUB_A, body]], output: 55_714 },
    ] });
  });

  // -- T2: a tail, the adopt, and a resume-append, all before one sync -----
  it("T2a tail after the last sync, adopt, and a resume-append in the ROOT copy, WT1 first: 56,614", async () => {
    const head = text154(145_888);
    const grown = head + text154(55_714);
    const extra = text154(900);
    await bothEngines({ ticks: [
      { files: [[WT1, head]], output: 145_888 },
      { files: [[WT1, grown], [ROOT, grown + extra]], output: 56_614 },
    ] });
  });

  it("T2b the same, ROOT first in the tar: 56,614", async () => {
    const head = text154(145_888);
    const grown = head + text154(55_714);
    const extra = text154(900);
    await bothEngines({ ticks: [
      { files: [[WT1, head]], output: 145_888 },
      { files: [[ROOT, grown + extra], [WT1, grown]], output: 56_614 },
    ] });
  });

  // -- R: several real subagents of ONE session ---------------------------
  // Each is its own conversation and its own key. PR #173 collapsed them all
  // onto `sub:<parent-uuid>`, so the shortest one was held and every longer
  // one re-counted.
  it("R1 two real subagents, the longer one first: 10,700, not 10,000", async () => {
    await bothEngines({ ticks: [
      { files: [[SUB_A, text154(5_000, 5_000)], [SUB_B, text154(700)]], output: 10_700 },
    ] });
  });

  it("R2 the SHORTER subagent first, then it grows: 11, not 0", async () => {
    const a = text154(5_000, 5_000);
    const b = text154(700);
    await bothEngines({ ticks: [
      { files: [[SUB_B, b], [SUB_A, a]], output: 10_700 },
      { files: [[SUB_B, b + text154(11)], [SUB_A, a]], output: 11 },
    ] });
  });

  it("R3 two subagents growing alternately over four ticks: 28,733, not 28,711", async () => {
    let a = text154(5_000, 5_000);
    let b = text154(700);
    const ticks: Tick[] = [{ files: [[SUB_A, a], [SUB_B, b]], output: 10_700 }];
    b += text154(11, 9_000, 9_000);
    ticks.push({ files: [[SUB_A, a], [SUB_B, b]], output: 18_011 });
    a += text154(22);
    ticks.push({ files: [[SUB_A, a], [SUB_B, b]], output: 22 });
    ticks.push({ files: [[SUB_A, a], [SUB_B, b]], output: 0 }); // idle tick
    expect(ticks.reduce((n, t) => n + t.output, 0)).toBe(28_733);
    await bothEngines({ ticks });
  });

  it("R4 a workflow agent alongside a plain subagent: 4,300, not 4,000", async () => {
    await bothEngines({ ticks: [
      { files: [[SUB_A, text154(4_000)], [WF_C, text154(300)]], output: 4_300 },
    ] });
  });

  it("R5 a pre-#154 cursor already holding both subagents' offsets, files unchanged: 0, not 10,000", async () => {
    const a = text154(5_000, 5_000);
    const b = text154(700);
    await bothEngines({
      prev: { fileOffsets: { [SUB_A]: a.length, [SUB_B]: b.length } },
      ticks: [{ files: [[SUB_A, a], [SUB_B, b]], output: 0 }],
    });
  });

  // -- M: the deploy tick that lands #154 over a live pre-#154 cursor ------
  const migrationHead = (): { head: string; recounted: string; legacy: BurnCursor } => {
    const head = text154(100_000);
    const recounted = head + text154(20_000);
    return { head, recounted, legacy: { fileOffsets: { [WT1]: head.length, [ROOT]: recounted.length } } };
  };

  it("M1 pre-#154 cursor, worktree original and root copy both in the tar, ROOT first: 500, not 120,500", async () => {
    const { head, recounted, legacy } = migrationHead();
    await bothEngines({ prev: legacy, ticks: [
      { files: [[ROOT, recounted + text154(500)], [WT1, head]], output: 500 },
    ] });
  });

  it("M2 the same, WT1 first in the tar: 500, not 120,500", async () => {
    const { head, recounted, legacy } = migrationHead();
    await bothEngines({ prev: legacy, ticks: [
      { files: [[WT1, head], [ROOT, recounted + text154(500)]], output: 500 },
    ] });
  });

  it("M3 the same with nothing new: 0, not 120,000 — and the NEXT tick's 9 tokens still count", async () => {
    const { head, recounted, legacy } = migrationHead();
    await bothEngines({ prev: legacy, ticks: [
      { files: [[WT1, head], [ROOT, recounted]], output: 0 },
      { files: [[WT1, head], [ROOT, recounted + text154(9)]], output: 9 },
    ] });
  });

  it("M4 a pre-#154 cursor whose file has since been TRUNCATED: 0 — a hashless shrink holds, never re-reads from 0", async () => {
    const full = text154(50_000, 50_000);
    const truncated = full.slice(0, full.indexOf("\n") + 1);
    await bothEngines({
      prev: { fileOffsets: { [ROOT]: full.length } },
      ticks: [{ files: [[ROOT, truncated]], output: 0 }],
    });
  });

  // -- S/D: under-count shapes the shrink HOLD must not create -------------
  it("S1 a static worktree prefix beside a growing root copy, WT1 first every tick: 10 per tick, never more", async () => {
    const head = text154(100_000);
    let root = head;
    const ticks: Tick[] = [{ files: [[WT1, head]], output: 100_000 }];
    for (let i = 0; i < 3; i++) {
      root += text154(10);
      ticks.push({ files: [[WT1, head], [ROOT, root]], output: 10 });
    }
    await bothEngines({ ticks });
  });

  it("S2 turns APPENDED to a truncated copy are counted at once (+77), not held until the file passes its old length", async () => {
    const head = text154(1_000);
    const full = head + text154(50_000, 50_000);
    const appended = head + text154(33, 44);
    await bothEngines({ ticks: [
      { files: [[ROOT, full]], output: 101_000 },
      { files: [[ROOT, head]], output: 0 },
      { files: [[ROOT, appended]], output: 77 },
      { files: [[ROOT, appended + text154(60_000, 60_000)]], output: 120_000 },
    ] });
  });

  it("D1 two DIVERGENT copies of one session id, one static and one growing: each new turn once, no per-tick re-count", async () => {
    const common = text154(10_000);
    const onlyInWorktree = text154(5);
    let root = common;
    const ticks: Tick[] = [
      { files: [[WT1, common]], output: 10_000 },
      { files: [[WT1, common + onlyInWorktree], [ROOT, common]], output: 5 },
    ];
    for (let i = 0; i < 4; i++) {
      root += text154(3);
      ticks.push({ files: [[WT1, common + onlyInWorktree], [ROOT, root]], output: 3 });
    }
    await bothEngines({ ticks });
  });

  // -- the fingerprint pin ------------------------------------------------
  it("hash pin: same session key, file LONGER than `counted`, but a different prefix — counted in FULL, never resumed", async () => {
    const counted = text154(4_000, 4_000);
    const divergent = text154(11, 22, 33);
    expect(divergent.length).toBeGreaterThanOrEqual(counted.length);
    await bothEngines({ ticks: [
      { files: [[ROOT, counted]], output: 8_000 },
      // Same key, long enough to resume — only the fingerprint at `counted`
      // says this is not that conversation. Delete that comparison (rule d in
      // burn.ts's resolveOffsets) and this test reads 33 instead of 66.
      { files: [[WT1, divergent]], output: 66 },
    ] });
  });

  it("hash pin: the SAME path, replaced by a divergent conversation at least as long — counted in FULL, never resumed", async () => {
    const counted = text154(4_000, 4_000);
    const replaced = text154(11, 22, 33);
    expect(replaced.length).toBeGreaterThanOrEqual(counted.length);
    await bothEngines({ ticks: [
      { files: [[ROOT, counted]], output: 8_000 },
      // Long enough to resume at `counted` on length alone, and this time the
      // stored offset belongs to THIS very path. Both fingerprint gates have to
      // reject it — rule (c)'s against `fileHashes[path]` and rule (d)'s against
      // the session's `hash`. Delete either comparison and this reads 33.
      { files: [[ROOT, replaced]], output: 66 },
    ] });
  });

  // Round-3 HOLD: a hashless legacy seed (rule i) is trusted on LENGTH
  // (rule d) forever, not just the tick it was seeded on. A file that later
  // passes the legacy length by coincidence jumps `start` straight to
  // `counted`, silently skipping every genuinely new line between its own
  // verified offset and that stale length — an UNDER-count, the direction
  // burn.ts's own header forbids.
  it("H1 hashless legacy seed is trusted on length only the tick it was seeded — a later coincidental length match does not skip new lines", async () => {
    const full = text154(50_000, 50_000, 1, 1, 1, 1, 1, 1);
    const truncated = full.slice(0, full.indexOf("\n") + 1);
    const appended = truncated + text154(33, 44);
    const grown = appended + text154(60_000, 60_000, 1, 1, 1, 1);
    expect(appended.length).toBeLessThan(full.length);
    expect(full.length).toBeLessThan(grown.length);
    await bothEngines({
      prev: { fileOffsets: { [ROOT]: full.length } },
      ticks: [
        { files: [[ROOT, truncated]], output: 0 },
        { files: [[ROOT, appended]], output: 77 },
        // `grown` has now passed the legacy seed's own `full.length` — rule
        // (d) must NOT treat that as "resume from `counted`" this far past
        // the seeding tick, or every line between `appended`'s own verified
        // offset and the stale legacy length vanishes uncounted.
        { files: [[ROOT, grown]], output: 120_004 },
      ],
    });
  });

  it("H2 hashless legacy seed, file moves worktree before passing the legacy length — same bound, different path", async () => {
    const full = text154(50_000, 50_000, 1, 1, 1, 1, 1, 1);
    const truncated = full.slice(0, full.indexOf("\n") + 1);
    const appended = truncated + text154(33, 44);
    const moved = appended + text154(5);
    const grown = moved + text154(60_000, 60_000);
    // Both must stay SHORTER than the legacy seed (`full`) — a fixture that
    // grows past `full` before it moves worktrees never enters the shape
    // this test exists to cover (a reviewer's own earlier fixture used a
    // 2-line `full`, silently broke this precondition, and produced a wrong
    // baseline as a result — see #154's round-3 HOLD history).
    expect(appended.length).toBeLessThan(full.length);
    expect(moved.length).toBeLessThan(full.length);
    await bothEngines({
      prev: { fileOffsets: { [ROOT]: full.length } },
      ticks: [
        { files: [[ROOT, truncated]], output: 0 },
        { files: [[ROOT, appended]], output: 77 },
        { files: [[WT1, moved]], output: 5 },
        { files: [[WT1, grown]], output: 120_000 },
      ],
    });
  });

  // Direction pin, not a real shape: a hashless seed cannot tell "the
  // original content came back" from "genuinely new content arrived" — it
  // has no fingerprint to compare against, by definition. Once rule (h)
  // replaces it on its own seeding tick (even at a LOWER offset, per the
  // fix above), the ORIGINAL full content returning right after that hold
  // re-counts in full rather than resuming silently. Accepted: an
  // over-count is the safe direction (burn.ts's own header forbids the
  // opposite, under-counting), and this is the cost of closing H1/H2's
  // real under-count bug.
  it("hashless seed, direction pin: original content returning right after the seeding-tick hold re-counts in full (accepted over-count, never under)", async () => {
    const full = text154(50_000, 50_000, 1, 1, 1, 1, 1, 1);
    const truncated = full.slice(0, full.indexOf("\n") + 1);
    await bothEngines({
      prev: { fileOffsets: { [ROOT]: full.length } },
      ticks: [
        { files: [[ROOT, truncated]], output: 0 },
        { files: [[ROOT, full]], output: 50_006 },
      ],
    });
  });
});

describe("burn cursor — identity comes from the tar NAME, never from a line's own sessionId (issue #154)", () => {
  it("a subagent's every line carries the PARENT's uuid, yet each subagent keeps its own cursor entry", () => {
    const a = text154(4_000);
    const b = text154(700);
    const first = parseUsageIncrement({ fileOffsets: {} }, new Map([[SUB_A, a], [SUB_B, b], [WF_C, text154(300)]]));
    expect(first.delta.outputTokens).toBe(5_000);
    // #258: `sessions` is now keyed by a short structural id derived from
    // `sessionKeyOf`'s own output (see burn.ts's `sessionMapKey`), not the
    // literal key string — three DISTINCT entries either way, one per
    // subagent, which is the invariant this test is actually pinning.
    expect(Object.keys(first.cursor.sessions ?? {})).toHaveLength(3);
  });

  it("the main transcript's key is the bare session uuid, shared by every project key it has lived under", () => {
    const body = text154(12);
    const first = parseUsageIncrement({ fileOffsets: {} }, new Map([[WT2, body]]));
    expect(Object.keys(first.cursor.sessions ?? {})).toHaveLength(1);
    // ...so the same session under a different project key resumes, not restarts
    const second = parseUsageIncrement(first.cursor, new Map([[ROOT, body]]));
    expect(second.delta.outputTokens).toBe(0);
  });

  it("a jsonl member outside `.claude/projects/<key>/` has no session identity and keeps the plain per-path offset", () => {
    const body = text154(9);
    const stray = "home/user/notes.jsonl";
    const first = parseUsageIncrement({ fileOffsets: {} }, new Map([[stray, body]]));
    expect(first.delta.outputTokens).toBe(9);
    expect(first.cursor.sessions).toEqual({});
    expect(first.cursor.fileOffsets[pathMapKey(stray)]).toBe(body.length);
    expect(parseUsageIncrement(first.cursor, new Map([[stray, body]])).delta.outputTokens).toBe(0);
  });
});

describe("burn cursor storage — one DO value, nothing pruned (issue #154)", () => {
  // A DO SQLite value is capped at 2 MB (key+value). The cursor holds three
  // entries per path: the offset (which a rollback to pre-#154 code reads),
  // its fingerprint, and the session entry that carries inheritance. Nothing
  // is pruned in this change — a studio that never sheds a subagent path grows
  // this value linearly, which is why pruning is tracked as its own follow-up.
  const cursorFor = (paths: number, projectKey: string = RK): BurnCursor => {
    const files = new Map<string, string>();
    for (let i = 0; i < paths; i++) {
      files.set(`${projectKey}/${SID}/subagents/agent-${i.toString(16).padStart(17, "0")}.jsonl`, text154(1));
    }
    return parseUsageIncrement({ fileOffsets: {} }, files).cursor;
  };

  /**
   * Issue #258 round-2 review (BLOCKER 2): the ACTUAL value session-sync.ts
   * persists to `BURN_CURSOR_KEY` — after `pruneCursor` runs, with a real
   * `lastSeenAt` entry per path, exactly the sequence `parseBurn` runs
   * (`burnIncrement`/`parseUsageIncrement` -> `pruneCursor` -> `storage.put`).
   * The pre-round-2 test measured `cursorFor`'s own return value directly —
   * BEFORE `pruneCursor`, so BEFORE `lastSeenAt` ever entered the byte count
   * at all — which is why its claim didn't hold: the real stored value (this
   * function's return) was 2.17 MB at 6,000 realistic paths, already over the
   * 2 MB DO cap the claim itself was about.
   */
  const storedCursorFor = (paths: number, projectKey: string = RK, now = new Date("2026-09-25T00:00:00.000Z")): BurnCursor => {
    const files = new Map<string, string>();
    for (let i = 0; i < paths; i++) {
      files.set(`${projectKey}/${SID}/subagents/agent-${i.toString(16).padStart(17, "0")}.jsonl`, text154(1));
    }
    const { cursor, presentPaths } = parseUsageIncrement({ fileOffsets: {} }, files);
    return pruneCursor(cursor, presentPaths, now);
  };

  it("a fingerprint is at most 16 chars", () => {
    const cursor = cursorFor(8);
    // #258: each path's own fileHashes entry is now compacted away (it is
    // exactly reconstructable from the session's own inheritance record —
    // see resolveOffsets' own compaction pass), so the fingerprint now lives
    // in the encoded `sessions` entry instead. Still one per path, still
    // short.
    expect(Object.keys(cursor.fileHashes ?? {})).toHaveLength(0);
    const encoded = Object.values(cursor.sessions ?? {});
    expect(encoded.length).toBe(8);
    for (const entry of encoded) {
      const hash = entry.slice(entry.indexOf(":") + 1);
      expect(hash.length).toBeLessThanOrEqual(16);
    }
  });

  it("1,000 subagent paths stay under 1 MB", () => {
    expect(JSON.stringify(cursorFor(1_000)).length).toBeLessThan(1_048_576);
  });

  it("5,000 subagent paths stay inside the 2 MB DO value cap", () => {
    // MEASURED, not a guess — see the PR body: ~1.9 MB at this path count, of
    // which ~0.63 MB is `fileOffsets` alone (mandatory: a rollback reads it).
    // The follow-up that prunes paths absent from the tar is what buys real
    // headroom; this assertion is the canary until then.
    expect(JSON.stringify(cursorFor(5_000)).length).toBeLessThan(2 * 1_048_576);
  });

  // Issue #258 round-2 review (BLOCKER 2): the STORED (post-`pruneCursor`,
  // real `lastSeenAt`) value at a realistic 76-char worktree-checkout project
  // key — see `storedCursorFor`'s own doc comment for why this replaces the
  // pre-round-2 test's pre-prune measurement.
  //
  // Issue #258 round-3 (maestro brief item 1): `fileOffsets`/`fileHashes`
  // themselves moved off literal-path keys onto `pathMapKey`'s short id (see
  // that field's own doc comment) — the term that used to dominate this
  // measurement and cap real capacity near 9,000-9,300 paths. MEASURED on
  // this round's own 153-char `RK_WORKTREE` paths (real worktree-checkout
  // shape, not a short bare-root key):
  //   6,000  paths: ~0.66 MB stored (fileOffsets alone: ~0.11 MB)
  //   9,000  paths: ~0.99 MB stored (fileOffsets alone: ~0.17 MB)
  //   10,000 paths: ~1.10 MB stored (fileOffsets alone: ~0.19 MB) — now fits
  //     comfortably under the 1.5 MB target the pre-round-3 numbers here
  //     claimed it could not (~2.13 MB stored, ~1.59 MB for `fileOffsets`
  //     alone) — the whole point of this round's shrink.
  // The 20,000-path emergency-prune scenario below (issue #258 round-3 item
  // 2) is what stress-tests the NEXT ceiling this shrink alone does not
  // solve on its own (a fleet that keeps outrunning even THIS smaller
  // per-path cost).
  it("6,000 realistic subagent paths, as ACTUALLY STORED (post-prune), fit comfortably under 1.5 MB (issue #258)", () => {
    const bytes = JSON.stringify(storedCursorFor(6_000, RK_WORKTREE)).length;
    expect(bytes).toBeLessThan(1.5 * 1_048_576);
  });

  it("9,000 realistic subagent paths, as ACTUALLY STORED, fit comfortably under 1.5 MB (issue #258)", () => {
    const bytes = JSON.stringify(storedCursorFor(9_000, RK_WORKTREE)).length;
    expect(bytes).toBeLessThan(1.5 * 1_048_576);
  });

  // Issue #258 round-3 (maestro brief item 1): END STATE the brief asked
  // for, verbatim — 10,000 paths, 7-digit-realistic offsets (`text154(1)`'s
  // own single-turn body is short, but the OFFSET each entry stores is this
  // whole subagent layout's own char count, which lands in the low 100s per
  // path here — see the fileOffsets-alone assertion below for the actual
  // shrink being measured, independent of any one offset's own digit count),
  // exact stored value MEASURED under 1.5 MB, not target-fit.
  it("10,000 realistic subagent paths, as ACTUALLY STORED, fit under 1.5 MB (issue #258 round-3 item 1)", () => {
    const stored = storedCursorFor(10_000, RK_WORKTREE);
    const bytes = JSON.stringify(stored).length;
    expect(bytes).toBeLessThan(1.5 * 1_048_576); // measured ~1.10 MB
  });

  it("fileOffsets ALONE (the mandatory, rollback-read map) shrinks by roughly 8x at 10,000 paths once it moves off literal-path keys", () => {
    // Pre-round-3 measurement on this same fixture shape (2ce3b860, this
    // round's own starting point): ~1.60 MB. Post-shrink: every key is now
    // `pathMapKey`'s short id instead of the full 153-char literal path.
    const stored = storedCursorFor(10_000, RK_WORKTREE);
    const fileOffsetsBytes = JSON.stringify(stored.fileOffsets).length;
    expect(fileOffsetsBytes).toBeLessThan(0.25 * 1_048_576); // measured ~0.19 MB
  });

  // ---------------------------------------------------------------------------
  // Issue #258 round-3 (maestro brief item 2): the emergency size-based prune.
  // Round-3 item 1's shrink alone still has a next ceiling — a fleet that
  // spawns paths FAST ENOUGH can outrun even the smaller per-path cost before
  // CURSOR_PRUNE_MS's 48h age-based window sheds any of them. MEASURED: at
  // 20,000 of this same realistic 153-char-path shape, `pruneCursor` (age-
  // based) alone leaves ~2.21 MB stored — OVER the 2 MB DO cap, exactly the
  // failure this belt exists to prevent (the persist itself would reject it).
  //
  // Memoized: building + resolving 20,000 realistic paths through the whole
  // `resolveOffsets`/`pruneCursor` pipeline is real work (fingerprinting every
  // path), and several tests below each need the SAME starting cursor — built
  // once, lazily, on first use, rather than five times over.
  // ---------------------------------------------------------------------------
  let cursor20k: BurnCursor | null = null;
  const stored20k = (): BurnCursor => (cursor20k ??= storedCursorFor(20_000, RK_WORKTREE));

  it("MUTANT PROOF: 20,000 realistic paths exceed the DO cap after age-based pruning ALONE — the scenario is real, not vacuous", () => {
    const bytes = JSON.stringify(stored20k()).length;
    // This is what session-sync.ts would try to `storage.put` if
    // pruneCursorForSize were skipped entirely — the mutant the brief asks
    // for. It is well past the DO cap, not merely over the 1.5 MB target.
    expect(bytes).toBeGreaterThan(2 * 1_048_576); // measured ~2.21 MB
  }, 20_000);

  it("pruneCursorForSize brings the SAME 20,000-path cursor back under the 1.5 MB target", () => {
    const sized = pruneCursorForSize(stored20k());
    expect(sized.removed).toBeGreaterThan(0);
    expect(sized.bytes).toBeLessThan(1.5 * 1_048_576);
    expect(JSON.stringify(sized.cursor).length).toBe(sized.bytes);
  }, 20_000);

  it("a no-op below the soft cap: fewer paths than the threshold requires are never touched", () => {
    const stored = storedCursorFor(1_000, RK_WORKTREE);
    const sized = pruneCursorForSize(stored);
    expect(sized.removed).toBe(0);
    expect(sized.cursor).toBe(stored); // same reference: a genuine no-op, not a copy
  });

  // Issue #258 round-4 review (finding 3): `pruneCursor`'s own `keepMapKeys`
  // derives a surviving path's session via `cursor.pathSession?.[pkey] ??
  // sessionKeyOf(pkey)` (a literal-path fallback) so a still-legacy
  // literal-keyed `fileOffsets` entry (possible for up to 48h post-deploy —
  // `pruneCursor`'s own migration-window doc comment) keeps its `sessions`
  // entry alive. An earlier `pruneCursorForSize` derived `keepMapKeys` from
  // `Object.values(pathSession)` ALONE, with no such fallback — harmless only
  // because session-sync.ts always calls `pruneCursor` first (which already
  // backfills `pathSession` for every survivor, legacy or not) and this
  // function on ITS output. This test calls `pruneCursorForSize` DIRECTLY,
  // bypassing `pruneCursor` entirely, to prove the standalone contract now
  // matches `pruneCursor`'s own fallback rather than relying on that
  // caller-order invariant.
  describe("pruneCursorForSize keeps a legacy literal-keyed survivor's `sessions` entry, matching pruneCursor's own fallback (issue #258 round-4 review, finding 3)", () => {
    it("a mixed legacy-literal-keyed + pid-keyed cursor: both survivors' session entries are kept", () => {
      const legacyPath = `${RK}/legacy-untouched/agent-legacy.jsonl`;
      const modernPath = `${RK}/modern-touched/agent-modern.jsonl`;

      // Real seeds, so `sessionMapKey`'s own (unexported) output is read off
      // a genuine cursor rather than reimplemented in the test.
      const legacySeed = parseUsageIncrement({ fileOffsets: {} }, new Map([[legacyPath, text154(5)]])).cursor;
      const legacyPid = Object.keys(legacySeed.fileOffsets)[0]!;
      const legacyMapKey = Object.keys(legacySeed.sessions ?? {})[0]!;
      const modernSeed = parseUsageIncrement({ fileOffsets: {} }, new Map([[modernPath, text154(7)]])).cursor;
      const modernPid = Object.keys(modernSeed.fileOffsets)[0]!;
      const modernMapKey = Object.keys(modernSeed.sessions ?? {})[0]!;
      expect(legacyMapKey).not.toBe(modernMapKey); // two genuinely distinct sessions

      const fileOffsets: Record<string, number> = {};
      const lastSeenAt: Record<string, number> = {};
      const pathSession: Record<string, string> = {};
      const sessions: Record<string, string> = {
        [legacyMapKey]: legacySeed.sessions![legacyMapKey]!,
        [modernMapKey]: modernSeed.sessions![modernMapKey]!,
      };

      // Filler entries: exactly one `pruneCursorForSize` RECHECK_BATCH's
      // worth, oldest-seen so they sort first and are the ONLY entries the
      // size-based eviction loop's first batch ever touches. No session
      // identity of their own (key === null shape) — pure byte padding to
      // force the size threshold, uninvolved in what this test proves.
      const FILLER_COUNT = 250;
      for (let i = 0; i < FILLER_COUNT; i++) {
        fileOffsets[`filler-${i}`] = 1;
        lastSeenAt[`filler-${i}`] = i;
      }

      // The legacy survivor: `fileOffsets` keyed by the LITERAL path (never
      // migrated to `pathMapKey`), no `pathSession` record — exactly the
      // shape `pruneCursor`'s own migration-window doc comment describes.
      fileOffsets[legacyPath] = legacySeed.fileOffsets[legacyPid]!;
      lastSeenAt[legacyPath] = 1_000_000; // newest — must survive

      // The modern survivor: pid-keyed, with its own `pathSession` record.
      fileOffsets[modernPid] = modernSeed.fileOffsets[modernPid]!;
      pathSession[modernPid] = modernMapKey;
      lastSeenAt[modernPid] = 1_000_001; // newest — must survive

      const cursor: BurnCursor = { fileOffsets, lastSeenAt, pathSession, sessions };
      const fullBytes = JSON.stringify(cursor).length;
      // Matches `pruneCursorForSize`'s own `snapshot()` shape exactly
      // (`fileOffsets`/`fileHashes`/`sessions`/`lastSeenAt`/`pathSession`,
      // `fileHashes` always present even when empty) so this buffer is
      // computed off the SAME bytes the real loop checks, not an approximation.
      const survivorsOnlyBytes = JSON.stringify({
        fileOffsets: { [legacyPath]: fileOffsets[legacyPath], [modernPid]: fileOffsets[modernPid] },
        fileHashes: {},
        sessions,
        lastSeenAt: { [legacyPath]: lastSeenAt[legacyPath], [modernPid]: lastSeenAt[modernPid] },
        pathSession: { [modernPid]: modernMapKey },
      }).length;

      // maxBytes just under the real size (forces the prune path to run at
      // all); targetBytes just over the survivors-only size (the ONE batch
      // that removes every filler is exactly enough — see FILLER_COUNT's own
      // comment above for why this is deterministic, not merely likely).
      const sized = pruneCursorForSize(cursor, fullBytes - 1, survivorsOnlyBytes + 10);

      expect(sized.removed).toBe(FILLER_COUNT);
      expect(Object.keys(sized.cursor.fileOffsets).sort()).toEqual([legacyPath, modernPid].sort());
      // The fix under test: the legacy survivor's OWN session entry is kept
      // even though it has no `pathSession` record of its own — matching
      // `pruneCursor`'s own fallback, not merely the pid-keyed survivor's.
      expect(sized.cursor.sessions?.[legacyMapKey]).toBe(sessions[legacyMapKey]);
      expect(sized.cursor.sessions?.[modernMapKey]).toBe(sessions[modernMapKey]);
    });
  });

  it("evicts LEAST-recently-seen first: the oldest paths are gone, the newest survive", () => {
    const stored = stored20k();
    // storedCursorFor's own lastSeenAt is uniform (one synthetic tick, one
    // `now`) — stamp a real age spread so "oldest first" has something to
    // prove: path 0 is the OLDEST (seen longest ago), the last path the
    // NEWEST (seen just now).
    const ids = Object.keys(stored.fileOffsets);
    const aged: BurnCursor = {
      ...stored,
      lastSeenAt: Object.fromEntries(ids.map((id, i) => [id, 1_000 + i])),
    };
    const oldestId = ids[0]!;
    const newestId = ids[ids.length - 1]!;

    const sized = pruneCursorForSize(aged);

    expect(sized.cursor.fileOffsets[oldestId]).toBeUndefined();
    expect(sized.cursor.fileOffsets[newestId]).toBe(aged.fileOffsets[newestId]);
    expect(sized.removed).toBe(ids.length - Object.keys(sized.cursor.fileOffsets).length);
  }, 20_000);

  it("fileHashes/lastSeenAt/pathSession/sessions are pruned in lockstep with fileOffsets — no orphaned entries", () => {
    const sized = pruneCursorForSize(stored20k());
    const survivingIds = new Set(Object.keys(sized.cursor.fileOffsets));

    for (const id of Object.keys(sized.cursor.fileHashes ?? {})) expect(survivingIds.has(id)).toBe(true);
    for (const id of Object.keys(sized.cursor.lastSeenAt ?? {})) expect(survivingIds.has(id)).toBe(true);
    for (const id of Object.keys(sized.cursor.pathSession ?? {})) expect(survivingIds.has(id)).toBe(true);

    const survivingMapKeys = new Set(Object.values(sized.cursor.pathSession ?? {}));
    for (const mapKey of Object.keys(sized.cursor.sessions ?? {})) expect(survivingMapKeys.has(mapKey)).toBe(true);
  }, 20_000);
});

describe("syncSessionTick — the emergency size-based prune is wired into the real tick (issue #258 round-3 item 2)", () => {
  it("a tick whose cursor would exceed the DO cap emergency-prunes before persisting, logging ONCE", async () => {
    const storage = fakeBurnStorage();
    const files: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) {
      files[`${RK_WORKTREE}/${SID}/subagents/agent-${i.toString(16).padStart(17, "0")}.jsonl`] = text154(1);
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await syncSessionTick(await fakeSyncDepsWithFiles(files, { now: "2026-09-25T00:00:00.000Z" }), storage, STUDIO_ID);

      const stored = (await storage.get(BURN_CURSOR_KEY))!;
      expect(JSON.stringify(stored).length).toBeLessThan(1.5 * 1_048_576);
      // Logged exactly once — not once per removed entry (there are thousands).
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/emergency-pruned \d+ least-recently-seen entries/);
    } finally {
      warnSpy.mockRestore();
    }
  }, 30_000);
});

// Issue #309 unit pins on pruneCursorForSize's order and accounting.
describe("pruneCursorForSize — absent first, live compacted, sessions counted inside the loop (issue #309)", () => {
  const livePath = (i: number) => `${RK_WORKTREE}/${SID}/subagents/agent-${i.toString(16).padStart(17, "0")}.jsonl`;
  const LIVE = 20_000;
  // Same fixture as the #154 block's own storedCursorFor (scoped there).
  const storedCursorFor = (paths: number, projectKey: string): BurnCursor => {
    const files = new Map<string, string>();
    for (let i = 0; i < paths; i++) {
      files.set(`${projectKey}/${SID}/subagents/agent-${i.toString(16).padStart(17, "0")}.jsonl`, text154(1));
    }
    const { cursor, presentPaths } = parseUsageIncrement({ fileOffsets: {} }, files);
    return pruneCursor(cursor, presentPaths, new Date("2026-09-25T00:00:00.000Z"));
  };
  let base: BurnCursor | null = null;
  const stored = (): BurnCursor => (base ??= storedCursorFor(LIVE, RK_WORKTREE));
  const presentAll = () => new Set(Array.from({ length: LIVE }, (_, i) => livePath(i)));

  it("every path present: nothing is evicted — every offset survives, compacted instead", () => {
    const before = stored();
    const sized = pruneCursorForSize(before, undefined, undefined, presentAll());
    expect(sized.removed).toBe(0);
    expect(sized.compacted).toBeGreaterThan(0);
    for (const [id, offset] of Object.entries(before.fileOffsets)) expect(sized.cursor.fileOffsets[id]).toBe(offset);
    expect(sized.bytes).toBeLessThanOrEqual(CURSOR_PERSIST_TARGET_BYTES);
  }, 60_000);

  it("absent paths go first: with half the paths absent, only absent ones are evicted", () => {
    const before = stored();
    const present = new Set(Array.from({ length: LIVE / 2 }, (_, i) => livePath(i)));
    const sized = pruneCursorForSize(before, undefined, undefined, present);
    const presentIds = new Set([...present].map((p) => pathMapKey(p)));
    for (const id of Object.keys(before.fileOffsets)) {
      if (presentIds.has(id)) expect(sized.cursor.fileOffsets[id]).toBe(before.fileOffsets[id]);
    }
    expect(sized.removed).toBeGreaterThan(0);
    expect(sized.bytes).toBeLessThanOrEqual(CURSOR_PERSIST_TARGET_BYTES);
  }, 60_000);

  it("a compacted live path keeps its session's entry", () => {
    const before = stored();
    const sized = pruneCursorForSize(before, undefined, undefined, presentAll());
    expect(Object.keys(sized.cursor.sessions ?? {}).sort()).toEqual(Object.keys(before.sessions ?? {}).sort());
  }, 60_000);

  it("sessions are counted INSIDE the loop: it stops within one batch of the target, never far below it", () => {
    const before = stored();
    const sized = pruneCursorForSize(before);
    const perEntry = JSON.stringify(before).length / Object.keys(before.fileOffsets).length;
    expect(sized.bytes).toBeLessThanOrEqual(CURSOR_PERSIST_TARGET_BYTES);
    expect(sized.bytes).toBeGreaterThan(CURSOR_PERSIST_TARGET_BYTES - 250 * perEntry);
  }, 60_000);
});

// Issue #309 (#282 round-3 review): above ~12k LIVE paths the size prune
// evicted paths still present (every one "seen just now"), and the next tick
// counted each evicted file again from 0 — measured ~10,500 tokens re-counted
// EVERY tick at 20k live paths with nothing new written.
describe("syncSessionTick — 20k LIVE paths, idle ticks re-count nothing (issue #309)", () => {
  it("tick 1 counts; 3 idle ticks on the same files add 0", async () => {
    const storage = fakeBurnStorage();
    const files: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) {
      files[`${RK_WORKTREE}/${SID}/subagents/agent-${i.toString(16).padStart(17, "0")}.jsonl`] = text154(1);
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await syncSessionTick(await fakeSyncDepsWithFiles(files, { now: "2026-09-25T00:00:00.000Z" }), storage, STUDIO_ID);
      const first = (await storage.get(BURN_KEY))!;
      expect(first.outputTokens).toBeGreaterThan(0);
      const idle: number[] = [];
      for (const now of ["2026-09-25T00:10:00.000Z", "2026-09-25T00:20:00.000Z", "2026-09-25T00:30:00.000Z"]) {
        const before = (await storage.get(BURN_KEY))!;
        await syncSessionTick(await fakeSyncDepsWithFiles(files, { now }), storage, STUDIO_ID);
        const after = (await storage.get(BURN_KEY))!;
        idle.push(after.outputTokens - before.outputTokens);
      }
      expect(idle).toEqual([0, 0, 0]);
      expect(JSON.stringify((await storage.get(BURN_CURSOR_KEY))!).length).toBeLessThan(CURSOR_PERSIST_SOFT_CAP_BYTES);
    } finally {
      warnSpy.mockRestore();
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Issue #258 (#173 round-3 review): pruning — a permanently-tracked path
// never sheds, so a long-running fleet that spawns one subagent after another
// grows burnCursor forever (measured: 1.77 MB at 5,000 paths, cap reached
// near ~5,900). `pruneCursor` drops fileOffsets/fileHashes/sessions entries
// for a path absent from the tar for CURSOR_PRUNE_MS of wall-clock time —
// never a raw tick count, since this fleet's own ticks have stalled for
// 20+ minutes at a time (session-sync.ts's own tarAndStatCmd doc comment).
// ---------------------------------------------------------------------------

describe("pruneCursor — stale (long-absent) entries are dropped, a live one never is (issue #258)", () => {
  const T0 = new Date("2026-09-01T00:00:00.000Z");
  const hoursLater = (h: number) => new Date(T0.getTime() + h * 3_600_000);

  it("CURSOR_PRUNE_MS is comfortably larger than the 24h budget-exclusion worst case", () => {
    // archive.ts's SESSION_SUBAGENT_WATERMARK_LOOKBACK_SECONDS (86_400s = 24h)
    // is the worst-case stretch session-sync.ts's own three-admission-rule
    // budget can hold a LIVE subagent out of a tick's tar. Pruning must never
    // fire before a live session could plausibly still be cycling in and out
    // under that rule.
    expect(CURSOR_PRUNE_MS).toBeGreaterThan(2 * 86_400_000 * 0.5); // >= 24h...
    expect(CURSOR_PRUNE_MS).toBeGreaterThanOrEqual(48 * 3_600_000); // ...with a full extra day of margin
  });

  it("(a) a path absent for LESS than the prune threshold stays", () => {
    const file = ".claude/projects/proj/agent-a.jsonl";
    const seeded: BurnCursor = pruneCursor({ fileOffsets: { [file]: 100 } }, new Set([file]), T0);
    // Absent from the tar for less than CURSOR_PRUNE_MS — still present.
    const later = pruneCursor(seeded, new Set(), hoursLater(24));
    expect(later.fileOffsets[file]).toBe(100);
  });

  it("(b) a path absent for AT LEAST the prune threshold is dropped", () => {
    const file = ".claude/projects/proj/agent-b.jsonl";
    const seeded = pruneCursor({ fileOffsets: { [file]: 100 } }, new Set([file]), T0);
    const afterThreshold = pruneCursor(seeded, new Set(), new Date(T0.getTime() + CURSOR_PRUNE_MS + 1));
    expect(afterThreshold.fileOffsets[file]).toBeUndefined();
  });

  it("(c) a path that CYCLES — present, absent for well under the threshold, present again — is never pruned, however many cycles", () => {
    const file = ".claude/projects/proj/agent-c.jsonl";
    let cursor: BurnCursor = { fileOffsets: { [pathMapKey(file)]: 42 } };
    // Simulates session-sync.ts's own budget/watermark rule squeezing a live
    // subagent out of one tick's tar and back in on the next, repeatedly,
    // each absence well under the prune threshold.
    for (let cycle = 0; cycle < 20; cycle++) {
      const absentAt = hoursLater(cycle * 10 + 2); // absent, ~2h into this cycle
      cursor = pruneCursor(cursor, new Set(), absentAt);
      expect(cursor.fileOffsets[pathMapKey(file)]).toBe(42); // never pruned mid-cycle
      const presentAt = hoursLater(cycle * 10 + 4); // back in the tar
      cursor = pruneCursor(cursor, new Set([file]), presentAt);
      expect(cursor.fileOffsets[pathMapKey(file)]).toBe(42);
    }
  });

  it("fileHashes and the session's own inheritance entry are pruned together with the path", () => {
    const file = ".claude/projects/proj/b1c006ac-dd42-48a7-a063-90400c353858.jsonl";
    const first = parseUsageIncrement({ fileOffsets: {} }, new Map([[file, text154(1)]]));
    const seeded = pruneCursor(first.cursor, new Set([file]), T0);
    expect(Object.keys(seeded.fileHashes ?? {})).toHaveLength(0); // #258: reconstructable, already deduped
    expect(Object.keys(seeded.sessions ?? {}).length).toBeGreaterThan(0);

    const pruned = pruneCursor(seeded, new Set(), new Date(T0.getTime() + CURSOR_PRUNE_MS + 1));
    expect(pruned.fileOffsets[file]).toBeUndefined();
    expect(pruned.fileHashes ?? {}).toEqual({});
    expect(pruned.sessions ?? {}).toEqual({}); // no path left referencing that session key
  });

  it("a never-before-seen path is treated as seen NOW, not instantly stale", () => {
    const file = ".claude/projects/proj/agent-d.jsonl";
    // No lastSeenAt tracked yet (a cursor persisted before this change) and
    // absent from THIS tick's tar — must not be pruned on the very first
    // tick pruning ever runs against it.
    const cursor: BurnCursor = { fileOffsets: { [file]: 5 } };
    const result = pruneCursor(cursor, new Set(), T0);
    expect(result.fileOffsets[file]).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Issue #258: presentPaths — what session-sync.ts's tick hands pruneCursor
// so it can tell "seen THIS tick" from "stale lastSeenAt", regardless of
// whether resolveOffsets found anything NEW to count for that path.
// ---------------------------------------------------------------------------

describe("parseUsageIncrement/burnIncrement report presentPaths (issue #258 pruning wiring)", () => {
  it("parseUsageIncrement: every member of jsonlByFile, even one with no new content this tick", () => {
    const seen = ".claude/projects/proj/agent-e.jsonl";
    const files = new Map([[seen, "short\n"]]);
    // Stored way past this tick's own length: rule (c)/(g) count nothing new,
    // but the path is still PRESENT in this tick's tar.
    const prev: BurnCursor = { fileOffsets: { [seen]: 999_999 } };
    const result = parseUsageIncrement(prev, files);
    expect(result.presentPaths).toEqual(new Set([seen]));
  });

  it("a path from a PRIOR tick absent from THIS tick's jsonlByFile is not reported present", () => {
    const gone = ".claude/projects/proj/agent-g.jsonl";
    const stillHere = ".claude/projects/proj/agent-h.jsonl";
    const prev: BurnCursor = { fileOffsets: { [gone]: 5 } };
    const { presentPaths } = parseUsageIncrement(prev, new Map([[stillHere, "x\n"]]));
    expect(presentPaths.has(gone)).toBe(false);
    expect(presentPaths.has(stillHere)).toBe(true);
  });

  it("burnIncrement (streaming) reports the same presentPaths as parseUsageIncrement over the same tar", async () => {
    const seen = ".claude/projects/proj/agent-f.jsonl";
    const prev: BurnCursor = { fileOffsets: { [seen]: 999_999 } };
    const gz = await gzipBytes(buildTar([{ name: seen, content: "short\n" }]));
    const production = await burnIncrement(prev, gz);
    expect(production.presentPaths).toEqual(new Set([seen]));
  });
});

// ---------------------------------------------------------------------------
// Issue #258 N1 (#173 round-3 review): legacySeed's migration-tick trust is
// on LENGTH alone, with no content check at all — a NEW same-session-key path
// whose content has genuinely DIVERGED from the one the seed offset was
// actually counted against is trusted anyway, under-counting (the review's
// own shorthand: "10 vs main 50"). The fix verifies against the seed SOURCE
// path's own fingerprint when one survives, falling through to a full
// recount (the safe, over-counting direction) on a mismatch.
// ---------------------------------------------------------------------------

describe("legacySeed — N1: a migration-tick seed whose source content diverged is not trusted (issue #258)", () => {
  it("N1 divergent migration: a same-key path with a verifiable, MISMATCHED fingerprint is recounted in full, not under-counted", () => {
    const K = "c2d117bd-ee53-59b8-b174-a1511d464969";
    const oldPath = `.claude/projects/proj-a/${K}.jsonl`;
    const newPath = `.claude/projects/proj-b/${K}.jsonl`;

    // A prior tick counted oldPath in full via the real code — prev now
    // carries a REAL fileOffsets + fileHashes entry for it, matching a
    // genuinely pre-#258 cursor (before this fix's own fileHashes/sessions
    // compaction existed, a session-keyed path's own fingerprint was ALWAYS
    // persisted in fileHashes directly, never solely inside `sessions`). The
    // fingerprint is extracted from the real encoded `sessions` entry
    // (`resolveOffsets`' own "<counted>:<hash>" wire format) rather than
    // fabricated, so this is the exact value the file's own code computed.
    // No `sessions` entry survives — simulating the "no session entry
    // recorded for this key under the CURRENT encoding" precondition
    // legacySeed fires on (issue #258's own sessions-key-hashing change
    // produces exactly this shape on its own deploy tick).
    const oldContent = text154(50);
    const seeded = parseUsageIncrement({ fileOffsets: {} }, new Map([[oldPath, oldContent]]));
    const encodedSeed = Object.values(seeded.cursor.sessions ?? {})[0]!;
    const realHash = encodedSeed.slice(encodedSeed.indexOf(":") + 1);
    const prev: BurnCursor = { fileOffsets: seeded.cursor.fileOffsets, fileHashes: { [oldPath]: realHash } };

    // A NEW tick: newPath shares the session key, is at least as long as the
    // seed offset (so the length gate alone would trust it), but its bytes up
    // to that offset are GENUINELY DIFFERENT — not a continuation, a
    // different conversation. Six turns of divergent content, longer overall
    // than oldContent.
    const divergentTail = text154(9, 9, 9, 9, 9, 9);
    expect(divergentTail.length).toBeGreaterThanOrEqual(oldContent.length);
    expect(divergentTail.slice(0, oldContent.length)).not.toBe(oldContent);

    const { delta } = parseUsageIncrement(prev, new Map([[newPath, divergentTail]]));
    // The safe, correct answer: newPath's content never verified against
    // oldPath's, so it is counted in FULL (rule (g)) — all six turns.
    expect(delta.outputTokens).toBe(54);
    expect(delta.turns).toBe(6);
  });

  it("N1 guard: a genuinely pre-#154 seed (no fileHashes recorded anywhere) still trusts on length, unchanged", () => {
    // No `fileHashes` at all — the ordinary, original pre-#154 migration
    // shape. Nothing to verify against, so the seed is trusted exactly as
    // before this fix (over-counting-averse migration behavior preserved).
    const K = SID;
    const head = text154(120_000);
    const grown = head + text154(240);
    const legacy: BurnCursor = { fileOffsets: { [WT1]: head.length } };
    const migrated = parseUsageIncrement(legacy, new Map([[ROOT, grown]]));
    expect(migrated.delta.outputTokens).toBe(240);
  });
});
