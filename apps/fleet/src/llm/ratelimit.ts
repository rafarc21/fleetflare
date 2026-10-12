// apps/fleet/src/llm/ratelimit.ts
//
// Board issue #284, MAJOR 1: the glm-lead route's (anthropic-route.ts) OWN
// rate limit, genuinely separate from /fleet/junior's (junior/ratelimit.ts).
// A GLM-led studio is a full Claude Code agentic session — every tool-use
// round trip is one Messages-API call to this route — so junior's 5/min
// burst limit (sized for occasional delegation calls) 429s a lead into
// uselessness within seconds of a normal session starting.
//
// Shares its real logic (atomic increment-then-check, minute/day bucketing,
// stale-row pruning) with junior/ratelimit.ts via ../ratelimit.ts. Issue
// #368 (sweep-4 finding F8): the parse-env-then-consume wrappers are
// makeRateLimitKind products now — this module holds TWO lead kinds as spec
// objects: the messages route's (per-minute + daily) and count_tokens' own
// (per-minute ONLY, its own prefixes, no daily arm).
import { makeRateLimitKind } from "../ratelimit";

// 60/min: the maestro's own suggested number (#284) — a Claude Code lead's
// agentic loop can legitimately burst many tool-use round trips per minute
// (each tool call and its result is a separate Messages-API round trip),
// far more than junior's occasional mechanical delegation calls.
export const DEFAULT_LEAD_RATE_PER_MINUTE = 60;

// 2000/day: generously larger than junior's 50 — junior is sized for
// occasional delegation, a lead legitimately makes many calls across a
// full active working day — while still being a REAL, low-thousands cap
// rather than effectively unlimited. Sized to comfortably clear a full day
// of genuinely active agentic work (a well-behaved lead should never
// actually hit it) while still catching a runaway loop left running
// unattended overnight.
export const DEFAULT_LEAD_DAILY_CAP = 2000;

// Type aliases, not interfaces: they must satisfy the factory's generic
// `E extends Record<string, string | undefined>` constraint, and only
// type aliases get implicit index signatures.
export type LeadRateLimitEnv = {
  LEAD_RATE_PER_MINUTE?: string;
  LEAD_DAILY_CAP?: string;
};

export const checkAndConsumeLeadRateLimit = makeRateLimitKind<LeadRateLimitEnv>({
  kind: { ratePrefix: "lead-rate:", dailyPrefix: "lead-daily:" },
  perMinuteEnv: "LEAD_RATE_PER_MINUTE",
  perMinuteDefault: DEFAULT_LEAD_RATE_PER_MINUTE,
  dailyCapEnv: "LEAD_DAILY_CAP",
  dailyCapDefault: DEFAULT_LEAD_DAILY_CAP,
});

// count_tokens' OWN bucket, deliberately per-minute ONLY: the endpoint
// spends no AI budget, and drawing its ~1800-calls/day volume (busiest GLM
// studio, measured 2026-10-11) from the messages route's daily cap locked
// studios out until UTC midnight.
export const DEFAULT_LEAD_COUNT_TOKENS_RATE_PER_MINUTE = 60;

export type LeadCountTokensRateLimitEnv = {
  LEAD_COUNT_TOKENS_RATE_PER_MINUTE?: string;
};

// dailyPrefix stays even though no daily arm exists: the pruning sweep in
// ../ratelimit.ts still names both prefixes, and keeping RateLimitKind's
// shape unchanged (one two-prefix kind per spec) costs nothing — the
// lead-count-daily: DELETE simply never matches a row.
export const checkAndConsumeLeadCountTokensRateLimit = makeRateLimitKind<LeadCountTokensRateLimitEnv>({
  kind: { ratePrefix: "lead-count-rate:", dailyPrefix: "lead-count-daily:" },
  perMinuteEnv: "LEAD_COUNT_TOKENS_RATE_PER_MINUTE",
  perMinuteDefault: DEFAULT_LEAD_COUNT_TOKENS_RATE_PER_MINUTE,
});
