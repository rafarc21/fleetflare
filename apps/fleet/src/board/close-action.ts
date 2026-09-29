// Board issue #8: the ONE idempotent write both triggers share — a push to
// the default branch (src/github/webhook.ts) and `fleet task reap --apply`
// (src/studio/task-reap.ts) both call this, and neither reimplements any
// part of it. GitHub's open/closed and this fleet's board `state` label are
// separate things by design (board.ts's own header: "Deploy truth is
// measured from branch + host, NEVER from a label"). This function does
// BOTH writes on purpose: that is the whole point of auto-close-on-promote.
// Since issue #55 the terminal transition does the close; this function
// closes directly only when no transition can run.

import type { Env } from "../env";
import { transitionTask, type BoardApi } from "./board";
import { appendEvent } from "../events/log";
import { makeEvent } from "../events/schema";
import type { CloseOutcome } from "./close-outcome";

export type { CloseOutcome } from "./close-outcome";

export interface CloseEvidence {
  /** The commit that proves this task's work landed on the default branch —
   *  the promotion PR's squash commit, a regular merge commit, or one of a
   *  PR's own original commits, whichever resolveIssuesForPushCommits /
   *  resolveIssuesFromEnvelopeArtifacts / task-reap.ts's landed-check found
   *  it through. */
  sha: string;
  /** The default branch it landed on — never assumed, always the caller's
   *  own getDefaultBranch result. */
  branch: string;
}

export interface CloseOnPromoteResult {
  ok: true;
  /** Still `ok: true` for every outcome above — a repeat delivery or a
   *  genuinely-already-closed issue is not a failure. */
  outcome: CloseOutcome;
}

/**
 * Idempotent given the SAME (repo, issueNumber, evidence.sha) triple.
 *
 * 1. Dedup CHECK, first, before any write: a plain read against the events
 *    table's PRIMARY KEY (`gh_close_${repo}_${issueNumber}_${sha}`) — a
 *    read, not the `appendEvent` insert itself, on purpose (see point 5
 *    below for why the insert is deferred to last). A hit means THIS
 *    evidence was already processed, but — board issue #157 hold review —
 *    that does NOT prove GitHub's own issue ever actually closed: production
 *    already carries a dedup record for #98 written by the old buggy build
 *    that let the marker get written unconditionally regardless of whether
 *    the completed+open backfill (point 3) ever ran. So a dedup hit now
 *    checks the real GitHub state and backfills the close ONLY when needed
 *    — `task.open === true` on an already-`completed` task calls
 *    `api.closeIssue` and returns `closed`; anything else is a true no-op —
 *    writing NO new marker (one already exists) and doing NO comment or CAS
 *    transition (unlike point 3's own completed+open case, this path never
 *    had a first-time board write to skip in the first place; skip it here
 *    too, for the same reason: an unrelated dedup key must not re-open the
 *    comment thread). A thrown `closeIssue` here propagates uncaught, same
 *    as everywhere else in this function — this branch never writes a
 *    marker at all, so there's nothing for a throw to leave stale.
 * 2. `PATCH .../issues/{n} {state:"closed"}` (issue #55: via the terminal
 *    transition in point 4, directly only when that cannot run) — idempotent on GitHub's own
 *    side (closing an already-closed issue is a harmless 200), so this
 *    still runs even when the board's own state already reads `completed`
 *    for THIS evidence (a first look at this exact sha) — skipped only in
 *    the already-completed case covered by point 3.
 * 3. If the board already reads `completed` (checked here via the SAME
 *    `api.getIssue` read the CAS transition needs anyway — fetched once,
 *    used for both), no CAS transition and no comment either way — a
 *    distinct sha discovered LATER for a task some earlier call already
 *    finished (a `reap` re-scan finding old evidence, or a second PR that
 *    also references the same issue) must not re-spam the "closed by..."
 *    comment thread just because the dedup key (which includes the sha) is
 *    different. But GitHub's own open/closed is a SEPARATE fact from the
 *    board label (see this file's header) — board issue #157 (task #98):
 *    `completed` on the board reached that state without the GitHub issue
 *    itself ever closing, and stayed open forever, because this branch used
 *    to be an unconditional no-op. So this now checks `task.open`: `false`
 *    means GitHub is already closed too, a true no-op (`already-closed`,
 *    no GitHub call at all); `true` calls `api.closeIssue` ONLY — no
 *    `transitionTask` (nothing to CAS, the board is already `completed`)
 *    and no `createComment` (unchanged dedup key, no re-post) — reported as
 *    `closed`. (This is the FRESH-evidence twin of point 1's dedup-hit
 *    backfill — same completed+open check and the same closeIssue-only
 *    response, reached from a different guard for a task seeing this sha
 *    for the first time rather than a repeat.)
 * 4. Otherwise: board CAS to `completed`, via the EXISTING `transitionTask`
 *    exactly as it already works — pass the state just read as `from`. A
 *    task carrying no single state label (board drift) has no safe `from`
 *    to CAS against at all: logged, GitHub issue still closes, board state
 *    is left exactly as found for a human to repair rather than guessed at.
 *    Then one comment, in caveman-compressed house style: "closed by
 *    <sha>, promoted to <branch>". (Portuguese until the #66 follow-up;
 *    dedup never read the comment text, so tasks closed under the old
 *    wording get no second comment.)
 * 5. The dedup marker is written LAST, only once every real write above has
 *    genuinely succeeded — never first. Writing it first (the original
 *    shape of this function) meant a thrown `closeIssue`/`transitionTask`/
 *    `createComment` left the marker permanently committed with no writer
 *    of the real work having ever completed: every later call for the SAME
 *    evidence (a webhook redelivery, or a repeat `reap` run) would then hit
 *    the dedup guard and report a silent, successful no-op FOREVER, even
 *    though the issue may never have actually closed. Moving it to last
 *    narrows the dedup race to true concurrency within one execution window
 *    (acceptable — redeliveries and reap runs are not sub-millisecond
 *    concurrent here) instead of "any transient failure poisons the
 *    evidence permanently". A throw from any real write above now correctly
 *    propagates OUT of this function uncaught — no marker was written, so
 *    nothing was falsely marked done, and the caller sees the real failure.
 */
export async function closeTaskOnPromote(
  env: Env, api: BoardApi, repo: string, issueNumber: number, evidence: CloseEvidence, now: number = Date.now(),
): Promise<CloseOnPromoteResult> {
  const eventId = `gh_close_${repo}_${issueNumber}_${evidence.sha}`;
  const already = await env.DB.prepare(`SELECT 1 FROM events WHERE id = ?`).bind(eventId).first();
  if (already) {
    // This evidence was already processed -- but a dedup record existing
    // does NOT prove GitHub's own issue ever closed (see this function's
    // header, point 1: production carries exactly this stale record for
    // #98). Check the real fact and backfill the close ONLY -- no new
    // marker (one already exists), no comment, no CAS transition.
    const task = await api.getIssue(repo, issueNumber);
    if (task.state === "completed" && task.open === true) {
      await api.closeIssue(repo, issueNumber);
      return { ok: true, outcome: "closed" };
    }
    return { ok: true, outcome: "no-op" };
  }

  const task = await api.getIssue(repo, issueNumber);
  let outcome: CloseOutcome;

  if (task.state === "completed") {
    // Already done on the board — this evidence is late (a different sha
    // for a task some earlier call already finished). No CAS transition,
    // no comment, either way. But board issue #157 (#98): the board reading
    // `completed` does NOT mean GitHub's own issue ever closed — check the
    // real fact and backfill the close, without touching the board again.
    if (task.open === false) {
      outcome = "already-closed";
    } else {
      await api.closeIssue(repo, issueNumber);
      outcome = "closed";
    }
  } else {
    // Issue #55: a transition to completed closes the issue itself, so the
    // close goes through it -- exactly one PATCH, never depending on a
    // re-read seeing the close. Closed directly only where no transition
    // can run (no single state label) or it refused.
    if (task.state === null) {
      await api.closeIssue(repo, issueNumber);
      console.error(
        `close-action: task #${issueNumber} in ${repo} carries no single board state label ` +
        `(labels: ${task.labels.join(", ") || "none"}) — issue closed on GitHub, board state left as drift`,
      );
    } else {
      const result = await transitionTask(api, repo, issueNumber, { from: task.state, to: "completed" });
      if (!result.ok) {
        console.error(
          `close-action: transitioning #${issueNumber} in ${repo} to completed failed ` +
          `(${result.status}): ${result.message}`,
        );
        await api.closeIssue(repo, issueNumber);
      }
    }

    await api.createComment(repo, issueNumber, `closed by ${evidence.sha.slice(0, 8)}, promoted to ${evidence.branch}`);
    outcome = "closed";
  }

  const marker = makeEvent(
    {
      from: "worker", to: "board", kind: "task", project: repo,
      body: `close #${issueNumber} @ ${evidence.sha} -> ${evidence.branch}`,
    },
    now, crypto.randomUUID().slice(0, 8),
  );
  marker.id = eventId;
  await appendEvent(env.DB, marker);
  return { ok: true, outcome };
}
