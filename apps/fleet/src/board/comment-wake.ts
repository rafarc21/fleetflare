// Board issue #236: the edge from "a qualifying comment landed on a task" to
// "wake the task's OWN assignee" -- distinct from, and additional to, the
// maestro's generic supervision wake (src/github/wake-events.ts's
// `deltaDigest`, fired by src/github/webhook.ts's `wakeMaestro`).
//
// Same root-cause family as board #158/#213: the board can change while a
// studio holds no open turn, and nothing hands it one. #159 fixed the
// same-studio-reassignment instance; #229 (merged) fixes the
// stopped-at-filing-time instance; this file fixes the "a comment landed on
// an already-assigned, already-live task" instance. See
// docs/superpowers/specs/2026-09-25-comment-triggers-wake-design.md for the
// full design, including why this deliberately does NOT reuse
// `wakeOnAssign`/`assignDigest` (a comment digest needs the comment's own
// URL, which an assignment digest has no notion of) and does NOT add any
// persisted "already woken for this task" dedup marker (each qualifying
// comment is genuinely new information, unlike #159/#229's "the same,
// unchanged information delivered twice").
//
// Pure over one port (`AssignWakeDeps`, reused by TYPE ONLY from
// src/board/assign-wake.ts -- no runtime import, no coupling to that
// module's own gating code), exactly the discipline that module already
// keeps: no Env, no binding, every rule here proven with no Durable Object,
// no D1 row and no container.

import type { AssignWakeDeps, AssignWakeReport } from "./assign-wake";
import { parseEnvelopeComment } from "./envelope";
import type { TaskState } from "./types";
// The one flatten fold, imported rather than re-typed -- see assign-wake.ts's
// own `assignDigest`, which flattens a task title the identical way for the
// identical reason (issue #159 already exports this from wake-events.ts).
// `sameRepoSlug` (issue #268's own canonical-nameWithOwner match, generalized
// for a bare repo-slug compare) is the SAME repo check assign-wake.ts's own
// `wakeOnAssign` uses -- issue #284 round 2 adds it here too, see
// `wakeOnComment`'s own doc comment for why a comment trigger needs it now
// when it deliberately did not before.
import { oneLine, sameRepoSlug } from "../github/wake-events";

/**
 * The explicit wake request a comment can carry regardless of the task's own
 * board state. Checked against the comment's FIRST LINE only, and only that
 * line -- a marker buried mid-comment is easy to miss on a real read and
 * just as easy to spoof by quoting somebody else's comment back verbatim.
 *
 * Exact match (`/wake` alone) or the literal string followed by a space
 * (`/wake <anything>`) both count; `/wakeup` or `/wakeless` deliberately do
 * not, since a plain prefix match would treat any word that happens to start
 * the same six characters as a request nobody typed.
 */
const WAKE_MARKER = "/wake";

/** True when this comment's first line is the explicit wake marker.
 *  See `WAKE_MARKER`'s own doc comment for the exact matching rule. */
export function hasWakeMarker(body: string): boolean {
  const firstLine = (body.split(/\r?\n/)[0] ?? "").trim();
  return firstLine === WAKE_MARKER || firstLine.startsWith(`${WAKE_MARKER} `);
}

/**
 * #363 review round 2: the first line of every completion-record comment
 * (do.ts's doneRecordComment -- FLEET_OPS_REPO unset keeps the record on its
 * board task). Paperwork, never an answer: on a token-auth repo its author
 * is a human login, so the [bot] filter alone would let it wake an
 * input_required studio.
 */
export const DONE_RECORD_COMMENT_MARKER = "<!-- fleet:done-record -->";

/** True when this comment is a completion record. ABSOLUTE, like an envelope. */
export function isDoneRecordComment(body: string): boolean {
  return (body.split(/\r?\n/)[0] ?? "").trim() === DONE_RECORD_COMMENT_MARKER;
}

/**
 * True only for a real §6 structured envelope (src/board/envelope.ts) --
 * the exact shape a studio's own result/status comment takes, and a shape a
 * human typing an unblock in plain English will not produce by accident.
 * ABSOLUTE: nothing (not even an explicit `/wake` marker) overrides this --
 * a studio's own result-posting comment must never wake itself, the same
 * self-sustaining-loop failure mode `wake-events.ts`'s `WAVE_LOG_TITLE`
 * exclusion already exists to prevent for the maestro's own wave log.
 */
export function isEnvelopeComment(body: string): boolean {
  return parseEnvelopeComment(body) !== null;
}

/**
 * True when the comment author's login ends in `[bot]` -- defense in depth,
 * reusing this codebase's own established convention (webhook.ts's
 * push-path handling of `sender.login`/`pusher.name`, and wake-events.ts's
 * `deltaDigest` reading `comment.user.login`) of trusting the
 * GitHub-populated actor field, since GitHub derives it from the
 * authenticated credential rather than from anything the comment body
 * claims.
 *
 * Unlike `isEnvelopeComment`, this is NOT absolute: fix round 2 (board
 * issue #236's own review) found that on APP-auth repos the cloud maestro
 * itself posts as the operator's own GitHub App bot login (e.g. `<slug>[bot]`), and an explicit `/wake` from that
 * account must still wake (see `qualifiesForCommentWake` below for where
 * that precedence is decided) -- this predicate only says "machine-shaped
 * login", not "always excluded".
 */
export function isBotComment(authorLogin: string | undefined): boolean {
  return typeof authorLogin === "string" && authorLogin.endsWith("[bot]");
}

/**
 * The trigger rule, exactly per the issue's own spec, in PRECEDENCE order:
 *
 *   1. A real §6 envelope (`isEnvelopeComment`) always excludes -- absolute,
 *      never overridden by anything below, including an explicit marker.
 *   2. An explicit `/wake` marker (`hasWakeMarker`) always qualifies,
 *      REGARDLESS of the comment author -- including a `[bot]` login. Fix
 *      round 2: on APP-auth repos the cloud maestro posts as
 *      the operator's own GitHub App bot login (e.g. `<slug>[bot]`), and an operator/maestro comment that
 *      explicitly asks for a wake must get one even though the `[bot]`
 *      check below would otherwise refuse it. This also means a marker
 *      wakes for ANY task state, not only a "live" one -- a completed task
 *      might still get a legitimate late comment worth surfacing, and
 *      nothing about an explicit request depends on the board's current
 *      state label.
 *   3. Only once neither of the above applies: the `[bot]` filter, then
 *      `taskState === "input_required"` (that state exists specifically to
 *      say "waiting on an answer", so a PLAIN comment with no marker still
 *      qualifies there -- but only from a non-bot author). `taskState` is
 *      `null` for a task whose label set is ambiguous (zero or more than
 *      one state label) or unknown -- treated the same as "not
 *      input_required", never upgraded into an unmarked wake just because
 *      the state could not be read cleanly.
 */
export function qualifiesForCommentWake(
  taskState: TaskState | null, commentBody: string, authorLogin: string | undefined,
): boolean {
  if (isEnvelopeComment(commentBody)) return false;
  if (isDoneRecordComment(commentBody)) return false;
  if (hasWakeMarker(commentBody)) return true;
  if (isBotComment(authorLogin)) return false;
  return taskState === "input_required";
}

/**
 * The wake prompt: a pointer at the task AND the comment, never a copy of
 * either. Same one-line posture `assignDigest` (src/board/assign-wake.ts)
 * already documents and for the identical reason: a literal newline typed
 * into the claude TUI is a SUBMIT, so a multi-line digest would arrive as
 * several half-prompts.
 *
 * Round 3 (review verdict: HOLD on MUST 1): the read-pointer APPENDS onto
 * the comment-URL digest, it does not replace the URL with the pointer --
 * issue #236's own spec is explicit that the wake must name "the task and
 * the comment URL". Both parts earn their place, for two different reasons:
 *
 *   - The comment's own `html_url` says WHICH comment is new -- useful when
 *     several land close together (see the two-in-a-row test in
 *     test/github.webhook.test.ts's #236 describe block).
 *   - The trailing `read: fleet task show N` pointer covers the lead reading
 *     the WHOLE thread, which matters specifically because a burst wake can
 *     be refused, not queued: `runGatedWake`'s single-flight lock (see the
 *     design doc's corrected single-flight section) means a later comment in
 *     a fast burst can have its OWN wake dropped, so its content might only
 *     ever be visible by reading the thread, not from any single digest.
 */
export function commentDigest(
  task: { number: number; title: string }, commentUrl: string,
): string {
  const title = oneLine(task.title);
  return `WAKE TASK COMMENT #${task.number} "${title}" | ${commentUrl} | read: fleet task show ${task.number}`;
}

/**
 * Wake the task's own assignee over a qualifying comment.
 *
 * Mirrors `wakeOnAssign`'s gating shape exactly (ask the registry for the
 * assignee's recorded state before touching a Durable Object; refuse a
 * `stopped` or unregistered studio; call through to the same
 * `AssignWakeDeps.wake` port, which the caller wires to
 * `wakeStudioOnAssignment` -- the RPC that runs `runGatedWake`'s
 * stopped/pane/single-flight gates without arming the maestro's own
 * supervision sweep) -- deliberately NOT by calling `wakeOnAssign` itself,
 * since that function's digest has no notion of a comment URL. See this
 * file's header for why this is an intentional near-duplication of a small
 * gating body rather than a refactor of already-reviewed code.
 *
 * Issue #284 round 2: `task.repo` -- the comment's OWN repo, straight off the
 * webhook payload GitHub already sent (`p.repository.full_name` in
 * `github/webhook.ts`'s `wakeTaskOnComment`) -- is now checked against the
 * studio's own recorded `repoSlug`, the same refusal `wakeOnAssign` already
 * makes at assignment time. This closes a gap that check never covered: a
 * stale, hand-edited, or otherwise legacy cross-repo `studio:` label on an
 * issue carries an assignee this function would otherwise wake blind, on
 * every qualifying comment, indefinitely -- assignment time is not the only
 * time a mismatch can exist. Same compare, same reason wording, same
 * fail-open on `repoSlug: null` -- see `wakeOnAssign`'s own doc comment for
 * why null fails open, and `github/wake-events.ts`'s `sameRepoSlug` for why
 * the compare itself is a canonical-name match (issue #268) rather than a
 * naive lowercase one.
 *
 * TOTAL on every path: a failed registry read, a stopped studio, a repo
 * mismatch, or a thrown RPC all come back as a `reason`, never a thrown
 * exception -- the caller (the webhook handler) has already committed to a
 * 200 by the time this runs.
 */
export async function wakeOnComment(
  deps: AssignWakeDeps, studioId: string, task: { number: number; title: string; repo: string }, commentUrl: string,
): Promise<AssignWakeReport> {
  let studio: { state: string; repoSlug: string | null } | null;
  try {
    studio = await deps.studioState(studioId);
  } catch (err) {
    return { woke: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (studio === null) {
    return {
      woke: false,
      reason: `${studioId} is not in the fleet registry — nothing to wake for the comment on task #${task.number}.`,
    };
  }
  if (studio.state === "stopped") {
    return {
      woke: false,
      reason: `${studioId} is stopped — no wake was sent for the comment on task #${task.number}, ` +
        "because starting its container costs money silently.",
    };
  }
  if (studio.repoSlug !== null) {
    const match = await sameRepoSlug(studio.repoSlug, task.repo, deps.resolveCanonicalRepo);
    // Issue #295 bug 2: "unknown" (a canonical lookup failed, no confirmed
    // match either way) refuses the wake exactly like "different" — this is
    // the wake-gate, which fails closed always. Only the write-gate
    // (assign-wake.ts's `checkAssignRepo`) fails open on "unknown".
    if (match !== "same") {
      const suffix = match === "unknown" ? " (canonical-name lookup failed — refusing the wake to be safe)" : "";
      return {
        woke: false,
        reason: `${studioId} is provisioned for ${studio.repoSlug}, not ${task.repo} — a comment on a task from a ` +
          `different repo would wake a lead that cannot see it. This task's assignee looks stale or hand-edited.${suffix}`,
      };
    }
  }

  const digest = commentDigest(task, commentUrl);
  let outcome;
  try {
    outcome = await deps.wake(studioId, digest);
  } catch (err) {
    return { woke: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!outcome.ok) return { woke: false, reason: outcome.error ?? "wake failed for an unstated reason" };
  return { woke: true, digest };
}
