/**
 * Issue #232 — pure join/decision logic for `fleet accounts sync`.
 * No network, no D1, no cswap binary — every case here is driven by the
 * HAND-BUILT fixture in test/fixtures/cswap-list.ts (see its own header).
 *
 * Reworked per the maestro's real-probe review of PR #237 (2 blockers + 4
 * major findings) plus the scope-add STATUS comment on issue #232 (reset-time
 * join, comment timestamp 2026-10-05T09:48:22Z).
 */
import { describe, it, expect } from "vitest";
import {
  joinAccountsToCswap, decideAccountSync, pickHeadroomAccount,
  MAX_USAGE_AGE_SECONDS, RESET_MATCH_WINDOW_MS,
  type FleetAccountSlot, type SlotJoin, type CswapAccount, type HeadroomCandidate,
} from "../src/studio/claude-swap";
import {
  OVER_FIVE_HOUR, UNDER_THRESHOLD, OVER_SCOPED_ONLY, RELOGIN_REQUIRED, STALE_OK, CSWAP_LIST_FIXTURE,
} from "./fixtures/cswap-list";

describe("joinAccountsToCswap", () => {
  it("matches a slot to a cswap row by exact label===email (label wins over any reset-time coincidence)", () => {
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", label: "primary@example.com", until: null }];
    const [joined] = joinAccountsToCswap(slots, CSWAP_LIST_FIXTURE, true);
    expect(joined).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN", label: "primary@example.com", until: null,
      cswap: OVER_FIVE_HOUR, matchSource: "label",
    });
  });

  it("falls back to reset-time match within +/-5 min when the slot has no label", () => {
    const account: CswapAccount = {
      email: "unclaimed@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: "2026-10-05T14:00:00Z" },
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, until: "2026-10-05T14:03:00Z" }];
    const [joined] = joinAccountsToCswap(slots, [account], true);
    expect(joined).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, until: "2026-10-05T14:03:00Z",
      cswap: account, matchSource: "inferred",
    });
  });

  it("falls back to reset-time match when the slot's label doesn't match anything in the pool", () => {
    const account: CswapAccount = {
      email: "realname@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: "2026-10-05T14:00:00Z" },
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_3", label: "ghost@example.com", until: "2026-10-05T14:02:00Z" }];
    const [joined] = joinAccountsToCswap(slots, [account], true);
    expect(joined.matchSource).toBe("inferred");
    expect(joined.cswap).toEqual(account);
  });

  it("zero reset-time candidates within the window -> unmapped", () => {
    const account: CswapAccount = {
      email: "faraway@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: "2026-10-05T14:00:00Z" },
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_4", label: null, until: "2026-10-05T20:00:00Z" }];
    const [joined] = joinAccountsToCswap(slots, [account], true);
    expect(joined).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN_4", label: null, until: "2026-10-05T20:00:00Z", cswap: null, matchSource: "unmapped",
    });
  });

  it("more than one reset-time candidate within the window -> unmapped, never guesses", () => {
    const a: CswapAccount = {
      email: "a@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: "2026-10-05T14:04:00Z" },
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const b: CswapAccount = {
      email: "b@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: "2026-10-05T13:56:00Z" },
        sevenDay: { pct: 1, resetsAt: "2026-10-12T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    // slot.until = 14:00:00Z. a is +4min, b is -4min -- both within +/-5min of
    // slot.until, but 8 min apart from each other.
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_5", label: null, until: "2026-10-05T14:00:00Z" }];
    const [joined] = joinAccountsToCswap(slots, [a, b], true);
    expect(joined.matchSource).toBe("unmapped");
    expect(joined.cswap).toBeNull();
  });

  it("a slot with no label and no until cannot reset-match -> unmapped", () => {
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_6", label: null, until: null }];
    const [joined] = joinAccountsToCswap(slots, CSWAP_LIST_FIXTURE, true);
    expect(joined).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN_6", label: null, until: null, cswap: null, matchSource: "unmapped",
    });
  });

  it("two slots with an identical reset time, both candidates for the same single cswap account, both read unmapped (STATUS comment's named case)", () => {
    const account: CswapAccount = {
      email: "shared@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: "2026-10-05T14:00:00Z" },
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const slots: FleetAccountSlot[] = [
      { name: "CLAUDE_CODE_OAUTH_TOKEN_A", label: null, until: "2026-10-05T14:00:00Z" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_B", label: null, until: "2026-10-05T14:00:00Z" },
    ];
    const joins = joinAccountsToCswap(slots, [account], true);
    expect(joins[0].matchSource).toBe("unmapped");
    expect(joins[0].cswap).toBeNull();
    expect(joins[1].matchSource).toBe("unmapped");
    expect(joins[1].cswap).toBeNull();
  });

  it("a duplicate email across cswap accounts makes every slot that would've matched it via label read unmapped, never first-wins", () => {
    const dup1: CswapAccount = {
      email: "dup@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: "2026-10-05T14:00:00Z" },
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const dup2: CswapAccount = { ...dup1, usageAgeSeconds: 20 };
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_7", label: "dup@example.com", until: null }];
    const [joined] = joinAccountsToCswap(slots, [dup1, dup2], true);
    expect(joined.matchSource).toBe("unmapped");
    expect(joined.cswap).toBeNull();
  });

  it("a duplicate email removes those accounts from the pool entirely, so reset-time matching can't pick them either", () => {
    const dup1: CswapAccount = {
      email: "dup2@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: "2026-10-05T14:00:00Z" },
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const dup2: CswapAccount = { ...dup1, usage: { ...dup1.usage!, fiveHour: { pct: 1, resetsAt: "2026-10-20T00:00:00Z" } } };
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_8", label: null, until: "2026-10-05T14:02:00Z" }];
    const [joined] = joinAccountsToCswap(slots, [dup1, dup2], true);
    expect(joined.matchSource).toBe("unmapped");
    expect(joined.cswap).toBeNull();
  });

  it("cswapAvailable: false forces every slot to cswap-missing, regardless of label or until", () => {
    const slots: FleetAccountSlot[] = [
      { name: "CLAUDE_CODE_OAUTH_TOKEN", label: "primary@example.com", until: "2026-10-05T14:00:00Z" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, until: null },
    ];
    const joins = joinAccountsToCswap(slots, CSWAP_LIST_FIXTURE, false);
    expect(joins).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", label: "primary@example.com", until: "2026-10-05T14:00:00Z", cswap: null, matchSource: "cswap-missing" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, until: null, cswap: null, matchSource: "cswap-missing" },
    ]);
  });
});

describe("decideAccountSync", () => {
  const now = new Date("2026-10-05T12:00:00Z");

  function joinFor(cswap: CswapAccount): SlotJoin {
    return { name: "CLAUDE_CODE_OAUTH_TOKEN", label: cswap.email, until: null, cswap, matchSource: "label" };
  }

  it("BLOCKER 1 probe: an 86400s-old 1% reading must decide no-data, never clear", () => {
    const stale: CswapAccount = {
      email: "old@example.com", usageStatus: "ok", usageAgeSeconds: 86400,
      usage: {
        fiveHour: { pct: 1, resetsAt: "2026-10-05T14:00:00Z" },
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const decision = decideAccountSync(joinFor(stale), now);
    expect(decision.action).toBe("no-data");
    expect(decision.action).not.toBe("clear");
  });

  it("the fixture's stale-but-ok reading (900s, over the 600s ceiling) also gates to no-data", () => {
    expect(STALE_OK.usageAgeSeconds).toBeGreaterThanOrEqual(MAX_USAGE_AGE_SECONDS);
    const decision = decideAccountSync(joinFor(STALE_OK), now);
    expect(decision.action).toBe("no-data");
  });

  it("usageStatus !== 'ok' with usage: null -> no-data, regardless of thresholdPct", () => {
    expect(decideAccountSync(joinFor(RELOGIN_REQUIRED), now, 1).action).toBe("no-data");
    expect(decideAccountSync(joinFor(RELOGIN_REQUIRED), now, 99).action).toBe("no-data");
  });

  it("a malformed usage object (empty object) -> no-data, and never throws", () => {
    const malformed: CswapAccount = {
      email: "malformed@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {} as unknown as CswapAccount["usage"],
    };
    let decision: ReturnType<typeof decideAccountSync> | undefined;
    expect(() => { decision = decideAccountSync(joinFor(malformed), now); }).not.toThrow();
    expect(decision?.action).toBe("no-data");
  });

  it("a malformed usage.scoped (not an array) -> no-data, and never throws", () => {
    const malformed: CswapAccount = {
      email: "malformed2@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: null },
        sevenDay: { pct: 1, resetsAt: null, willLastToReset: true },
        scoped: "not-an-array" as unknown as CswapAccount["usage"] extends { scoped: infer S } ? S : never,
      },
    };
    let decision: ReturnType<typeof decideAccountSync> | undefined;
    expect(() => { decision = decideAccountSync(joinFor(malformed), now); }).not.toThrow();
    expect(decision?.action).toBe("no-data");
  });

  it("a malformed usage.fiveHour.pct (non-numeric) -> no-data, and never throws", () => {
    const malformed: CswapAccount = {
      email: "malformed3@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: "ninety" as unknown as number, resetsAt: null },
        sevenDay: { pct: 1, resetsAt: null, willLastToReset: true },
        scoped: [],
      },
    };
    let decision: ReturnType<typeof decideAccountSync> | undefined;
    expect(() => { decision = decideAccountSync(joinFor(malformed), now); }).not.toThrow();
    expect(decision?.action).toBe("no-data");
  });

  it("fiveHour pct >= 95 -> limit with fiveHour's own resetsAt", () => {
    const decision = decideAccountSync(joinFor(OVER_FIVE_HOUR), now);
    expect(decision).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until: OVER_FIVE_HOUR.usage!.fiveHour.resetsAt, seenAt: now.toISOString() });
  });

  it("sevenDay pct >= 95 -> limit with sevenDay's own resetsAt", () => {
    const account: CswapAccount = {
      email: "sevenday@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 10, resetsAt: "2026-10-05T13:00:00Z" },
        sevenDay: { pct: 95, resetsAt: "2026-10-09T00:00:00Z", willLastToReset: false },
        scoped: [],
      },
    };
    const decision = decideAccountSync(joinFor(account), now);
    expect(decision).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until: "2026-10-09T00:00:00Z", seenAt: now.toISOString() });
  });

  it("a scoped model >= 95, fiveHour/sevenDay both low -> limit with that scoped window's own resetsAt", () => {
    const decision = decideAccountSync(joinFor(OVER_SCOPED_ONLY), now);
    expect(decision).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit",
      until: OVER_SCOPED_ONLY.usage!.scoped[0].resetsAt, seenAt: now.toISOString(),
    });
  });

  it("all three below threshold -> clear", () => {
    const decision = decideAccountSync(joinFor(UNDER_THRESHOLD), now);
    expect(decision).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: now.toISOString() });
  });

  it("exactly at threshold (95) counts as limit, not clear", () => {
    const account: CswapAccount = {
      email: "exact@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 95, resetsAt: "2026-10-05T15:00:00Z" },
        sevenDay: { pct: 10, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const decision = decideAccountSync(joinFor(account), now);
    expect(decision.action).toBe("limit");
  });

  it("a limit decision's until is string | null, never undefined, even when resetsAt is null", () => {
    const account: CswapAccount = {
      email: "nulluntil@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 99, resetsAt: null },
        sevenDay: { pct: 10, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const decision = decideAccountSync(joinFor(account), now);
    expect(decision.action).toBe("limit");
    expect("until" in decision).toBe(true);
    const until = (decision as { until: unknown }).until;
    expect(typeof until === "string" || until === null).toBe(true);
    expect(until).toBeNull();
  });

  it("an unmanaged join (matchSource: unmapped) decides unmanaged, with no reason field", () => {
    const unmapped: SlotJoin = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, until: null, cswap: null, matchSource: "unmapped" };
    expect(decideAccountSync(unmapped, now)).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN_2", action: "unmanaged" });
  });

  it("an unmanaged join (matchSource: cswap-missing) decides unmanaged too", () => {
    const missing: SlotJoin = { name: "CLAUDE_CODE_OAUTH_TOKEN_3", label: "x@example.com", until: null, cswap: null, matchSource: "cswap-missing" };
    expect(decideAccountSync(missing, now)).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN_3", action: "unmanaged" });
  });

  it("respects a custom thresholdPct", () => {
    expect(decideAccountSync(joinFor(UNDER_THRESHOLD), now, 5).action).toBe("limit");
    expect(decideAccountSync(joinFor(UNDER_THRESHOLD), now, 50).action).toBe("clear");
  });
});

describe("pickHeadroomAccount", () => {
  function candidate(name: string, fiveHour: number, sevenDay: number, dataAgeMs: number = 0): HeadroomCandidate {
    return {
      name,
      cswap: {
        email: `${name}@example.com`,
        usageStatus: "ok",
        usageAgeSeconds: 10,
        usage: {
          fiveHour: { pct: fiveHour, resetsAt: null },
          sevenDay: { pct: sevenDay, resetsAt: null, willLastToReset: true },
          scoped: [],
        },
      },
      dataAgeMs,
    };
  }

  it("picks the lowest maxPct among fresh candidates", () => {
    const candidates = [candidate("a", 50, 20), candidate("b", 10, 30), candidate("c", 80, 5)];
    // maxPct: a=50, b=30, c=80 -> b wins
    expect(pickHeadroomAccount(candidates)).toBe("b");
  });

  it("excludes a candidate with lower pct but stale data (dataAgeMs >= freshnessMs)", () => {
    const fresh = candidate("fresh", 60, 60);
    const stale = candidate("stale", 5, 5, 10 * 60 * 1000);
    expect(pickHeadroomAccount([fresh, stale])).toBe("fresh");
  });

  it("returns null when all candidates are stale", () => {
    const candidates = [candidate("a", 10, 10, 10 * 60 * 1000), candidate("b", 20, 20, 15 * 60 * 1000)];
    expect(pickHeadroomAccount(candidates)).toBeNull();
  });

  it("returns null for empty candidates", () => {
    expect(pickHeadroomAccount([])).toBeNull();
  });

  it("respects a custom freshnessMs", () => {
    const c = candidate("a", 10, 10, 5000);
    expect(pickHeadroomAccount([c], 1000)).toBeNull();
    expect(pickHeadroomAccount([c], 10000)).toBe("a");
  });
});

describe("constants", () => {
  it("RESET_MATCH_WINDOW_MS is +/-5 minutes, per the STATUS comment's own number", () => {
    expect(RESET_MATCH_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it("MAX_USAGE_AGE_SECONDS is 10 minutes", () => {
    expect(MAX_USAGE_AGE_SECONDS).toBe(600);
  });
});
