// Board issue #8: the ONE shared "which open tasks claim a PR in their
// latest envelope" scan, written once and walked from three directions:
//   - src/github/promote-close.ts (push-triggered, run inside ctx.waitUntil):
//     a push just landed; check whether any open task's claimed PR shows up
//     in THAT push's own commit list.
//   - src/studio/task-reap.ts (poll-triggered, no push exists): the SAME
//     question, answered by asking GitHub directly whether the claimed PR's
//     merge commit is now an ancestor of the default branch.
//   - src/board/open-prs.ts (#332's studio-scoped read, synchronous route
//     handler, one bounded scan per studio per request, NOT inside
//     ctx.waitUntil): which of one studio's assigned tasks' envelopes name
//     a PR, asked for that studio's unmerged-PR answer only.
// No caller re-implements the envelope scan itself — only HOW "landed" (or
// "unmerged") is decided differs, and that decision lives entirely in each
// caller.
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
 * The math: three callers now share this ONE scan — github/webhook.ts's
 * deferred envelope cross-check (Path 2, inside `ctx.waitUntil`), studio/
 * task-reap.ts's reap route (via `board/routes.ts`'s `listOpenTasks`), and
 * (#332) open-prs.ts's studio-scoped read — so bounding it here bounds all
 * three for free. The two waitUntil/reap callers run it ONCE per
 * invocation; open-prs.ts runs it once PER STUDIO inside one synchronous
 * route request, and the cross-studio total is that route's own concern,
 * documented beside its Promise.all (board/routes.ts). §5's busiest repo
 * measured 2026-09-24: ~41 candidates today; issue #180 projects ~186 once
 * #163's `listIssues` pagination fix keeps a wider net visible. At 300
 * candidates * 2 subrequests (showTask: getIssue + listComments) = 600,
 * plus listTasks' own BOARD_MAX_PAGES (20) page-fetches, a single scan
 * stays comfortably under Cloudflare's 1000-subrequests-per-invocation cap
 * even past today's projection — and where wall-clock matters (the
 * synchronous route, not the deferred paths) the per-studio scans run
 * concurrently, which changes only wall-clock, never the count.
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
 *  omission. `readFailed` (#416 item 3-tail) says which side of the
 *  distinction a `prNumber: null` came from: `true` is "this task's
 *  comments could not be read at all" (a thrown showTask or its own
 *  `{ok:false}`), `false` is "read fine, the envelope names no PR". The two
 *  original callers ignore it — promote-close and task-reap degrade per
 *  task and `null` is their degrade answer either way; open-prs.ts reads
 *  it to fail its whole scan (a false zero to --strict-unmerged), which is
 *  why it cannot be re-derived there from `prNumber === null` alone. */
export interface OpenTaskPr {
  taskNumber: number;
  prNumber: number | null;
  readFailed: boolean;
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
    let readFailed = false;
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
        readFailed = true;
      }
    } catch (err) {
      console.error(`pr-landed: reading task #${task.number} in ${repo} threw`, err);
      readFailed = true;
    }
    out.push({ taskNumber: task.number, prNumber, readFailed });
  }
  return out;
}
