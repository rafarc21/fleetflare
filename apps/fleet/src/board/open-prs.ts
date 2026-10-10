// Board issue #332: the ONE scan that answers "which of this studio's PRs are
// sitting UNMERGED right now" — the data behind the park/destroy warning.
//
// Why this scan must exist at all: `awaiting_merge` is not a live board state
// (board #110 — the lead's part is done, so destroy/reap's open-task gate
// correctly has nothing left to protect), which means `destroy --park` sails
// through while the studio's PRs still wait on a human merge. That is
// deliberately fine for routine work, but a bounced security-adjacent PR
// needs the lane ALIVE — one lane was parked 5x in a day while its PR kept
// bouncing, and nothing anywhere said so. This module fills that gap: it
// names the PRs, and the route/CLI built on it (plan step 2+) turns that into
// a non-blocking warning the operator reads in the same breath as the
// destroy's own output.
//
// Why the attribution chain is studio -> assigned tasks -> newest result
// envelope's pr artifact -> live PR state, and nothing else: every studio
// pushes under ONE shared git identity, so a PR's author and head-ref name
// nothing about WHOSE lane owns it — there is no branch naming convention,
// and PR author attribution is structurally useless here. The board's own
// chain already exists and is fleet-native: the studio's `studio:` label
// names the tasks, each task's newest §6 result envelope names the PR it
// shipped (findLatestResultEnvelope — the same "the current truth lives in
// the newest result envelope, not the last comment" rule board task #119
// established), and getPullRequest names that PR's live state. pr-landed.ts
// walks the same chain for a different question ("which open tasks claim a
// PR in the latest push"); this is its sibling walking the studio-scoped
// half.
//
// Pure over the same BoardApi port everything else in this directory is — no
// Env, no binding, so every rule below is provable without a live issue.

import { listTasks, showTask, type BoardApi, type BoardResult } from "./board";
import { findLatestResultEnvelope } from "./verify";
import { taskStates, type BoardTaskView } from "./types";

/** One unmerged PR this studio still has a live interest in — the exact
 *  record the warning prints: which task shipped it, which PR it is, its
 *  title, and the URL an operator taps from a phone. */
export interface OpenPr {
  taskNumber: number;
  prNumber: number;
  title: string;
  url: string;
}

/**
 * Every unmerged, still-open PR named by one of `studioId`'s assigned tasks'
 * newest result envelopes.
 *
 * Which tasks are scanned — pr-landed.ts's own candidate rule, verbatim,
 * because the two questions share the same failure mode (a GitHub native
 * closing keyword flips `open` the instant a PR merges, before any board
 * write lands, so `task.open` alone would drop the exact task whose PR state
 * is most interesting):
 *
 *   - `task.open || task.state !== "completed"` — a task GitHub already
 *     closed AND the board already called completed is done work: skipped
 *     without a single per-task GitHub read (no showTask, no
 *     getPullRequest). Everything else still has a live interest in its PR,
 *     including the two shapes that matter most for this warning:
 *       - OPEN issue, `completed` board label — the aftermath of an
 *         awaiting_merge task whose verifier ran before the merge landed;
 *       - OPEN issue, terminal-but-not-completed — re-openable work.
 *   - `taskStates(task.labels).length > 0` — board #198's exclusion: an
 *     issue with ZERO state labels is never a fleet task (an ordinary repo
 *     issue the assignedTo label filter cannot have skipped), so scanning it
 *     is pure waste. Deliberately NOT `state !== null`: a drifted task
 *     carrying two state labels IS a real fleet task and stays scanned.
 *
 * Degrades per task, never per scan — the posture pr-landed.ts already
 * takes: a thrown showTask/getPullRequest or a `{ok:false}` showTask logs
 * via console.error and contributes nothing for THAT task alone. The
 * alternative — failing the whole scan on one bad task — would report the
 * OTHERS' unmerged PRs as absent on a 5xx, which is exactly the false
 * "nothing to warn about" shape this module exists to prevent; the honest
 * contract is one bad task contributes nothing AND the rest of the scan
 * still answers for the tasks it could read. Only the studio-wide board
 * listing itself is scan-fatal: a `{ok:false}` listTasks is returned AS-IS
 * (status and message verbatim, never collapsed into "zero PRs" — an
 * unreadable board must not read as a clean board, the same fail-closed
 * rule board.ts's openAssignedTasks documents for destroy's gate), and a
 * THROWN listIssues propagates to the caller rather than being swallowed.
 */
export async function studioOpenPrs(
  api: BoardApi, repo: string, studioId: string,
): Promise<BoardResult<OpenPr[]>> {
  const listed = await listTasks(api, repo, { assignedTo: studioId });
  if (!listed.ok) return listed;

  // The candidate filter BEFORE any per-task read, for the same cost reason
  // pr-landed.ts states: a task already closed AND completed on the board
  // costs this scan nothing at all — not even a showTask.
  const candidates = listed.value.filter(
    (task: BoardTaskView) => (task.open || task.state !== "completed") && taskStates(task.labels).length > 0,
  );

  const prs: OpenPr[] = [];
  for (const task of candidates) {
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
        console.error(`open-prs: reading task #${task.number} in ${repo} failed (${shown.status}): ${shown.message}`);
      }
    } catch (err) {
      console.error(`open-prs: reading task #${task.number} in ${repo} threw`, err);
    }
    if (prNumber === null) continue;

    try {
      const pr = await api.getPullRequest(repo, prNumber);
      // Merged is the one state that needs no warning — the work landed.
      // Closed-unmerged is the one that must NEVER warn: it can never merge,
      // so a PR closed without merging is a decision already made, and
      // warning about it would nag on every destroy forever. Only an OPEN,
      // unmerged PR is "still waiting on a human" — the exact thing the
      // warning is about.
      if (!pr.merged && pr.open) {
        prs.push({
          taskNumber: task.number,
          prNumber,
          title: pr.title,
          url: `https://github.com/${repo}/pull/${prNumber}`,
        });
      }
    } catch (err) {
      console.error(`open-prs: reading PR #${prNumber} for task #${task.number} in ${repo} threw`, err);
    }
  }
  return { ok: true, value: prs };
}
