// Issue #311 — member-row parsing, poll-loop thresholds, gone-row diff, and
// the alert builder that composes memguard kills + row liveness into
// `MemberAlert`s. See docs/superpowers/specs/2026-09-24-row-tells-truth-
// design.md, "PR3 addendum (issue #311)", for the full design and the two
// mutant-proof claims this file pins:
//   (a) a memguard kill that DID happen must always surface as an alert;
//   (b) a member's row disappearing is NEVER, on its own, evidence of
//       death — only a corroborating memguard kill inside the correlation
//       window earns a `member-gone` alert, and it is marked `inferred`.
import { describe, it, expect } from "vitest";
import {
  parseMemberRows, pollLoopFlags, goneMemberNames, buildMemberAlerts,
  POLL_LOOP_ELAPSED_MINUTES, POLL_LOOP_TOKENS,
  type MemberRow,
} from "../src/studio/member-alerts";
import type { MemguardKillLogEntry } from "../src/studio/memguard-log";
import { REAL_WEBSTUDIO_PANE } from "./fixtures/rate-limit-panes";

describe("parseMemberRows (issue #311)", () => {
  it("parses name, elapsed seconds, and an absolute token count off a real fixture row", () => {
    // REAL_WEBSTUDIO_PANE's own tail: "  ◯ frontend-developer  Track A e2e
    // harness tasks 1… 1h 1m 15s · ↑ 225.5k tokens" (test/fixtures/rate-
    // limit-panes.ts) — the SAME real capture this spec's own state table
    // cites for the WAITING MEMBERS panel-diff leg.
    const rows = parseMemberRows(REAL_WEBSTUDIO_PANE);
    expect(rows).toEqual([{ name: "frontend-developer", elapsedS: 3675, tokens: 225500 }]);
  });

  it("a row with no elapsed/tokens ('  ● main') is skipped, never a crash", () => {
    const pane = [
      "⏺ Done.", "", "─".repeat(20), "❯ ", "─".repeat(20),
      "  ⏵⏵ bypass permissions on", "", "  ● main",
    ].join("\n");
    expect(parseMemberRows(pane)).toEqual([]);
  });

  it("no footer at all yields an empty array, never a throw", () => {
    expect(() => parseMemberRows("garbage\nnot a real pane")).not.toThrow();
    expect(parseMemberRows("garbage\nnot a real pane")).toEqual([]);
  });

  it("parses an hours-minutes-seconds duration and a plain (non-'k') integer token count", () => {
    const pane = [
      "⏺ Done.", "", "─".repeat(20), "❯ ", "─".repeat(20), "  ⏵⏵ bypass permissions on", "",
      "  ◯ some-member  Polling vitest pre-push run progress… 1h 10m 0s · ↑ 506.3k tokens",
    ].join("\n");
    expect(parseMemberRows(pane)).toEqual([{ name: "some-member", elapsedS: 4200, tokens: 506300 }]);
  });
});

describe("pollLoopFlags (issue #311)", () => {
  it("flags a row whose elapsed time alone crosses the threshold (OR, not AND)", () => {
    const rows: MemberRow[] = [{ name: "a", elapsedS: (POLL_LOOP_ELAPSED_MINUTES + 1) * 60, tokens: 0 }];
    expect(pollLoopFlags(rows)).toEqual(rows);
  });

  it("flags a row whose token count alone crosses the threshold", () => {
    const rows: MemberRow[] = [{ name: "a", elapsedS: 0, tokens: POLL_LOOP_TOKENS + 1 }];
    expect(pollLoopFlags(rows)).toEqual(rows);
  });

  it("does not flag a row under both thresholds", () => {
    const rows: MemberRow[] = [{ name: "a", elapsedS: 60, tokens: 100 }];
    expect(pollLoopFlags(rows)).toEqual([]);
  });
});

describe("goneMemberNames (issue #311)", () => {
  it("a name present last tick and absent this tick's rows is 'gone'", () => {
    expect(goneMemberNames(["a", "b"], [{ name: "a", elapsedS: 0, tokens: 0 }])).toEqual(["b"]);
  });

  it("nothing is gone when every previous name is still present", () => {
    expect(goneMemberNames(["a"], [{ name: "a", elapsedS: 0, tokens: 0 }])).toEqual([]);
  });
});

const NOW = new Date("2026-09-25T10:10:00.000Z");
function killAt(at: string): MemguardKillLogEntry {
  return {
    at, signal: "SIGKILL", pid: 1, comm: "vitest", rssMib: 500, availMib: 10, totalMib: 11930,
    source: "cgroup", cmd: "vitest run",
  };
}

describe("buildMemberAlerts (issue #311) — mutant proof (a): a real kill must always surface", () => {
  it("a fresh memguard kill (inside MEMGUARD_ALERT_RETENTION_S) produces a measured memguard-kill alert", () => {
    const kill = killAt("2026-09-25T10:05:00.000Z"); // 5 min before NOW
    const alerts = buildMemberAlerts([kill], [], [], [], NOW);
    expect(alerts).toContainEqual(expect.objectContaining({ kind: "memguard-kill", confidence: "measured", at: kill.at }));
  });

  it("a stale memguard kill (past retention) produces no memguard-kill alert", () => {
    const kill = killAt("2026-09-25T09:30:00.000Z"); // 40 min before NOW
    const alerts = buildMemberAlerts([kill], [], [], [], NOW);
    expect(alerts.some((a) => a.kind === "memguard-kill")).toBe(false);
  });

  it("no kill lines at all produces no memguard-kill alert", () => {
    expect(buildMemberAlerts([], [], [], [], NOW).some((a) => a.kind === "memguard-kill")).toBe(false);
  });
});

describe("buildMemberAlerts (issue #311) — mutant proof (b): member death is surface-only and evidence-gated", () => {
  it("a row vanishing WITH a corroborating kill in the same window produces an inferred member-gone alert", () => {
    const kill = killAt("2026-09-25T10:09:30.000Z"); // 30s before NOW
    const alerts = buildMemberAlerts([kill], ["frontend-developer"], [], [], NOW);
    expect(alerts).toContainEqual(expect.objectContaining({ kind: "member-gone", confidence: "inferred" }));
  });

  it("a row vanishing with NO nearby kill produces NO member-gone alert — never guesses", () => {
    const alerts = buildMemberAlerts([], ["frontend-developer"], [], [], NOW);
    expect(alerts.some((a) => a.kind === "member-gone")).toBe(false);
  });

  it("a row vanishing while the only kill is OUTSIDE the correlation window produces NO member-gone alert", () => {
    const kill = killAt("2026-09-25T10:00:00.000Z"); // 10 min before NOW, well outside 90s
    const alerts = buildMemberAlerts([kill], ["frontend-developer"], [], [], NOW);
    expect(alerts.some((a) => a.kind === "member-gone")).toBe(false);
  });

  it("no row vanished at all — a fresh kill alone never produces a member-gone alert", () => {
    const kill = killAt("2026-09-25T10:09:30.000Z");
    const alerts = buildMemberAlerts([kill], ["frontend-developer"], [{ name: "frontend-developer", elapsedS: 1, tokens: 1 }], [], NOW);
    expect(alerts.some((a) => a.kind === "member-gone")).toBe(false);
  });
});

describe("buildMemberAlerts (issue #311) — poll-loop rows flow through", () => {
  it("a currently-live row crossing the threshold produces a measured poll-loop alert", () => {
    const rows: MemberRow[] = [{ name: "frontend-developer", elapsedS: (POLL_LOOP_ELAPSED_MINUTES + 5) * 60, tokens: 0 }];
    const alerts = buildMemberAlerts([], [], rows, [], NOW);
    expect(alerts).toContainEqual(expect.objectContaining({ kind: "poll-loop", confidence: "measured", name: "frontend-developer" }));
  });

  it("a healthy row under both thresholds produces no poll-loop alert", () => {
    const rows: MemberRow[] = [{ name: "frontend-developer", elapsedS: 60, tokens: 10 }];
    expect(buildMemberAlerts([], [], rows, [], NOW).some((a) => a.kind === "poll-loop")).toBe(false);
  });
});

describe("buildMemberAlerts (issue #311) — PR #336 round 2, item 1: poll-loop `at` is first-seen, not re-stamped", () => {
  const rows: MemberRow[] = [{ name: "frontend-developer", elapsedS: (POLL_LOOP_ELAPSED_MINUTES + 5) * 60, tokens: 0 }];
  const FIRST_SEEN = "2026-09-25T09:00:00.000Z";

  it("a brand-new poll-loop row gets `at: now` — nothing to carry forward yet", () => {
    const alerts = buildMemberAlerts([], [], rows, [], NOW);
    const alert = alerts.find((a) => a.kind === "poll-loop");
    expect(alert?.at).toBe(NOW.toISOString());
  });

  it("MUTANT PROOF (c): a poll-loop alert already live for this name keeps ITS OWN `at`, never `now`", () => {
    const prevAlerts = [
      { kind: "poll-loop" as const, name: "frontend-developer", at: FIRST_SEEN, detail: "stale detail text", confidence: "measured" as const },
    ];
    const alerts = buildMemberAlerts([], [], rows, prevAlerts, NOW);
    const alert = alerts.find((a) => a.kind === "poll-loop");
    expect(alert?.at).toBe(FIRST_SEEN);
    expect(alert?.at).not.toBe(NOW.toISOString());
  });

  it("a DIFFERENT row's prior alert never leaks its `at` onto this row's fresh one", () => {
    const prevAlerts = [
      { kind: "poll-loop" as const, name: "some-other-member", at: FIRST_SEEN, detail: "x", confidence: "measured" as const },
    ];
    const alerts = buildMemberAlerts([], [], rows, prevAlerts, NOW);
    const alert = alerts.find((a) => a.kind === "poll-loop" && a.name === "frontend-developer");
    expect(alert?.at).toBe(NOW.toISOString());
  });
});
