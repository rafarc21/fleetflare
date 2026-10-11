// Issue #399 (sweep-5 F1): the ONE column-table builder behind the four CLI
// tables that hand-rolled the same dance — cli/fleet.ts's formatTable,
// cli/accounts-format.ts's formatAccountsTable, cli/task-format.ts's
// formatTaskTable, and cli/junior.ts's formatJuniorStats — whose copies had
// already drifted (junior's padded every column then trimEnded each line,
// so the no-trailing-pad rule lived in a trimEnd call, not in the table).
//
// Pure, imports NOTHING (no node:*, no Bun globals) — same reason
// cli/readiness-format.ts's own header documents: a test under the root
// tsconfig's type set can import this directly, and nothing here pulls
// Bun-only declarations into that compilation graph.
/**
 * One column table: a header row, one row per entry, column widths from the
 * longest cell in each column (header included), cells joined by two spaces.
 *
 * The LAST column is never padded — issue #205: trailing blanks on every
 * line are pure bytes, and they turned one long ERROR into 87 KB of output.
 * Also, trailing spaces after a url make it harder to select, and nothing
 * follows it (the second, independent rationale task-format.ts carried).
 * Callers wanting the old padded-right-edge shape (what junior's per-line
 * trimEnd used to mask) can opt back in with `padLast: true`; no current
 * caller does.
 */
export function formatColumns(
  headers: string[],
  rows: string[][],
  opts?: { padLast?: boolean },
): string {
  const last = headers.length - 1;
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols: string[]) =>
    cols.map((c, i) => (i === last && opts?.padLast !== true ? c : c.padEnd(widths[i]!))).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}
