import { describe, it, expect } from "vitest";
import { detectRateLimitModal, PANE_CAPTURE_MARKER, DEAD_ACCOUNT_HEADLINE } from "../src/studio/failover";
import { ORG_DISABLED_PANE, NOT_DETECTED_141 } from "./fixtures/rate-limit-panes";

// ---------------------------------------------------------------------------
// Issue #141 — "Your organization has disabled Claude subscription access for
// Claude Code · Use an Anthropic API key instead" is NOT a rate limit: it
// never resets, and it is not a select-style modal (no options, no Enter/Esc
// footer) — it is a plain inline `⎿` line, same shape as the existing "out of
// usage credits" inline block. This file pins the detector the same way
// studio.failover-fixtures.test.ts pins every OTHER shape: a fixture that
// must fire, a fixture that must not, and a mid-turn repaint that must not.
// ---------------------------------------------------------------------------

/** Two identical observations: a static pane, as `paneCaptureCmd()` prints it. */
function captured(first: string, second = first): string {
  return `${first}\n${PANE_CAPTURE_MARKER}\n${second}\n`;
}

describe("detectRateLimitModal — issue #141 dead account (org disabled subscription access)", () => {
  it("fires on the org-disabled pane: a dead, inline, permanent modal", () => {
    const v = detectRateLimitModal(captured(ORG_DISABLED_PANE));
    expect(v).toEqual({
      kind: "modal", headline: DEAD_ACCOUNT_HEADLINE, marker: "dead-account", inline: true, dead: true,
    });
  });

  for (const [name, pane] of Object.entries(NOT_DETECTED_141)) {
    it(`does not fire on ${name}`, () => {
      expect(detectRateLimitModal(captured(pane)).kind).not.toBe("modal");
    });
  }

  it("a turn in flight (pane repaints) never fires, even on the same wording", () => {
    const a = ORG_DISABLED_PANE;
    const b = ORG_DISABLED_PANE.replace("Opening the PR for the pilot fix.", "Opening the PR for the pilot fix..");
    const v = detectRateLimitModal(captured(a, b));
    expect(v.kind).toBe("working");
  });
});
