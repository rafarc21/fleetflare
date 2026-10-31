// Board issue #1447: `fleet task reconcile [--dry-run|--apply]` — the Worker
// reconcile that closes the board's state drift. Three cases, each proven
// against one open task:
//
//   (a) a task whose linked PR is MERGED INTO THE DEFAULT BRANCH -> `completed`,
//       with "auto-completed: PR #n merged" commented once;
//   (b) a working/awaiting_merge task on a studio that is stopped or parked,
//       with NO open PR -> back to `submitted`, commented once;
//   (c) an awaiting_merge task on a stopped/parked studio whose linked PR is
//       still OPEN -> state left as-is, commented once.
//
// "Linked PR" is whatever `linkedPrs` returns — the real side unions the
// task's envelope PR (its own reported PR) with the search-based `refs #N`
// result (see routes.ts). Completion is the DEFAULT branch, not any merge: a
// PR merged into `staging` is "merged but not on default yet", skipped rather
// than completed — the same verdict reap already reaches.
//
// Same shape as src/studio/task-reap.ts: a pure orchestrator, DI'd so every
// rule is provable without Env, a token or GitHub. Every write goes through
// the single-writer `transition` port (board.ts's transitionTask, the Worker's
// own CAS) or the `comment` port — this file never writes a label itself, and
// every comment is guarded by `hasComment` so a second run on the same task is
// a no-op rather than a re-post. Reading PR/studio state is fail-CLOSED: a
// throw on either skips the task (never resets a task we could not fully
// read), and a studio id with no registry row is `null` — skipped, never read
// as stopped (review #1447 item 3).

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

/** One linked PR's live state. `landed` is "merged into the DEFAULT branch"
 *  (squash-safe), the completion condition; `merged` (any branch) but not
 *  landed is a PR whose promotion is still pending; `open` is a PR that
 *  still holds the work. Exactly one of the three is true, and a closed
 *  unmerged PR has all three false. */
export interface ReconcilePrState {
  open: boolean;
  landed: boolean;
  merged: boolean;
}

export interface ReconcileDeps {
  repo: string;
  listOpenTasks: () => Promise<ReconcileTask[]>;
  /** Every PR linked to this task — its envelope PR and any `refs #N` PR,
   *  merged and open alike. Fail-closed: a throw skips the task, so a read
   *  failure never reads as "no open PR" and resets live work. */
  linkedPrs: (taskNumber: number) => Promise<number[]>;
  /** One linked PR's live state. Fail-closed, same as linkedPrs. */
  prState: (prNumber: number) => Promise<ReconcilePrState>;
  /** Is this studio stopped or parked? `null` when the registry has no row
   *  for it — a skip, never "stopped". Fail-closed, same as linkedPrs. */
  studioStopped: (studioId: string) => Promise<boolean | null>;
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

/** Per-run cap for the SCHEDULED sweep (rate-limit safety). The CLI route
 *  applies no cap: the operator asked for a full pass. */
export const RECONCILE_DEFAULT_LIMIT = 25;

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
    // No single assignee -> no studio to reset or hold, and no PR search is
    // worth paying for a task that can only ever complete via a PR anyway.
    // Ordered BEFORE the PR reads so an unassigned task costs no search
    // (review #1447 item 1: skip PR search for tasks needing no PR read).
    if (t.assignee === null) {
      out.push({ taskNumber: t.taskNumber, outcome: "skipped", reason: "unassigned" });
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

    // Ask each linked PR's state once. A landed PR wins outright (case a);
    // a merged-but-not-landed PR (promotion pending) is its own skip; an open
    // PR holds the work for cases (b)/(c). A PR read that throws fails the
    // WHOLE task closed — the task is skipped, never completed and never reset
    // on the strength of a read we could not finish.
    let landed: number | null = null;
    let merged: number | null = null;
    let open: number | null = null;
    let readFailed = false;
    for (const pr of prs) {
      let s: ReconcilePrState;
      try {
        s = await deps.prState(pr);
      } catch (err) {
        out.push({
          taskNumber: t.taskNumber,
          outcome: "skipped", reason: `reading PR #${pr} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        readFailed = true;
        break;
      }
      if (s.landed) { landed = pr; break; }
      if (s.merged && merged === null) merged = pr;
      if (s.open && open === null) open = pr;
    }
    if (readFailed) continue;

    if (landed !== null) {
      out.push(await completeTask(deps, apply, t.taskNumber, t.state, landed));
      continue;
    }
    if (merged !== null) {
      out.push({
        taskNumber: t.taskNumber,
        outcome: "skipped", reason: `PR #${merged} merged but not on default branch yet`,
      });
      continue;
    }

    let stopped: boolean | null;
    try {
      stopped = await deps.studioStopped(t.assignee);
    } catch (err) {
      out.push({
        taskNumber: t.taskNumber,
        outcome: "skipped", reason: `reading studio state failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (stopped === null) {
      out.push({ taskNumber: t.taskNumber, outcome: "skipped", reason: "unknown studio" });
      continue;
    }
    if (!stopped) {
      out.push({ taskNumber: t.taskNumber, outcome: "skipped", reason: "studio running" });
      continue;
    }

    if (open !== null) {
      // Case (c): an awaiting_merge task's PR still holds the work. A working
      // task with an open PR is left for review rather than noted.
      if (t.state === "awaiting_merge") {
        out.push(await noteTask(deps, apply, t.taskNumber, t.assignee, open));
      } else {
        out.push({ taskNumber: t.taskNumber, outcome: "skipped", reason: "working with an open PR — left for review" });
      }
      continue;
    }

    // Case (b): stopped or parked, and nothing open/merged to hold the work.
    // `state` is non-null here — the caller skips a null state before ever
    // reaching this point, so the assertion only restates that invariant.
    out.push(await resetTask(deps, apply, t.taskNumber, t.state, t.assignee));
  }

  return out;
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

/**
 * The rotating-cursor cap for the scheduled sweep (review #1447 item 1):
 * rotate a newest-first task list so a run starts just after `cursor` (the
 * last task number a prior run considered), then take at most `limit`.
 * Returns the slice and the cursor to persist for the next run — the LAST
 * considered task's number (skips included), so a task that is skipped
 * repeatedly cannot hold the cursor and starve the rest of the list. A
 * cursor that no longer exists (task closed/merged since) is ignored and the
 * run starts from the head.
 */
export function rotateReconcileSlice(
  tasks: ReconcileTask[], limit: number, cursor: number | null,
): { slice: ReconcileTask[]; nextCursor: number | null } {
  if (tasks.length === 0) return { slice: [], nextCursor: null };
  let start = 0;
  if (cursor !== null) {
    const idx = tasks.findIndex((t) => t.taskNumber === cursor);
    if (idx !== -1) start = (idx + 1) % tasks.length;
  }
  const slice: ReconcileTask[] = [];
  const count = Math.min(limit, tasks.length);
  for (let i = 0; i < count; i++) slice.push(tasks[(start + i) % tasks.length]);
  const nextCursor = slice.length > 0 ? slice[slice.length - 1].taskNumber : null;
  return { slice, nextCursor };
}