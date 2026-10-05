/**
 * Issue #232 — pure join/decision logic for `fleet accounts sync`.
 * No network, no D1, no cswap binary — every case here is driven by the
 * HAND-BUILT fixture in test/fixtures/cswap-list.ts (see its own header).
 */
import { describe, it, expect } from "vitest";
import {
  joinAccountsToCswap, decideAccountSync, pickHeadroomAccount,
  type FleetAccountSlot, type SlotJoin, type CswapAccount, type HeadroomCandidate,
} from "../src/studio/claude-swap";
import { OVER_FIVE_HOUR, UNDER_THRESHOLD, OVER_SCOPED_ONLY, CSWAP_LIST_FIXTURE } from "./fixtures/cswap-list";

describe("joinAccountsToCswap", () => {
  const slots: FleetAccountSlot[] = [
    { name: "CLAUDE_CODE_OAUTH_TOKEN", label: "primary@example.com" },
    { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null },
    { name: "CLAUDE_CODE_OAUTH_TOKEN_3", label: "ghost@example.com" },
  ];

  it("matches a slot to a cswap row by exact label===email", () => {
    const [joined] = joinAccountsToCswap(slots, CSWAP_LIST_FIXTURE, true);
    expect(joined).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", label: "primary@example.com", cswap: OVER_FIVE_HOUR });
  });

  it("a slot with no label reads no-label", () => {
    const [, noLabel] = joinAccountsToCswap(slots, CSWAP_LIST_FIXTURE, true);
    expect(noLabel).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, cswap: null, reason: "no-label" });
  });

  it("a slot with a label but no matching cswap row reads not-managed", () => {
    const [, , notManaged] = joinAccountsToCswap(slots, CSWAP_LIST_FIXTURE, true);
    expect(notManaged).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN_3", label: "ghost@example.com", cswap: null, reason: "not-managed" });
  });

  it("cswapAvailable: false forces every slot to cswap-missing, regardless of label", () => {
    const joins = joinAccountsToCswap(slots, CSWAP_LIST_FIXTURE, false);
    expect(joins).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", label: "primary@example.com", cswap: null, reason: "cswap-missing" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, cswap: null, reason: "cswap-missing" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_3", label: "ghost@example.com", cswap: null, reason: "cswap-missing" },
    ]);
  });
});

describe("decideAccountSync", () => {
  const now = new Date("2026-10-05T12:00:00Z");

  function joinFor(cswap: CswapAccount): SlotJoin {
    return { name: "CLAUDE_CODE_OAUTH_TOKEN", label: cswap.email, cswap };
  }

  it("fiveHour pct >= 95 -> limit with fiveHour's own resetsAt", () => {
    const decision = decideAccountSync(joinFor(OVER_FIVE_HOUR), now);
    expect(decision).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until: OVER_FIVE_HOUR.usage.fiveHour.resetsAt, seenAt: now.toISOString() });
  });

  it("sevenDay pct >= 95 -> limit with sevenDay's own resetsAt", () => {
    const account: CswapAccount = {
      email: "sevenday@example.com",
      usageStatus: "active",
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
      until: OVER_SCOPED_ONLY.usage.scoped[0].resetsAt, seenAt: now.toISOString(),
    });
  });

  it("all three below threshold -> clear", () => {
    const decision = decideAccountSync(joinFor(UNDER_THRESHOLD), now);
    expect(decision).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear" });
  });

  it("exactly at threshold (95) counts as limit, not clear", () => {
    const account: CswapAccount = {
      email: "exact@example.com",
      usageStatus: "active",
      usage: {
        fiveHour: { pct: 95, resetsAt: "2026-10-05T15:00:00Z" },
        sevenDay: { pct: 10, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const decision = decideAccountSync(joinFor(account), now);
    expect(decision.action).toBe("limit");
  });

  it("an unmanaged join passes its reason through, never limit or clear", () => {
    const unmanaged: SlotJoin = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, cswap: null, reason: "no-label" };
    expect(decideAccountSync(unmanaged, now)).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN_2", action: "unmanaged", reason: "no-label" });

    const cswapMissing: SlotJoin = { name: "CLAUDE_CODE_OAUTH_TOKEN_3", label: "x@example.com", cswap: null, reason: "cswap-missing" };
    expect(decideAccountSync(cswapMissing, now)).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN_3", action: "unmanaged", reason: "cswap-missing" });

    const notManaged: SlotJoin = { name: "CLAUDE_CODE_OAUTH_TOKEN_4", label: "y@example.com", cswap: null, reason: "not-managed" };
    expect(decideAccountSync(notManaged, now)).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN_4", action: "unmanaged", reason: "not-managed" });
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
        usageStatus: "active",
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
