import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  chunkKey, sessionLatestKey, sessionDailyKey, advance, shouldRotate,
  CHUNK_SEQ_WIDTH, ROTATION_THRESHOLD_BYTES,
  TRANSCRIPT_PULL_MAX, HOT_TAIL_BYTES, SESSION_SINGLE_READ_MAX,
  SESSION_SPLIT_PART, SESSION_TOTAL_MAX, SESSION_SUBAGENT_RAW_BUDGET,
  SESSION_SUBAGENT_LIVE_WINDOW_SECONDS, SESSION_SUBAGENT_WATERMARK_LOOKBACK_SECONDS,
  SESSION_DAILY_KEEPERS, BURN_WINDOW_MS,
  type TranscriptManifest,
} from "../src/studio/archive";

describe("chunkKey", () => {
  it("formats id/date/seq as transcripts/<id>/<date>/<seq>.log", () => {
    expect(chunkKey("websites--pilot", "2026-08-16", 0)).toBe(
      "transcripts/websites--pilot/2026-08-16/000000.log",
    );
  });

  it("zero-pads seq to CHUNK_SEQ_WIDTH digits", () => {
    expect(CHUNK_SEQ_WIDTH).toBe(6);
    expect(chunkKey("id1", "2026-08-16", 9)).toBe("transcripts/id1/2026-08-16/000009.log");
    expect(chunkKey("id1", "2026-08-16", 10)).toBe("transcripts/id1/2026-08-16/000010.log");
  });

  it("zero-padded keys sort lexicographically in numeric seq order (R2 list order)", () => {
    const nine = chunkKey("id1", "2026-08-16", 9);
    const ten = chunkKey("id1", "2026-08-16", 10);
    expect(nine < ten).toBe(true);
    expect([ten, nine].sort()).toEqual([nine, ten]);
  });

  // Issue #269 round 2: same reasoning as sessionLatestKey's own pin below —
  // the full id, verbatim, is what makes a second instance's transcript
  // chunks land at their own key with zero code change.
  it("a second instance gets its own key, never colliding with instance 1", () => {
    expect(chunkKey("websites--pilot--2", "2026-08-16", 0)).not.toBe(
      chunkKey("websites--pilot", "2026-08-16", 0),
    );
  });
});

describe("sessionLatestKey / sessionDailyKey", () => {
  it("sessionLatestKey builds the overwrite-in-place snapshot key", () => {
    expect(sessionLatestKey("websites--pilot")).toBe("sessions/websites--pilot/latest.tar.gz");
  });

  it("sessionDailyKey builds a dated daily-keeper key", () => {
    expect(sessionDailyKey("websites--pilot", "2026-08-16")).toBe(
      "sessions/websites--pilot/2026-08-16.tar.gz",
    );
  });

  // Issue #269 round 2: both key builders interpolate the FULL studio id
  // verbatim, never a reconstructed {repo, role} pair, so a second instance's
  // snapshot already lives at its own R2 key with zero code change needed —
  // this pin exists only to catch a FUTURE "fix" that reconstructs the key
  // from parsed repo/role and silently drops the instance segment, colliding
  // two studios' session archives onto one key.
  it("a second instance gets its own key, never colliding with instance 1", () => {
    expect(sessionLatestKey("websites--pilot--2")).not.toBe(sessionLatestKey("websites--pilot"));
  });
});

describe("advance", () => {
  const base: TranscriptManifest = { seq: 3, offset: 1000, date: "2026-08-16" };

  it("increments seq and carries (accumulates) offset within the same UTC date", () => {
    expect(advance(base, 250, new Date("2026-08-16T23:59:00Z"))).toEqual({
      seq: 4, offset: 1250, date: "2026-08-16",
    });
  });

  it("rolls seq to 0 on a new UTC date but still carries offset", () => {
    expect(advance(base, 250, new Date("2026-08-17T00:00:01Z"))).toEqual({
      seq: 0, offset: 1250, date: "2026-08-17",
    });
  });

  it("date comparison is UTC — a timestamp on the same UTC calendar date never rolls seq", () => {
    // Same UTC date as base ("2026-08-16"), even at the day's first instant.
    expect(advance(base, 0, new Date("2026-08-16T00:00:00.000Z"))).toEqual({
      seq: 4, offset: 1000, date: "2026-08-16",
    });
  });

  it("allows the last representable seq (999999) without throwing", () => {
    const m: TranscriptManifest = { seq: 999_998, offset: 0, date: "2026-08-16" };
    expect(advance(m, 0, new Date("2026-08-16T12:00:00Z"))).toEqual({
      seq: 999_999, offset: 0, date: "2026-08-16",
    });
  });

  it("throws when the next seq would reach 1_000_000 (would overflow chunkKey's 6-digit width)", () => {
    const m: TranscriptManifest = { seq: 999_999, offset: 0, date: "2026-08-16" };
    expect(() => advance(m, 0, new Date("2026-08-16T12:00:00Z"))).toThrow();
  });
});

describe("shouldRotate", () => {
  it("is false one byte under 64 MiB (67108863)", () => {
    expect(shouldRotate(67_108_863)).toBe(false);
  });

  it("is true at exactly 64 MiB (67108864)", () => {
    expect(shouldRotate(67_108_864)).toBe(true);
  });

  it("is true above 64 MiB", () => {
    expect(shouldRotate(100_000_000)).toBe(true);
  });

  it("ROTATION_THRESHOLD_BYTES is exactly 64 MiB", () => {
    expect(ROTATION_THRESHOLD_BYTES).toBe(67_108_864);
  });
});

// Plan constants Tasks 2-4 consume from here (transcript.ts, session-sync.ts,
// burn.ts) — single-sourced in archive.ts so those tasks' own files never
// re-declare (and risk drifting from) the plan's numbers.
// REBASE NOTE vs #191 (review round 3, item 4). #191 moves SESSION_TOTAL_MAX
// to 33_554_432 (32 MiB). When it lands, the resolution of this table is a
// UNION, never a swap: take #191's 33_554_432 AND keep #202's
// SESSION_SUBAGENT_RAW_BUDGET (12_582_912), the live-window constant and the
// watermark lookback below. Dropping any one of those pins silently is how a
// constant drifts back out of the plan. Same rule for studio.session.test.ts's
// import list: union both sides, never take one wholesale.
describe("exported constants — plan-pinned values", () => {
  it("matches the plan's exact values", () => {
    const table: Array<[unknown, unknown]> = [
      [TRANSCRIPT_PULL_MAX, 1_048_576],
      [HOT_TAIL_BYTES, 8_192],
      [SESSION_SINGLE_READ_MAX, 4_194_304],
      [SESSION_SPLIT_PART, "4m"],
      [SESSION_TOTAL_MAX, 33_554_432], // #176: 64 -> 32 MiB, measured (archive.ts)
      [SESSION_SUBAGENT_RAW_BUDGET, 12_582_912],
      [SESSION_SUBAGENT_LIVE_WINDOW_SECONDS, 600],
      [SESSION_SUBAGENT_WATERMARK_LOOKBACK_SECONDS, 86_400],
      [SESSION_DAILY_KEEPERS, 7],
      [BURN_WINDOW_MS, 18_000_000],
    ];
    for (const [actual, expected] of table) expect(actual).toBe(expected);
  });
});

describe("STUDIO_ARCHIVE R2 binding (smoke)", () => {
  it("put/get round-trips through the pool's R2 simulator", async () => {
    const key = "smoke-test/roundtrip.txt";
    await env.STUDIO_ARCHIVE.put(key, "hello archive");

    const obj = await env.STUDIO_ARCHIVE.get(key);
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe("hello archive");

    await env.STUDIO_ARCHIVE.delete(key);
    expect(await env.STUDIO_ARCHIVE.get(key)).toBeNull();
  });
});
