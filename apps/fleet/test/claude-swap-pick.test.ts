/**
 * Split S35-F11 (refs #804) out of the former test/claude-swap.test.ts: the
 * USAGE + PICK half. usageMaxPct/toUsageHeadroom is issue #238's scoped-window
 * fold-in; pickHeadroomAccount picks the account with the most headroom for
 * `fleet accounts sync`. No network, no D1, no cswap binary — same pure
 * per-account arithmetic as the join half in test/claude-swap-join.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  usageMaxPct, toUsageHeadroom, pickHeadroomAccount,
  type CswapAccount, type HeadroomCandidate, type UsageHeadroom,
} from "../src/studio/claude-swap";
import { OVER_SCOPED_ONLY, STALE_OK } from "./fixtures/cswap-list";

describe("usageMaxPct / toUsageHeadroom — issue #238's scoped-window fold-in", () => {
  it("usageMaxPct: a higher scopedMaxPct dominates both fiveHourPct and sevenDayPct", () => {
    const u: UsageHeadroom = { fiveHourPct: 10, sevenDayPct: 20, scopedMaxPct: 90 };
    expect(usageMaxPct(u)).toBe(90);
  });

  it("usageMaxPct: scopedMaxPct: null falls back to max(fiveHourPct, sevenDayPct), no crash", () => {
    expect(usageMaxPct({ fiveHourPct: 30, sevenDayPct: 70, scopedMaxPct: null })).toBe(70);
    expect(usageMaxPct({ fiveHourPct: 85, sevenDayPct: 10, scopedMaxPct: null })).toBe(85);
  });

  it("toUsageHeadroom extracts scopedMaxPct as the max of usage.scoped[].pct", () => {
    expect(toUsageHeadroom(OVER_SCOPED_ONLY)).toEqual({ fiveHourPct: 30, sevenDayPct: 45, scopedMaxPct: 96 });
  });

  it("toUsageHeadroom: scopedMaxPct is null when usage.scoped is empty", () => {
    expect(toUsageHeadroom(STALE_OK)).toEqual({ fiveHourPct: 1, sevenDayPct: 2, scopedMaxPct: null });
  });
});

describe("pickHeadroomAccount", () => {
  function candidate(
    name: string, fiveHour: number, sevenDay: number, dataAgeMs: number = 0, scoped: number[] = [],
  ): HeadroomCandidate {
    return {
      name,
      cswap: {
        email: `${name}@example.com`,
        usageStatus: "ok",
        usageAgeSeconds: 10,
        usage: {
          fiveHour: { pct: fiveHour, resetsAt: null },
          sevenDay: { pct: sevenDay, resetsAt: null, willLastToReset: true },
          scoped: scoped.map((pct, i) => ({ name: `model-${i}`, pct, resetsAt: null })),
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

  it("issue #238: a candidate's SCOPED window, not its fiveHour/sevenDay, is what makes it the WORSE choice — proves the fold-in fix changed real behaviour, not just added an unused helper", () => {
    // "scoped" has low fiveHour/sevenDay (10/20) but a scoped window at 99% —
    // the pre-fix maxPct (max(fiveHour, sevenDay) only) would have read this
    // as 20, the best of the two, and wrongly picked it. "plain" has no
    // scoped windows and a real maxPct of 50 — genuinely more headroom once
    // scoped is correctly folded in.
    const scopedWorse = candidate("scoped", 10, 20, 0, [99]);
    const plainBetter = candidate("plain", 40, 50, 0, []);
    expect(pickHeadroomAccount([scopedWorse, plainBetter])).toBe("plain");
  });
});
