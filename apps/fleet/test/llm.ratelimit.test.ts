// apps/fleet/test/llm.ratelimit.test.ts
//
// Board issue #284, MAJOR 1: the glm-lead route's OWN rate limit, separate
// from /fleet/junior's (src/junior/ratelimit.ts, 5/min, 50/day — sized for
// occasional delegation calls, not a full Claude Code agentic session that
// makes many Messages-API calls per minute). Same cloudflare:test convention
// as test/junior.ratelimit.test.ts.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  checkAndConsumeLeadRateLimit,
  DEFAULT_LEAD_DAILY_CAP,
  DEFAULT_LEAD_RATE_PER_MINUTE,
} from "../src/llm/ratelimit";
import { checkAndConsumeJuniorRateLimit } from "../src/junior/ratelimit";

const STUDIO = "websites--web-studio";
const OTHER = "websites--release-studio";
const MINUTE = 60_000;
const DAY = 86_400_000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("checkAndConsumeLeadRateLimit — defaults", () => {
  it("default per-minute cap is 60, not junior's 5 — a burst of 10 rapid calls all succeed", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await checkAndConsumeLeadRateLimit(env.DB, {}, STUDIO, 0);
      results.push(r.ok);
    }
    expect(results.every(Boolean)).toBe(true);
  });

  it("blocks the (default + 1)th call within the same minute", async () => {
    for (let i = 0; i < DEFAULT_LEAD_RATE_PER_MINUTE; i++) {
      expect(await checkAndConsumeLeadRateLimit(env.DB, {}, STUDIO, i)).toEqual({ ok: true });
    }
    expect(await checkAndConsumeLeadRateLimit(env.DB, {}, STUDIO, DEFAULT_LEAD_RATE_PER_MINUTE)).toEqual({ ok: false, limit: "per-minute" });
  });

  it("DEFAULT_LEAD_RATE_PER_MINUTE is exactly 60", () => {
    expect(DEFAULT_LEAD_RATE_PER_MINUTE).toBe(60);
  });

  it("DEFAULT_LEAD_DAILY_CAP is exactly 2000", () => {
    expect(DEFAULT_LEAD_DAILY_CAP).toBe(2000);
  });

  it("defaults are sane: both positive, daily >= per-minute", () => {
    expect(DEFAULT_LEAD_RATE_PER_MINUTE).toBeGreaterThan(0);
    expect(DEFAULT_LEAD_DAILY_CAP).toBeGreaterThan(0);
    expect(DEFAULT_LEAD_DAILY_CAP).toBeGreaterThanOrEqual(DEFAULT_LEAD_RATE_PER_MINUTE);
  });
});

describe("checkAndConsumeLeadRateLimit — config + bucketing", () => {
  it("blocks the (configured + 1)th call within the same minute", async () => {
    const e = { LEAD_RATE_PER_MINUTE: "2" };
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, 0)).toEqual({ ok: true });
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, 100)).toEqual({ ok: true });
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, 200)).toEqual({ ok: false, limit: "per-minute" });
  });

  it("a new minute bucket resets the per-minute count", async () => {
    const e = { LEAD_RATE_PER_MINUTE: "1" };
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, 0)).toEqual({ ok: true });
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, 500)).toEqual({ ok: false, limit: "per-minute" });
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, MINUTE + 1)).toEqual({ ok: true });
  });

  it("blocks past the daily cap even with room left in the per-minute bucket", async () => {
    const e = { LEAD_RATE_PER_MINUTE: "100", LEAD_DAILY_CAP: "2" };
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, 0)).toEqual({ ok: true });
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, MINUTE)).toEqual({ ok: true });
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, MINUTE * 2)).toEqual({ ok: false, limit: "daily" });
  });

  it("a new UTC day resets the daily count", async () => {
    const e = { LEAD_RATE_PER_MINUTE: "100", LEAD_DAILY_CAP: "1" };
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, 0)).toEqual({ ok: true });
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, MINUTE)).toEqual({ ok: false, limit: "daily" });
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, DAY + 1)).toEqual({ ok: true });
  });

  it("tracks each studio independently", async () => {
    const e = { LEAD_RATE_PER_MINUTE: "1" };
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, 0)).toEqual({ ok: true });
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, 0)).toEqual({ ok: false, limit: "per-minute" });
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, OTHER, 0)).toEqual({ ok: true });
  });

  it("garbage config values fall back to the defaults rather than disabling the limit", async () => {
    const e = { LEAD_RATE_PER_MINUTE: "not-a-number", LEAD_DAILY_CAP: "-5" };
    for (let i = 0; i < DEFAULT_LEAD_RATE_PER_MINUTE; i++) {
      expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, i)).toEqual({ ok: true });
    }
    expect(await checkAndConsumeLeadRateLimit(env.DB, e, STUDIO, DEFAULT_LEAD_RATE_PER_MINUTE)).toEqual({ ok: false, limit: "per-minute" });
  });
});

// MAJOR 1's whole point: the lead limit must NOT share a budget with
// junior's — a lead burning its much higher budget must never be mistaken
// for junior spend, and a studio hammering /fleet/junior must never eat
// into its own lead-route budget.
describe("checkAndConsumeLeadRateLimit — genuinely separate from junior's", () => {
  it("exhausting junior's per-minute budget does not touch the lead route's own budget", async () => {
    const juniorEnv = { JUNIOR_RATE_PER_MINUTE: "5" };
    for (let i = 0; i < 5; i++) {
      expect(await checkAndConsumeJuniorRateLimit(env.DB, juniorEnv, STUDIO, 0)).toEqual({ ok: true });
    }
    expect(await checkAndConsumeJuniorRateLimit(env.DB, juniorEnv, STUDIO, 0)).toEqual({ ok: false, limit: "per-minute" });

    // Same studio, same instant — the lead route's own limit (default 60)
    // is untouched by junior's 5 calls above.
    const lead = await checkAndConsumeLeadRateLimit(env.DB, {}, STUDIO, 0);
    expect(lead).toEqual({ ok: true });
  });

  it("exhausting the lead route's per-minute budget does not touch junior's own budget", async () => {
    const leadEnv = { LEAD_RATE_PER_MINUTE: "3" };
    for (let i = 0; i < 3; i++) {
      expect(await checkAndConsumeLeadRateLimit(env.DB, leadEnv, STUDIO, 0)).toEqual({ ok: true });
    }
    expect(await checkAndConsumeLeadRateLimit(env.DB, leadEnv, STUDIO, 0)).toEqual({ ok: false, limit: "per-minute" });

    const junior = await checkAndConsumeJuniorRateLimit(env.DB, {}, STUDIO, 0);
    expect(junior).toEqual({ ok: true });
  });

  it("the two limits write to distinct, non-colliding D1 key prefixes in fleet_state", async () => {
    await checkAndConsumeJuniorRateLimit(env.DB, {}, STUDIO, 0);
    await checkAndConsumeLeadRateLimit(env.DB, {}, STUDIO, 0);
    const rows = await env.DB.prepare("SELECT key FROM fleet_state ORDER BY key").all<{ key: string }>();
    const keys = (rows.results ?? []).map((r) => r.key);
    expect(keys.some((k) => k.startsWith("junior-rate:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("lead-rate:"))).toBe(true);
    // Genuinely distinct prefixes — neither key list overlaps the other.
    expect(keys.filter((k) => k.startsWith("junior-rate:")).some((k) => k.startsWith("lead-rate:"))).toBe(false);
  });
});
