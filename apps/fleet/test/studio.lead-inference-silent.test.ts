// apps/fleet/test/studio.lead-inference-silent.test.ts
//
// Issue #1142, item 2 (issue #911 ask): a router-led (glm/kimi/deepseek) row
// whose lead reads "working" but made ZERO router calls in the INFER window is
// silent — READY must say so. Review F2: the rule now reads the SAME gate fleet
// ls ACTIVITY reads (leadGate), a fresh mirror, and a working run long enough to
// have logged a call. Pure rule only; the table wiring is pinned in
// test/bun/cli.fleet-ls-infer.test.ts.
import { describe, it, expect } from "vitest";
import { isLeadInferenceSilent } from "../cli/readiness-format";
import type { StudioStatus } from "../src/studio/types";

const NOW = new Date("2026-10-16T15:30:00.000Z");
const MIN = 60_000;
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * MIN).toISOString();

/** A router-led row whose lead has been working for 10 minutes, mirror fresh. */
function working(partial: Partial<StudioStatus> = {}, activity: { since?: string; observedAt?: string } = {}): StudioStatus {
  return {
    id: "acme-app--web-studio", state: "running", leadType: "glm",
    observed: {
      activity: { state: "working", since: minutesAgo(10), anchored: true, observedAt: NOW.toISOString(), ...activity },
    },
    ...partial,
  } as unknown as StudioStatus;
}

describe("isLeadInferenceSilent (#1142 item 2)", () => {
  it("a working router-led row with a known map and no entry (0 calls) is silent", () => {
    expect(isLeadInferenceSilent(working(), undefined, true, NOW)).toBe(true);
  });

  it("a working router-led row with a 0-call entry is silent", () => {
    expect(isLeadInferenceSilent(working(), { calls: 0, ok: 0 }, true, NOW)).toBe(true);
  });

  it("no usage map at all (route unavailable) is never silent: absence there is no data, not 0", () => {
    expect(isLeadInferenceSilent(working(), undefined, false, NOW)).toBe(false);
  });

  it("any router call in the window clears it", () => {
    expect(isLeadInferenceSilent(working(), { calls: 1, ok: 1 }, true, NOW)).toBe(false);
  });

  it("a Claude-led row is never silent", () => {
    expect(isLeadInferenceSilent(working({ leadType: "claude" }), undefined, true, NOW)).toBe(false);
  });

  it("an idle router-led row is not silent: only a lead that claims to be working", () => {
    const idle = working({
      observed: { activity: { state: "idle", since: minutesAgo(10), anchored: true, observedAt: NOW.toISOString() } } as unknown as StudioStatus["observed"],
    });
    expect(isLeadInferenceSilent(idle, undefined, true, NOW)).toBe(false);
  });

  // Review F2 — the cases the review measured as false positives.
  it("a STALE activity mirror (40 min old) is not silent: fleet ls would print '? stale', not working", () => {
    expect(isLeadInferenceSilent(working({}, { observedAt: minutesAgo(40) }), undefined, true, NOW)).toBe(false);
  });

  it("a lead working for only seconds is not silent: its first call has not logged yet", () => {
    expect(isLeadInferenceSilent(working({}, { since: minutesAgo(0) }), undefined, true, NOW)).toBe(false);
  });

  it("an unparseable activity timestamp is not silent: NaN must never read as a long-running turn", () => {
    expect(isLeadInferenceSilent(working({}, { since: "not-a-date" }), undefined, true, NOW)).toBe(false);
    expect(isLeadInferenceSilent(working({}, { observedAt: "not-a-date" }), undefined, true, NOW)).toBe(false);
  });

  it("a REPLACED row is not silent: leadGate says 'replaced', not working", () => {
    const replaced = working({
      observed: {
        activity: { state: "working", since: minutesAgo(10), anchored: true, observedAt: NOW.toISOString() },
        replacedAt: minutesAgo(40),
      } as unknown as StudioStatus["observed"],
    });
    expect(isLeadInferenceSilent(replaced, undefined, true, NOW)).toBe(false);
  });

  it("a LIMIT row is not silent: leadGate says 'limit', not working", () => {
    const limited = working({ rateLimited: { until: null } as unknown as StudioStatus["rateLimited"] });
    expect(isLeadInferenceSilent(limited, undefined, true, NOW)).toBe(false);
  });
});
