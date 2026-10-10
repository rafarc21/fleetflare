import { describe, it, expect } from "vitest";
import {
  formatAccountsTable, describeCurrentState, describeWould, wouldChange, snapshotsEqual, buildLabelSuggestions,
  parseCswapListOutput, formatCswapUnavailableNote, ACCOUNTS_TABLE_UTC_NOTE,
  type AccountSnapshotRow, type AccountCurrentState,
} from "../cli/accounts-format";
import type { SyncDecision } from "../src/studio/claude-swap";
import { CSWAP_LIST_FIXTURE, CSWAP_LIST_ENVELOPE, OVER_FIVE_HOUR } from "./fixtures/cswap-list";

// Imports cli/accounts-format.ts specifically, NOT cli/accounts.ts or
// cli/fleet.ts — same reason test/cli.task-format.test.ts imports
// cli/task-format.ts directly: those two carry Bun-only globals the root
// tsconfig's "workers-types" type set cannot resolve. This module is
// deliberately Bun/node-free (see its own header).

// Issue #253 — the "now" every describeCurrentState/wouldChange/
// describeWould/formatAccountsTable call below is measured against. Sits
// strictly between LIMITED's own seenAt (12:00) and until (14:00), so every
// PRE-EXISTING assertion using LIMITED keeps reading "limited" unchanged —
// only the self-free fix (a PAST until) or a deliberately past fixture
// changes behavior.
const NOW = new Date("2026-10-05T13:00:00Z");

const FREE: AccountCurrentState = { dead: false, until: null, seenAt: null };
const LIMITED: AccountCurrentState = { dead: false, until: "2026-10-05T14:00:00Z", seenAt: "2026-10-05T12:00:00Z" };
const DEAD: AccountCurrentState = { dead: true, until: null, seenAt: "2026-10-05T12:00:00Z" };

const LIMIT_DECISION: SyncDecision = { name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until: "2026-10-05T14:00:00Z", seenAt: "2026-10-05T12:00:00Z", usageAgeSeconds: 10 };
const CLEAR_DECISION: SyncDecision = { name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: "2026-10-05T12:00:00Z", usageAgeSeconds: 10 };
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
    expect(describeCurrentState(FREE, NOW)).toBe("free");
  });
  it("limited: until set, not dead, and still in the future at now", () => {
    expect(describeCurrentState(LIMITED, NOW)).toBe("limited until 2026-10-05T14:00:00Z");
  });
  it("dead wins over a stale until", () => {
    expect(describeCurrentState({ dead: true, until: "2026-10-05T14:00:00Z", seenAt: null }, NOW)).toBe("dead");
  });

  // Issue #253 — "ROW STATE / WOULD disagree, only WOULD is right": one
  // concrete cause was a `until` already in the past still printing "limited
  // until <stale date>" forever. `accountIsFree` (src/studio/accounts.ts)
  // already treats a passed `until` as free again; this function had no such
  // check at all until this fix.
  it("self-frees: a until already in the past at now reads free, matching accountIsFree's own convention", () => {
    const pastLimit: AccountCurrentState = { dead: false, until: "2026-10-05T10:00:00Z", seenAt: "2026-10-05T08:00:00Z" };
    expect(describeCurrentState(pastLimit, NOW)).toBe("free");
  });

  it("self-frees exactly AT now too (until <= now, not only until < now)", () => {
    const exactlyNow: AccountCurrentState = { dead: false, until: NOW.toISOString(), seenAt: "2026-10-05T08:00:00Z" };
    expect(describeCurrentState(exactlyNow, NOW)).toBe("free");
  });

  it("dead wins over a PAST until too, unconditionally — same precedence accountIsFree gives dead over everything else", () => {
    const deadWithPastUntil: AccountCurrentState = { dead: true, until: "2026-10-05T10:00:00Z", seenAt: "2026-10-05T08:00:00Z" };
    expect(describeCurrentState(deadWithPastUntil, NOW)).toBe("dead");
  });

  // Issue #306 — a null-until row (a sighting with no readable reset, e.g.
  // `account-limit:_5 {until:null}`) blocks launches for 24h after seenAt
  // (accountIsFree's NULL_UNTIL_CEILING_MS), yet read "free" here.
  it("null until, seen within the 24h ceiling: limited, in describeOutcome's own words", () => {
    const nullUntil: AccountCurrentState = { dead: false, until: null, seenAt: "2026-10-05T12:00:00Z" };
    expect(describeCurrentState(nullUntil, NOW)).toBe("limited");
  });

  it("null until, seen past the 24h ceiling: free, same as accountIsFree", () => {
    const stale: AccountCurrentState = { dead: false, until: null, seenAt: "2026-10-04T12:59:59Z" };
    expect(describeCurrentState(stale, NOW)).toBe("free");
  });

  it("a null-until row a sync would limit again is not a change", () => {
    const nullUntil: AccountCurrentState = { dead: false, until: null, seenAt: "2026-10-05T12:00:00Z" };
    const limitNoReset: SyncDecision = { ...LIMIT_DECISION, until: null } as SyncDecision;
    expect(wouldChange(nullUntil, limitNoReset, NOW)).toBe(false);
  });
});

describe("wouldChange / describeWould", () => {
  it("no-op: current already matches the limit decision's own until", () => {
    expect(wouldChange(LIMITED, LIMIT_DECISION, NOW)).toBe(false);
    expect(describeWould(row({ current: LIMITED, decision: LIMIT_DECISION }), NOW)).toBe("-");
  });

  it("change: current free, decision says limit", () => {
    expect(wouldChange(FREE, LIMIT_DECISION, NOW)).toBe(true);
    expect(describeWould(row({ current: FREE, decision: LIMIT_DECISION }), NOW)).toBe("limited until 2026-10-05T14:00:00Z");
  });

  it("change: current limited until a DIFFERENT time than the decision", () => {
    const olderLimit: AccountCurrentState = { dead: false, until: "2026-10-04T00:00:00Z", seenAt: null };
    expect(wouldChange(olderLimit, LIMIT_DECISION, NOW)).toBe(true);
  });

  it("change: current dead, decision clears (fresh low reading proves it's alive)", () => {
    expect(wouldChange(DEAD, CLEAR_DECISION, NOW)).toBe(true);
    expect(describeWould(row({ current: DEAD, decision: CLEAR_DECISION }), NOW)).toBe("free");
  });

  it("no-op: current already free, decision clears", () => {
    expect(wouldChange(FREE, CLEAR_DECISION, NOW)).toBe(false);
  });

  it("unmanaged never counts as a change, regardless of current state", () => {
    expect(wouldChange(FREE, UNMANAGED_DECISION, NOW)).toBe(false);
    expect(wouldChange(DEAD, UNMANAGED_DECISION, NOW)).toBe(false);
    expect(describeWould(row({ current: DEAD, decision: UNMANAGED_DECISION }), NOW)).toBe("-");
  });

  // MAJOR 4: "no-data" (a real cswap account, untrustworthy reading) must
  // never write either, same as "unmanaged" — but it must read DIFFERENTLY
  // in the WOULD column, so an operator can tell the two apart.
  it("no-data never counts as a change, but reads distinctly from unmanaged in the WOULD column", () => {
    expect(wouldChange(FREE, NO_DATA_DECISION, NOW)).toBe(false);
    expect(wouldChange(DEAD, NO_DATA_DECISION, NOW)).toBe(false);
    const would = describeWould(row({ current: DEAD, decision: NO_DATA_DECISION }), NOW);
    expect(would).not.toBe("-");
    expect(would).toContain("no data");
    expect(would).toContain("relogin_required");
  });

  // Issue #253 — a PAST current `until` must self-free for WOULD purposes
  // too (describeWould/wouldChange both call describeCurrentState), not
  // just for the standalone ROW STATE text.
  it("a current until already past at now is treated as free when comparing against a would-be decision", () => {
    const pastLimit: AccountCurrentState = { dead: false, until: "2026-10-05T10:00:00Z", seenAt: "2026-10-05T08:00:00Z" };
    expect(wouldChange(pastLimit, CLEAR_DECISION, NOW)).toBe(false);
    expect(describeWould(row({ current: pastLimit, decision: CLEAR_DECISION }), NOW)).toBe("-");
  });
});

describe("formatAccountsTable", () => {
  it("says so plainly when there are no accounts", () => {
    expect(formatAccountsTable([], NOW)).toBe("(no accounts configured)");
  });

  it("renders SLOT, LABEL, MATCH, 5H%, 7D%, RESETS, ROW STATE, WOULD", () => {
    const out = formatAccountsTable([row({ current: FREE, decision: LIMIT_DECISION, fiveHourPct: 97, sevenDayPct: 40 })], NOW);
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

  // Issue #253 — the "2h earlier than reality" symptom is exactly what a
  // silently-stripped offset/truncated instant would cause. Real assertion,
  // not a tautology: re-parses the printed RESETS/WOULD cells independently
  // and checks they round-trip to the EXACT epoch ms cswap reported, and
  // that each one carries an explicit "Z" a reader can see is UTC — not just
  // that the function returned whatever it returned.
  it("RESETS and WOULD print the full UTC instant with its Z marker intact, never truncated", () => {
    const until = "2026-10-05T14:00:00.000Z";
    const out = formatAccountsTable(
      [row({ current: FREE, decision: { ...LIMIT_DECISION, until }, fiveHourPct: 97, sevenDayPct: 40 })],
      NOW,
    );
    const [, body] = out.split("\n");
    const cells = body!.trim().split(/\s{2,}/);
    const resets = cells[5]!;
    const would = cells[7]!;
    expect(resets).toBe(until);
    expect(would).toBe(`limited until ${until}`);
    expect(resets.endsWith("Z")).toBe(true);
    expect(Date.parse(resets)).toBe(Date.parse(until));
    expect(Date.parse(would.replace("limited until ", ""))).toBe(Date.parse(until));
  });

  it("an unmanaged/cswap-missing row shows dashes for pct/resets, never crashes", () => {
    const missing: SyncDecision = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", action: "unmanaged" };
    const out = formatAccountsTable([row({
      name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, matchSource: "cswap-missing", matchedEmail: null,
      fiveHourPct: null, sevenDayPct: null, decision: missing, current: FREE,
    })], NOW);
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
    const out = formatAccountsTable([unmanagedRow, noDataRow], NOW);
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
    })], NOW);
    const body = out.split("\n")[1]!;
    expect(body).toContain("inferred");
  });

  // Issue #253 — the "2 hours early" symptom traced to an operator comparing
  // this (correctly UTC) table against cswap's own separate local-time
  // output: one plain footer line stating the displayed times are UTC,
  // printed once per table (never per row), closes every non-empty render.
  it("ends with a single '(reset times shown in UTC)' footer line, once per table, not per row", () => {
    const out = formatAccountsTable([row(), row({ name: "CLAUDE_CODE_OAUTH_TOKEN_2" })], NOW);
    const lines = out.split("\n");
    expect(lines[lines.length - 1]).toBe(ACCOUNTS_TABLE_UTC_NOTE);
    expect(lines.filter((l) => l === ACCOUNTS_TABLE_UTC_NOTE)).toHaveLength(1);
  });

  // The empty-table message is its own distinct one-liner — no footer note
  // tacked onto it (nothing to clarify when there's no table to misread).
  it("the empty-table message carries no UTC footer", () => {
    expect(formatAccountsTable([], NOW)).toBe("(no accounts configured)");
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

// Issue #240: real `cswap list --json` prints an envelope OBJECT
// (`{schemaVersion, activeAccountNumber, accounts}`), never the bare array
// the old `readCswapList` required — every one of these pins the real shape,
// not the fiction test/fixtures/cswap-list.ts used to invent.
describe("parseCswapListOutput", () => {
  it("parses the real envelope shape ({schemaVersion: 1, activeAccountNumber, accounts}) into the accounts array", () => {
    const result = parseCswapListOutput(JSON.stringify(CSWAP_LIST_ENVELOPE));
    expect(result).toEqual({ available: true, accounts: CSWAP_LIST_FIXTURE });
  });

  it("still parses a bare array (the old shape) -- kept tolerated, cheap to keep", () => {
    const result = parseCswapListOutput(JSON.stringify(CSWAP_LIST_FIXTURE));
    expect(result).toEqual({ available: true, accounts: CSWAP_LIST_FIXTURE });
  });

  it("an unknown schemaVersion reads available: false, with a reason naming the actual version seen", () => {
    const result = parseCswapListOutput(JSON.stringify({ schemaVersion: 2, activeAccountNumber: 1, accounts: [OVER_FIVE_HOUR] }));
    expect(result.available).toBe(false);
    expect((result as { reason: string }).reason).toContain("2");
    expect((result as { reason: string }).reason).toContain("schemaVersion");
  });

  it("a well-formed-looking object missing its own accounts array reads available: false, reason describing what's missing", () => {
    const result = parseCswapListOutput(JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1 }));
    expect(result.available).toBe(false);
    expect((result as { reason: string }).reason).toContain("accounts");
  });

  it("accounts present but not an array reads available: false, same malformed-envelope reason", () => {
    const result = parseCswapListOutput(JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: "nope" }));
    expect(result.available).toBe(false);
    expect((result as { reason: string }).reason).toContain("accounts");
  });

  it("unparseable JSON reads available: false with its own distinct reason", () => {
    const result = parseCswapListOutput("{not json");
    expect(result).toEqual({ available: false, reason: "printed unparseable JSON" });
  });

  it("a bare JSON scalar (neither an array nor an object) reads available: false", () => {
    const result = parseCswapListOutput("42");
    expect(result.available).toBe(false);
  });
});

describe("formatCswapUnavailableNote", () => {
  it("null reason (cswap WAS available) -> no note to print", () => {
    expect(formatCswapUnavailableNote(null)).toBeNull();
  });

  it("a reason prints as one 'cswap: <reason>' line", () => {
    expect(formatCswapUnavailableNote("binary not found on PATH")).toBe("cswap: binary not found on PATH");
  });
});
