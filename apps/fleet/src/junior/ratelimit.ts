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
// bucketing, stale-row pruning) lives in ../ratelimit.ts. Issue #368 (sweep-4
// finding F8): the parse-env-then-consume wrapper is makeRateLimitKind's too —
// this module supplies junior's own key prefixes, env var names, and defaults
// as ONE spec object. Public exports and behavior are unchanged.
import { makeRateLimitKind } from "../ratelimit";

export const DEFAULT_JUNIOR_RATE_PER_MINUTE = 5;
export const DEFAULT_JUNIOR_DAILY_CAP = 50;

// A type alias, not an interface: it must satisfy the factory's generic
// `E extends Record<string, string | undefined>` constraint, and only type
// aliases get implicit index signatures.
export type JuniorRateLimitEnv = {
  JUNIOR_RATE_PER_MINUTE?: string;
  JUNIOR_DAILY_CAP?: string;
};

export const checkAndConsumeJuniorRateLimit = makeRateLimitKind<JuniorRateLimitEnv>({
  kind: { ratePrefix: "junior-rate:", dailyPrefix: "junior-daily:" },
  perMinuteEnv: "JUNIOR_RATE_PER_MINUTE",
  perMinuteDefault: DEFAULT_JUNIOR_RATE_PER_MINUTE,
  dailyCapEnv: "JUNIOR_DAILY_CAP",
  dailyCapDefault: DEFAULT_JUNIOR_DAILY_CAP,
});
