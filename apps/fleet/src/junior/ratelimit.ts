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
//
// Board issue #284, MAJOR 1: the real logic (atomic increment-then-check,
// bucketing, stale-row pruning) now lives in ../ratelimit.ts, shared with
// the glm-lead route's OWN separate limit (llm/ratelimit.ts) — this module
// is a thin wrapper supplying junior's own key prefixes, env var names, and
// defaults. Public exports and behavior are unchanged.
import { checkAndConsumeRateLimit, parsePositiveInt, type RateLimitKind, type RateLimitResult } from "../ratelimit";

export const DEFAULT_JUNIOR_RATE_PER_MINUTE = 5;
export const DEFAULT_JUNIOR_DAILY_CAP = 50;

const JUNIOR_KIND: RateLimitKind = { ratePrefix: "junior-rate:", dailyPrefix: "junior-daily:" };

export interface JuniorRateLimitEnv {
  JUNIOR_RATE_PER_MINUTE?: string;
  JUNIOR_DAILY_CAP?: string;
}

export type JuniorRateLimitResult = RateLimitResult;

export async function checkAndConsumeJuniorRateLimit(
  db: D1Database, env: JuniorRateLimitEnv, studioId: string, now: number,
): Promise<JuniorRateLimitResult> {
  const perMinute = parsePositiveInt(env.JUNIOR_RATE_PER_MINUTE, DEFAULT_JUNIOR_RATE_PER_MINUTE);
  const dailyCap = parsePositiveInt(env.JUNIOR_DAILY_CAP, DEFAULT_JUNIOR_DAILY_CAP);
  return checkAndConsumeRateLimit(db, studioId, now, perMinute, dailyCap, JUNIOR_KIND);
}
