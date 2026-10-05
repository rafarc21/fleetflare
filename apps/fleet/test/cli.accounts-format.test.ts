import { describe, it, expect } from "vitest";
import {
  formatAccountsTable, describeCurrentState, describeWould, wouldChange, snapshotsEqual, buildLabelSuggestions,
  type AccountSnapshotRow, type AccountCurrentState,
} from "../cli/accounts-format";
import type { SyncDecision } from "../src/studio/claude-swap";

// Imports cli/accounts-format.ts specifically, NOT cli/accounts.ts or
// cli/fleet.ts — same reason test/cli.task-format.test.ts imports
// cli/task-format.ts directly: those two carry Bun-only globals the root
// tsconfig's "workers-types" type set cannot resolve. This module is
// deliberately Bun/node-free (see its own header).

const FREE: AccountCurrentState = { dead: false, until: null, seenAt: null };
const LIMITED: AccountCurrentState = { dead: false, until: "2026-10-05T14:00:00Z", seenAt: "2026-10-05T12:00:00Z" };
const DEAD: AccountCurrentState = { dead: true, until: null, seenAt: "2026-10-05T12:00:00Z" };

const LIMIT_DECISION: SyncDecision = { name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until: "2026-10-05T14:00:00Z", seenAt: "2026-10-05T12:00:00Z" };
const CLEAR_DECISION: SyncDecision = { name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: "2026-10-05T12:00:00Z" };
const UNMANAGED_DECISION: SyncDecision = { name: "CLAUDE_CODE_OAUTH_TOKEN", action: "unmanaged" };
const NO_DATA_DECISION: SyncDecision = { name: "CLAUDE_CODE_OAUTH_TOKEN", action: "no-data", reason: "usageStatus: relogin_required" };

function row(overrides: Partial<AccountSnapshotRow> = {}): AccountSnapshotRow {
  return {
    name: "CLAUDE_CODE_OAUTH_TOKEN", label: "primary@example.com", matchSource: "label", matchedEmail: "primary@example.com",
    fiveHourPct: 10, sevenDayPct: 20, decision: CLEAR_DECISION, current: FREE,
    ...overrides,
  };
}

describe("describeCurrentState", () => {
  it("free: neither dead nor until", () => {
    expect(describeCurrentState(FREE)).toBe("free");
  });
  it("limited: until set, not dead", () => {
    expect(describeCurrentState(LIMITED)).toBe("limited until 2026-10-05T14:00:00Z");
  });
  it("dead wins over a stale until", () => {
    expect(describeCurrentState({ dead: true, until: "2026-10-05T14:00:00Z", seenAt: null })).toBe("dead");
  });
});

describe("wouldChange / describeWould", () => {
  it("no-op: current already matches the limit decision's own until", () => {
    expect(wouldChange(LIMITED, LIMIT_DECISION)).toBe(false);
    expect(describeWould(row({ current: LIMITED, decision: LIMIT_DECISION }))).toBe("-");
  });

  it("change: current free, decision says limit", () => {
    expect(wouldChange(FREE, LIMIT_DECISION)).toBe(true);
    expect(describeWould(row({ current: FREE, decision: LIMIT_DECISION }))).toBe("limited until 2026-10-05T14:00:00Z");
  });

  it("change: current limited until a DIFFERENT time than the decision", () => {
    const olderLimit: AccountCurrentState = { dead: false, until: "2026-10-04T00:00:00Z", seenAt: null };
    expect(wouldChange(olderLimit, LIMIT_DECISION)).toBe(true);
  });

  it("change: current dead, decision clears (fresh low reading proves it's alive)", () => {
    expect(wouldChange(DEAD, CLEAR_DECISION)).toBe(true);
    expect(describeWould(row({ current: DEAD, decision: CLEAR_DECISION }))).toBe("free");
  });

  it("no-op: current already free, decision clears", () => {
    expect(wouldChange(FREE, CLEAR_DECISION)).toBe(false);
  });

  it("unmanaged never counts as a change, regardless of current state", () => {
    expect(wouldChange(FREE, UNMANAGED_DECISION)).toBe(false);
    expect(wouldChange(DEAD, UNMANAGED_DECISION)).toBe(false);
    expect(describeWould(row({ current: DEAD, decision: UNMANAGED_DECISION }))).toBe("-");
  });

  // MAJOR 4: "no-data" (a real cswap account, untrustworthy reading) must
  // never write either, same as "unmanaged" — but it must read DIFFERENTLY
  // in the WOULD column, so an operator can tell the two apart.
  it("no-data never counts as a change, but reads distinctly from unmanaged in the WOULD column", () => {
    expect(wouldChange(FREE, NO_DATA_DECISION)).toBe(false);
    expect(wouldChange(DEAD, NO_DATA_DECISION)).toBe(false);
    const would = describeWould(row({ current: DEAD, decision: NO_DATA_DECISION }));
    expect(would).not.toBe("-");
    expect(would).toContain("no data");
    expect(would).toContain("relogin_required");
  });
});

describe("formatAccountsTable", () => {
  it("says so plainly when there are no accounts", () => {
    expect(formatAccountsTable([])).toBe("(no accounts configured)");
  });

  it("renders SLOT, LABEL, MATCH, 5H%, 7D%, RESETS, ROW STATE, WOULD", () => {
    const out = formatAccountsTable([row({ current: FREE, decision: LIMIT_DECISION, fiveHourPct: 97, sevenDayPct: 40 })]);
    const [header, body] = out.split("\n");
    expect(header.split(/\s{2,}/)).toEqual(["SLOT", "LABEL", "MATCH", "5H%", "7D%", "RESETS", "ROW STATE", "WOULD"]);
    expect(body).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(body).toContain("primary@example.com");
    expect(body).toContain("label");
    expect(body).toContain("97%");
    expect(body).toContain("40%");
    expect(body).toContain("2026-10-05T14:00:00Z");
    expect(body).toContain("free");
    expect(body).toContain("limited until 2026-10-05T14:00:00Z");
  });

  it("an unmanaged/cswap-missing row shows dashes for pct/resets, never crashes", () => {
    const missing: SyncDecision = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", action: "unmanaged" };
    const out = formatAccountsTable([row({
      name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, matchSource: "cswap-missing", matchedEmail: null,
      fiveHourPct: null, sevenDayPct: null, decision: missing, current: FREE,
    })]);
    const body = out.split("\n")[1]!;
    expect(body).toContain("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(body).toContain("cswap-missing");
    expect(body).toMatch(/-\s+cswap-missing\s+-\s+-/); // label "-", MATCH, 5H% "-", 7D% "-"
    expect(body).toContain("free");
    expect(body).toContain("-"); // WOULD: unmanaged never changes anything
  });

  // MAJOR 4: a "no-data" row (a real cswap account found, but its reading is
  // stale/failed) must read distinctly from a plain unmapped/cswap-missing
  // row in the WOULD column.
  it("a no-data row (stale/failed cswap reading) reads distinctly from an unmanaged row", () => {
    const noData: SyncDecision = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", action: "no-data", reason: "usage data is 900s old (>= 600s)" };
    const unmanagedRow = row({
      name: "CLAUDE_CODE_OAUTH_TOKEN_3", label: null, matchSource: "unmapped", matchedEmail: null,
      decision: { name: "CLAUDE_CODE_OAUTH_TOKEN_3", action: "unmanaged" }, current: FREE,
    });
    const noDataRow = row({
      name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: "stale@example.com", matchSource: "label", matchedEmail: "stale@example.com",
      decision: noData, current: FREE,
    });
    const out = formatAccountsTable([unmanagedRow, noDataRow]);
    const [, unmanagedLine, noDataLine] = out.split("\n");
    expect(unmanagedLine.trim().endsWith("-")).toBe(true); // WOULD column ends in a bare "-"
    expect(noDataLine).toContain("no data (usage data is 900s old (>= 600s))");
    expect(noDataLine).not.toBe(unmanagedLine);
  });

  // A slot resolved by reset-time inference (no label) renders "inferred" in
  // the MATCH column, distinctly from a plain label match.
  it("an inferred match renders 'inferred' in the MATCH column", () => {
    const out = formatAccountsTable([row({
      label: null, matchSource: "inferred", matchedEmail: "primary@example.com",
      decision: { name: "CLAUDE_CODE_OAUTH_TOKEN", action: "unmanaged" },
    })]);
    const body = out.split("\n")[1]!;
    expect(body).toContain("inferred");
  });
});

describe("buildLabelSuggestions", () => {
  it("one suggestion per inferred match, formatted CLAUDE_ACCOUNT_<n>_LABEL=<email>", () => {
    const rows = [
      row({ name: "CLAUDE_CODE_OAUTH_TOKEN", matchSource: "inferred", matchedEmail: "primary@example.com" }),
      row({ name: "CLAUDE_CODE_OAUTH_TOKEN_2", matchSource: "inferred", matchedEmail: "second@example.com" }),
    ];
    expect(buildLabelSuggestions(rows)).toEqual([
      "CLAUDE_ACCOUNT_1_LABEL=primary@example.com",
      "CLAUDE_ACCOUNT_2_LABEL=second@example.com",
    ]);
  });

  it("never suggests a label match (it already has one)", () => {
    const rows = [row({ matchSource: "label", matchedEmail: "primary@example.com" })];
    expect(buildLabelSuggestions(rows)).toEqual([]);
  });

  it("never suggests unmapped/cswap-missing (no matched email at all)", () => {
    const rows = [
      row({ matchSource: "unmapped", matchedEmail: null }),
      row({ matchSource: "cswap-missing", matchedEmail: null }),
    ];
    expect(buildLabelSuggestions(rows)).toEqual([]);
  });

  it("empty snapshot: no suggestions", () => {
    expect(buildLabelSuggestions([])).toEqual([]);
  });
});

describe("snapshotsEqual", () => {
  it("identical snapshots are equal", () => {
    const a = [row()];
    const b = [row()];
    expect(snapshotsEqual(a, b)).toBe(true);
  });

  it("a changed pct makes them unequal", () => {
    const a = [row({ fiveHourPct: 10 })];
    const b = [row({ fiveHourPct: 97 })];
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it("a changed decision makes them unequal", () => {
    const a = [row({ decision: CLEAR_DECISION })];
    const b = [row({ decision: LIMIT_DECISION })];
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it("a changed current row state makes them unequal", () => {
    const a = [row({ current: FREE })];
    const b = [row({ current: DEAD })];
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it("a changed match source makes them unequal", () => {
    const a = [row({ matchSource: "label" })];
    const b = [row({ matchSource: "inferred" })];
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it("different lengths are unequal", () => {
    expect(snapshotsEqual([row()], [row(), row({ name: "OTHER" })])).toBe(false);
  });

  it("empty snapshots are equal", () => {
    expect(snapshotsEqual([], [])).toBe(true);
  });
});
