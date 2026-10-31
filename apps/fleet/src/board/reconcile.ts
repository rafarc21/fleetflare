// Board issue #1447: `fleet task reconcile [--dry-run|--apply]` — the Worker
// reconcile that closes the board's state drift. Three cases, each proven
// against one open task:
//
//   (a) a task whose linked PR is MERGED -> `completed`, with
//       "auto-completed: PR #n merged" commented once;
//   (b) a working/awaiting_merge task on a studio that is stopped or parked,
//       with NO open PR -> back to `submitted`, commented once;
//   (c) an awaiting_merge task on a stopped/parked studio whose linked PR is
//       still OPEN -> state left as-is, commented once.
//
// "Linked PR" is whatever `linkedPrs` returns (the real side unions the
// search-based `refs #N` result with the task's envelope PR — see routes.ts).
// Same shape as src/studio/task-reap.ts: a pure orchestrator, DI'd so every
// rule is provable without Env, a token or GitHub. Every write goes through
// the single-writer `transition` port (board.ts's transitionTask, the Worker's
// own CAS) or the `comment` port — this file never writes a label itself, and
// every comment is guarded by `hasComment` so a second run on the same task is
// a no-op rather than a re-post. Reading PR/studio state is fail-CLOSED: a
// throw on either skips the task (never resets a task we could not fully
// read).

import type { BoardTaskState } from "./types";

/** One open board task as reconcile needs it. Produced by the real side from
 *  `listTasks` + `listStudios` (see routes.ts). */
export interface ReconcileTask {
  taskNumber: number;
  /** `null` exactly when `taskStates` did not find one state label — drift,
   *  never reconciled (the single writer refuses to guess). */
  state: BoardTaskState | null;
  /** The studio label's id, or `null` when there is no single assignee. */
  assignee: string | null;
}

export interface ReconcileDeps {
  repo: string;
  listOpenTasks: () => Promise<ReconcileTask[]>;
  /** Every PR linked to this task — merged and open alike. Fail-closed: a
   *  throw skips the task, so a read failure never reads as "no open PR" and
   *  resets live work. */
  linkedPrs: (taskNumber: number) => Promise<number[]>;
  /** One linked PR's live state. Fail-closed, same as linkedPrs. */
  prState: (prNumber: number) => Promise<{ merged: boolean; open: boolean }>;
  /** Is this studio stopped or parked? Fail-closed, same as linkedPrs. */
  studioStopped: (studioId: string) => Promise<boolean>;
  /** Has this exact comment marker already been written on this task? The
   *  idempotency guard — a second run re-posts nothing. */
  hasComment: (taskNumber: number, marker: string) => Promise<boolean>;
  /** The single writer: board.ts's transitionTask CAS. */
  transition: (taskNumber: number, from: BoardTaskState, to: BoardTaskState) =>
    Promise<{ ok: true } | { ok: false; message: string }>;
  /** One board comment. */
  comment: (taskNumber: number, body: string) => Promise<void>;
}

export type ReconcileOutcome =
  | { taskNumber: number; prNumber: number; outcome: "would-complete" | "completed" }
  | { taskNumber: number; outcome: "would-reset" | "reset"; reason: string }
  | { taskNumber: number; prNumber: number; outcome: "would-note" | "noted"; reason: string }
  | { taskNumber: number; outcome: "skipped"; reason: string }
  | { taskNumber: number; outcome: "failed"; reason: string };

export const RECONCILE_COMPLETE_MARKER = (pr: number) => `auto-completed: PR #${pr} merged`;
export const RECONCILE_RESET_MARKER = (id: string) => `auto-reconcile: ${id} stopped or parked with no open PR — task back to submitted`;
export const RECONCILE_NOTE_MARKER = (id: string, pr: number) => `auto-reconcile: ${id} stopped or parked, PR #${pr} still open — leaving awaiting_merge`;

const TERMINAL: readonly BoardTaskState[] = ["completed", "failed", "canceled"];

/**
 * `apply: false` only REPORTS (`would-*`), nothing writes. `apply: true`
 * performs the write each case names. One outcome per task, in
 * `listOpenTasks` order; a per-task failure never stops the rest of the run.
 */
export async function runBoardReconcile(deps: ReconcileDeps, apply: boolean): Promise<ReconcileOutcome[]> {
  const tasks = await deps.listOpenTasks();
  const out: ReconcileOutcome[] = [];

  for (const t of tasks) {
    if (t.state === null) {
      out.push({ taskNumber: t.taskNumber, outcome: "skipped", reason: "no single board state" });
      continue;
    }
    if (t.state === "input_required") {
      out.push({ taskNumber: t.taskNumber, outcome: "skipped", reason: "input_required parked" });
      continue;
    }
    if (TERMINAL.includes(t.state)) {
      out.push({ taskNumber: t.taskNumber, outcome: "skipped", reason: `terminal ${t.state}` });
      continue;
    }
    if (t.state === "submitted") {
      out.push({ taskNumber: t.taskNumber, outcome: "skipped", reason: "submitted, not in flight" });
      continue;
    }

    let prs: number[];
    try {
      prs = dedupe(await deps.linkedPrs(t.taskNumber));
    } catch (err) {
      out.push({
        taskNumber: t.taskNumber,
        outcome: "skipped", reason: `reading linked PRs failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (prs.length === 0) {
      // No linked PR at all: only case (b) can apply — a stopped studio whose
      // work has no PR anywhere to hold it.
      out.push(await stopOrSkip(deps, apply, t, null));
      continue;
    }

    // Ask each linked PR's state once; a merged PR wins outright (case a).
    let merged: number | null = null;
    let open: number | null = null;
    for (const pr of prs) {
      let s: { merged: boolean; open: boolean };
      try {
        s = await deps.prState(pr);
      } catch (err) {
        out.push({
          taskNumber: t.taskNumber,
          outcome: "skipped", reason: `reading PR #${pr} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        merged = null;
        open = null;
        break;
      }
      if (s.merged) { merged = pr; break; }
      if (s.open) open = pr;
    }

    if (merged !== null) {
      out.push(await completeTask(deps, apply, t.taskNumber, t.state, merged));
      continue;
    }

    out.push(await stopOrSkip(deps, apply, t, open));
  }

  return out;
}

/** The stopped-studio half, shared by "no linked PR" and "linked but none
 *  open/merged". `openPr` is the (single) open linked PR, or `null`. */
async function stopOrSkip(
  deps: ReconcileDeps, apply: boolean, t: ReconcileTask, openPr: number | null,
): Promise<ReconcileOutcome> {
  if (t.assignee === null) {
    return { taskNumber: t.taskNumber, outcome: "skipped", reason: "unassigned" };
  }
  let stopped: boolean;
  try {
    stopped = await deps.studioStopped(t.assignee);
  } catch (err) {
    return {
      taskNumber: t.taskNumber,
      outcome: "skipped", reason: `reading studio state failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!stopped) {
    return { taskNumber: t.taskNumber, outcome: "skipped", reason: "studio running" };
  }

  if (openPr !== null) {
    // Case (c): an awaiting_merge task's PR still holds the work. A working
    // task with an open PR is left for review rather than noted.
    if (t.state === "awaiting_merge") {
      return noteTask(deps, apply, t.taskNumber, t.assignee, openPr);
    }
    return { taskNumber: t.taskNumber, outcome: "skipped", reason: "working with an open PR — left for review" };
  }
  // Case (b): stopped or parked, and nothing open to hold the work. `state`
  // is non-null here — the caller skips a null state before ever reaching
  // this function, so the assertion only restates that invariant.
  return resetTask(deps, apply, t.taskNumber, t.state as BoardTaskState, t.assignee);
}

async function completeTask(
  deps: ReconcileDeps, apply: boolean, taskNumber: number, from: BoardTaskState, prNumber: number,
): Promise<ReconcileOutcome> {
  const marker = RECONCILE_COMPLETE_MARKER(prNumber);
  if (!apply) return { taskNumber, prNumber, outcome: "would-complete" };
  const result = await deps.transition(taskNumber, from, "completed");
  if (!result.ok) return { taskNumber, outcome: "failed", reason: result.message };
  await commentOnce(deps, taskNumber, marker);
  return { taskNumber, prNumber, outcome: "completed" };
}

async function resetTask(
  deps: ReconcileDeps, apply: boolean, taskNumber: number, from: BoardTaskState, studioId: string,
): Promise<ReconcileOutcome> {
  if (!apply) return { taskNumber, outcome: "would-reset", reason: studioId };
  const result = await deps.transition(taskNumber, from, "submitted");
  if (!result.ok) return { taskNumber, outcome: "failed", reason: result.message };
  await commentOnce(deps, taskNumber, RECONCILE_RESET_MARKER(studioId));
  return { taskNumber, outcome: "reset", reason: studioId };
}

async function noteTask(
  deps: ReconcileDeps, apply: boolean, taskNumber: number, studioId: string, prNumber: number,
): Promise<ReconcileOutcome> {
  if (!apply) return { taskNumber, prNumber, outcome: "would-note", reason: studioId };
  await commentOnce(deps, taskNumber, RECONCILE_NOTE_MARKER(studioId, prNumber));
  return { taskNumber, prNumber, outcome: "noted", reason: studioId };
}

async function commentOnce(deps: ReconcileDeps, taskNumber: number, marker: string): Promise<void> {
  if (await deps.hasComment(taskNumber, marker)) return;
  await deps.comment(taskNumber, marker);
}

function dedupe(numbers: number[]): number[] {
  return [...new Set(numbers)];
}