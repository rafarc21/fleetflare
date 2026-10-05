// Issue #232, step 3 — pure table/diff helpers for `fleet accounts` /
// `fleet accounts sync`. No I/O: the cswap subprocess read and the Worker
// fetch both live in cli/accounts.ts (bun-only, see that file's own header
// for why it stays separate); this module imports only
// src/studio/claude-swap.ts's types, so it is directly unit-testable the
// same way cli/task-format.ts and cli/restart-format.ts already are (see
// cli/burn-format.ts's own header for the general "pure sibling of an impure
// cli/ file" convention this follows).
import type { SlotJoin, SyncDecision } from "../src/studio/claude-swap";

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
 *  into one column.
 *
 *  `matchSource` is the join's own verdict (claude-swap.ts's `SlotJoin`) —
 *  label/inferred/unmapped/cswap-missing — surfaced as its own column
 *  (MAJOR 4) rather than folded into `decision`, which only ever answers
 *  "what would a sync do", not "how did we find this account".
 *
 *  `matchedEmail` is the cswap account's own email when the join found one
 *  (label or inferred match), null otherwise — `--write-labels` (cli/
 *  accounts.ts) needs it to print a pasteable `CLAUDE_ACCOUNT_<n>_LABEL=
 *  <email>` suggestion for an `"inferred"` row. */
export interface AccountSnapshotRow {
  name: string;
  label: string | null;
  matchSource: SlotJoin["matchSource"];
  matchedEmail: string | null;
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
 *  `describeCurrentState` uses, so the two are directly comparable.
 *  `"no-data"` is never compared against current state at all (see
 *  `describeWould` below) — this branch exists only so `wouldChange` has a
 *  total function to call; its own text is never printed. */
function describeOutcome(decision: SyncDecision): string {
  if (decision.action === "clear") return "free";
  if (decision.action === "limit") return decision.until !== null ? `limited until ${decision.until}` : "limited";
  return "unmanaged";
}

/**
 * Whether running sync would actually CHANGE this row. Neither `"unmanaged"`
 * (no real account found) nor `"no-data"` (a real account, but its reading
 * isn't trustworthy right now) ever writes (routes.ts's own posture — see
 * POST /studio/accounts/sync's doc comment), so neither ever counts as a
 * change regardless of current state.
 */
export function wouldChange(current: AccountCurrentState, decision: SyncDecision): boolean {
  if (decision.action === "unmanaged" || decision.action === "no-data") return false;
  return describeCurrentState(current) !== describeOutcome(decision);
}

/**
 * The table's WOULD column: the outcome, only when it differs from the
 * current row ("-" when sync would be a no-op). This dispatch's own
 * addition alongside the issue's six named columns — see this module's
 * header on why current state and the would-be outcome are kept distinct
 * rather than collapsed into one.
 *
 * MAJOR 4: `"no-data"` reads distinctly from a plain `"unmanaged"` "-" —
 * "we found a real cswap account but can't trust this reading right now" is
 * a different fact from "we don't know which account this is at all", and
 * collapsing both to "-" would hide that an operator-visible cswap problem
 * (relogin required, a frozen reading) exists for this slot.
 */
export function describeWould(row: AccountSnapshotRow): string {
  if (row.decision.action === "no-data") return `no data (${row.decision.reason})`;
  return wouldChange(row.current, row.decision) ? describeOutcome(row.decision) : "-";
}

/**
 * `fleet accounts`'s table. Columns: SLOT, LABEL, MATCH, 5H%, 7D%, RESETS,
 * ROW STATE (what D1 holds now), WOULD (what sync would change it to, "-"
 * when nothing would change, "no data (...)" when cswap's own reading can't
 * be trusted right now). RESETS shows the specific window's `resetsAt` that
 * a "limit" decision would use — the same `until` `decideAccountSync`
 * already picked — and "-" otherwise (nothing currently trips). MATCH is the
 * join's own verdict (claude-swap.ts's `SlotJoin.matchSource`) — label,
 * inferred (reset-time match, no label needed), unmapped, or cswap-missing
 * — so an operator can tell how (or whether) this slot was identified.
 *
 * Same column-table house style as cli/task-format.ts's formatTaskTable:
 * header + one row per slot, widths from the longest cell per column, two
 * spaces between columns, right edge never padded.
 */
export function formatAccountsTable(rows: AccountSnapshotRow[]): string {
  if (rows.length === 0) return "(no accounts configured)";
  const headers = ["SLOT", "LABEL", "MATCH", "5H%", "7D%", "RESETS", "ROW STATE", "WOULD"];
  const body = rows.map((r) => [
    r.name,
    r.label ?? "-",
    r.matchSource,
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
 * `--write-labels` (MAJOR 4, the STATUS comment's own requirement): one
 * suggested config line per slot resolved by reset-time INFERENCE (never for
 * a `"label"` match — it already has one), the exact non-secret
 * `CLAUDE_ACCOUNT_<n>_LABEL=<email>` line an operator can paste into their
 * own ops config to make that match explicit going forward. This command
 * never writes a config file itself — see cli/accounts.ts's own
 * `--write-labels` doc comment. Pure (no I/O), so it is unit-testable
 * directly, same as every other helper in this module.
 */
export function buildLabelSuggestions(rows: AccountSnapshotRow[]): string[] {
  return rows
    .filter((r): r is AccountSnapshotRow & { matchedEmail: string } => r.matchSource === "inferred" && r.matchedEmail !== null)
    .map((r) => `${labelVarName(r.name)}=${r.matchedEmail}`);
}

/** The secret name's own 1-based slot number (accounts.ts's
 *  `claudeAccountVarName`, not imported here — see this module's header on
 *  why this stays Bun/node-free and pulls in none of src/studio/accounts.ts's
 *  own `Env`-adjacent graph), or null for a name outside that shape. */
function slotNumber(secretName: string): number | null {
  if (secretName === "CLAUDE_CODE_OAUTH_TOKEN") return 1;
  const m = /^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/.exec(secretName);
  return m ? Number(m[1]) : null;
}

/** `CLAUDE_ACCOUNT_<n>_LABEL` for a known slot name; falls back to naming
 *  the secret itself for a name outside the ordinary shape (defensive only —
 *  every real fleet slot matches `slotNumber`'s pattern). */
function labelVarName(secretName: string): string {
  const n = slotNumber(secretName);
  return n === null ? `CLAUDE_ACCOUNT_${secretName}_LABEL` : `CLAUDE_ACCOUNT_${n}_LABEL`;
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
