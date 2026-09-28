// apps/fleet/test/junior.ratelimit.test.ts
//
// PR #9 review, F1: a per-studio per-minute rate and a separate daily cap on
// /fleet/junior, both D1-backed (fleet_state, same as everything else in
// src/state.ts), both configurable with sane defaults.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  checkAndConsumeJuniorRateLimit,
  DEFAULT_JUNIOR_DAILY_CAP,
  DEFAULT_JUNIOR_RATE_PER_MINUTE,
} from "../src/junior/ratelimit";

const STUDIO = "websites--web-studio";
const OTHER = "websites--release-studio";
const MINUTE = 60_000;
const DAY = 86_400_000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("checkAndConsumeJuniorRateLimit", () => {
  it("allows calls under both limits", async () => {
    const r = await checkAndConsumeJuniorRateLimit(env.DB, {}, STUDIO, 0);
    expect(r).toEqual({ ok: true });
  });

  it("blocks the (default + 1)th call within the same minute", async () => {
    const env_ = { JUNIOR_RATE_PER_MINUTE: "2" };
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, 0)).toEqual({ ok: true });
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, 100)).toEqual({ ok: true });
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, 200)).toEqual({ ok: false, limit: "per-minute" });
  });

  it("a new minute bucket resets the per-minute count", async () => {
    const env_ = { JUNIOR_RATE_PER_MINUTE: "1" };
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, 0)).toEqual({ ok: true });
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, 500)).toEqual({ ok: false, limit: "per-minute" });
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, MINUTE + 1)).toEqual({ ok: true });
  });

  it("blocks past the daily cap even with room left in the per-minute bucket", async () => {
    const env_ = { JUNIOR_RATE_PER_MINUTE: "100", JUNIOR_DAILY_CAP: "2" };
    // Two calls a minute apart, well under the per-minute limit, each in a
    // different minute bucket so only the daily counter is exercised.
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, 0)).toEqual({ ok: true });
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, MINUTE)).toEqual({ ok: true });
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, MINUTE * 2)).toEqual({ ok: false, limit: "daily" });
  });

  it("a new UTC day resets the daily count", async () => {
    const env_ = { JUNIOR_RATE_PER_MINUTE: "100", JUNIOR_DAILY_CAP: "1" };
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, 0)).toEqual({ ok: true });
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, MINUTE)).toEqual({ ok: false, limit: "daily" });
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, DAY + 1)).toEqual({ ok: true });
  });

  it("tracks each studio independently", async () => {
    const env_ = { JUNIOR_RATE_PER_MINUTE: "1" };
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, 0)).toEqual({ ok: true });
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, 0)).toEqual({ ok: false, limit: "per-minute" });
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, OTHER, 0)).toEqual({ ok: true });
  });

  it("defaults are sane and exported", async () => {
    expect(DEFAULT_JUNIOR_RATE_PER_MINUTE).toBeGreaterThan(0);
    expect(DEFAULT_JUNIOR_DAILY_CAP).toBeGreaterThan(0);
    expect(DEFAULT_JUNIOR_DAILY_CAP).toBeGreaterThanOrEqual(DEFAULT_JUNIOR_RATE_PER_MINUTE);
  });

  it("garbage config values fall back to the defaults rather than disabling the limit", async () => {
    const env_ = { JUNIOR_RATE_PER_MINUTE: "not-a-number", JUNIOR_DAILY_CAP: "-5" };
    for (let i = 0; i < DEFAULT_JUNIOR_RATE_PER_MINUTE; i++) {
      expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, i)).toEqual({ ok: true });
    }
    expect(await checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, DEFAULT_JUNIOR_RATE_PER_MINUTE)).toEqual({ ok: false, limit: "per-minute" });
  });

  // PR #9 review, BLOCKER F1: the pre-fix implementation reads the counter,
  // checks it, and only THEN writes the increment — two separate D1
  // round-trips with nothing atomic between them. N genuinely concurrent
  // callers against the SAME window can all read the same pre-increment
  // value, all pass the check, and all then write — a live 20-vs-cap-3 run
  // measured all 20 succeeding. The fix must make the increment-and-check a
  // SINGLE atomic D1 statement (RETURNING the post-increment value), so that
  // under real concurrent access to the same binding, EXACTLY `cap` calls
  // succeed — never more, never "approximately".
  it("F1: exactly `cap` of N concurrent calls succeed — the increment is atomic, not read-then-write", async () => {
    const cap = 3;
    const n = 20;
    const env_ = { JUNIOR_RATE_PER_MINUTE: String(cap) };
    const results = await Promise.all(
      Array.from({ length: n }, () => checkAndConsumeJuniorRateLimit(env.DB, env_, STUDIO, 0)),
    );
    const succeeded = results.filter((r) => r.ok).length;
    expect(succeeded).toBe(cap);
  });
});

// PR #9 review, item (c): a new fleet_state row per studio per minute (and
// per day) bucket, with nothing deleting an old one, grows this table
// unboundedly forever. Pruning must actually delete stale rows, not just be
// a TODO comment.
describe("checkAndConsumeJuniorRateLimit — stale counter pruning (c)", () => {
  async function countKeysLike(pattern: string): Promise<number> {
    const row = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM fleet_state WHERE key LIKE ?`)
      .bind(pattern)
      .first<{ n: number }>();
    return row!.n;
  }

  it("deletes a stale per-minute bucket row once its retention window has passed", async () => {
    // A call at t=0 leaves behind a junior-rate:...:0 row stamped ts=0.
    await checkAndConsumeJuniorRateLimit(env.DB, {}, STUDIO, 0);
    expect(await countKeysLike("junior-rate:%")).toBe(1);
    // A later call, far enough past that bucket's retention window, must
    // prune the old row — for a DIFFERENT studio, so this is provably the
    // pruning sweep and not that studio's own bucket simply rolling over.
    await checkAndConsumeJuniorRateLimit(env.DB, {}, OTHER, MINUTE * 10);
    expect(await countKeysLike("junior-rate:" + STUDIO + ":%")).toBe(0);
  });

  it("deletes a stale daily bucket row once its retention window has passed", async () => {
    await checkAndConsumeJuniorRateLimit(env.DB, {}, STUDIO, 0);
    expect(await countKeysLike("junior-daily:%")).toBe(1);
    await checkAndConsumeJuniorRateLimit(env.DB, {}, OTHER, DAY * 10);
    expect(await countKeysLike("junior-daily:" + STUDIO + ":%")).toBe(0);
  });

  it("does not delete a row still inside its retention window", async () => {
    await checkAndConsumeJuniorRateLimit(env.DB, {}, STUDIO, 0);
    await checkAndConsumeJuniorRateLimit(env.DB, {}, OTHER, 500);
    expect(await countKeysLike("junior-rate:" + STUDIO + ":%")).toBe(1);
  });
});
