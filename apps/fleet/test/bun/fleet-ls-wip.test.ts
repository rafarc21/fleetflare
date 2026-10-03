// Board issue #208, part 2: `fleet ls` shows each studio's periodic WIP
// safety-net sync age -- the WIP column (age since `Observed.wipSyncedAt`,
// stamped by do.ts's `wipSync` on an actual push to `fleet/rescue/<studio>/
// wip`) and `fleet inspect`'s own ref+age line. Model: test/bun/
// fleet-ls-restarts.test.ts (the RST column's own suite).
import { describe, expect, test } from "bun:test";
import { formatTable, formatLsHead } from "../../cli/fleet";
import { formatWipCell, formatWipInspectLines, WIP_LEGEND, wipSyncRefEcho } from "../../cli/wip-format";
import { emptyObserved } from "../../src/studio/observed";
import type { StudioStatus } from "../../src/studio/types";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const MIN = 60_000;
const ago = (m: number) => new Date(NOW.getTime() - m * MIN).toISOString();

function row(wipSyncedAt?: string | null, id = "acmeclient--lead"): StudioStatus {
  return {
    id, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...(wipSyncedAt === undefined ? {} : { observed: { ...emptyObserved(), wipSyncedAt } }),
  };
}

/** Exactly what deployed main (pre-#208) writes: `observed` with no
 *  `wipSyncedAt` key at all. */
const MAIN_ROW: StudioStatus = JSON.parse(JSON.stringify({
  id: "acmeclient--lead", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
  lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null, readiness: null,
  observed: {
    incarnation: null, replacedAt: null, execFailures: 0, unreachableSince: null, lastShipOkAt: null,
    lastSnapshotAt: null, session: null, activity: null, memberAlerts: null,
    survivalBriefDeliveredFor: null, survivalBriefPending: null,
  },
}));

describe("WIP cell", () => {
  test("age since the last real sync", () => {
    expect(formatWipCell(row(ago(4)), NOW)).toBe("4m");
  });
  test("null (never synced) reads '-', not a fabricated age", () => {
    expect(formatWipCell(row(null), NOW)).toBe("-");
  });
  test("row written before #208 (no wipSyncedAt key) reads '-', never crashes", () => {
    expect(formatWipCell(MAIN_ROW, NOW)).toBe("-");
    expect(formatWipCell(row(), NOW)).toBe("-");
  });
  test("an unparseable timestamp reads '-' rather than a garbled age", () => {
    expect(formatWipCell(row("not-a-date"), NOW)).toBe("-");
  });
});

describe("fleet ls table", () => {
  test("has a WIP column carrying the cell", () => {
    const out = formatTable([row(ago(90))], NOW);
    const [header, line] = out.split("\n");
    expect(header).toContain("WIP");
    expect(line.split(/\s{2,}/)[header.split(/\s{2,}/).indexOf("WIP")]).toBe("90m");
  });
  test("renders a main-shaped (pre-#208) row", () => {
    const out = formatTable([MAIN_ROW], NOW);
    const [header, line] = out.split("\n");
    expect(line.split(/\s{2,}/)[header.split(/\s{2,}/).indexOf("WIP")]).toBe("-");
  });
  test("the WIP legend is part of fleet ls's head", () => {
    expect(formatLsHead([row(ago(1))])).toContain(WIP_LEGEND);
    expect(WIP_LEGEND).toContain("WIP");
    expect(WIP_LEGEND).toContain("never synced");
  });
});

describe("fleet inspect — WIP line(s)", () => {
  test("names the full ref and the age when synced", () => {
    const lines = formatWipInspectLines("acmeclient--lead", { ...emptyObserved(), wipSyncedAt: ago(4) }, NOW);
    expect(lines).toEqual([
      `wip sync:     ${wipSyncRefEcho("acmeclient--lead")}, last synced 4m ago`,
    ]);
  });
  test("says 'never synced' rather than omitting the line entirely", () => {
    const lines = formatWipInspectLines("acmeclient--lead", { ...emptyObserved(), wipSyncedAt: null }, NOW);
    expect(lines).toEqual([`wip sync:     ${wipSyncRefEcho("acmeclient--lead")} — never synced`]);
  });
  test("`observed` undefined (DO call failed, or a Worker predating #208) adds nothing", () => {
    expect(formatWipInspectLines("acmeclient--lead", undefined, NOW)).toEqual([]);
  });
  test("the ref name is byte-identical to rescue.ts's own wipSyncRef convention", () => {
    expect(wipSyncRefEcho("acmeclient--lead")).toBe("fleet/rescue/acmeclient--lead/wip");
  });
});
