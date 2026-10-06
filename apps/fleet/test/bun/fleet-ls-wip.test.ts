// Board issue #208, part 2: `fleet ls` shows each studio's periodic WIP
// safety-net sync age -- the WIP column (age since `Observed.wipSyncedAt`,
// stamped by do.ts's `wipSync` on an actual push to `fleet/rescue/<studio>/
// wip`) and `fleet inspect`'s own ref+age line. Model: test/bun/
// fleet-ls-restarts.test.ts (the RST column's own suite).
import { describe, expect, test } from "bun:test";
import { formatTable, formatLsHead } from "../../cli/fleet";
import { formatWipCell, formatWipInspectLines, WIP_LEGEND, wipSyncRefEcho } from "../../cli/wip-format";
import { emptyObserved } from "../../src/studio/observed";
import { wipSyncRef } from "../../src/studio/rescue";
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
    expect(WIP_LEGEND).toContain("never checked");
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
  test("with a known bootStamp, the ref name is byte-identical to rescue.ts's own wipSyncRef convention", () => {
    expect(wipSyncRefEcho("acmeclient--lead", "20261004000000")).toBe(wipSyncRef("acmeclient--lead", "20261004000000"));
  });

  test("with no bootStamp known, falls back to a glob rather than a literal, possibly-nonexistent ref", () => {
    expect(wipSyncRefEcho("acmeclient--lead")).toBe("fleet/rescue/acmeclient--lead/wip/*");
    expect(wipSyncRefEcho("acmeclient--lead", null)).toBe("fleet/rescue/acmeclient--lead/wip/*");
  });
});

/**
 * Fix round (#208 PR #215 review, minor (a)): `Observed.wipLastCheck` lets
 * `fleet ls`/`fleet inspect` distinguish "pushed Xm ago" from "checked
 * clean Xm ago" from "last attempt FAILED Xm ago" -- `wipSyncedAt` alone
 * could never tell those apart (a clean tick never advances it at all, and
 * a failed tick looks identical to "nothing has run in a while").
 *
 * Issue #241 item 5: `wipLastCheck` is now PER-TARGET (keyed by the
 * target's own ref name), never one blended value -- `rowWithCheck` below
 * builds a one-entry map under a single `target` key (default "main"), the
 * single-target shape every test in THIS describe block still exercises
 * unchanged; the multi-target rollup gets its own describe block below.
 */
describe("WIP cell — wipLastCheck (minor (a))", () => {
  function rowWithCheck(
    result: "pushed" | "clean" | "markers-only" | "no-checkout" | "failed", at: string, target = "main",
  ): StudioStatus {
    return {
      id: "acmeclient--lead", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      observed: { ...emptyObserved(), wipLastCheck: { [target]: { at, result } } },
    };
  }

  test("a failed last attempt reads the age with a trailing '!'", () => {
    expect(formatWipCell(rowWithCheck("failed", ago(2)), NOW)).toBe("2m!");
  });

  test("a clean (nothing-to-sync) check reads the plain age, no '!'", () => {
    expect(formatWipCell(rowWithCheck("clean", ago(2)), NOW)).toBe("2m");
  });

  test("a real push reads the plain age, no '!'", () => {
    expect(formatWipCell(rowWithCheck("pushed", ago(2)), NOW)).toBe("2m");
  });

  test("wipLastCheck takes priority over a stale wipSyncedAt from a much earlier real push", () => {
    const s: StudioStatus = {
      id: "acmeclient--lead", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      observed: { ...emptyObserved(), wipSyncedAt: ago(90), wipLastCheck: { main: { at: ago(2), result: "failed" } } },
    };
    expect(formatWipCell(s, NOW)).toBe("2m!");
  });

  test("absent wipLastCheck (a row from before this field existed) falls back to wipSyncedAt unchanged", () => {
    expect(formatWipCell(row(ago(4)), NOW)).toBe("4m");
  });

  test("empty wipLastCheck map (no target has ever been named) falls back to wipSyncedAt unchanged", () => {
    const s: StudioStatus = {
      id: "acmeclient--lead", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      observed: { ...emptyObserved(), wipSyncedAt: ago(4), wipLastCheck: {} },
    };
    expect(formatWipCell(s, NOW)).toBe("4m");
  });
});

/**
 * Issue #241 item 5 — the bug this item fixes: main pushes, a member fails,
 * SAME tick -- the single-line WIP column must NEVER read "pushed" (no
 * trailing '!') while a member's own safety net is silently broken. Floor
 * requirement: roll up to the WORST status across every named target.
 */
describe("WIP cell — multi-target rollup (#241 item 5)", () => {
  test("main pushed, a member failed, same tick: the cell reads the FAILED entry's age with '!', never 'pushed'", () => {
    const s: StudioStatus = {
      id: "acmeclient--lead", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      observed: {
        ...emptyObserved(),
        wipLastCheck: {
          main: { at: ago(1), result: "pushed" },
          "member-a": { at: ago(3), result: "failed" },
        },
      },
    };
    expect(formatWipCell(s, NOW)).toBe("3m!");
  });

  test("every target healthy (pushed + clean, no failures): rolls up to the pushed entry's own age", () => {
    const s: StudioStatus = {
      id: "acmeclient--lead", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      observed: {
        ...emptyObserved(),
        wipLastCheck: {
          main: { at: ago(5), result: "pushed" },
          "member-a": { at: ago(2), result: "clean" },
        },
      },
    };
    expect(formatWipCell(s, NOW)).toBe("5m");
  });
});

describe("fleet inspect — last-FAILED-attempt line (minor (a))", () => {
  test("appends a second line naming how long ago the last attempt failed", () => {
    const lines = formatWipInspectLines("acmeclient--lead", {
      ...emptyObserved(), wipSyncedAt: ago(90), wipLastCheck: { main: { at: ago(2), result: "failed" } },
    }, NOW);
    expect(lines).toEqual([
      `wip sync:     ${wipSyncRefEcho("acmeclient--lead")}, last synced 90m ago`,
      "wip sync:     last attempt FAILED for main 2m ago",
    ]);
  });

  test("a successful last check adds no second line", () => {
    const lines = formatWipInspectLines("acmeclient--lead", {
      ...emptyObserved(), wipSyncedAt: ago(2), wipLastCheck: { main: { at: ago(2), result: "pushed" } },
    }, NOW);
    expect(lines).toEqual([`wip sync:     ${wipSyncRefEcho("acmeclient--lead")}, last synced 2m ago`]);
  });

  test("a known bootStamp names the exact ref, not the glob", () => {
    const lines = formatWipInspectLines("acmeclient--lead", {
      ...emptyObserved(), wipSyncedAt: ago(2), wipBootStamp: "20261004000000",
    }, NOW);
    expect(lines).toEqual([`wip sync:     ${wipSyncRef("acmeclient--lead", "20261004000000")}, last synced 2m ago`]);
  });

  // Issue #241 item 5: more than one target can be failed in the SAME tick
  // (the exact bug-report scenario) -- every failed target gets its OWN
  // line, sorted by key for determinism, never collapsing to one.
  test("two failed targets in the same tick: two distinct FAILED lines, one per target", () => {
    const lines = formatWipInspectLines("acmeclient--lead", {
      ...emptyObserved(),
      wipSyncedAt: ago(90),
      wipLastCheck: {
        main: { at: ago(2), result: "pushed" },
        "member-z": { at: ago(5), result: "failed" },
        "member-a": { at: ago(3), result: "failed" },
      },
    }, NOW);
    expect(lines).toEqual([
      `wip sync:     ${wipSyncRefEcho("acmeclient--lead")}, last synced 90m ago`,
      "wip sync:     last attempt FAILED for member-a 3m ago",
      "wip sync:     last attempt FAILED for member-z 5m ago",
    ]);
  });
});
