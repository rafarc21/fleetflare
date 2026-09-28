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
import { incrementCounter } from "../state";

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

// PR #9 review, item (c): a window comfortably wider than the bucket size
// itself, so a row is never deleted while its own bucket could still be
// read — only once its bucket is definitely over and it has become pure
// dead weight.
const RATE_RETENTION_MS = MINUTE_MS * 2;
const DAILY_RETENTION_MS = DAY_MS * 2;

/**
 * PR #9 review, item (c): `checkAndConsumeJuniorRateLimit` writes a NEW
 * `fleet_state` row per studio per minute (and per day) bucket and nothing
 * else in this codebase ever deletes one — left alone, this table grows by
 * one row per call, forever. Opportunistic deletion, run inline on every
 * call this module makes, rather than a scheduled job: this Worker has no
 * cron wired for it, and a `DELETE ... WHERE key LIKE ... AND ts < ?` against
 * this table's small row count is cheap enough to simply always run rather
 * than gate behind a TODO.
 *
 * The two prefixes (`junior-rate:` / `junior-daily:`) are pruned
 * independently, each against its own retention window, since a minute
 * bucket and a day bucket go stale on very different timescales.
 */
async function pruneStaleCounters(db: D1Database, now: number): Promise<void> {
  await Promise.all([
    db.prepare(`DELETE FROM fleet_state WHERE key LIKE 'junior-rate:%' AND ts < ?`)
      .bind(now - RATE_RETENTION_MS).run(),
    db.prepare(`DELETE FROM fleet_state WHERE key LIKE 'junior-daily:%' AND ts < ?`)
      .bind(now - DAILY_RETENTION_MS).run(),
  ]);
}

/**
 * Checks BOTH limits and, only if neither is exceeded, consumes one unit of
 * each — a single call this route makes once per request it intends to
 * actually run (see route.ts's own comment on WHEN it calls this: after
 * authorization passes, so a refused call never costs budget).
 *
 * Bucketed by `Math.floor(now / window)`, so a bucket boundary is a plain
 * integer change — no bucket-expiry logic is needed for CORRECTNESS, since a
 * stale bucket's key is simply never read again. It still leaves a row
 * behind forever if nothing prunes it, though — see `pruneStaleCounters`
 * below (PR #9 review, item (c)) for the opportunistic cleanup that bounds
 * this table's growth.
 *
 * PR #9 review, BLOCKER F1: increment-then-check, via state.ts's
 * `incrementCounter` — ONE atomic D1 statement per counter (an INSERT ...
 * ON CONFLICT DO UPDATE ... RETURNING, see that function's own doc comment),
 * never a read followed by a separate write. The old shape read the counter,
 * compared it to the cap, and only THEN wrote the increment as a second,
 * unrelated D1 round-trip — under real concurrency, N callers could all read
 * the same pre-increment value, all pass the check, and all then write (a
 * live run measured 20 concurrent calls against a cap of 3 all succeeding).
 * `incrementCounter`'s RETURNING value already reflects the FULL, correctly
 * serialized post-increment count no matter how many callers raced for it,
 * so comparing that single returned number against the cap is the entire
 * check — there is no separate read to race against.
 *
 * The minute counter increments (and is checked) first; the daily counter is
 * only touched if the minute check passes, matching a caller's own budget
 * shape — a call refused for being over the per-minute burst limit does not
 * also spend a unit of the separate daily budget. A call that DOES pass the
 * minute check but then trips the daily cap still leaves the minute counter
 * incremented — normal and expected for a rate limiter: a rejected request
 * still consumes a slot in whichever window it actually reached, which is
 * what keeps a caller from bypassing a cap by retrying rejected calls for
 * free.
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

  // Item (c): opportunistic, ahead of this call's own increments — see
  // pruneStaleCounters's own doc comment for why inline rather than a cron.
  await pruneStaleCounters(db, now);

  const minuteCount = await incrementCounter(db, rKey, now);
  if (minuteCount > perMinute) return { ok: false, limit: "per-minute" };

  const dayCount = await incrementCounter(db, dKey, now);
  if (dayCount > dailyCap) return { ok: false, limit: "daily" };

  return { ok: true };
}
