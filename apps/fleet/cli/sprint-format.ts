// How `fleet sprint ls` and `fleet sprint status` print. Pure — strings in,
// strings out, no I/O and no Bun/node globals — same reason cli/task-format.ts
// is: cli/fleet.ts itself is never imported from test/ (bun-only globals), so
// anything worth asserting on has to live outside it.

import type { SprintSummary } from "../src/board/sprint";
import type { BoardTask } from "../src/board/types";

/** The percent a summary prints. Zero total reads as 0% — an empty sprint has
 *  nothing completed, never a divide-by-zero. */
function pct(s: SprintSummary): number {
  return s.total === 0 ? 0 : Math.round((100 * s.completed) / s.total);
}

/** The one summary line every sprint verb shares: `Sprint <title>: x/y (z%)`. */
export function formatSprintStatusLine(s: SprintSummary): string {
  return `Sprint ${s.title}: ${s.completed}/${s.total} (${pct(s)}%)`;
}

/** `fleet sprint status` with no title — one status line per open sprint. */
export function formatSprintStatusLines(summaries: SprintSummary[]): string {
  if (summaries.length === 0) return "(no open sprints)";
  return summaries.map(formatSprintStatusLine).join("\n");
}

/** `fleet sprint ls` — one line per open sprint, with owner and goal. */
export function formatSprintSummaries(summaries: SprintSummary[]): string {
  if (summaries.length === 0) return "(no open sprints)";
  return summaries
    .map((s) => `${formatSprintStatusLine(s)}  owner: ${s.owner ?? "-"}  goal: ${s.goal}`)
    .join("\n");
}

/** `fleet sprint status <title>` — the summary line, then one line per task
 *  that still needs work (not completed, not canceled). */
export function formatSprintStatus(summary: SprintSummary, tasks: BoardTask[]): string {
  const lines = [formatSprintStatusLine(summary)];
  for (const t of tasks) {
    if (t.state === "completed" || t.state === "canceled") continue;
    lines.push(`  ${t.number} ${t.state ?? "-"} ${t.assignee ?? "-"}`);
  }
  return lines.join("\n");
}