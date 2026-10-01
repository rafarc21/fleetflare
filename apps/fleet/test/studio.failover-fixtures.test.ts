import { describe, it, expect } from "vitest";
import {
  detectRateLimitModal, RATE_LIMIT_HEADLINES, RATE_LIMIT_MODAL_MARKERS, SESSION_LIMIT_HEADLINE,
  PANE_CAPTURE_MARKER, MODAL_TAIL_LINES,
} from "../src/studio/failover";
import {
  V1_FULL_PANE, V1_STOP_AND_WAIT_PANE, V2_SESSION_LIMIT_PANE, V2_SESSION_LIMIT_RULE_PANE,
  V3_ADD_FUNDS_PANE, ORG_SPEND_LIMIT_PANE, USAGE_LIMIT_PANE, USAGE_LIMIT_REACHED_PANE, NOT_DETECTED,
} from "./fixtures/rate-limit-panes";

// ---------------------------------------------------------------------------
// Issue #101 — failover was blind to the wording claude printed on
// 2026-09-24. Every pane that fleet actually saw is a fixture here, and every
// wording the detector knows is pinned to one, so neither side can drift away
// from the other without a red test. PR #102's review added the other half:
// an idle lead TALKING about the limit must never look like one that hit it.
// ---------------------------------------------------------------------------

/** Two identical observations: a static pane, as `paneCaptureCmd()` prints it. */
function captured(pane: string): string {
  return `${pane}\n${PANE_CAPTURE_MARKER}\n${pane}\n`;
}

const DETECTED: { name: string; pane: string; headline: string | null; marker: string }[] = [
  { name: "V1 fleetflare--web-studio, last 18 lines", pane: V1_STOP_AND_WAIT_PANE,
    headline: null, marker: "Stop and wait for limit to reset" },
  { name: "V1 fleetflare--web-studio, full 127-line capture", pane: V1_FULL_PANE,
    headline: null, marker: "Stop and wait for limit to reset" },
  { name: "V2 demosite-life session limit, box prompt", pane: V2_SESSION_LIMIT_PANE,
    headline: "You've hit your session limit", marker: "/upgrade" },
  { name: "V2 demosite-life session limit, ❯-between-rules prompt + footer", pane: V2_SESSION_LIMIT_RULE_PANE,
    headline: "You've hit your session limit", marker: "/upgrade" },
  { name: "V3 acme-os add funds", pane: V3_ADD_FUNDS_PANE,
    headline: null, marker: "Add funds" },
  { name: "#53 org spend limit", pane: ORG_SPEND_LIMIT_PANE,
    headline: "You've hit your org's monthly spend limit", marker: "Upgrade your plan" },
  { name: "usage limit (not measured)", pane: USAGE_LIMIT_PANE,
    headline: "You've hit your usage limit", marker: "Upgrade your plan" },
  { name: "usage limit reached (not measured)", pane: USAGE_LIMIT_REACHED_PANE,
    headline: "Claude usage limit reached", marker: "Upgrade your plan" },
];

describe("detectRateLimitModal — panes seen in production", () => {
  for (const f of DETECTED) {
    it(`detects ${f.name}`, () => {
      const v = detectRateLimitModal(captured(f.pane));
      expect(v).toMatchObject({ kind: "modal", headline: f.headline, marker: f.marker });
    });
  }

  it("carries the reset time when the pane prints one", () => {
    expect(detectRateLimitModal(captured(V2_SESSION_LIMIT_PANE))).toMatchObject({ resets: "1:30pm (UTC)" });
    const madrid = V2_SESSION_LIMIT_PANE.replace("1:30pm (UTC)", "3:30pm (Europe/Madrid)");
    expect(detectRateLimitModal(captured(madrid))).toMatchObject({ resets: "3:30pm (Europe/Madrid)" });
  });

  it("has no reset time when the pane prints none", () => {
    const v = detectRateLimitModal(captured(V1_STOP_AND_WAIT_PANE));
    expect(v.kind).toBe("modal");
    if (v.kind !== "modal") throw new Error("unreachable");
    expect(v.resets).toBeUndefined();
  });
});

describe("detectRateLimitModal — nothing it knows is unpinned", () => {
  const verdicts = DETECTED.map((f) => detectRateLimitModal(captured(f.pane)));

  it("every RATE_LIMIT_HEADLINES entry, and the session-limit headline, is matched on a fixture", () => {
    for (const h of [...RATE_LIMIT_HEADLINES, SESSION_LIMIT_HEADLINE]) {
      expect(verdicts.some((v) => v.kind === "modal" && v.headline === h),
        `headline not pinned by any fixture: ${h}`).toBe(true);
    }
  });

  it("every RATE_LIMIT_MODAL_MARKERS entry is on a detected fixture", () => {
    for (const m of RATE_LIMIT_MODAL_MARKERS) {
      expect(DETECTED.some((f, i) => f.pane.includes(m) && verdicts[i].kind === "modal"),
        `marker not pinned by any fixture: ${m}`).toBe(true);
    }
  });

  // SESSION_LIMIT_HEADLINE's real behavior coverage: the DETECTED fixture
  // above (V2 demosite-life session limit) hardcodes this exact literal as
  // its expected `headline`, matched against detectRateLimitModal's REAL
  // output (line 47's toMatchObject) — not the import.
  it("knows the session-limit headline, but not as a bare substring marker", () => {
    expect(RATE_LIMIT_MODAL_MARKERS).not.toContain("/upgrade");
  });
});

describe("detectRateLimitModal — an idle lead talking about the limit is not a limit", () => {
  for (const [name, pane] of Object.entries(NOT_DETECTED)) {
    it(`does not fire on ${name}`, () => {
      expect(detectRateLimitModal(captured(pane)).kind).toBe("working");
    });
  }

  it("the session-limit headline with no /upgrade line is not a limit", () => {
    const headlineOnly = V2_SESSION_LIMIT_PANE.replace("/upgrade to increase your usage limit.", "");
    expect(detectRateLimitModal(captured(headlineOnly)).kind).toBe("working");
  });

  it("the V1 modal scrolled above the tail is scrollback, not a modal", () => {
    const buried = [V1_STOP_AND_WAIT_PANE, ...Array.from({ length: MODAL_TAIL_LINES + 5 }, (_, i) => `⏺ line ${i}`)]
      .join("\n");
    expect(detectRateLimitModal(captured(buried)).kind).toBe("working");
  });

  it("the V1 modal on a pane that repaints is a turn in flight, not a modal", () => {
    const v = detectRateLimitModal(
      `${V1_STOP_AND_WAIT_PANE}\n${PANE_CAPTURE_MARKER}\n${V1_STOP_AND_WAIT_PANE}\n✻ Thinking… (3s)\n`,
    );
    expect(v.kind).toBe("working");
  });
});
