// apps/fleet/test/studio.lead-account-mismatch.test.ts
//
// Issue #911: a glm-led studio's lead must never run on a Claude account.
// leadAccountMismatch is the one predicate every (re)start path and the fleet
// ls READY column share, so the rule cannot drift between them.
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

  it("a healthy glm row gets no override", () => {
    expect(readyOverride(running({ leadType: "glm" }), now)).toBeNull();
  });
});
