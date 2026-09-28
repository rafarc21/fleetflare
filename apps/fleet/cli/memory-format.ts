// `fleet memory ls` — the survey, as a table. Pure (rows in, string out), so
// it is unit-testable outside the bun-only CLI, same split cli/task-format.ts
// already keeps.

/** One row of src/memory/routes.ts's survey response. */
export interface MemoryFileRow {
  target: string;
  citations: number;
  ageMs: number | null;
  indexed: boolean;
  verdict: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function age(ms: number | null): string {
  return ms === null ? "-" : `${Math.floor(ms / DAY_MS)}d`;
}

/**
 * The numbers a demotion decision actually rests on, beside every file: how
 * many tasks cite it, how old it is, and the verdict those two produce. The
 * verdict column is the Worker's arithmetic, not a suggestion — a proposal
 * that disagrees with it is refused server-side, so showing it here is showing
 * what will be allowed.
 */
export function formatMemoryTable(files: MemoryFileRow[]): string {
  if (files.length === 0) return "(no memory files)";
  const width = Math.max(4, ...files.map((f) => f.target.length));
  const head = `${"FILE".padEnd(width)}  CITED  AGE   IDX  VERDICT`;
  const rows = files.map((f) =>
    `${f.target.padEnd(width)}  ${String(f.citations).padStart(5)}  ${age(f.ageMs).padStart(4)}  ` +
    `${(f.indexed ? "y" : "n").padEnd(3)}  ${f.verdict}`);
  return [head, ...rows].join("\n");
}

/**
 * The legend. Spelled out because the whole point of P5 §9 is that a reader
 * can trust what compaction does to a fact — and "demote" reads like "delete"
 * to anyone who has not read the spec.
 */
export const MEMORY_LEGEND =
  "VERDICT: promote = cited by 3+ tasks, collapse into a skill · keep = cited, stays indexed · " +
  "demote = uncited and 2 sprints old, MOVES to archive/ (never deleted) · hold = uncited but too new to judge";
