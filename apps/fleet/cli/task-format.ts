// How `fleet task ls` and `fleet task show` print. Pure — strings in, strings
// out, no I/O and no Bun/node globals — for the same reason cli/fleet-totals.ts
// is: cli/fleet.ts itself can never be imported from test/ (bun-only globals
// the root tsconfig's type set cannot resolve), so anything worth asserting on
// has to live outside it.
//
// The board is GitHub Issues, so the ONE thing every line here must carry is
// the issue url: the operator reads the board on his phone, in the GitHub app,
// and this table's job is to get him there — not to become a second board.

import { STUDIO_LABEL_PREFIX, taskStates, type BoardTask, type EnvelopeDoc } from "../src/board/types";
import type { TaskComment } from "../src/board/board";
import type { AssignWakeReport } from "../src/board/assign-wake";

/**
 * Board issue #41, half one, and board issue #158: what an assigning command
 * prints about the wake.
 *
 * `null` only when the response carried no `wake` field at all — a bare
 * backlog create with no assignee, the one case with no studio to report a
 * wake outcome about. A same-studio re-assignment that changes nothing on
 * the board (#158) still carries a `wake` field and prints one of the two
 * lines below, same as a real move.
 *
 * A refusal is surfaced LOUDLY and in the Worker's own words. The failure this
 * whole issue is about is a coordinator assigning four tasks, seeing four
 * green responses, and discovering hours later that no studio ever heard about
 * any of them.
 */
export function formatAssignWake(wake: AssignWakeReport | undefined): string | null {
  if (wake === undefined) return null;
  return wake.woke ? `woke the studio: ${wake.digest}` : `NO WAKE — ${wake.reason}`;
}

/** Titles are truncated to this, so the URL column stays on screen in an
 *  ordinary terminal. The url is the actionable half of the row. */
export const TITLE_WIDTH = 52;

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/**
 * One cell, three readings, and telling them apart is the whole of P5 §3's
 * visibility fix:
 *
 *   - NO state label is `backlog` — an issue nobody has triaged yet. It used
 *     to print as DRIFT, which said "a writer other than the Worker touched
 *     this"; for a hand-filed issue that is not a fault, it is the normal way
 *     work arrives.
 *   - TWO state labels is still DRIFT, with the labels that caused it. A blank
 *     cell would read as "nothing to see", the opposite of what an ambiguous
 *     issue means (src/board/board.ts refuses to move one until a human fixes
 *     it).
 *   - `/stale` is appended, never substituted, so the state stays readable:
 *     `backlog/stale`, `submitted/stale`. One whitespace-free token either
 *     way — this table is read by agents as well as by the operator.
 */
function stateCell(task: BoardTask & { stale?: boolean }): string {
  const base = task.state ?? (
    taskStates(task.labels).length === 0 ? "backlog" : `DRIFT(${task.labels.join(",")})`
  );
  return task.stale === true ? `${base}/stale` : base;
}

/**
 * Who owns the task. Same drift treatment `stateCell` gives state, for the
 * same reason: two `studio:` labels is a board someone hand-edited, and a
 * blank cell would read as "unassigned" — the opposite of what it means.
 */
function studioCell(task: BoardTask): string {
  if (task.assignee !== null) return task.assignee;
  const assignees = task.labels.filter((l) => l.startsWith(STUDIO_LABEL_PREFIX));
  return assignees.length === 0 ? "-" : `DRIFT(${assignees.join(",")})`;
}

/** Accepts a plain BoardTask (what `fleet task new` prints back) as well as a
 *  list row carrying the Worker's stale flag — the two differ by one optional
 *  field, and a second table for it would be a second thing to keep honest. */
export function formatTaskTable(tasks: (BoardTask & { stale?: boolean })[]): string {
  if (tasks.length === 0) return "(no tasks on this board)";
  const headers = ["#", "STATE", "STUDIO", "SPRINT", "TITLE", "URL"];
  const rows = tasks.map((t) => [
    String(t.number),
    stateCell(t),
    studioCell(t),
    t.milestone ?? "-",
    truncate(t.title.replace(/\s+/g, " "), TITLE_WIDTH),
    t.url,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  // The last column is never padded — trailing spaces after a url make it
  // harder to select, and nothing follows it.
  const line = (cols: string[]) =>
    cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

/** One envelope as prose, rebuilt from the struct rather than echoed from the
 *  comment body — the body carries the raw JSON in a details block, which is
 *  machinery an operator should never have to scroll past. */
function envelopeLines(doc: EnvelopeDoc): string[] {
  // The sender, not the comment's GitHub author: every envelope is posted by
  // the same App identity (the Worker is the single writer), so the author
  // column cannot tell one team's result from another's. `sender` can.
  const lines: string[] = [`  ${doc.envelope.sender} — ${doc.envelope.intent} / ${doc.payload.status}`];
  if (doc.notes !== "") lines.push(...doc.notes.split("\n").map((l) => `  ${l}`));
  const section = (label: string, entries: string[]) => {
    if (entries.length === 0) return;
    lines.push(`  ${label}:`);
    for (const e of entries) lines.push(`    - ${e}`);
  };
  section("artifacts", doc.payload.artifacts.map((a) =>
    `${a.pr ? `PR #${a.pr}` : a.url ?? a.path} (${a.kind})${a.digest ? ` ${a.digest}` : ""}`));
  section("evidence", doc.payload.evidence);
  section("open questions", doc.payload.open_questions);
  section("context", doc.payload.context_digest);
  section("learnings", doc.payload.learnings);
  return lines;
}

export function formatTaskShow(view: { task: BoardTask; comments: TaskComment[] }): string {
  const t = view.task;
  const out: string[] = [
    `#${t.number}  ${stateCell(t)}  studio: ${studioCell(t)}  sprint: ${t.milestone ?? "-"}  ${t.open ? "open" : "closed"}`,
    t.title,
    t.url,
    "",
    t.body.trimEnd(),
    "",
  ];
  if (view.comments.length === 0) {
    out.push("(no comments yet)");
    return out.join("\n");
  }
  out.push(`--- ${view.comments.length} comment${view.comments.length === 1 ? "" : "s"} ---`);
  for (const c of view.comments) {
    out.push("", `[${c.createdAt}] ${c.author}`);
    out.push(...(c.envelope ? envelopeLines(c.envelope) : c.body.split("\n").map((l) => `  ${l}`)));
  }
  return out.join("\n");
}
