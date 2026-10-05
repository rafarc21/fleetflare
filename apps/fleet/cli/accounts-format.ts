// Issue #232, step 3 — pure table/diff helpers for `fleet accounts` /
// `fleet accounts sync`. No I/O: the cswap subprocess read and the Worker
// fetch both live in cli/accounts.ts (bun-only, see that file's own header
// for why it stays separate); this module imports only
// src/studio/claude-swap.ts's types, so it is directly unit-testable the
// same way cli/task-format.ts and cli/restart-format.ts already are (see
// cli/burn-format.ts's own header for the general "pure sibling of an impure
// cli/ file" convention this follows).
import type { SyncDecision } from "../src/studio/claude-swap";

/** The row's state exactly as GET /studio/accounts reports it — what D1
 *  currently HOLDS, before any sync runs. Deliberately a separate type from
 *  `SyncDecision`: the issue's own acceptance language ("slot, label, 5h %,
 *  7d %, resets, row state") names this as ROW STATE, distinct from what a
 *  sync WOULD do — conflating the two was called out explicitly in this
 *  dispatch's own brief. */
export interface AccountCurrentState {
  dead: boolean;
  until: string | null;
  seenAt: string | null;
}

/** One table row: a fleet account slot, its cswap usage (`null` fields when
 *  unmanaged or cswap itself is unavailable), the decision a sync would make
 *  right now, and the row's CURRENT D1 state — side by side, never merged
 *  into one column. */
export interface AccountSnapshotRow {
  name: string;
  label: string | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  decision: SyncDecision;
  current: AccountCurrentState;
}

function pct(n: number | null): string {
  return n === null ? "-" : `${n}%`;
}

/** The current row's own state in one phrase. `dead` wins over a plain
 *  `until` — a dead row can also carry a stale `until`, and `dead` is the
 *  louder fact an operator needs to see first. Neither set reads "free". */
export function describeCurrentState(s: AccountCurrentState): string {
  if (s.dead) return "dead";
  if (s.until !== null) return `limited until ${s.until}`;
  return "free";
}

/** What applying `decision` would leave the row reading, in the SAME words
 *  `describeCurrentState` uses, so the two are directly comparable. */
function describeOutcome(decision: SyncDecision): string {
  if (decision.action === "clear") return "free";
  if (decision.action === "limit") return decision.until !== null ? `limited until ${decision.until}` : "limited";
  return `unmanaged (${decision.reason})`;
}

/**
 * Whether running sync would actually CHANGE this row. `"unmanaged"` never
 * writes at all (routes.ts's own posture — see POST /studio/accounts/sync's
 * doc comment), so it is never a change regardless of current state.
 */
export function wouldChange(current: AccountCurrentState, decision: SyncDecision): boolean {
  if (decision.action === "unmanaged") return false;
  return describeCurrentState(current) !== describeOutcome(decision);
}

/** The table's WOULD column: the outcome, only when it differs from the
 *  current row ("-" when sync would be a no-op). This dispatch's own
 *  addition alongside the issue's six named columns — see this module's
 *  header on why current state and the would-be outcome are kept distinct
 *  rather than collapsed into one. */
export function describeWould(row: AccountSnapshotRow): string {
  return wouldChange(row.current, row.decision) ? describeOutcome(row.decision) : "-";
}

/**
 * `fleet accounts`'s table. Columns: SLOT, LABEL, 5H%, 7D%, RESETS, ROW
 * STATE (what D1 holds now), WOULD (what sync would change it to, "-" when
 * nothing would change). RESETS shows the specific window's `resetsAt` that
 * a "limit" decision would use — the same `until` `decideAccountSync`
 * already picked — and "-" otherwise (nothing currently trips).
 *
 * Same column-table house style as cli/task-format.ts's formatTaskTable:
 * header + one row per slot, widths from the longest cell per column, two
 * spaces between columns, right edge never padded.
 */
export function formatAccountsTable(rows: AccountSnapshotRow[]): string {
  if (rows.length === 0) return "(no accounts configured)";
  const headers = ["SLOT", "LABEL", "5H%", "7D%", "RESETS", "ROW STATE", "WOULD"];
  const body = rows.map((r) => [
    r.name,
    r.label ?? "-",
    pct(r.fiveHourPct),
    pct(r.sevenDayPct),
    r.decision.action === "limit" ? r.decision.until ?? "-" : "-",
    describeCurrentState(r.current),
    describeWould(r),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const last = headers.length - 1;
  const line = (cols: string[]) => cols.map((c, i) => (i === last ? c : c.padEnd(widths[i]))).join("  ");
  return [line(headers), ...body.map(line)].join("\n");
}

/**
 * `--watch`'s diff-only gate: true only when the two snapshots carry
 * identical data in identical order — structural equality over every field
 * the table renders (and the raw decision behind WOULD), not a string
 * compare of the rendered table, which would also flag an unrelated row's
 * longer value reflowing every column's width.
 */
export function snapshotsEqual(a: AccountSnapshotRow[], b: AccountSnapshotRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => JSON.stringify(row) === JSON.stringify(b[i]));
}
