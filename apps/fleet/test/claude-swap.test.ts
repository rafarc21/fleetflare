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
  ABSENT_WILL_LAST_TO_RESET,
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

  it("a reset-time candidate exactly RESET_MATCH_WINDOW_MS away still matches -- the window's own edge is inclusive", () => {
    const resetsAt = "2026-10-05T14:00:00Z";
    const untilMs = Date.parse(resetsAt) + RESET_MATCH_WINDOW_MS;
    const account: CswapAccount = {
      email: "edge@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt },
        sevenDay: { pct: 1, resetsAt: "2026-10-20T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_EDGE", label: null, until: new Date(untilMs).toISOString() }];
    const [joined] = joinAccountsToCswap(slots, [account], true);
    expect(joined.matchSource).toBe("inferred");
    expect(joined.cswap).toEqual(account);
  });

  it("a reset-time candidate one millisecond past RESET_MATCH_WINDOW_MS falls outside the window -> unmapped", () => {
    const resetsAt = "2026-10-05T14:00:00Z";
    const untilMs = Date.parse(resetsAt) + RESET_MATCH_WINDOW_MS + 1;
    const account: CswapAccount = {
      email: "edge2@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt },
        sevenDay: { pct: 1, resetsAt: "2026-10-20T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_EDGE2", label: null, until: new Date(untilMs).toISOString() }];
    const [joined] = joinAccountsToCswap(slots, [account], true);
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

  // Maestro review round 2, finding 3: a malformed cswap entry anywhere in
  // the list must never crash the join — it is dropped from the matching
  // pool entirely, up front, before any label/reset-time logic runs. Every
  // case below uses an UNLABELED slot carrying a non-null `until` — the
  // exact trigger the maestro named: it forces the reset-time pass to
  // actually touch the malformed entry's `usage.fiveHour`/`sevenDay`, which
  // is where the pre-fix crash happened.
  it("a cswap entry missing usage.fiveHour entirely does not crash the reset-time join -- unmapped, never throws", () => {
    const malformed = {
      email: "missingfivehour@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    } as unknown as CswapAccount;
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_MALFORMED_1", label: null, until: "2026-10-05T14:00:00Z" }];
    let joins: SlotJoin[] | undefined;
    expect(() => { joins = joinAccountsToCswap(slots, [malformed], true); }).not.toThrow();
    expect(joins![0]).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN_MALFORMED_1", label: null, until: "2026-10-05T14:00:00Z", cswap: null, matchSource: "unmapped",
    });
  });

  it("a cswap entry with usage: {} (present but empty) does not crash the reset-time join -- unmapped, never throws", () => {
    const malformed = {
      email: "emptyusage@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {},
    } as unknown as CswapAccount;
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_MALFORMED_2", label: null, until: "2026-10-05T14:00:00Z" }];
    let joins: SlotJoin[] | undefined;
    expect(() => { joins = joinAccountsToCswap(slots, [malformed], true); }).not.toThrow();
    expect(joins![0]).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN_MALFORMED_2", label: null, until: "2026-10-05T14:00:00Z", cswap: null, matchSource: "unmapped",
    });
  });

  it("a bare null inside cswapAccounts does not crash the reset-time join -- unmapped, never throws, .email is never read off it", () => {
    const cswapAccounts = [null] as unknown as CswapAccount[];
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_MALFORMED_3", label: null, until: "2026-10-05T14:00:00Z" }];
    let joins: SlotJoin[] | undefined;
    expect(() => { joins = joinAccountsToCswap(slots, cswapAccounts, true); }).not.toThrow();
    expect(joins![0]).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN_MALFORMED_3", label: null, until: "2026-10-05T14:00:00Z", cswap: null, matchSource: "unmapped",
    });
  });

  // Regression (issue #244): the fix must stay surgical -- `email` is on
  // the task's own keep-required list, so an empty/missing email must still
  // fail `isValidCswapAccountForJoin`, same as before this fix.
  it("regression: an empty email still fails join validation -- dropped from the pool, never matched", () => {
    const malformed = {
      email: "", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: null },
        sevenDay: { pct: 1, resetsAt: null },
        scoped: [],
      },
    } as unknown as CswapAccount;
    const slots: FleetAccountSlot[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN_MALFORMED_4", label: "", until: null }];
    const [joined] = joinAccountsToCswap(slots, [malformed], true);
    expect(joined.matchSource).toBe("unmapped");
    expect(joined.cswap).toBeNull();
  });

  // Issue #244: a real-shape account missing `sevenDay.willLastToReset`
  // entirely (and `scoped[0].name` entirely) must still pass
  // `isValidCswapAccountForJoin` and match by label, never get dropped from
  // the pool as malformed (the pre-fix behavior for this exact shape).
  it("a real-shape account missing willLastToReset and scoped[].name entirely still matches by label, never dropped as malformed", () => {
    const slots: FleetAccountSlot[] = [
      { name: "CLAUDE_CODE_OAUTH_TOKEN", label: ABSENT_WILL_LAST_TO_RESET.email, until: null },
    ];
    const [joined] = joinAccountsToCswap(slots, [ABSENT_WILL_LAST_TO_RESET], true);
    expect(joined).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN", label: ABSENT_WILL_LAST_TO_RESET.email, until: null,
      cswap: ABSENT_WILL_LAST_TO_RESET, matchSource: "label",
    });
    expect(joined.matchSource).not.toBe("unmapped");
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

  it("usageAgeSeconds one below MAX_USAGE_AGE_SECONDS is fresh enough -- a real over-threshold reading still decides limit", () => {
    const account: CswapAccount = {
      email: "freshedge@example.com", usageStatus: "ok", usageAgeSeconds: MAX_USAGE_AGE_SECONDS - 1,
      usage: {
        fiveHour: { pct: 99, resetsAt: "2026-10-05T15:00:00Z" },
        sevenDay: { pct: 10, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const decision = decideAccountSync(joinFor(account), now);
    expect(decision.action).toBe("limit");
  });

  it("usageAgeSeconds exactly MAX_USAGE_AGE_SECONDS is already too stale -> no-data, even with an over-threshold reading", () => {
    const account: CswapAccount = {
      email: "staleedge@example.com", usageStatus: "ok", usageAgeSeconds: MAX_USAGE_AGE_SECONDS,
      usage: {
        fiveHour: { pct: 99, resetsAt: "2026-10-05T15:00:00Z" },
        sevenDay: { pct: 10, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const decision = decideAccountSync(joinFor(account), now);
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
    expect(decision).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: now.toISOString(),
      usageAgeSeconds: UNDER_THRESHOLD.usageAgeSeconds,
    });
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

// Maestro real-probe review of PR #242 (issue #240): the real `cswap list
// --json` per-account usage shape differs from this codebase's own
// validators/types in four ways, and the strictness rejected every real
// account outright -- every slot read "unmapped" even when a label matched a
// real account's email. These four cases each pin ONE real-shape mismatch
// directly against decideAccountSync/isValidUsage (there's no separate
// export for the validators themselves -- decideAccountSync is the one
// place that calls isValidUsage and turns "malformed shape" into an
// observable "no-data" outcome, so that's the behavior these tests pin).
describe("real cswap shape tolerance (maestro real-probe review, issue #240)", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  function joinFor(cswap: CswapAccount): SlotJoin {
    return { name: "CLAUDE_CODE_OAUTH_TOKEN", label: cswap.email, until: null, cswap, matchSource: "label" };
  }

  it("a scoped window using 'name' (real shape) instead of 'model' is accepted, not rejected as malformed", () => {
    const account: CswapAccount = {
      email: "scopedname@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: "2026-10-05T14:00:00Z" },
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [{ name: "claude-opus-4", pct: 97, resetsAt: "2026-10-06T00:00:00Z" } as unknown as CswapAccount["usage"] extends { scoped: (infer S)[] } ? S : never],
      },
    };
    const decision = decideAccountSync(joinFor(account), now);
    // Real shape must trip the scoped window's own 97% -- "limit", never
    // "no-data" (which is what the old 'model'-expecting validator decided,
    // dropping this account's usage entirely).
    expect(decision.action).toBe("limit");
  });

  it("a window with the resetsAt KEY ENTIRELY ABSENT is accepted, identically to an explicit resetsAt: null", () => {
    const missingKey: CswapAccount = {
      email: "missingkey@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 99 } as unknown as CswapAccount["usage"] extends { fiveHour: infer W } ? W : never, // no resetsAt key at all
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const explicitNull: CswapAccount = {
      ...missingKey, email: "explicitnull@example.com",
      usage: { ...missingKey.usage!, fiveHour: { pct: 99, resetsAt: null } },
    };
    const missingDecision = decideAccountSync(joinFor(missingKey), now);
    const nullDecision = decideAccountSync(joinFor(explicitNull), now);
    expect(missingDecision.action).toBe("limit");
    expect(missingDecision).toEqual({ ...nullDecision, name: missingDecision.name });
    expect((missingDecision as { until: string | null }).until).toBeNull();
  });

  it("sevenDay.willLastToReset: null (not a boolean) is accepted, not rejected as malformed", () => {
    const account: CswapAccount = {
      email: "nullwilllast@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 1, resetsAt: "2026-10-05T14:00:00Z" },
        sevenDay: { pct: 97, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: null as unknown as boolean },
        scoped: [],
      },
    };
    const decision = decideAccountSync(joinFor(account), now);
    // sevenDay's own 97% must trip "limit" -- the old boolean-only validator
    // decided "no-data" (malformed usage shape) for this exact account.
    expect(decision.action).toBe("limit");
  });

  it("extra unrecognized keys on a window (countdown, clock, expectedPct, aheadOfPace) were already tolerated -- confirms this, not a fix", () => {
    const account: CswapAccount = {
      email: "extrakeys@example.com", usageStatus: "ok", usageAgeSeconds: 10,
      usage: {
        fiveHour: {
          pct: 97, resetsAt: "2026-10-05T14:00:00Z",
          countdown: "3h12m", clock: "14:00:00Z", expectedPct: 95, aheadOfPace: true,
        } as unknown as CswapAccount["usage"] extends { fiveHour: infer W } ? W : never,
        sevenDay: { pct: 1, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
        scoped: [],
      },
    };
    const decision = decideAccountSync(joinFor(account), now);
    expect(decision.action).toBe("limit");
  });

  // Issue #244: `willLastToReset` can be ABSENT entirely (never a key on
  // `sevenDay` at all), not just `null`/boolean -- observed live, 2026-10-06,
  // on a fresh account. The old validator required `typeof willLastToReset
  // === "boolean" || willLastToReset === null`, which an absent key
  // (reading as `undefined`) failed -- dropping the account as malformed.
  it("sevenDay.willLastToReset entirely ABSENT (no key at all) is accepted, not rejected as malformed", () => {
    expect("willLastToReset" in ABSENT_WILL_LAST_TO_RESET.usage!.sevenDay).toBe(false);
    const decision = decideAccountSync(joinFor(ABSENT_WILL_LAST_TO_RESET), now);
    expect(decision.action).toBe("clear");
    expect(decision.action).not.toBe("no-data");
  });

  // Issue #244's second finding, same bug class: a scoped window missing
  // `name` entirely (real shape, some accounts) must stay valid -- nothing
  // in this module reads `.scoped[].name` for any decision.
  it("a scoped window missing 'name' entirely is accepted, not rejected as malformed", () => {
    expect("name" in ABSENT_WILL_LAST_TO_RESET.usage!.scoped[0]).toBe(false);
    const decision = decideAccountSync(joinFor(ABSENT_WILL_LAST_TO_RESET), now);
    expect(decision.action).not.toBe("no-data");
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
