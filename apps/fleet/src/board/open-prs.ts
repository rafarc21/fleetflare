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
// owns that chain for a different question ("which open tasks claim a PR in
// the latest push"); this module calls its ONE shared scan
// (openTasksWithLatestPr) for the studio-scoped half, so the candidate
// filter, per-task degrade posture, and the 300-candidate bound stay
// identical by construction.
//
// Pure over the same BoardApi port everything else in this directory is — no
// Env, no binding, so every rule below is provable without a live issue.

import { listTasks, type BoardApi, type BoardResult } from "./board";
import { openTasksWithLatestPr } from "./pr-landed";

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
 * Which tasks are scanned — the filter, bound, and degrade posture are
 * pr-landed.ts's own (see openTasksWithLatestPr), shared so the two scans
 * can never drift.
 *
 * Degrades per task, never per scan — the posture pr-landed.ts already
 * takes for showTask/listTasks (openTasksWithLatestPr owns that posture and
 * it is unchanged): a thrown showTask or a `{ok:false}` showTask logs
 * via console.error and contributes nothing for THAT task alone. The
 * alternative — failing the whole scan on one bad task — would report the
 * OTHERS' unmerged PRs as absent on a 5xx, which is exactly the false
 * "nothing to warn about" shape this module exists to prevent; the honest
 * contract is one bad task contributes nothing AND the rest of the scan
 * still answers for the tasks it could read.
 *
 * #332 review H2 (operator-ordered): a thrown getPullRequest FAILS THE
 * WHOLE SCAN ({ok:false}) — PR-state unreadable is never a dropped PR. A
 * PR whose live state cannot be read means this module cannot answer the
 * question it exists for, and a dropped PR would report a false zero to
 * --strict-unmerged. The scan-fatal set: the studio-wide board listing (a
 * `{ok:false}` listTasks is returned AS-IS, status and message verbatim,
 * never collapsed into "zero PRs" — an unreadable board must not read as a
 * clean board, the same fail-closed rule board.ts's openAssignedTasks
 * documents for destroy's gate), a THROWN listIssues (propagates to the
 * caller rather than being swallowed), and now an unreadable PR state.
 */
export async function studioOpenPrs(
  api: BoardApi, repo: string, studioId: string,
): Promise<BoardResult<OpenPr[]>> {
  const listed = await listTasks(api, repo, { assignedTo: studioId });
  if (!listed.ok) return listed;

  // The ONE shared envelope scan (pr-landed.ts's openTasksWithLatestPr) walks
  // the candidates — the same filter, the same per-task degrade posture, and
  // the same OPEN_TASKS_SCAN_MAX_CANDIDATES bound its other two callers
  // (promote-close, task-reap) already live under; this module reuses all of
  // it rather than re-implementing the plumbing (#332 review: pr-landed's own
  // header says neither caller re-implements the scan, and a third walk would
  // drift — the two "live PR interest" scans must agree forever).
  const tasksWithPr = await openTasksWithLatestPr(api, repo, listed.value);
  const prs: OpenPr[] = [];
  for (const { taskNumber, prNumber } of tasksWithPr) {
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
          taskNumber,
          prNumber,
          title: pr.title,
          url: `https://github.com/${repo}/pull/${prNumber}`,
        });
      }
    } catch (err) {
      // #332 review H2: a PR whose live state cannot be read means this
      // module cannot answer the question it exists for — dropping it
      // would report a false zero to --strict-unmerged. The whole scan
      // reads as failed (the route's `unknown`), never as clean.
      console.error(`open-prs: reading PR #${prNumber} for task #${taskNumber} in ${repo} threw`, err);
      return { ok: false, status: 502, message: `reading PR #${prNumber} for task #${taskNumber} in ${repo} failed` };
    }
  }
  return { ok: true, value: prs };
}
