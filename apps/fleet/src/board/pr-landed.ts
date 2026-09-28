// Board issue #8: the ONE shared "which open tasks claim a PR in their
// latest envelope" scan, written once and walked from two opposite
// directions:
//   - src/github/promote-close.ts (push-triggered): a push just landed;
//     check whether any open task's claimed PR shows up in THAT push's own
//     commit list.
//   - src/studio/task-reap.ts (poll-triggered, no push exists): the SAME
//     question, answered by asking GitHub directly whether the claimed PR's
//     merge commit is now an ancestor of the default branch.
// Neither caller re-implements the envelope scan itself — only HOW "landed"
// is decided differs, and that decision lives entirely in each caller.
//
// Reuses src/board/verify.ts's own findLatestResultEnvelope (comments
// scanned BACKWARDS for the newest intent:"result" envelope) — board task
// #119's precedent for "the current truth about a task's result lives in
// its newest result envelope, not necessarily its last comment", applied
// here instead of re-derived.

import { showTask, type BoardApi } from "./board";
import { findLatestResultEnvelope } from "./verify";
import { taskStates, type BoardTaskView } from "./types";
import { AUTO_CLOSE_BUDGET_MS, budgetExceeded, type TimeBudget } from "../time-budget";

/**
 * Board issue #180: hard ceiling on how many candidate tasks ONE call will
 * run `showTask` (a `getIssue` + a `listComments`, 2 subrequests) for.
 * Mirrors `board/api.ts`'s own `BOARD_MAX_PAGES` register — a named,
 * documented, never-thrown bound rather than an unbounded loop nothing here
 * would notice growing without limit.
 *
 * The math: this is the ONE scan both `github/webhook.ts`'s deferred
 * envelope cross-check (Path 2, run inside `ctx.waitUntil` — see that
 * file's own header) AND `studio/task-reap.ts`'s reap route (via
 * `board/routes.ts`'s `listOpenTasks`) call — bounding it here bounds both
 * callers for free. §5's busiest repo measured 2026-09-24: ~41 candidates
 * today; issue #180 itself projects ~186 once #163's `listIssues`
 * pagination fix deploys and a wider net of issues stays visible past the
 * old single-page cutoff. At 300 candidates * 2 subrequests = 600, plus
 * `listTasks`'s own `BOARD_MAX_PAGES` (20) page-fetches and Path 1's own
 * small per-push cost, this stays comfortably under Cloudflare's
 * 1000-subrequests-per-invocation cap even if candidate counts keep
 * growing well past today's projection — this runs inside `ctx.waitUntil`,
 * so wall-clock here is a lesser concern than the subrequest budget itself.
 *
 * KNOWN LIMITATION, recorded rather than papered over (mirrors
 * `github/webhook.ts`'s own "KNOWN LIMITATION" register): the bound applies
 * to a STABLE newest-first order (`listTasks`'s own, per #163/#168), so a
 * task older than the bound could in principle be skipped repeatedly by
 * BOTH callers — reap included — forever, never just once. Filed as a
 * tracked follow-up rather than solved here: issue #188 (reap should scan
 * the OLDEST unresolved candidates first, or track a cursor, so a stale
 * candidate is not permanently invisible to either caller).
 */
export const OPEN_TASKS_SCAN_MAX_CANDIDATES = 300;

/** One open task, and the PR number its latest result envelope names —
 *  `null` when there is no envelope yet, or the newest one names no `pr`
 *  artifact. `null` is carried rather than the task being dropped: both
 *  callers report "no PR artifact found" as its own outcome, not a silent
 *  omission. */
export interface OpenTaskPr {
  taskNumber: number;
  prNumber: number | null;
}

/**
 * `tasks` is the caller's own FULL list (task-reap.ts's `listOpenTasks`,
 * promote-close's webhook-side wiring both already have one from
 * `listTasks` — this function does not fetch the board list itself, only
 * reads each task's comments). Both callers now pass every task through
 * unfiltered; the "does this still need a look" call lives here, once.
 *
 * Board issue #26: a task is a candidate when it's still open on GitHub, OR
 * its board label isn't `completed` yet. NOT plain `task.open` — a GitHub
 * native closing keyword ("closes #N" in a merged PR) flips `open` to false
 * the instant the PR merges, before this scan or anything else in the
 * fleet's own reconciliation code ever looks. Dropping it on `open` alone
 * would permanently exclude it from every existing reconciliation path
 * (this scan's two callers are the ONLY ones that exist) even though its
 * board label was never moved to `completed` — closeTaskOnPromote
 * (close-action.ts) never got the chance to run. The one case genuinely
 * safe to skip forever is closed AND already `completed`: that task is
 * actually done, and re-scanning finished work on every push/reap would be
 * unbounded for no reason.
 *
 * A read failure for one task (a thrown `showTask`, or its own `{ok:false}`)
 * is logged and reported as `prNumber: null` for that task alone — the same
 * "one bad candidate does not stop the others" posture
 * `promote-close.ts`'s own resolvers take.
 *
 * Board issue #198, second condition: a candidate must ALSO carry at least
 * one board state label (`taskStates(task.labels).length > 0`) — `board.ts`'s
 * own `commentEnvelope` refuses to post a §6 envelope onto any issue with
 * ZERO state labels (never a fleet task at all, an ordinary repo issue mixed
 * in with real ones), so such an issue can never have useful data here and
 * scanning it is pure waste. Deliberately NOT `task.state !== null`: `state`
 * is already `null` for BOTH zero-labels AND two-or-more-labels (board
 * drift, `board/api.ts`'s `toBoardTask`) — a drifted task carrying two state
 * labels IS a real fleet task needing reconciliation and must stay a
 * candidate. Only zero state labels excludes.
 *
 * `budget`, when given (the webhook's own push flow — see
 * `AutoCloseSetup.budget`, computed once in `webhook.ts`'s `prepareAutoClose`
 * and shared across Path 1, this scan, and the close loop that follows both),
 * is checked before each candidate. Exceeding it stops the scan where it is
 * — never mid-task — and reports via `console.error`, once, naming this
 * repo and how far the scan got; never thrown. A caller with no budget
 * (task-reap.ts's poll-triggered scan, which has no HTTP response deadline
 * to protect) is unaffected — `budgetExceeded(undefined)` is always false.
 */
export async function openTasksWithLatestPr(
  api: BoardApi, repo: string, tasks: BoardTaskView[], budget?: TimeBudget,
): Promise<OpenTaskPr[]> {
  // Board issue #180: the "does this still need a look" filter runs FIRST,
  // then the bound applies to actual candidates — a task already closed AND
  // completed costs nothing (no `showTask` call at all) and so does not
  // count against OPEN_TASKS_SCAN_MAX_CANDIDATES.
  const candidates = tasks.filter(
    (task) => (task.open || task.state !== "completed") && taskStates(task.labels).length > 0,
  );
  const scanned = candidates.length > OPEN_TASKS_SCAN_MAX_CANDIDATES
    ? candidates.slice(0, OPEN_TASKS_SCAN_MAX_CANDIDATES)
    : candidates;
  if (scanned.length < candidates.length) {
    console.error(
      `pr-landed: ${repo} has ${candidates.length} candidate tasks, more than the ` +
      `${OPEN_TASKS_SCAN_MAX_CANDIDATES}-candidate bound covers — scanned only the first ` +
      `${scanned.length} (newest-first)`,
    );
  }

  const out: OpenTaskPr[] = [];
  for (let i = 0; i < scanned.length; i++) {
    if (budgetExceeded(budget)) {
      console.error(
        `pr-landed: ${AUTO_CLOSE_BUDGET_MS / 1000}s budget exceeded for ${repo}, Path 2: processed ` +
        `${i}/${scanned.length} candidates`,
      );
      break;
    }
    const task = scanned[i];
    let prNumber: number | null = null;
    try {
      const shown = await showTask(api, repo, task.number);
      if (shown.ok) {
        const envelope = findLatestResultEnvelope(shown.value.comments);
        if (envelope) {
          for (const art of envelope.payload.artifacts) {
            if (art.pr === undefined) continue;
            const num = Number.parseInt(art.pr.replace(/^#/, ""), 10);
            if (Number.isInteger(num) && num > 0) {
              prNumber = num;
              break;
            }
          }
        }
      } else {
        console.error(`pr-landed: reading task #${task.number} in ${repo} failed (${shown.status}): ${shown.message}`);
      }
    } catch (err) {
      console.error(`pr-landed: reading task #${task.number} in ${repo} threw`, err);
    }
    out.push({ taskNumber: task.number, prNumber });
  }
  return out;
}
