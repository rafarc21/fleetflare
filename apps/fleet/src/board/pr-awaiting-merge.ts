// Board issue #1071, item 1: a PR that names a board task (`refs #N`) flips
// that task working -> awaiting_merge once the PR is ready for review. The
// lead's part is done when its PR is up. Maestros flipped this by hand, and 2
// of 4 lanes sat at "working" with a PR open.
//
// Board issue #1077, item 1: a sub-PR routinely names umbrella tasks too, so
// several refs can be working at once. Then the PR's head branch picks the one
// task whose lead just finished (`task-1049-…` names #1049), and a branch that
// names none or two of them flips none.
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
 * the repo (lowercased, the board's own casing), the refs named in the PR's
 * title and body, and the head branch name (the tie-break when several refs are
 * working). `null` when the delivery is not "ready for review" or names no task,
 * so the caller does nothing at all. `head` is "" when the payload carries none.
 */
export function flipRequestFromPullRequest(
  payload: {
    action?: unknown; repository?: { full_name?: unknown };
    pull_request?: { draft?: unknown; title?: unknown; body?: unknown; head?: { ref?: unknown } };
  },
): { repo: string; refs: number[]; head: string } | null {
  const pr = payload.pull_request;
  if (typeof payload.action !== "string" || !pr) return null;
  if (!prAwaitsMerge(payload.action, pr.draft === true)) return null;
  const full = payload.repository?.full_name;
  if (typeof full !== "string") return null;
  const refs = refsInBody(`${typeof pr.title === "string" ? pr.title : ""}\n${typeof pr.body === "string" ? pr.body : ""}`);
  if (refs.length === 0) return null;
  const head = typeof pr.head?.ref === "string" ? pr.head.ref : "";
  return { repo: full.toLowerCase(), refs, head };
}

/** The task numbers a branch name carries as whole tokens. `task-1049-x` names
 *  #1049; `task-10491-x` does not, because a digit run is one token. */
function branchNumbers(headRef: string): Set<number> {
  return new Set(headRef.split(/[^A-Za-z0-9]+/).filter((t) => /^\d+$/.test(t)).map(Number));
}

/**
 * The one task a PR may flip, from the working candidates it names. Exactly one
 * candidate is the answer. Several: keep those the head branch names as a token;
 * exactly one of those is the answer. Anything else (none, or the branch names
 * two or none) is no answer, so nothing flips.
 */
function flipTarget(candidates: number[], headRef: string): number | null {
  if (candidates.length === 1) return candidates[0]!;
  const named = branchNumbers(headRef);
  const matched = candidates.filter((n) => named.has(n));
  return matched.length === 1 ? matched[0]! : null;
}

/**
 * Flip at most one referenced task that is working, open, and held by exactly
 * one studio to awaiting_merge. Every other task is left alone: a task not
 * working (submitted, input_required, already awaiting_merge), unassigned,
 * closed, or drifted (two state labels) has no lead whose part this PR just
 * finished. When several refs qualify, `headRef` picks the one (flipTarget); a
 * pick that is still ambiguous flips nothing and is logged.
 *
 * TOTAL: a board read or write failure is logged and flips nothing. The caller
 * has already answered the webhook with a 200.
 *
 * Returns the task numbers it flipped (empty or one).
 */
export async function markAwaitingMerge(api: BoardApi, repo: string, refs: number[], headRef = ""): Promise<number[]> {
  const candidates: number[] = [];
  for (const number of refs) {
    try {
      const task = await api.getIssue(repo, number);
      if (!task.open) continue;
      const states = taskStates(task.labels);
      if (states.length !== 1 || states[0] !== "working") continue;
      if (taskAssignees(task.labels).length !== 1) continue;
      candidates.push(number);
    } catch (err) {
      console.error(`board: awaiting_merge read of #${number} in ${repo} threw`, err);
    }
  }

  const number = flipTarget(candidates, headRef);
  if (number === null) {
    if (candidates.length > 1) {
      console.error(
        `board: awaiting_merge flip in ${repo} skipped — ${candidates.map((n) => `#${n}`).join(", ")} are all working ` +
        `and branch "${headRef}" does not name exactly one of them`,
      );
    }
    return [];
  }

  try {
    const moved = await transitionTask(api, repo, number, { from: "working", to: "awaiting_merge" });
    if (moved.ok) return [number];
    console.error(`board: awaiting_merge flip on #${number} in ${repo} refused — ${moved.message}`);
  } catch (err) {
    console.error(`board: awaiting_merge flip on #${number} in ${repo} threw`, err);
  }
  return [];
}
