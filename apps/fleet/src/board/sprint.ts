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

import { BACKLOG_MILESTONE_TITLE, parseMilestoneOwner, renderMilestoneDescription } from "./milestone";
import type { BoardApi, BoardResult } from "./board";
import type { BoardTask, BoardTaskState } from "./types";

/** One open sprint as `fleet sprint status` reads it. `total` is the milestone's
 *  tasks minus canceled — a canceled task is a decision, not work still owed. */
export interface SprintSummary {
  title: string;
  owner: string | null;
  goal: string;
  completed: number;
  total: number;
}

/** The goal line a sprint's milestone description carries, or "" when absent —
 *  the sibling of milestone.ts's parseMilestoneOwner. */
function parseMilestoneGoal(description: string): string {
  const match = description.match(/^Goal: (.+)$/m);
  return match === null ? "" : match[1].trim();
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

/** The backlog milestone's number, created once on first use — the ONE
 *  implicit milestone the board owns. A thrown listMilestones/createMilestone
 *  error propagates; the route's try/catch handles it. */
async function resolveOrCreateBacklogMilestone(api: BoardApi, repo: string): Promise<BoardResult<number>> {
  const milestones = await api.listMilestones(repo);
  const found = milestones.find((m) => m.title.toLowerCase() === BACKLOG_MILESTONE_TITLE.toLowerCase());
  if (found) return { ok: true, value: found.number };
  const created = await api.createMilestone(repo, {
    title: BACKLOG_MILESTONE_TITLE,
    description: "Backlog: tasks awaiting a sprint.",
  });
  return { ok: true, value: created.number };
}

/** The states that mean "work is still genuinely in flight" — a task in one of
 *  these must not be swept into the backlog or dropped by a sprint close. */
const IN_FLIGHT_STATES: readonly BoardTaskState[] = ["working", "input_required", "awaiting_merge"];

/** The open PR number a task links by mentioning `#N` (or `refs #N`) in its
 *  title or body, or null. `(?!\d)` keeps `#45` from matching `#450`. */
function taskLinksOpenPr(task: BoardTask, openPrs: { number: number }[]): number | null {
  const text = `${task.title}\n${task.body}`;
  for (const pr of openPrs) {
    if (new RegExp(`#${pr.number}(?!\\d)`).test(text)) return pr.number;
  }
  return null;
}

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
 * completed/total task counts. `total` counts every task except canceled; a
 * drifted task (state null) still counts, because it is in the milestone and
 * not canceled. A `title` narrows to the one open milestone matching it,
 * case-insensitively, 404 when none does.
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
      completed: tasks.filter((t) => t.state === "completed").length,
      total: tasks.filter((t) => t.state !== "canceled").length,
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

  // GATE 2: a task that links an open PR still has unmerged work — refusing
  // keeps the PR's merge (and its auto-close) from landing on a closed sprint.
  const openPrs = await api.listOpenPullFiles(repo);
  const linked: { task: BoardTask; pr: number }[] = [];
  for (const t of tasks) {
    const pr = taskLinksOpenPr(t, openPrs);
    if (pr !== null) linked.push({ task: t, pr });
  }
  if (linked.length > 0) {
    return {
      ok: false, status: 409,
      message: `sprint "${title}" has open PRs: ` +
        linked.map((l) => `task #${l.task.number} links PR #${l.pr}`).join(", "),
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
    } else {
      await api.setIssueMilestone(repo, t.number, backlog.value);
      movedToBacklog.push(t.number);
    }
  }
  await api.closeMilestone(repo, sprintNumber);
  return { ok: true, value: { movedToBacklog, closed } };
}