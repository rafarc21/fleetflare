// The sprint policy layer: the three verbs the fleet does to a sprint — open,
// status, close — and the rules each one refuses to break. Pure over one port
// (BoardApi), exactly like board.ts's own policy functions: no Env, no binding,
// no fetch; the routes layer (src/board/routes.ts) holds only the wiring, and
// nothing in this file touches a token.
//
// A sprint IS a GitHub milestone (§5), so these functions translate between the
// operator's words ("open a sprint titled X, owned by Y, toward Z") and
// GitHub's milestone+issue writes. The rules that matter are the refusals:
//   - open refuses a duplicate title (a typo that quietly forked a second
//     sprint milestone would split one board in two);
//   - close refuses while any task is still in flight or links an open PR, so
//     a sprint can only be closed by moving work somewhere it will not be lost,
//     never by dropping it.

import { parseMilestoneGoal, parseMilestoneOwner, renderMilestoneDescription } from "./milestone";
import { resolveOrCreateBacklogMilestone, showTask, type BoardApi, type BoardResult } from "./board";
import { latestResultPr, taskStates, type BoardTask, type BoardTaskState } from "./types";

/** One open sprint as `fleet sprint status` reads it. `total` is the milestone's
 *  counted tasks minus canceled: a task counts while open, or closed but still
 *  carrying a board state label — a canceled task is a decision, not work still
 *  owed, and a closed issue with no state label is repo history, not sprint work. */
export interface SprintSummary {
  title: string;
  owner: string | null;
  goal: string;
  completed: number;
  total: number;
}

/** Sprint title -> milestone number over the full milestone list (state=all),
 *  case-insensitive — a sprint being closed is still listed. An unknown title
 *  is a 404 and never an implicit create, same ruling board.ts's own
 *  resolveMilestone documents: opening a sprint is a deliberate act. */
async function resolveMilestoneByTitle(api: BoardApi, repo: string, title: string): Promise<BoardResult<number>> {
  const milestones = await api.listMilestones(repo);
  const found = milestones.find((m) => m.title.toLowerCase() === title.toLowerCase());
  if (!found) return { ok: false, status: 404, message: `no milestone titled "${title}"` };
  return { ok: true, value: found.number };
}

/** A task worth counting: open, or closed but still carrying a board state
 *  label (terminal states close the issue, but the board label outlives it).
 *  A CLOSED issue with NO state label is repo history, not sprint work — it
 *  must not inflate the sprint's denominator. A closed task carrying TWO state
 *  labels is drift, kept counted and visible rather than silently dropped
 *  (same posture listTasks takes: filtering it out would hide the thing that
 *  needs fixing). */
function countsTowardsSprint(t: BoardTask): boolean {
  return t.open || taskStates(t.labels).length > 0;
}

/** The states that mean "work is still genuinely in flight" — a task in one of
 *  these must not be swept into the backlog or dropped by a sprint close. */
const IN_FLIGHT_STATES: readonly BoardTaskState[] = ["working", "input_required", "awaiting_merge"];

/**
 * `fleet sprint open` — creates the sprint milestone, refusing a blank title,
 * owner or goal, and refusing a duplicate title (case-insensitive) so a typo
 * cannot fork a second sprint under a near-identical name.
 */
export async function openSprint(
  api: BoardApi, repo: string, input: { title: string; owner: string; goal: string },
): Promise<BoardResult<{ number: number; title: string }>> {
  const title = input.title.trim();
  if (title === "") return { ok: false, status: 400, message: "sprint needs a title" };
  const owner = input.owner.trim();
  if (owner === "") return { ok: false, status: 400, message: "sprint open needs --maestro <name>" };
  const goal = input.goal.trim();
  if (goal === "") return { ok: false, status: 400, message: 'sprint open needs --goal "<outcome>"' };

  const milestones = await api.listMilestones(repo);
  if (milestones.some((m) => m.title.toLowerCase() === title.toLowerCase())) {
    return { ok: false, status: 409, message: `a sprint titled "${title}" already exists` };
  }
  const created = await api.createMilestone(repo, {
    title,
    description: renderMilestoneDescription({ owner, goal }),
  });
  return { ok: true, value: { number: created.number, title: created.title } };
}

/**
 * `fleet sprint status` — every open sprint with its owner, goal and
 * completed/total task counts. A task counts toward `total` only while it is
 * OPEN, or closed but still carrying a board state label; a CLOSED issue with
 * no state label is repo history, not sprint work, and is excluded from the
 * denominator (see countsTowardsSprint). Canceled tasks are excluded from
 * `total` either way — a canceled task is a decision, not work still owed. A
 * `title` narrows to the one open milestone matching it, case-insensitively,
 * 404 when none does.
 */
export async function sprintSummaries(
  api: BoardApi, repo: string, title: string | null,
): Promise<BoardResult<SprintSummary[]>> {
  let milestones = await api.listOpenMilestones(repo);
  if (title !== null) {
    const found = milestones.find((m) => m.title.toLowerCase() === title.toLowerCase());
    if (!found) return { ok: false, status: 404, message: `no open sprint titled "${title}"` };
    milestones = [found];
  }
  const summaries: SprintSummary[] = [];
  for (const m of milestones) {
    const tasks = await api.listIssues(repo, { milestone: m.number });
    summaries.push({
      title: m.title,
      owner: parseMilestoneOwner(m.description),
      goal: parseMilestoneGoal(m.description),
      completed: tasks.filter((t) => countsTowardsSprint(t) && t.state === "completed").length,
      total: tasks.filter((t) => countsTowardsSprint(t) && t.state !== "canceled").length,
    });
  }
  return { ok: true, value: summaries };
}

/**
 * `fleet sprint close` — closes the sprint milestone, refusing (before any
 * write) a sprint that still has work in flight or that links an open PR.
 * Completed tasks close with reason "completed"; every other task moves to the
 * backlog milestone, created if it does not exist yet. The two refusals are
 * the whole point: a sprint close must never silently drop work.
 */
export async function closeSprint(
  api: BoardApi, repo: string, title: string,
): Promise<BoardResult<{ movedToBacklog: number[]; closed: number[] }>> {
  const sprint = await resolveMilestoneByTitle(api, repo, title);
  if (!sprint.ok) return sprint;
  const sprintNumber = sprint.value;
  const tasks = await api.listIssues(repo, { milestone: sprintNumber });

  // GATE 1: nothing still in flight may be swept or dropped.
  const inFlight = tasks.filter((t) => t.state !== null && IN_FLIGHT_STATES.includes(t.state));
  if (inFlight.length > 0) {
    return {
      ok: false, status: 409,
      message: `sprint "${title}" has tasks still in flight: ` +
        inFlight.map((t) => `#${t.number} ${t.state}`).join(", "),
    };
  }

  // GATE 2: a task whose newest result envelope names an OPEN PR still has
  // unmerged work — the one channel the fleet itself writes is the §6
  // envelope's pr artifact, read per task via showTask. Scanned over the
  // sprint's OWN tasks, not the shared 300-candidate scan: a sprint has no
  // task cap (its scope is set by a human at planning), so bounding this
  // gate by anything but the sprint itself would silently skip a PR check.
  // Both reads fail CLOSED with a named 502 — an unreadable PR is not "no PR".
  const openPrs: { task: BoardTask; pr: number }[] = [];
  for (const t of tasks) {
    let prNumber: number | null;
    try {
      const shown = await showTask(api, repo, t.number);
      if (!shown.ok) {
        return {
          ok: false, status: 502,
          message: `sprint "${title}" close cannot verify task #${t.number}'s PR — its comments could not be read`,
        };
      }
      prNumber = latestResultPr(shown.value.comments);
    } catch {
      return {
        ok: false, status: 502,
        message: `sprint "${title}" close cannot verify task #${t.number}'s PR — its comments could not be read`,
      };
    }
    if (prNumber === null) continue;
    let pr: { merged: boolean; open: boolean };
    try {
      pr = await api.getPullRequest(repo, prNumber);
    } catch {
      return {
        ok: false, status: 502,
        message: `sprint "${title}" close cannot read PR #${prNumber} (linked by task #${t.number})`,
      };
    }
    if (!pr.merged && pr.open) openPrs.push({ task: t, pr: prNumber });
  }
  if (openPrs.length > 0) {
    return {
      ok: false, status: 409,
      message: `sprint "${title}" has open PRs: ` +
        openPrs.map((l) => `task #${l.task.number} links PR #${l.pr}`).join(", "),
    };
  }

  // GATE 3: an empty sprint just closes — nothing to move.
  if (tasks.length === 0) {
    await api.closeMilestone(repo, sprintNumber);
    return { ok: true, value: { movedToBacklog: [], closed: [] } };
  }

  const backlog = await resolveOrCreateBacklogMilestone(api, repo);
  if (!backlog.ok) return backlog;
  const movedToBacklog: number[] = [];
  const closed: number[] = [];
  for (const t of tasks) {
    if (t.state === "completed") {
      await api.closeIssue(repo, t.number, "completed");
      closed.push(t.number);
    } else if (t.state === "canceled" || !t.open) {
      // finished or already closed — never moved, never closed here
    } else {
      await api.setIssueMilestone(repo, t.number, backlog.value);
      movedToBacklog.push(t.number);
    }
  }
  await api.closeMilestone(repo, sprintNumber);
  return { ok: true, value: { movedToBacklog, closed } };
}