import { describe, it, expect } from "vitest";
import { detectRateLimitModal, PANE_CAPTURE_MARKER } from "../src/studio/failover";
import {
  startOfNextMonthUtc, accountHoldActive, encodeAccountLimitState, decodeAccountLimitState, formatRateLimited,
} from "../src/studio/rate-limit";
import { accountIsFree, NULL_UNTIL_CEILING_MS } from "../src/studio/accounts";
import {
  ORG_SPEND_LIMIT_PANE, ORG_SPEND_CAP_TAIL_PANE, ORG_SPEND_CAP_RULED_PANE, MONTHLY_SPEND_SESSION_PANE,
  V1_THREE_OPTION_PANE,
} from "./fixtures/rate-limit-panes";

// ---------------------------------------------------------------------------
// Issue #336 — an org's MONTHLY spend cap is not a 5h/7d window: it does not
// reset at the window end. Detect it, and hold the account limited until the
// month rolls over (or an operator clears it).
// ---------------------------------------------------------------------------

function captured(pane: string): string {
  return `${pane}\n${PANE_CAPTURE_MARKER}\n${pane}\n`;
}

const NOW = new Date("2026-10-10T10:28:00.000Z");

describe("issue #336 — detecting the org monthly spend cap", () => {
  it("the measured headline with its ' · ask your admin to raise it' tail is a spend-cap modal", () => {
    expect(detectRateLimitModal(captured(ORG_SPEND_CAP_TAIL_PANE), NOW)).toMatchObject({
      kind: "modal", headline: "You've hit your org's monthly spend limit", spendCap: true,
    });
  });

  it("the original 09-23 org headline (no tail) is a spend cap too", () => {
    expect(detectRateLimitModal(captured(ORG_SPEND_LIMIT_PANE), NOW)).toMatchObject({ kind: "modal", spendCap: true });
  });

  it("the headline above a ▔-ruled select (no /rate-limit-options row) still marks the modal a spend cap", () => {
    expect(detectRateLimitModal(captured(ORG_SPEND_CAP_RULED_PANE), NOW)).toMatchObject({ kind: "modal", spendCap: true });
  });

  it("a plain window select modal is NOT a spend cap", () => {
    const v = detectRateLimitModal(captured(V1_THREE_OPTION_PANE), NOW);
    expect(v.kind).toBe("modal");
    expect((v as { spendCap?: true }).spendCap).toBeUndefined();
  });

  it("a personal monthly-spend inline block that names a session reset is NOT a spend cap (it ends at that reset)", () => {
    const v = detectRateLimitModal(captured(MONTHLY_SPEND_SESSION_PANE), new Date("2026-09-24T10:00:00Z"));
    expect(v.kind).toBe("modal");
    expect((v as { spendCap?: true }).spendCap).toBeUndefined();
  });
});

describe("issue #336 — startOfNextMonthUtc", () => {
  it("is the first instant of the next UTC month", () => {
    expect(startOfNextMonthUtc(NOW)).toBe("2026-11-01T00:00:00.000Z");
  });
  it("rolls December into January of the next year", () => {
    expect(startOfNextMonthUtc(new Date("2026-12-31T23:59:59.000Z"))).toBe("2027-01-01T00:00:00.000Z");
  });
  it("on the 1st at 00:00Z it is still the NEXT month, never now", () => {
    expect(startOfNextMonthUtc(new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-12-01T00:00:00.000Z");
  });
});

describe("issue #336 — AccountLimitState kind/reason", () => {
  it("round-trips kind and reason", () => {
    const s = { until: "2026-11-01T00:00:00.000Z", seenAt: NOW.toISOString(), kind: "spend_cap" as const, reason: "org cap" };
    expect(decodeAccountLimitState(encodeAccountLimitState(s))).toEqual(s);
  });
  it("an unknown kind reads as a corrupt row (null), never a silently-dropped field", () => {
    expect(decodeAccountLimitState(JSON.stringify({ until: null, seenAt: NOW.toISOString(), kind: "weird" }))).toBeNull();
  });
  it("a row with no kind decodes exactly as before", () => {
    expect(decodeAccountLimitState(JSON.stringify({ until: null, seenAt: NOW.toISOString() })))
      .toEqual({ until: null, seenAt: NOW.toISOString() });
  });
});

describe("issue #336 — accountHoldActive", () => {
  const seenAt = NOW.toISOString();
  it("null for no row, and for a plain window row", () => {
    expect(accountHoldActive(null, NOW)).toBeNull();
    expect(accountHoldActive({ until: "2026-10-10T15:00:00.000Z", seenAt }, NOW)).toBeNull();
  });
  it("the kind while a spend_cap/hold until is still ahead", () => {
    expect(accountHoldActive({ until: "2026-11-01T00:00:00.000Z", seenAt, kind: "spend_cap" }, NOW)).toBe("spend_cap");
    expect(accountHoldActive({ until: "2026-11-01T00:00:00.000Z", seenAt, kind: "hold" }, NOW)).toBe("hold");
  });
  it("a hold with no until is held until cleared", () => {
    expect(accountHoldActive({ until: null, seenAt, kind: "hold" }, new Date("2027-06-01T00:00:00Z"))).toBe("hold");
  });
  it("null once the until has passed", () => {
    expect(accountHoldActive({ until: "2026-11-01T00:00:00.000Z", seenAt, kind: "spend_cap" }, new Date("2026-11-01T00:00:00Z"))).toBeNull();
  });
});

describe("issue #336 — accountIsFree on held rows", () => {
  const a = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: "t" };
  it("a spend_cap row is NOT free at the next 5h reset — only at the month rollover", () => {
    const limits = { [a.name]: { until: "2026-11-01T00:00:00.000Z", seenAt: NOW.toISOString(), kind: "spend_cap" as const } };
    expect(accountIsFree(a, limits, new Date("2026-10-10T12:00:00Z"))).toBe(false);
    expect(accountIsFree(a, limits, new Date("2026-11-01T00:00:00Z"))).toBe(true);
  });
  it("an operator hold with no until never gets the 24h null-until grace", () => {
    const limits = { [a.name]: { until: null, seenAt: NOW.toISOString(), kind: "hold" as const } };
    expect(accountIsFree(a, limits, new Date(NOW.getTime() + NULL_UNTIL_CEILING_MS * 10))).toBe(false);
  });
});

describe("issue #336 — formatRateLimited names the spend cap", () => {
  it("a spend-cap observation reads as the org cap, not a window", () => {
    expect(formatRateLimited({ until: null, seenAt: NOW.toISOString(), select: true, spendCap: true }, NOW, "s1"))
      .toBe("org monthly spend cap hit — held until month end (ff s1)");
  });
});
