// apps/fleet/src/ratelimit.ts
//
// Board issue #284, MAJOR 1: the shared core behind BOTH
// junior/ratelimit.ts (/fleet/junior) and llm/ratelimit.ts (the glm-lead
// route, src/llm/anthropic-route.ts). The atomic increment-then-check, the
// minute/day bucketing, and the opportunistic stale-row pruning (originally
// PR #9 review, F1 and item (c), all written for junior first) are
// IDENTICAL for every caller — only the D1 key prefixes, the env var names,
// and the numeric defaults differ per "kind" of limit. Hoisted here, once,
// rather than duplicated, because junior's /fleet/junior route and the
// glm-lead's /fleet/llm/anthropic/v1/messages route spend out of the same
// Workers AI budget but must NOT share a counter — a lead burning its much
// higher per-minute budget must never be mistaken, bucket-for-bucket, for
// junior's much tighter one, and vice versa. Each kind's own prefix keeps
// the two counters from ever colliding even though both are keyed by the
// same studio id and live in the same fleet_state table (src/state.ts).
import { incrementCounter } from "./state";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// Item (c): a window comfortably wider than the bucket size itself, so a
// row is never deleted while its own bucket could still be read — only
// once its bucket is definitely over and it has become pure dead weight.
const RATE_RETENTION_MS = MINUTE_MS * 2;
const DAILY_RETENTION_MS = DAY_MS * 2;

export type RateLimitResult =
  | { ok: true }
  | { ok: false; limit: "per-minute" | "daily" };

/** One "kind" of rate limit: its own D1 key prefixes, so two kinds keyed by
 *  the same subject id never collide in the shared fleet_state table.
 *  Prefixes are expected to already include their own trailing separator
 *  (e.g. "junior-rate:"), matching this module's `${prefix}${id}:${bucket}`
 *  key shape. */
export interface RateLimitKind {
  ratePrefix: string;
  dailyPrefix: string;
}

/** Garbage (absent, non-numeric, zero, negative) falls back to `fallback`
 *  rather than disabling the limit — an unset or malformed config var must
 *  never read as "no cap". */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function bucketKey(prefix: string, subjectId: string, bucket: number): string {
  return `${prefix}${subjectId}:${bucket}`;
}

/**
 * PR #9 review, item (c): `checkAndConsumeRateLimit` writes a NEW
 * `fleet_state` row per subject per minute (and per day) bucket and
 * nothing else in this codebase ever deletes one — left alone, this table
 * grows by one row per call, forever, per kind. Opportunistic deletion, run
 * inline on every call this module makes, rather than a scheduled job: no
 * cron is wired for it, and a `DELETE ... WHERE key LIKE ... AND ts < ?`
 * against this table's small row count is cheap enough to simply always
 * run rather than gate behind a TODO.
 *
 * The two prefixes a kind supplies are pruned independently, each against
 * its own retention window, since a minute bucket and a day bucket go
 * stale on very different timescales.
 */
async function pruneStaleCounters(db: D1Database, now: number, kind: RateLimitKind): Promise<void> {
  await Promise.all([
    db.prepare(`DELETE FROM fleet_state WHERE key LIKE ? AND ts < ?`)
      .bind(`${kind.ratePrefix}%`, now - RATE_RETENTION_MS).run(),
    db.prepare(`DELETE FROM fleet_state WHERE key LIKE ? AND ts < ?`)
      .bind(`${kind.dailyPrefix}%`, now - DAILY_RETENTION_MS).run(),
  ]);
}

/**
 * Checks BOTH limits for one `kind` and, only if neither is exceeded,
 * consumes one unit of each.
 *
 * Bucketed by `Math.floor(now / window)`, so a bucket boundary is a plain
 * integer change — no bucket-expiry logic is needed for CORRECTNESS, since
 * a stale bucket's key is simply never read again. It still leaves a row
 * behind forever if nothing prunes it, though — see `pruneStaleCounters`
 * above (PR #9 review, item (c)) for the opportunistic cleanup that bounds
 * this table's growth.
 *
 * PR #9 review, BLOCKER F1: increment-then-check, via state.ts's
 * `incrementCounter` — ONE atomic D1 statement per counter (an INSERT ...
 * ON CONFLICT DO UPDATE ... RETURNING, see that function's own doc comment),
 * never a read followed by a separate write. `incrementCounter`'s
 * RETURNING value already reflects the FULL, correctly serialized post-
 * increment count no matter how many callers raced for it, so comparing
 * that single returned number against the cap is the entire check — there
 * is no separate read to race against.
 *
 * The minute counter increments (and is checked) first; the daily counter
 * is only touched if the minute check passes, matching a caller's own
 * budget shape — a call refused for being over the per-minute burst limit
 * does not also spend a unit of the separate daily budget. A call that DOES
 * pass the minute check but then trips the daily cap still leaves the
 * minute counter incremented — normal and expected for a rate limiter: a
 * rejected request still consumes a slot in whichever window it actually
 * reached, which is what keeps a caller from bypassing a cap by retrying
 * rejected calls for free.
 */
export async function checkAndConsumeRateLimit(
  db: D1Database, subjectId: string, now: number,
  perMinute: number, dailyCap: number, kind: RateLimitKind,
): Promise<RateLimitResult> {
  const minuteBucket = Math.floor(now / MINUTE_MS);
  const dayBucket = Math.floor(now / DAY_MS);
  const rKey = bucketKey(kind.ratePrefix, subjectId, minuteBucket);
  const dKey = bucketKey(kind.dailyPrefix, subjectId, dayBucket);

  // Item (c): opportunistic, ahead of this call's own increments — see
  // pruneStaleCounters's own doc comment for why inline rather than a cron.
  await pruneStaleCounters(db, now, kind);

  const minuteCount = await incrementCounter(db, rKey, now);
  if (minuteCount > perMinute) return { ok: false, limit: "per-minute" };

  const dayCount = await incrementCounter(db, dKey, now);
  if (dayCount > dailyCap) return { ok: false, limit: "daily" };

  return { ok: true };
}
