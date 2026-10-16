// Board issue #1071, item 1: a PR that names a board task (`refs #N`) flips
// that task working -> awaiting_merge once the PR is ready for review. The
// lead's part is done when its PR is up. Maestros flipped this by hand, and 2
// of 4 lanes sat at "working" with a PR open.
//
// Worker-side, called from the pull_request webhook (src/github/webhook.ts).
// The write goes through transitionTask (board.ts), the one writer of task
// state, so its compare-and-swap and single-label rule still hold. Pure over
// the BoardApi port, so every rule is proven with no webhook and no token.

import type { BoardApi } from "./board";
import { transitionTask } from "./board";
import { taskAssignees, taskStates } from "./types";

/**
 * Every task number a PR names with `refs #N`, unique, in first-seen order.
 * `refs` is the one reference form board PRs carry: a closing keyword
 * (`closes`, `fixes`) would close the task on merge, which the board never
 * wants from a PR, so this reader ignores those words on purpose.
 */
export function refsInBody(body: string): number[] {
  const seen = new Set<number>();
  for (const m of body.matchAll(/\brefs #(\d+)\b/gi)) seen.add(Number(m[1]));
  return [...seen];
}

/** True when a pull_request delivery means "this PR is ready for review": opened
 *  ready, or a draft marked ready. A draft opened, a push, an edit or a close
 *  is not that moment. */
export function prAwaitsMerge(action: string, draft: boolean): boolean {
  return action === "ready_for_review" || (action === "opened" && !draft);
}

/**
 * What the pull_request webhook should flip, read from one delivery's payload:
 * the repo (lowercased, the board's own casing) and the refs named in the PR's
 * title and body. `null` when the delivery is not "ready for review" or names
 * no task, so the caller does nothing at all.
 */
export function flipRequestFromPullRequest(
  payload: { action?: unknown; repository?: { full_name?: unknown }; pull_request?: { draft?: unknown; title?: unknown; body?: unknown } },
): { repo: string; refs: number[] } | null {
  const pr = payload.pull_request;
  if (typeof payload.action !== "string" || !pr) return null;
  if (!prAwaitsMerge(payload.action, pr.draft === true)) return null;
  const full = payload.repository?.full_name;
  if (typeof full !== "string") return null;
  const refs = refsInBody(`${typeof pr.title === "string" ? pr.title : ""}\n${typeof pr.body === "string" ? pr.body : ""}`);
  if (refs.length === 0) return null;
  return { repo: full.toLowerCase(), refs };
}

/**
 * Flip each referenced task that is working, open, and held by exactly one
 * studio to awaiting_merge. Every other task is left alone: a task not working
 * (submitted, input_required, already awaiting_merge), unassigned, closed, or
 * drifted (two state labels) has no lead whose part this PR just finished.
 *
 * TOTAL per ref: a board read or write failure on one task is logged and the
 * rest still flip. The caller has already answered the webhook with a 200.
 *
 * Returns the task numbers it flipped.
 */
export async function markAwaitingMerge(api: BoardApi, repo: string, refs: number[]): Promise<number[]> {
  const flipped: number[] = [];
  for (const number of refs) {
    try {
      const task = await api.getIssue(repo, number);
      if (!task.open) continue;
      const states = taskStates(task.labels);
      if (states.length !== 1 || states[0] !== "working") continue;
      if (taskAssignees(task.labels).length !== 1) continue;
      const moved = await transitionTask(api, repo, number, { from: "working", to: "awaiting_merge" });
      if (moved.ok) flipped.push(number);
      else console.error(`board: awaiting_merge flip on #${number} in ${repo} refused — ${moved.message}`);
    } catch (err) {
      console.error(`board: awaiting_merge flip on #${number} in ${repo} threw`, err);
    }
  }
  return flipped;
}
