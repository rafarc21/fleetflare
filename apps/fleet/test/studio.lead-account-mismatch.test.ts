// apps/fleet/test/studio.lead-account-mismatch.test.ts
//
// Issue #911: a glm-led studio's lead must never run on a Claude account.
// leadAccountMismatch is the predicate the fleet ls READY column reads (#1142
// item 4: the (re)start paths gate on leadType directly, not on this).
import { describe, it, expect } from "vitest";
import { leadAccountMismatch } from "../src/studio/lead-route";
import { readyOverride } from "../cli/readiness-format";
import type { StudioStatus } from "../src/studio/types";

describe("leadAccountMismatch (#911)", () => {
  it("glm lead recorded on a Claude account is a mismatch", () => {
    expect(leadAccountMismatch({ leadType: "glm", launchedAccount: "acme" })).toBe(true);
  });

  it("glm lead with no recorded Claude account is not a mismatch", () => {
    expect(leadAccountMismatch({ leadType: "glm" })).toBe(false);
    expect(leadAccountMismatch({ leadType: "glm", launchedAccount: null })).toBe(false);
  });

  it("claude lead on any account is not a mismatch", () => {
    expect(leadAccountMismatch({ leadType: "claude", launchedAccount: "acme" })).toBe(false);
    expect(leadAccountMismatch({ launchedAccount: "acme" })).toBe(false);
  });
});

describe("fleet ls READY surfaces a lead on the wrong account (#911)", () => {
  const now = new Date("2026-10-16T15:30:00Z");
  const running = (partial: Partial<StudioStatus>): StudioStatus =>
    ({ id: "acme-app--web-studio", state: "running", ...partial } as StudioStatus);

  it("glm row with a Claude launchedAccount reads 'lead on wrong account'", () => {
    const out = readyOverride(running({ leadType: "glm", launchedAccount: "acme" }), now);
    expect(out).toContain("lead on wrong account");
  });

  // Issue #1142, item 3 — a wedged row's recycle cost is what the operator
  // needs before deciding; the mismatch line must not hide it.
  it("a wedged glm row on a Claude account reads 'unreachable' (recycle cost first), not the mismatch", () => {
    const wedged = running({
      leadType: "glm",
      launchedAccount: "acme",
      observed: {
        execFailures: 3, lastShipOkAt: "2026-10-16T15:00:00.000Z", unreachableSince: "2026-10-16T15:00:00.000Z",
        lastSnapshotAt: null,
      } as unknown as StudioStatus["observed"],
    });
    const out = readyOverride(wedged, now);
    expect(out).toContain("unreachable");
    expect(out).not.toContain("lead on wrong account");
  });

  it("a healthy glm row gets no override", () => {
    expect(readyOverride(running({ leadType: "glm" }), now)).toBeNull();
  });
});
