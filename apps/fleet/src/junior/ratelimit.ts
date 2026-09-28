// apps/fleet/src/junior/ratelimit.ts
//
// PR #9 review, F1: a per-studio per-minute rate AND a separate daily cap on
// /fleet/junior, both D1-backed (state.ts's fleet_state table, same generic
// key/value store every other flag in this codebase already uses), both
// configurable with sane defaults so a fresh deploy is protected with zero
// extra config.
//
// Two independent counters, not one: a burst limiter (per-minute) catches a
// runaway loop; a daily cap catches a studio that stays just under the burst
// limit but calls all day. Either one tripping is a 429 naming which — a
// caller retrying blind against an undifferentiated 429 cannot tell "back off
// a few seconds" from "come back tomorrow".
import { getFlag, setFlag } from "../state";

export const DEFAULT_JUNIOR_RATE_PER_MINUTE = 5;
export const DEFAULT_JUNIOR_DAILY_CAP = 50;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface JuniorRateLimitEnv {
  JUNIOR_RATE_PER_MINUTE?: string;
  JUNIOR_DAILY_CAP?: string;
}

export type JuniorRateLimitResult =
  | { ok: true }
  | { ok: false; limit: "per-minute" | "daily" };

/** Garbage (absent, non-numeric, zero, negative) falls back to `fallback`
 *  rather than disabling the limit — an unset or malformed config var must
 *  never read as "no cap". */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function rateKey(studioId: string, minuteBucket: number): string {
  return `junior-rate:${studioId}:${minuteBucket}`;
}

function dailyKey(studioId: string, dayBucket: number): string {
  return `junior-daily:${studioId}:${dayBucket}`;
}

/**
 * Checks BOTH limits and, only if neither is exceeded, consumes one unit of
 * each — a single call this route makes once per request it intends to
 * actually run (see route.ts's own comment on WHEN it calls this: after
 * authorization passes, so a refused call never costs budget).
 *
 * Bucketed by `Math.floor(now / window)`, so a bucket boundary is a plain
 * integer change — no explicit expiry or cleanup needed, since a stale
 * bucket's key is simply never read again. Read-then-write, not a single
 * atomic increment: D1 has no native counter primitive, and this module's
 * concurrency exposure is the same one state.ts's other counters already
 * accept (a race is a slightly-over-permissive count for one request, never
 * an unbounded one — see agents.do.test.ts's own rearm counter for the same
 * shape).
 */
export async function checkAndConsumeJuniorRateLimit(
  db: D1Database, env: JuniorRateLimitEnv, studioId: string, now: number,
): Promise<JuniorRateLimitResult> {
  const perMinute = parsePositiveInt(env.JUNIOR_RATE_PER_MINUTE, DEFAULT_JUNIOR_RATE_PER_MINUTE);
  const dailyCap = parsePositiveInt(env.JUNIOR_DAILY_CAP, DEFAULT_JUNIOR_DAILY_CAP);

  const minuteBucket = Math.floor(now / MINUTE_MS);
  const dayBucket = Math.floor(now / DAY_MS);
  const rKey = rateKey(studioId, minuteBucket);
  const dKey = dailyKey(studioId, dayBucket);

  const [rawMinute, rawDay] = await Promise.all([getFlag(db, rKey), getFlag(db, dKey)]);
  const minuteCount = Number(rawMinute ?? "0");
  const dayCount = Number(rawDay ?? "0");

  if (minuteCount >= perMinute) return { ok: false, limit: "per-minute" };
  if (dayCount >= dailyCap) return { ok: false, limit: "daily" };

  await Promise.all([
    setFlag(db, rKey, String(minuteCount + 1), now),
    setFlag(db, dKey, String(dayCount + 1), now),
  ]);
  return { ok: true };
}
