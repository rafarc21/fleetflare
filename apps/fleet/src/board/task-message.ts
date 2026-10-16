// Board issue #1071, item 4: `fleet task message <n> "<text>"` posts a board
// comment on task n AND wakes the task's studio lead with the text. It replaces
// terminal sends, which were unreliable. Pure over the BoardApi port and the
// wake port, the same two ports the assign and comment wakes already take.

import type { BoardApi, BoardResult } from "./board";
import type { AssignWakeDeps, AssignWakeReport } from "./assign-wake";
import { oneLine, COMMENT_EXCERPT } from "../github/wake-events";
import { wakeStudioFor } from "./wake-gate";
import { taskAssignees, taskStates } from "./types";
import { MESSAGE_COMMENT_MARKER } from "./comment-wake";
import { GitHubError } from "./api";

export { MESSAGE_COMMENT_MARKER } from "./comment-wake";

/** Longest message a studio may send. Long enough for a real note, short
 *  enough that a runaway paste cannot flood a board comment. */
export const MESSAGE_MAX_CHARS = 4000;

/** States a message may not reach: the work is finished, so a wake would
 *  announce nothing the lead still owes. An awaiting_merge task IS reachable,
 *  because a review note on an open PR is an explicit ask. */
const TERMINAL_STATES = ["completed", "failed", "canceled"] as const;

/** The board comment a message leaves behind. The marker line keeps the
 *  comment-wake path from waking the lead a second time. */
export function taskMessageComment(senderId: string, text: string): string {
  return `${MESSAGE_COMMENT_MARKER}\n**Message from \`${senderId}\`**\n\n${text}`;
}

/**
 * The wake prompt: a pointer, with the text inline. One line, always: a newline
 * typed into the claude TUI submits the turn. The full text sits in the comment,
 * so the lead reads the whole message with the command this line names.
 */
export function taskMessageDigest(task: { number: number; title: string }, text: string): string {
  return `WAKE TASK MESSAGE #${task.number} "${oneLine(task.title)}" | ${oneLine(text).slice(0, COMMENT_EXCERPT)} | read: fleet task show ${task.number}`;
}

/**
 * Post the message as a comment, then wake the task's one studio lead with it.
 *
 * Order: the comment lands first, so the record exists even when the wake is
 * refused (a stopped lead). A refused wake is reported in `wake.reason`, never
 * dropped silently.
 *
 * Refusals, all before any write: missing or oversized text (400); a closed or
 * terminal task (409); a task without exactly one studio assignee (409).
 */
export async function sendTaskMessage(
  api: BoardApi, deps: AssignWakeDeps, repo: string, number: number, raw: unknown, senderId: string,
): Promise<BoardResult<{ comment: { id: number; url: string }; wake: AssignWakeReport }>> {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text === "") {
    return { ok: false, status: 400, message: 'a message needs "text" — the words the lead should read' };
  }
  if (text.length > MESSAGE_MAX_CHARS) {
    return { ok: false, status: 400, message: `"text" is over ${MESSAGE_MAX_CHARS} characters` };
  }

  let task;
  try {
    task = await api.getIssue(repo, number);
  } catch (err) {
    // Board issue #1106: an unknown number answers in words that name the task,
    // not GitHub's bare "Not Found".
    if (err instanceof GitHubError && err.status === 404) {
      return { ok: false, status: 404, message: `task #${number} not found in ${repo} — nothing to message` };
    }
    throw err;
  }
  if (!task.open) {
    return { ok: false, status: 409, message: `task #${number} is closed — nothing to message` };
  }
  const states = taskStates(task.labels);
  if (states.length === 1 && (TERMINAL_STATES as readonly string[]).includes(states[0])) {
    return { ok: false, status: 409, message: `task #${number} is ${states[0]} — finished work takes no message` };
  }
  const assignees = taskAssignees(task.labels);
  if (assignees.length !== 1) {
    return {
      ok: false, status: 409,
      message: `task #${number} has ${assignees.length} studio assignees — a message needs exactly one lead to wake`,
    };
  }

  const comment = await api.createComment(repo, number, taskMessageComment(senderId, text));
  const wake = await wakeStudioFor(deps, assignees[0], {
    repo,
    digest: taskMessageDigest({ number, title: task.title }, text),
    refuse: {
      unregistered: `${assignees[0]} is not in the fleet registry — the message on task #${number} is posted but nothing was woken.`,
      stopped: `${assignees[0]} is stopped — the message on task #${number} is posted, but no wake was sent, ` +
        "because starting its container costs money silently.",
      repoMismatch: (repoSlug) => `${assignees[0]} is provisioned for ${repoSlug}, not ${repo} — the message on task ` +
        `#${number} is posted, but a lead for another repo cannot see it.`,
    },
  });
  return { ok: true, value: { comment, wake } };
}
