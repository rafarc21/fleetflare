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
// stale-row pruning) with junior/ratelimit.ts via ../ratelimit.ts — only
// the D1 key prefixes, env var names, and numeric defaults differ.
import { checkAndConsumeRateLimit, parsePositiveInt, type RateLimitKind, type RateLimitResult } from "../ratelimit";

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

const LEAD_KIND: RateLimitKind = { ratePrefix: "lead-rate:", dailyPrefix: "lead-daily:" };

export interface LeadRateLimitEnv {
  LEAD_RATE_PER_MINUTE?: string;
  LEAD_DAILY_CAP?: string;
}

export type LeadRateLimitResult = RateLimitResult;

export async function checkAndConsumeLeadRateLimit(
  db: D1Database, env: LeadRateLimitEnv, studioId: string, now: number,
): Promise<LeadRateLimitResult> {
  const perMinute = parsePositiveInt(env.LEAD_RATE_PER_MINUTE, DEFAULT_LEAD_RATE_PER_MINUTE);
  const dailyCap = parsePositiveInt(env.LEAD_DAILY_CAP, DEFAULT_LEAD_DAILY_CAP);
  return checkAndConsumeRateLimit(db, studioId, now, perMinute, dailyCap, LEAD_KIND);
}
