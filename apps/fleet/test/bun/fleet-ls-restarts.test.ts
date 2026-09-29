// Issue #56: `fleet ls` shows each studio's container restart churn — the
// RST column (`<last 24h>/<lifetime>`) and a RESTARTS line under the table for
// a studio churning hard enough to matter.
import { describe, expect, test } from "bun:test";
import { formatTable } from "../../cli/fleet";
import { formatRestartCell, formatRestartChurn, RESTART_CHURN_24H, RESTART_LEGEND } from "../../cli/restart-format";
import { emptyObserved } from "../../src/studio/observed";
import type { RestartLog } from "../../src/studio/restarts";
import type { StudioStatus } from "../../src/studio/types";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();

function row(restarts?: RestartLog | null, id = "acmeclient--lead"): StudioStatus {
  return {
    id, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    // `null` is never stored (hand-edited row only) — cast to exercise it.
    ...(restarts === undefined ? {} : { observed: { ...emptyObserved(), restarts: restarts as RestartLog } }),
  };
}

/** Exactly what deployed main writes: `observed` with no `restarts` key. */
const MAIN_ROW: StudioStatus = JSON.parse(JSON.stringify({
  id: "acmeclient--lead", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
  lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null, readiness: null,
  observed: {
    incarnation: null, replacedAt: null, execFailures: 0, unreachableSince: null, lastShipOkAt: null,
    lastSnapshotAt: null, session: null, activity: null, memberAlerts: null,
    survivalBriefDeliveredFor: null, survivalBriefPending: null,
  },
}));

describe("RST cell", () => {
  test("<in last 24h>/<lifetime>", () => {
    const log: RestartLog = { total: 6, recent: [{ at: ago(30), via: "heal" }, { at: ago(2), via: "recycle" }, { at: ago(1), via: "recycle" }] };
    expect(formatRestartCell(row(log), NOW)).toBe("2/6");
  });
  test("a studio with a baseline and no replacement since reads 0/0", () => {
    expect(formatRestartCell(row({ total: 0, recent: [] }), NOW)).toBe("0/0");
  });
  test("null (never a stored shape) reads '-', not a fabricated 0/0", () => {
    expect(formatRestartCell(row(null), NOW)).toBe("-");
  });
  test("row written by deployed main (no count recorded) reads '-', never crashes", () => {
    expect(formatRestartCell(MAIN_ROW, NOW)).toBe("-");
    expect(formatRestartCell(row(), NOW)).toBe("-");
  });
});

describe("fleet ls table", () => {
  test("has an RST column carrying the cell", () => {
    const out = formatTable([row({ total: 3, recent: [{ at: ago(1), via: "recycle" }] })], NOW);
    const [header, line] = out.split("\n");
    expect(header).toContain("RST");
    expect(line.split(/\s{2,}/)[header.split(/\s{2,}/).indexOf("RST")]).toBe("1/3");
  });
  test("renders a main-shaped row", () => {
    const out = formatTable([MAIN_ROW], NOW);
    const [header, line] = out.split("\n");
    expect(line.split(/\s{2,}/)[header.split(/\s{2,}/).indexOf("RST")]).toBe("-");
  });
});

describe("RESTARTS churn line", () => {
  const churning: RestartLog = {
    total: 7,
    recent: [
      { at: ago(5), via: "recycle" }, { at: ago(4), via: "recycle" }, { at: ago(3), via: "heal" },
      { at: ago(26), via: "restart" },
    ],
  };
  test(`named once a studio hits ${RESTART_CHURN_24H} in 24h, with what rebuilt each container`, () => {
    expect(formatRestartChurn([row(churning)], NOW)).toEqual([
      "RESTARTS acmeclient--lead: container replaced 3x in 24h (7 total; recycle 2, heal 1) -- each one re-bootstraps the studio",
    ]);
  });
  test("quiet below the threshold, and for rows with no count", () => {
    const calm: RestartLog = { total: 9, recent: [{ at: ago(1), via: "recycle" }, { at: ago(2), via: "recycle" }] };
    expect(formatRestartChurn([row(calm), MAIN_ROW, row(null)], NOW)).toEqual([]);
  });
  test("an unknown bring-up is named as such, not dropped", () => {
    const log: RestartLog = { total: 3, recent: [{ at: ago(1), via: null }, { at: ago(2), via: null }, { at: ago(3), via: "recycle" }] };
    expect(formatRestartChurn([row(log)], NOW)[0]).toContain("(3 total; unknown 2, recycle 1)");
  });
  test("legend explains the column", () => {
    expect(RESTART_LEGEND).toContain("RST");
    expect(RESTART_LEGEND).toContain("24h");
    expect(RESTART_LEGEND).toContain("since tracking began");
    expect(RESTART_LEGEND).not.toContain("lifetime");
  });
});
