import { describe, it, expect } from "vitest";
import { formatColumns } from "../cli/columns";
import { formatTaskTable, TITLE_WIDTH } from "../cli/task-format";
import { formatAccountsTable } from "../cli/accounts-format";
import type { AccountSnapshotRow, AccountCurrentState } from "../cli/accounts-format";
import type { SyncDecision } from "../src/studio/claude-swap";
import type { BoardTask } from "../src/board/types";

// Issue #399 (sweep-5 F1): byte-exact characterization pins of the column
// tables, written BEFORE the formatColumns fold. Every pin asserts the
// ENTIRE returned string — every byte, the two-space column gaps, and the
// #205 rule (never a trailing space after the last column). The fold then
// proves itself by keeping every pin green, byte-identical: any width or
// gap change anywhere in the shared builder shows up here first.
//
// The exact-bytes pins transcribe the tables' own output for fixed inputs
// (same discipline as the junior/fleet-ls pins in test/bun): the literals
// below ARE the before-snapshot, so a fold that changes even one space
// fails, while a fold that changes nothing passes without editing a line.

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 12, url: "https://github.com/o/r/issues/12", title: "Build the task board",
    body: "", state: "submitted", labels: ["submitted"], assignee: null,
    milestone: "Sprint 1", open: true, updatedAt: "2026-08-25T10:00:00Z", ...overrides,
  };
}

// What a > TITLE_WIDTH title renders: the first TITLE_WIDTH-1 chars plus the
// ellipsis — spelled this way instead of 51 literal x's so the pin stays
// readable, same trick cli.task-format.test.ts's own truncation test uses.
const truncatedTitle = `${"x".repeat(TITLE_WIDTH - 1)}…`;

describe("formatTaskTable — exact bytes (#399)", () => {
  it("two tasks, one long title (truncation), one null sprint: every byte of the table", () => {
    const out = formatTaskTable([
      task({ milestone: "Sprint 5", title: "Short title" }),
      task({ number: 300, milestone: null, title: "x".repeat(TITLE_WIDTH + 40), url: "https://github.com/o/r/issues/300" }),
    ]);
    expect(out).toBe(
      "#    STATE      STUDIO  SPRINT    TITLE" + " ".repeat(47) + "  URL\n" +
      "12   submitted  -       Sprint 5  Short title" + " ".repeat(41) + "  https://github.com/o/r/issues/12\n" +
      "300  submitted  -       -         " + truncatedTitle + "  https://github.com/o/r/issues/300",
    );
  });
});

// The fixed `now` every time-sensitive cell below is measured against — same
// value test/cli.accounts-format.test.ts's own LIMITED fixtures sit inside.
const NOW = new Date("2026-10-05T13:00:00Z");
const FREE: AccountCurrentState = { dead: false, until: null, seenAt: null };

const LIMIT_DECISION: SyncDecision = {
  name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit",
  until: "2026-10-05T14:00:00Z", seenAt: "2026-10-05T12:00:00Z", usageAgeSeconds: 10,
};
const CLEAR_DECISION: SyncDecision = {
  name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear",
  seenAt: "2026-10-05T12:00:00Z", usageAgeSeconds: 10,
};

// Same row-building shape as cli.accounts-format.test.ts's own `row`, kept
// inline here (a test file never imports another test file).
function acct(overrides: Partial<AccountSnapshotRow> = {}): AccountSnapshotRow {
  return {
    name: "CLAUDE_CODE_OAUTH_TOKEN", label: "primary@example.com", matchSource: "label",
    matchedEmail: "primary@example.com", fiveHourPct: 10, sevenDayPct: 20,
    decision: CLEAR_DECISION, current: FREE, ...overrides,
  };
}

describe("formatAccountsTable — exact bytes (#399)", () => {
  it("two rows, differing widths, the UTC footer: every byte of the table", () => {
    const out = formatAccountsTable([
      acct(),
      acct({
        name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, matchSource: "unmapped",
        matchedEmail: null, fiveHourPct: 97, sevenDayPct: null, decision: LIMIT_DECISION,
      }),
    ], NOW);
    expect(out).toBe(
      "SLOT                       LABEL                MATCH     KIND    5H%  7D%  RESETS                ROW STATE  WOULD\n" +
      "CLAUDE_CODE_OAUTH_TOKEN    primary@example.com  label     window  10%  20%  -                     free       -\n" +
      "CLAUDE_CODE_OAUTH_TOKEN_2  -                    unmapped  window  97%  -    2026-10-05T14:00:00Z  free       limited until 2026-10-05T14:00:00Z\n" +
      "\n" +
      "(reset times shown in UTC)",
    );
  });
});

describe("formatColumns — the shared builder's own contract (#399)", () => {
  it("widths from the longest cell per column, two spaces between, no trailing newline", () => {
    expect(formatColumns(["A", "BB"], [["x", "y"]])).toBe("A  BB\nx  y");
  });

  it("the last column is NEVER padded by default (#205): no line ends in whitespace", () => {
    const out = formatColumns(["HEAD", "H"], [["short", "c"], ["longer-cell", "cell"]]);
    expect(out).toBe(
      "HEAD" + " ".repeat(9) + "H\n" +
      "short" + " ".repeat(8) + "c\n" +
      "longer-cell cell",
    );
    for (const line of out.split("\n")) expect(line).toBe(line.trimEnd());
  });

  it("padLast: true opts back into the padded-every-column shape junior used to reach via trimEnd", () => {
    // Widths [1, 2]: the last cell ("b", 1 char) pads to the header's 2 —
    // the trailing space is the whole point of the opt-in.
    expect(formatColumns(["A", "BB"], [["a", "b"]], { padLast: true })).toBe("A  BB\na  b ");
  });

  it("no rows: just the header line", () => {
    expect(formatColumns(["A", "B"], [])).toBe("A  B");
  });
});
