// The board's policy layer: the four things the fleet does to a task, and the
// rules each one refuses to break. Pure over one port (BoardApi) for the same
// reason src/studio/repo.ts and src/studio/spawn.ts are — everything worth
// asserting on is here, routes.ts holds only the wiring, and nothing in this
// file imports `Env` or touches a binding.
//
// The rule the whole file exists to enforce: THE WORKER IS THE SINGLE WRITER
// OF TASK STATE. Agents never label, close or reopen an issue. That is not a
// convention this code trusts — transitionTask below refuses any transition
// whose starting point it cannot recognise as its own last write. Concretely
// a compare-and-swap: the caller states the state it believes the task is in,
// and a disagreement is a REFUSAL, never an overwrite. A hand-labelled issue,
// a half-applied transition, an agent that reached for the label anyway — all
// three surface as a 409 naming what was actually found, instead of being
// silently flattened into whatever the last writer wanted.
//
// The failure this prevents has already been paid for once (websites fleet):
// a merged PR whose issue still claimed "in progress". Which is also why
// nothing here infers deploy truth from a label — that is measured from
// branch + host, never from the board.

import { parseBrief, renderBriefPrompt, renderTaskBody, taskKeyMarker, type TaskBrief } from "./brief";
import { parseEnvelope, parseEnvelopeComment, renderEnvelopeComment } from "./envelope";
import {
  isStaleBacklog, isTaskState, studioLabel, taskAssignees, taskStates, TASK_STATES, TERMINAL_TASK_STATES, LIVE_TASK_STATES,
  JUNIOR_LABEL, SECURITY_LABEL,
  type BoardTask, type BoardTaskView, type EnvelopeDoc, type TaskState, type CloseReason,
} from "./types";
import { GitHubError, type BoardComment, type IssueInput, type ListIssuesQuery } from "./api";
import { extractPaths, findPathOverlaps, formatPathOverlapWarnings } from "./path-overlap";
import { parseRepoSlug } from "../studio/repo";
// Type-only, and from reach.ts not auth.ts — same reason src/studio/repo.ts
// does: this module touches no Env and no binding. See github/reach.ts.
import type { RepoReach } from "../github/reach";
import { parseStudioId } from "../studio/ids";

/**
 * Everything this module can do to GitHub, as one injectable port. The real
 * implementation is src/board/api.ts bound to a freshly minted installation
 * token (see routes.ts's boardApi); tests pass a fake, so every rule above is
 * proven without a live issue.
 */
export interface BoardApi {
  createIssue: (repo: string, input: IssueInput) => Promise<BoardTask>;
  getIssue: (repo: string, number: number) => Promise<BoardTask>;
  listIssues: (repo: string, query: ListIssuesQuery) => Promise<BoardTask[]>;
  addLabels: (repo: string, number: number, labels: string[]) => Promise<void>;
  removeLabel: (repo: string, number: number, label: string) => Promise<void>;
  createComment: (repo: string, number: number, body: string) => Promise<{ id: number; url: string }>;
  pullRequestExists: (repo: string, number: number) => Promise<boolean>;
  listComments: (repo: string, number: number) => Promise<BoardComment[]>;
  listMilestones: (repo: string) => Promise<{ number: number; title: string }[]>;
  // Task #119: the same existence-check shape as pullRequestExists above,
  // for the other two ref kinds a §6 verification step can name. See
  // src/board/verify.ts's attemptVerification, the one caller of all three.
  branchExists: (repo: string, branch: string) => Promise<boolean>;
  commitExists: (repo: string, sha: string) => Promise<boolean>;
  // Board issue #8: the one write auto-close-on-promote needs that no prior
  // board write covers — every issue helper before this was read/label/
  // comment only. See src/board/close-action.ts, the one caller.
  closeIssue: (repo: string, number: number, reason?: CloseReason) => Promise<void>;
  // Board issue #112 / #70 ask 8: every open PR's changed files, for the
  // path-claim overlap check. See pathClaimWarnings below, the one caller.
  listOpenPullFiles: (repo: string) => Promise<{ number: number; files: string[] }[]>;
  // Board issue #332: one PR's live state — merged, open-or-closed, title —
  // for the park/destroy unmerged-PR warning (src/board/open-prs.ts, the one
  // caller). Narrowed from github/api.ts's PullRequestInfo: this port only
  // needs what the warning prints.
  getPullRequest: (repo: string, number: number) => Promise<{ number: number; merged: boolean; open: boolean; title: string }>;
}

/** Same shape src/studio/repo.ts's WorkRepoResult uses: a status and a
 *  message the route hands straight to the caller, so HTTP semantics are
 *  decided HERE (where the rule is) and not in the wiring. */
export type BoardResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

/** The one entry state. §5: a task is born submitted; every later state is a
 *  transition this Worker wrote. */
const ENTRY_STATE: TaskState = "submitted";

/**
 * Board issue #41, half one, and board issue #158: the hook that fires on
 * every assigning call this Worker answers — a studio label actually
 * written, a task filed carrying one, AND a re-assignment to the studio that
 * already owns the task. Only the label/state/lineage-comment WRITES are
 * skipped for that last, no-op case (`assignTask` below's early return) —
 * the wake itself is not, because board #158 measured exactly this shape
 * twice: a coordinator re-pointing a task at the studio that already has it,
 * on purpose, to nudge an idle lead, and getting a success-shaped response
 * that woke nobody. `src/board/routes.ts` hangs the wake edge off this one
 * hook either way, so a caller here never has to know which case it is.
 *
 * Every call is wrapped in a try/catch by its caller below: the GitHub writes
 * (when there are any) have already landed by the time it runs, and a waker
 * that threw must never turn a successful assignment into a failed request.
 *
 * `why` (board issue #158's own spec, missed by this issue's first pass): the
 * operator's `--why` text, passed ONLY on the no-op/same-studio branch of
 * `assignTask` below. A real move never passes it — that path already writes
 * `why` into the lineage comment, so threading it here too would be
 * redundant. `createTask` never passes it either: creation has no concept of
 * a "why" for an assignment that has not happened yet.
 */
export type OnAssigned = (studioId: string, task: BoardTask, why?: string | null) => Promise<void>;

/**
 * Issue #249 (maestro spec point 5): the one port createTask/assignTask need
 * to enforce "security-class work never routed to `lead: glm`" — a studio's
 * own recorded `StudioStatus.leadType`, resolved by whatever registry read
 * routes.ts wires (never a request field: a caller must not be able to
 * claim a studio's lead type any more than it can claim its repo). Optional
 * on both callers, same "absence = skip the check" shape every other
 * injectable port on this file's own `BoardApi`-adjacent surface uses for a
 * feature a caller predates — every existing test/call site that omits it
 * keeps compiling and behaving exactly as before #249.
 */
export type GetLeadType = (studioId: string) => Promise<"claude" | "glm" | undefined>;

/**
 * Issue #249 (maestro spec point 5): true exactly when a task labelled
 * SECURITY_LABEL would land on a `leadType: "glm"` studio — the one
 * condition createTask/assignTask both refuse on, before any write. Pure,
 * so the rule itself (not the plumbing around it) is directly testable.
 */
function securityRefusesGlmLead(labels: string[], leadType: "claude" | "glm" | undefined): boolean {
  return leadType === "glm" && labels.includes(SECURITY_LABEL);
}

/** The shared refusal message both createTask and assignTask answer with —
 *  one wording, so an operator sees the identical sentence whichever path
 *  tripped it. */
function securityGlmRefusalMessage(studioId: string): string {
  return `task is labelled "${SECURITY_LABEL}" — cannot assign to ${studioId}, a lead:glm studio never runs security-class work`;
}

/**
 * Maestro review round 1 MINOR (#249, #255): createTask/assignTask above
 * both refuse `SECURITY_LABEL` going IN, at creation or (re)assignment time
 * — but neither one is watching for the label arriving AFTER a task is
 * already live-assigned to a glm-lead studio (the GitHub UI, a hand-run `gh
 * issue edit --add-label security`, anything other than this Worker's own
 * write). Without this, that studio stays silently owned by work it should
 * never have been handed.
 *
 * Meant to be called in reaction to exactly that event — webhook.ts's own
 * issues-event handler wires it off the same `labeled` trigger
 * junior/authz.ts's revokeJuniorOnIssueEvent already answers for issue #35
 * (see that file's header for the shape this follows: "revoking only, never
 * granting"). A fresh `api.getIssue` read, not whatever label list the
 * caller's own webhook payload happened to carry: this function behaves
 * identically reached from a live delivery or any other caller that only
 * knows the task number, the same defensive posture assignTask's own
 * `api.getIssue` call already takes.
 *
 * Unassigns every CURRENT owner whose leadType resolves to "glm" (removes
 * their studio label, and resets backlog state the same way a real
 * reassignment does when nothing else claims the task) and posts one
 * comment naming why. Once revoked here, nothing brings the assignment back
 * on its own — a later unlabel or relabel is not a grant, same rule
 * junior/authz.ts's own revoke enforces; a human has to reassign the task,
 * through assignTask, which already refuses to hand a security task BACK to
 * a glm-lead studio.
 */
export async function revokeGlmLeadOnSecurityLabel(
  api: BoardApi, repo: string, number: number, getLeadType: GetLeadType,
): Promise<{ revoked: string[] }> {
  const task = await api.getIssue(repo, number);
  if (!task.labels.includes(SECURITY_LABEL)) return { revoked: [] };
  const owners = taskAssignees(task.labels);
  const revoked: string[] = [];
  for (const owner of owners) {
    if ((await getLeadType(owner)) === "glm") revoked.push(owner);
  }
  if (revoked.length === 0) return { revoked: [] };

  for (const owner of revoked) await api.removeLabel(repo, number, studioLabel(owner));
  const state = taskStates(task.labels)[0] ?? null;
  if (state !== null && state !== ENTRY_STATE) {
    await api.removeLabel(repo, number, state);
    await api.addLabels(repo, number, [ENTRY_STATE]);
  }
  await api.createComment(
    repo, number,
    `board: unassigned ${revoked.join(", ")} — the \`${SECURITY_LABEL}\` label was added after assignment; ` +
      "a lead:glm studio never runs security-class work, so this revokes the assignment rather than leaving it in place.",
  );
  return { revoked };
}

/** Board issue #41, half one. Never lets a hook failure escape into the
 *  assign path — see `OnAssigned`. */
async function fireOnAssigned(
  hook: OnAssigned | undefined, studioId: string, task: BoardTask, why?: string | null,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(studioId, task, why);
  } catch (err) {
    console.error(`board: assignment hook for ${studioId} on #${task.number} threw`, err);
  }
}

/**
 * Sprint title -> milestone number, since GitHub's issue API takes the number
 * and a human (or an agent reading a sprint brief) only ever knows the title.
 *
 * An unknown title is a 404 and NOT an implicit create: opening a sprint is a
 * deliberate act with a meeting attached to it (§7's sprint diamond), and a
 * typo that quietly forks a second sprint milestone would split one board in
 * two with nothing visible to say so. Case-insensitive, because the title is
 * typed by hand on both sides.
 */
async function resolveMilestone(api: BoardApi, repo: string, title: string): Promise<BoardResult<number>> {
  const milestones = await api.listMilestones(repo);
  const found = milestones.find((m) => m.title.toLowerCase() === title.toLowerCase());
  if (!found) {
    const known = milestones.map((m) => `"${m.title}"`).join(", ") || "(none)";
    return {
      ok: false, status: 404,
      message: `no milestone titled "${title}" in ${repo} — sprints on this board: ${known}. ` +
        "Open the sprint first; the board never creates one implicitly.",
    };
  }
  return { ok: true, value: found.number };
}

/**
 * Board issue #112 / #70 ask 8: does this brief's own path-looking text
 * overlap a path something else already claims — an open PR's changed
 * files, or another open task's own brief? Never refuses; only warns —
 * the issue's own title says so ("warn on path overlap").
 *
 * `extractPaths` over the brief's own free-text fields first, and an empty
 * result returns `[]` immediately, before either GitHub read: most briefs
 * describe BEHAVIOR, not files, and this keeps ordinary task creation just
 * as cheap as it is today for that overwhelmingly common case.
 *
 * Tasks are filtered to LIVE ones (LIVE_TASK_STATES) other than `selfNumber`
 * — a task's own just-created issue would otherwise "overlap" itself, and a
 * terminal (completed/failed/canceled) task is not a live claim on anything.
 *
 * The whole body is wrapped in try/catch and FAILS OPEN: any throw is logged
 * and swallowed to `[]`. Same posture `fireOnAssigned` above documents for
 * the assign-wake hook — a GitHub read going down must never refuse a task
 * that otherwise validated, and this is a WARN, so an unreachable warning
 * mechanism is strictly better silent than blocking.
 */
async function pathClaimWarnings(
  api: BoardApi, repo: string, brief: TaskBrief, selfNumber: number,
): Promise<string[]> {
  const briefPaths = extractPaths([brief.title, brief.objective, brief.outputFormat, brief.boundaries].join("\n"));
  if (briefPaths.length === 0) return [];
  try {
    const [prClaims, tasks] = await Promise.all([api.listOpenPullFiles(repo), api.listIssues(repo, {})]);
    const taskClaims = tasks
      .filter((t) => t.number !== selfNumber && t.state !== null && LIVE_TASK_STATES.includes(t.state))
      .map((t) => ({ number: t.number, paths: extractPaths(t.body) }));
    return formatPathOverlapWarnings(findPathOverlaps(briefPaths, prClaims, taskClaims));
  } catch (err) {
    console.error(`board: path-claim overlap check failed for ${repo}`, err);
    return [];
  }
}

/**
 * One task = one deliverable of substantial scope (§5), opened `submitted`.
 *
 * The six state labels do not have to exist in the repo first: GitHub creates
 * a missing label when an issue is created with it (verified live against
 * acme-org/websites, 2026-08-25), which is why there is no ensure-labels
 * step here. A new board repo therefore works on its first task.
 */
export async function createTask(
  api: BoardApi, repo: string, raw: unknown, onAssigned?: OnAssigned, getLeadType?: GetLeadType,
): Promise<BoardResult<BoardTask & { pathWarnings?: string[] }>> {
  const lineage = await resolveContinues(api, repo, raw);
  if (!lineage.ok) return lineage;
  raw = lineage.value;
  const parsed = parseBrief(raw);
  if (!parsed.ok) return { ok: false, status: 400, message: parsed.message };
  const brief = parsed.brief;

  // Both labels written in ONE create call, not a create followed by an
  // add: an issue that exists for a moment carrying a state but no owner is
  // a window in which `listStudioTasks` would not return it to the studio
  // being spawned for it, and `ff` spawns immediately after filing.
  const labels = brief.assignee === null ? [ENTRY_STATE] : [ENTRY_STATE, studioLabel(brief.assignee)];
  if (brief.junior === true) labels.push(JUNIOR_LABEL);
  if (brief.security === true) labels.push(SECURITY_LABEL);
  // Issue #249 (maestro spec point 5): refused BEFORE any write — a
  // security-labelled task filed straight onto a glm-lead studio, at
  // creation, never gets as far as `api.createIssue`. `getLeadType`
  // absent (every caller that predates this feature) skips the check
  // entirely, same posture every other optional port here takes.
  if (brief.assignee !== null && getLeadType) {
    const leadType = await getLeadType(brief.assignee);
    if (securityRefusesGlmLead(labels, leadType)) {
      return { ok: false, status: 400, message: securityGlmRefusalMessage(brief.assignee) };
    }
  }
  const input: IssueInput = {
    title: brief.title,
    body: renderTaskBody(brief),
    labels,
  };
  if (brief.milestone !== null) {
    const milestone = await resolveMilestone(api, repo, brief.milestone);
    if (!milestone.ok) return milestone;
    input.milestone = milestone.value;
  }
  // Issue #139: a key means "this may be a retry". Look first — a create that
  // landed upstream but whose response was lost is already on the board.
  const key = brief.idempotencyKey;
  let created = key === undefined ? null : await findByKey(api, repo, key);
  if (created === null) {
    try {
      created = await api.createIssue(repo, input);
    } catch (err) {
      // GitHub may have written the issue and still answered 520/timeout.
      // Look once more before reporting failure; nothing found, rethrow and
      // the caller's retry (same key) looks again.
      const landed = key === undefined ? null : await findByKey(api, repo, key);
      if (landed === null) throw err;
      created = landed;
    }
  }
  // A replay fires the hook too: the lost-response path above never reached
  // it, and a studio that was assigned work and never woken is issue #41.
  // Board issue #41: `fleet task new --studio` is an assignment too. The
  // studio label went on in the create call above, so a lead that is up has a
  // task it will otherwise never hear about.
  if (brief.assignee !== null) await fireOnAssigned(onAssigned, brief.assignee, created);
  const warnings = await pathClaimWarnings(api, repo, brief, created.number);
  return { ok: true, value: warnings.length > 0 ? { ...created, pathWarnings: warnings } : created };
}

/** Issue #139: the task an earlier attempt with this key already filed, or
 *  null. `listIssues` paginates (issue #148) but still returns GitHub's
 *  default newest-first order overall — a retry follows its lost create by
 *  seconds, so it is near the front regardless of how many pages that takes.
 *  Two matches (a race between concurrent retries) resolve to the OLDEST, the
 *  last in that order: the first filed is the task. */
async function findByKey(api: BoardApi, repo: string, key: string): Promise<BoardTask | null> {
  const marker = taskKeyMarker(key);
  return (await api.listIssues(repo, {})).filter((t) => t.body.includes(marker)).at(-1) ?? null;
}

/**
 * Issue #54: `continues: <n>` files a follow-up to task #n. A merge
 * auto-completes #n; follow-up typed into the lead is invisible to the board,
 * so the studio held no open task and was reaped mid-work. The follow-up
 * becomes a real task: assigned to #n's studio unless the caller names one
 * (read from #n, never retyped), and "Continues #n." heads its objective.
 * Returns the brief to parse, `continues` consumed.
 */
async function resolveContinues(api: BoardApi, repo: string, raw: unknown): Promise<BoardResult<unknown>> {
  if (typeof raw !== "object" || raw === null || !("continues" in raw)) return { ok: true, value: raw };
  const { continues, ...rest } = raw as Record<string, unknown>;
  if (typeof continues !== "number" || !Number.isInteger(continues) || continues < 1) {
    return { ok: false, status: 400, message: "continues must be a task number (a positive integer)" };
  }
  let prior: BoardTask;
  try {
    prior = await api.getIssue(repo, continues);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) {
      return { ok: false, status: 404, message: `task #${continues} not found in ${repo} -- nothing to continue` };
    }
    throw err;
  }
  const given = typeof rest.assignee === "string" && rest.assignee.trim() !== "";
  if (!given && prior.assignee === null) {
    return {
      ok: false, status: 400,
      message: `task #${continues} has no studio to continue with -- pass --studio <id>`,
    };
  }
  const objective = typeof rest.objective === "string" ? `Continues #${continues}.\n\n${rest.objective}` : rest.objective;
  return { ok: true, value: { ...rest, objective, ...(given ? {} : { assignee: prior.assignee }) } };
}

/**
 * Moves one task between states, as a compare-and-swap on the label the
 * Worker itself last wrote.
 *
 * `from` is mandatory. A transition that only names its destination is a
 * blind write, and a blind write is exactly how a board starts lying: it
 * cannot tell "the task is where I left it" from "someone else moved it and I
 * am about to erase that". Three refusals, all 409, all naming what was
 * actually on the issue:
 *   - no state label at all — this issue's state was not written by the Worker
 *   - more than one — two writers, and no way to know which is current
 *   - a different one than the caller expected — someone moved it
 *
 * Issue #55: a terminal state also CLOSES the issue (completed = GitHub's
 * "completed", canceled/failed = "not_planned"). It used to leave it open
 * for a sprint close that never shipped: 226 finished tasks sat open in one
 * repo, and "open issues keep growing" was read as a growing backlog. The
 * close goes AFTER the label, so a failed close leaves a terminal label on
 * an open issue -- and the same terminal transition onto itself retries
 * just the close.
 */
export async function transitionTask(
  api: BoardApi, repo: string, number: number, raw: unknown,
): Promise<BoardResult<BoardTask>> {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const vocabulary = TASK_STATES.join("|");
  // Issue #82: "none" = repair a task left with ZERO state labels.
  if (!isTaskState(body.from) && body.from !== "none") {
    return {
      ok: false, status: 400,
      message: `transition needs "from" — the state the caller believes this task is in — one of ${vocabulary}, ` +
        `or "none" to repair a task carrying no state label`,
    };
  }
  if (!isTaskState(body.to)) {
    return { ok: false, status: 400, message: `unknown state ${JSON.stringify(body.to)} — one of ${vocabulary}` };
  }
  const from = body.from;
  const to = body.to;

  const task = await api.getIssue(repo, number);
  const observed = taskStates(task.labels);
  if (from === "none") return repairStateless(api, repo, number, task, observed, to);
  if (observed.length === 0) {
    return {
      ok: false, status: 409,
      message: `task #${number} carries no board state label (labels: ${task.labels.join(", ") || "none"}) — ` +
        "the Worker did not write this issue's state, so it will not overwrite it",
    };
  }
  if (observed.length > 1) {
    return {
      ok: false, status: 409,
      message: `task #${number} carries ${observed.length} state labels (${observed.join(", ")}) — ` +
        "another writer touched this issue; fix the labels by hand before the Worker moves it again",
    };
  }
  if (observed[0] !== from) {
    return {
      ok: false, status: 409,
      message: `task #${number} is "${observed[0]}", caller expected "${from}" — ` +
        "the Worker is the single writer of task state and refuses a transition it did not initiate",
    };
  }
  // A no-op transition writes nothing rather than removing and re-adding the
  // same label: two API calls whose only visible effect is a pair of
  // timeline events saying nothing happened.
  if (from === to) return closeIfTerminal(api, repo, task);

  // Issue #248: an open-state label on a closed issue says "in flight" where
  // GitHub says done. The Worker does not reopen issues, so it refuses.
  if (!task.open && LIVE_TASK_STATES.includes(to)) {
    return {
      ok: false, status: 409,
      message: `task #${number} is closed on GitHub; the Worker does not reopen issues, so it will not label it "${to}" — ` +
        "reopen the issue first, or file a new task",
    };
  }

  // Remove then add, so a crash between the two leaves ZERO state labels
  // rather than two. Both are drift and both are refused by the checks above
  // — but "no state" reads unambiguously as an interrupted write, while two
  // labels reads as two writers, which is the more expensive diagnosis.
  await removeStateWithRetry(api, repo, number, from);
  await addStateAfterRemove(api, repo, number, from, to);

  // Returned from what was just written rather than re-read: these two calls
  // succeeded, so the label set is known, and a third round trip would only
  // add a window for someone else's write to be reported as ours.
  const labels = [...task.labels.filter((l) => l !== from), to];
  return closeIfTerminal(api, repo, { ...task, state: to, labels });
}

/**
 * Issue #86: a GitHub 500 on the remove left the task in its old state and
 * the destroy that waited on it refused. Retried once, like the add. A 404
 * on the retry means the first remove landed despite its 500: removed. A
 * first-try 404 is another writer (the CAS just read the label) and surfaces.
 */
async function removeStateWithRetry(api: BoardApi, repo: string, number: number, from: TaskState): Promise<void> {
  try {
    await api.removeLabel(repo, number, from);
    return;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) throw err;
  }
  try {
    await api.removeLabel(repo, number, from);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return;
    throw err;
  }
}

/**
 * Issue #82: the add after a remove failed twice (GitHub 500s) and left the
 * issue with ZERO state labels, which every CAS then refuses. Retried once;
 * if it still fails, the old label goes back (best effort) and the original
 * failure propagates -- the task reads as it did before the attempt.
 */
async function addStateAfterRemove(api: BoardApi, repo: string, number: number, from: TaskState, to: TaskState): Promise<void> {
  try {
    await api.addLabels(repo, number, [to]);
    return;
  } catch {
    // one retry below
  }
  try {
    await api.addLabels(repo, number, [to]);
  } catch (err) {
    try {
      await api.addLabels(repo, number, [from]);
    } catch (restoreErr) {
      console.error(`board: task #${number} in ${repo} left with no state label; restoring "${from}" failed too`, restoreErr);
    }
    throw err;
  }
}

/**
 * Issue #82: `from: "none"` -- the repair for a task carrying ZERO state
 * labels (an interrupted transition). Refused unless there really are zero:
 * one label is an ordinary CAS, two are two writers. The repair is logged on
 * the issue. Same closed-issue rule and terminal close as any transition.
 */
async function repairStateless(
  api: BoardApi, repo: string, number: number, task: BoardTask, observed: TaskState[], to: TaskState,
): Promise<BoardResult<BoardTask>> {
  if (observed.length > 0) {
    return {
      ok: false, status: 409,
      message: `task #${number} carries ${observed.length} state label(s) (${observed.join(", ")}) — ` +
        `from "none" repairs only a task with no state label`,
    };
  }
  if (!task.open && LIVE_TASK_STATES.includes(to)) {
    return {
      ok: false, status: 409,
      message: `task #${number} is closed on GitHub; the Worker does not reopen issues, so it will not label it "${to}" — ` +
        "reopen the issue first, or file a new task",
    };
  }
  await api.addLabels(repo, number, [to]);
  await api.createComment(repo, number, `board: state repaired: no state label -> ${to}`);
  return closeIfTerminal(api, repo, { ...task, state: to, labels: [...task.labels, to] });
}

/**
 * Issue #86: leads never flipped their own task to `working` (the brief asks
 * them to), so the board read `submitted` while a lead visibly worked. The
 * studio DO calls this on the lead's first observed working turn: every open
 * task assigned to `studioId` still at `submitted` moves to `working`, each
 * through `transitionTask`'s own CAS. Never throws: a failure is a line.
 */
export async function autoStartSubmittedTasks(
  api: BoardApi, repo: string, studioId: string,
): Promise<{ moved: number[]; errors: string[] }> {
  const moved: number[] = [];
  const errors: string[] = [];
  let tasks: BoardTask[];
  try {
    const listed = await listTasks(api, repo, { state: "submitted", assignedTo: studioId });
    if (!listed.ok) return { moved, errors: [listed.message] };
    tasks = listed.value.filter((t) => t.open);
  } catch (err) {
    return { moved, errors: [err instanceof Error ? err.message : String(err)] };
  }
  for (const t of tasks) {
    try {
      const res = await transitionTask(api, repo, t.number, { from: "submitted", to: "working" });
      if (res.ok) moved.push(t.number);
      else errors.push(`#${t.number}: ${res.message}`);
    } catch (err) {
      errors.push(`#${t.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { moved, errors };
}

/** Issue #55: closes per `reap --terminal` call. Each is one GitHub write;
 *  the Worker caps subrequests per request, so a big backlog goes in pages. */
export const TERMINAL_CLOSE_PAGE = 40;

export interface TerminalCloseOutcome {
  number: number;
  state: TaskState;
  outcome: "would-close" | "closed" | "error";
  reason: CloseReason;
  error?: string;
}

/**
 * Issue #55: the backlog of terminal tasks whose issue is still open -- left
 * by transitions from before #55, or by a close that failed. Dry-run unless
 * `apply`; with it, closes up to TERMINAL_CLOSE_PAGE and reports how many are
 * left. Only the issue's open/closed changes: labels are already terminal.
 * An ambiguous label set (state null) is not this function's to decide.
 */
export async function closeTerminalTasks(
  api: BoardApi, repo: string, apply: boolean,
): Promise<{ results: TerminalCloseOutcome[]; remaining: number }> {
  const stale = (await api.listIssues(repo, {}))
    .filter((t) => t.open && t.state !== null && TERMINAL_TASK_STATES.includes(t.state))
    .sort((a, b) => a.number - b.number);
  const reasonOf = (state: TaskState): CloseReason => (state === "completed" ? "completed" : "not_planned");
  if (!apply) {
    return {
      results: stale.map((t) => ({ number: t.number, state: t.state as TaskState, outcome: "would-close", reason: reasonOf(t.state as TaskState) })),
      remaining: 0,
    };
  }
  const results: TerminalCloseOutcome[] = [];
  for (const t of stale.slice(0, TERMINAL_CLOSE_PAGE)) {
    const state = t.state as TaskState;
    const reason = reasonOf(state);
    try {
      await api.closeIssue(repo, t.number, reason);
      results.push({ number: t.number, state, outcome: "closed", reason });
    } catch (err) {
      results.push({ number: t.number, state, outcome: "error", reason, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results, remaining: Math.max(0, stale.length - TERMINAL_CLOSE_PAGE) };
}

/** Issue #55: a task in a terminal state whose issue is still open gets it
 *  closed, with the reason its state implies. Anything else is returned as is. */
async function closeIfTerminal(api: BoardApi, repo: string, task: BoardTask): Promise<BoardResult<BoardTask>> {
  if (!task.open || task.state === null || !TERMINAL_TASK_STATES.includes(task.state)) return { ok: true, value: task };
  await api.closeIssue(repo, task.number, task.state === "completed" ? "completed" : "not_planned");
  return { ok: true, value: { ...task, open: false } };
}

/**
 * Appends one §6 envelope as an issue comment: prose for the human, the
 * struct for the machine, one comment for both.
 *
 * Reads the issue first, to refuse an envelope aimed at something that is not
 * a board task — a PR, a random issue, a number an agent hallucinated. Same
 * family of guard as the envelope's own task_id check (src/board/envelope.ts):
 * a result landing on the wrong task is the wrong-agent-contamination class,
 * and it is far cheaper to refuse than to unpick later.
 *
 * Posting a result NEVER moves the task's state, even a `failed` one. The
 * agent reports; the Worker decides. Collapsing those two is the single-writer
 * rule with extra steps.
 */
export async function commentEnvelope(
  api: BoardApi, repo: string, number: number, raw: unknown, msgId: string,
): Promise<BoardResult<{ url: string; envelope: EnvelopeDoc }>> {
  const parsed = parseEnvelope(raw, number, msgId);
  if (!parsed.ok) return { ok: false, status: 400, message: parsed.message };

  const task = await api.getIssue(repo, number);
  if (taskStates(task.labels).length === 0) {
    return {
      ok: false, status: 409,
      message: `#${number} in ${repo} is not a board task (no state label) — refusing to post an envelope onto it`,
    };
  }

  // A claimed artifact is a claim, not a fact. Shape is all envelope.ts can
  // check -- it is pure by design -- so existence is checked here, where a
  // token lives. Only `pr` artifacts: a path or url the Worker cannot resolve
  // without the checkout it does not have.
  //
  // Fail-OPEN on a thrown error, deliberately: a gate fails closed, a CHECK
  // fails open. An unreachable GitHub is a statement about GitHub.
  for (const art of parsed.doc.payload.artifacts) {
    const pr = art.pr;
    if (pr === undefined) continue;
    const num = Number.parseInt(pr.replace(/^#/, ""), 10);
    if (!Number.isInteger(num) || num <= 0) {
      return { ok: false, status: 409, message: `artifact pr ${JSON.stringify(pr)} is not an issue number` };
    }
    let exists: boolean;
    try {
      exists = await api.pullRequestExists(repo, num);
    } catch {
      continue;
    }
    if (!exists) {
      return {
        ok: false, status: 409,
        message: `artifact claims PR #${num} in ${repo}, which does not exist — refusing to record it as fact`,
      };
    }
  }

  const { url } = await api.createComment(repo, number, renderEnvelopeComment(parsed.doc));
  return { ok: true, value: { url, envelope: parsed.doc } };
}

// --- assignment: adoption and reassignment (P5 §3) --------------------------
//
// Two verbs, one rule underneath: the Worker stamps the `studio:` label, and
// no agent-facing route can. `ff <role> <n>` ADOPTS an existing issue —
// the operator's phone-filed backlog, an old untriaged issue, a task whose studio
// died. `fleet task assign <n> <role>` REASSIGNS one that already has an
// owner, which is Maestro's decision to make.
//
// Why assignment has no compare-and-swap when state does: a transition is
// RELATIVE (from -> to), so a caller that disagrees about `from` is a caller
// working from a stale read, and guessing which of two states was current is
// unanswerable. An assignment is ABSOLUTE — the caller names the destination
// outright, every prior owner is named in the lineage comment, and nothing
// has to be inferred. So a task carrying two `studio:` labels is REPAIRED by
// a reassignment rather than refused by one; a task carrying two STATE labels
// is still refused, exactly as transitionTask refuses it.

/** Adoption refuses to take a task another studio holds; reassignment is the
 *  verb that does that, and writes the lineage saying so. */
export type AssignMode = "adopt" | "reassign";

/**
 * The lineage comment. From, to, when, why — P5 §3, verbatim.
 *
 * It exists because the studio that did the work is DEAD by the time anyone
 * reads the task back (§4: studios are ephemeral), so the only surviving
 * account of who held it and why it moved is what the Worker wrote down at
 * the moment it moved. Prior envelope comments are never touched: the record
 * of what the previous studio actually did is the more valuable half of the
 * history, and reassignment must not erase it.
 *
 * Pure, so the exact text that lands on a real issue is the text a test
 * asserts on.
 */
export function renderLineageComment(
  args: { from: string[]; to: string; at: string; why: string | null; mode: AssignMode },
): string {
  const from = args.from.length === 0 ? "(backlog — no studio was assigned)" : args.from.join(", ");
  return [
    `### ${args.mode === "adopt" ? "Adopted" : "Reassigned"} — ${from} → ${args.to}`,
    "",
    `- from: ${from}`,
    `- to: ${args.to}`,
    `- when: ${args.at}`,
    `- why: ${args.why ?? "(not given)"}`,
    "",
    `State reset to \`${ENTRY_STATE}\` — the new studio has not started yet.`,
    "",
    "Earlier comments on this task stay where they are: they are the record of " +
      "what the previous studio did, and it outlives the studio.",
    "",
  ].join("\n");
}

/**
 * Points ONE studio at ONE task, whatever shape that task arrived in.
 *
 * Four writes, in this order, and the order is the failure story: remove every
 * other studio's label, add the new one, reset the state to `submitted`,
 * comment the lineage. Removes before adds for the same reason transitionTask
 * does it — a crash between them leaves ZERO state labels, which reads
 * unambiguously as an interrupted write, rather than two, which reads as two
 * writers and is the more expensive diagnosis.
 *
 * "Atomically" is as atomic as GitHub allows: there is no transaction across
 * issue-label calls, so what this guarantees is a defined ORDER with a defined
 * intermediate state, not indivisibility. The lineage comment is written LAST
 * so it never claims a move that did not land.
 *
 * A no-op writes no LABELS and no COMMENT. Re-running `ff web-studio 42` on a
 * task that studio already owns and has not started is a normal thing to do
 * (the studio was recycled; the operator typed it twice), and a timeline full
 * of "reassigned to the same studio, reason: none" is how a lineage trail
 * stops being read.
 *
 * Board #158: it still fires the wake hook, though — see `OnAssigned`'s own
 * comment. A no-op on the BOARD is not a no-op on the STUDIO's tmux pane; the
 * two were conflated before this, and a same-studio assign silently woke
 * nobody twice measured in one day.
 */
export async function assignTask(
  api: BoardApi, repo: string, number: number, raw: unknown,
  opts: { mode: AssignMode; at?: string; onAssigned?: OnAssigned; getLeadType?: GetLeadType },
): Promise<BoardResult<BoardTask>> {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  // Same field name and same grammar check src/board/brief.ts applies to a
  // brief's `assignee`: an id that could never match a label the Worker
  // writes is a 400 here rather than a label nothing will ever find.
  const rawAssignee = body.assignee;
  if (typeof rawAssignee !== "string" || rawAssignee.trim() === "") {
    return { ok: false, status: 400, message: 'assignment needs "assignee" — the studio id this task moves to' };
  }
  const to = rawAssignee.trim();
  if (!parseStudioId(to)) {
    return { ok: false, status: 400, message: `assignee ${JSON.stringify(to)} is not a studio id — expected "<repo>--<role>"` };
  }
  let why: string | null = null;
  if (body.why !== undefined && body.why !== null) {
    if (typeof body.why !== "string") return { ok: false, status: 400, message: '"why" must be a string' };
    why = body.why.trim() === "" ? null : body.why.trim();
  }

  const task = await api.getIssue(repo, number);
  // Issue #249 (maestro spec point 5): refused BEFORE any write — a task
  // already carrying SECURITY_LABEL (createTask's own write, above, or a
  // hand-labelled issue — either way, the label on the issue is what this
  // checks, not whatever the caller claims) must never move onto a
  // glm-lead studio, adopt or reassign alike. `getLeadType` absent (every
  // caller that predates this feature) skips the check entirely.
  if (opts.getLeadType) {
    const leadType = await opts.getLeadType(to);
    if (securityRefusesGlmLead(task.labels, leadType)) {
      return { ok: false, status: 400, message: securityGlmRefusalMessage(to) };
    }
  }
  const states = taskStates(task.labels);
  // Zero state labels is BACKLOG, not drift — that is the whole of P5 §3, and
  // adopting one is the point of this function. Two is drift, and unlike an
  // assignment it cannot be repaired by naming a destination: which of the
  // two the Worker last wrote is unknowable.
  if (states.length > 1) {
    return {
      ok: false, status: 409,
      message: `task #${number} carries ${states.length} state labels (${states.join(", ")}) — ` +
        "another writer touched this issue; fix the labels by hand before the Worker moves it again",
    };
  }

  const owners = taskAssignees(task.labels);
  const others = owners.filter((o) => o !== to);
  if (opts.mode === "adopt" && others.length > 0) {
    return {
      ok: false, status: 409,
      message: `task #${number} already belongs to ${others.join(", ")} — ` +
        `adoption never takes a task from another studio. Reassign it: fleet task assign ${number} <role>`,
    };
  }

  const state = states[0] ?? null;
  const addStudio = owners.includes(to) ? [] : [studioLabel(to)];
  const resetState = state !== ENTRY_STATE;
  if (others.length === 0 && addStudio.length === 0 && !resetState) {
    // Board #158: nothing on the board changes, but the wake still fires —
    // this IS the "nudge the studio that already owns it" case, not a
    // duplicate of a real move. `why` goes with it: no lineage comment is
    // written on this no-op path, so the wake digest is the ONLY place the
    // operator's --why text can reach the lead being woken. Deliberately no
    // issue comment for it either — a posted comment is itself a webhook
    // delivery that wakes the lead a SECOND time via board #236's own
    // comment-wake edge.
    await fireOnAssigned(opts.onAssigned, to, task, why);
    return { ok: true, value: task };
  }

  for (const owner of others) await api.removeLabel(repo, number, studioLabel(owner));
  if (state !== null && resetState) await api.removeLabel(repo, number, state);
  const added = [...addStudio, ...(resetState ? [ENTRY_STATE] : [])];
  if (added.length > 0) await api.addLabels(repo, number, added);
  await api.createComment(repo, number, renderLineageComment({
    from: others, to, at: opts.at ?? new Date().toISOString(), why, mode: opts.mode,
  }));

  // Built from what was just written rather than re-read, same as
  // transitionTask: these calls succeeded, so the label set is known, and a
  // further round trip would only widen the window for someone else's write
  // to be reported as ours.
  const removed = new Set([...others.map(studioLabel), ...(state !== null && resetState ? [state] : [])]);
  const labels = [...task.labels.filter((l) => !removed.has(l)), ...added];
  const assigned: BoardTask = { ...task, state: ENTRY_STATE, labels, assignee: to };

  // Board issue #41, half one. Placed AFTER every write and after the lineage
  // comment, for the same reason the comment itself is written last: a wake
  // must never announce a move that did not land. (The no-op return above
  // fires this same hook too, on the unchanged `task` — board #158.)
  await fireOnAssigned(opts.onAssigned, to, assigned);
  return { ok: true, value: assigned };
}

export interface ListTasksQuery {
  /** Sprint title. §5: the sprint board IS the milestone-filtered list. */
  milestone?: string;
  /** One board state label. */
  state?: string;
  /**
   * One studio id. Applied as a LABEL filter, which means GitHub drops every
   * other studio's task before the response is built — the scoping a studio
   * reads its own board through is therefore enforced upstream of this
   * Worker, not by trimming a full board here. Never taken from a request
   * body: the fleet route resolves it from the caller's spawn token.
   */
  assignedTo?: string;
}

/**
 * The board, or one sprint's slice of it — INCLUDING backlog (P5 §3).
 *
 * This filter used to be `taskStates(i.labels).length > 0`, and that one line
 * is the whole reason P5 §3 exists. the operator files an issue from his phone with
 * raw `gh issue create`; it carries no state label, because the Worker is the
 * only thing that writes those; so it never appeared here, and no studio could
 * be pointed at it. It looked filed. It was inert.
 *
 * So an issue with no state label is BACKLOG and shows. The only thing dropped
 * is a CLOSED issue with no state label: that is repo history — a bug report
 * from last year, somebody's question — never a task waiting to be picked up.
 * A task the Worker DID write a state onto stays visible either way, open or
 * closed, because sprint close closes issues and their board state outlives it.
 *
 * A drifted task (two state labels) stays visible for the reason it always
 * did: filtering it out would hide precisely the thing that needs fixing.
 *
 * `nowMs` is a parameter so the stale flag is testable without faking a clock;
 * every caller uses the default.
 */
export async function listTasks(
  api: BoardApi, repo: string, query: ListTasksQuery, nowMs: number = Date.now(),
): Promise<BoardResult<BoardTaskView[]>> {
  const apiQuery: ListIssuesQuery = {};
  if (query.state !== undefined) {
    if (!isTaskState(query.state)) {
      return { ok: false, status: 400, message: `unknown state ${JSON.stringify(query.state)} — one of ${TASK_STATES.join("|")}` };
    }
    // Server-side: GitHub's `labels` filter is an AND over one label here,
    // which is exactly "carries this state".
    apiQuery.labels = [query.state];
  }
  if (query.assignedTo !== undefined) {
    // GitHub ANDs multiple labels, so this composes with the state filter
    // above rather than replacing it.
    apiQuery.labels = [...(apiQuery.labels ?? []), studioLabel(query.assignedTo)];
  }
  if (query.milestone !== undefined) {
    const milestone = await resolveMilestone(api, repo, query.milestone);
    if (!milestone.ok) return milestone;
    apiQuery.milestone = milestone.value;
  }
  const issues = await api.listIssues(repo, apiQuery);
  return {
    ok: true,
    value: issues
      .filter((i) => i.open || taskStates(i.labels).length > 0)
      .map((i) => ({ ...i, stale: isStaleBacklog(i, nowMs) })),
  };
}

export interface TaskComment extends BoardComment {
  /** The §6 struct when this comment is an envelope, null when a human (or an
   *  older schema) wrote it. */
  envelope: EnvelopeDoc | null;
}

/** One task in full: its brief, its state, and every comment with any
 *  envelope decoded. The read half of "post a result, then read it back". */
export async function showTask(
  api: BoardApi, repo: string, number: number,
): Promise<BoardResult<{ task: BoardTask; comments: TaskComment[] }>> {
  const [task, comments] = await Promise.all([api.getIssue(repo, number), api.listComments(repo, number)]);
  return {
    ok: true,
    value: { task, comments: comments.map((c) => ({ ...c, envelope: parseEnvelopeComment(c.body) })) },
  };
}

/** Same port, same reasoning as src/studio/repo.ts's WorkRepoDeps — see its
 *  doc comment for why P6a made this a per-repo question that carries its own
 *  refusal wording back. */
export interface BoardRepoDeps {
  reachRepo: (slug: string) => Promise<RepoReach>;
}

/**
 * Which repo IS the board (§5: "board repo = repo being worked", not always
 * the fleet's own).
 *
 * Same rule, same order and same reasoning as src/studio/repo.ts's
 * resolveWorkRepo, minus everything that is about studio IDs: a caller NAMES a
 * repo, the Worker VERIFIES that the fleet's own credential can reach it — the
 * one boundary that already decides what this fleet can touch. Nothing is
 * verified when no caller named it, because the fallback is `AGENT_REPO` from
 * wrangler.jsonc, which is deployment config and not client input.
 */
export async function resolveBoardRepo(
  deps: BoardRepoDeps, req: { requested: unknown; defaultSlug: string },
): Promise<BoardResult<string>> {
  const defaultLower = req.defaultSlug.toLowerCase();
  if (req.requested === undefined || req.requested === null) return { ok: true, value: defaultLower };

  const parsed = parseRepoSlug(req.requested);
  if (!parsed) {
    return { ok: false, status: 400, message: `bad repo ${JSON.stringify(req.requested)} — expected "owner/name"` };
  }
  const slug = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  if (slug === defaultLower) return { ok: true, value: slug };

  let reach: RepoReach;
  try {
    reach = await deps.reachRepo(slug);
  } catch (err) {
    // 503, not 500: the request is fine, the answer is momentarily
    // unavailable, and retrying is the right client behaviour. The caught
    // error can carry an upstream message (and on some failures a token) —
    // logged server-side only, same posture resolveWorkRepo takes.
    console.error(`board: reachability unavailable for "${slug}"`, err);
    return { ok: false, status: 503, message: "repo reachability unavailable" };
  }
  if (!reach.reachable) {
    // The remedy is the answering provider's own — "install the app" or
    // "grant the token", never whichever one did not apply.
    return { ok: false, status: 403, message: `repo "${slug}" ${reach.remedy}` };
  }
  return { ok: true, value: slug };
}

// --- the studio side of the board (P4a-2) -----------------------------------
//
// Everything below is what a STUDIO may do, and the rules are narrower than
// the operator's above by design. Two invariants hold across all of them, and
// neither is enforced by trusting the caller:
//
//   1. A studio reads only tasks assigned to ITSELF. The id it is measured
//      against is resolved from its spawn token by the Worker
//      (src/studio/spawn.ts's resolveSpawnParent), never read from a request.
//   2. A studio never writes state ITSELF. Board issue #41 narrows that from
//      "a studio never moves a task" to "a studio never writes a LABEL": it
//      may ASK the Worker to move its own task within a four-state allowlist
//      (transitionStudioTask below), and the Worker is still the only thing
//      that touches GitHub. Posting a result envelope still moves nothing,
//      exactly as commentEnvelope above already refuses to.

/**
 * One task, but only if the calling studio owns it.
 *
 * 404, not 403, and the message names the CALLER rather than the real owner:
 * a studio has no business learning which OTHER studio holds a task, and a
 * refusal that named the owner would turn this route into a board-wide read
 * one number at a time. Naming the caller keeps the refusal diagnosable
 * (`this is who the Worker thinks you are`) without leaking anything the
 * caller did not already know about itself.
 *
 * Membership, not exclusivity: a task carrying TWO studio labels, one of them
 * mine, is still mine — the second label is board drift for a human to fix
 * (it shows up as `assignee: null` and prints as DRIFT), and refusing a lead
 * its own brief because someone hand-labelled the issue would be a worse
 * failure than the drift itself.
 */
export async function requireAssignedTask(
  api: BoardApi, repo: string, number: number, studioId: string,
): Promise<BoardResult<BoardTask>> {
  const task = await api.getIssue(repo, number);
  if (!taskAssignees(task.labels).includes(studioId)) {
    return {
      ok: false, status: 404,
      message: `task #${number} in ${repo} is not assigned to ${studioId} — a studio reads only its own tasks`,
    };
  }
  return { ok: true, value: task };
}

/** `showTask` behind the ownership gate. */
export async function showStudioTask(
  api: BoardApi, repo: string, number: number, studioId: string,
): Promise<BoardResult<{ task: BoardTask; comments: TaskComment[] }>> {
  const owned = await requireAssignedTask(api, repo, number, studioId);
  if (!owned.ok) return owned;
  return showTask(api, repo, number);
}

/**
 * Board issue #41, half two: the ONLY states a lead may move its own task to.
 *
 * Four, and the two that are missing are missing for different reasons:
 *
 *   `completed` — the verdict of whoever VERIFIES, never of whoever does the
 *     work. A lead that can mark its own task done is exactly what the
 *     verification gate exists to prevent, and this fleet has already paid
 *     for the failure once (a merged PR whose issue still claimed in
 *     progress). It stays on the operator surface (POST
 *     /studio/board/tasks/<n>/state, behind Cloudflare Access) and on the
 *     Worker's own push-triggered auto-close (src/board/close-action.ts),
 *     which measures a landed commit rather than believing a claim.
 *
 *   `canceled` — dropping a task is a decision about what the fleet should be
 *     doing, which is the operator's, not the worker's.
 *
 *   `submitted` — the entry state. Only `createTask` and `assignTask` write
 *     it, and a lead rewinding its own task to "nobody has started" would
 *     erase the very signal this feature exists to produce.
 *
 * Board issue #110 adds `awaiting_merge` to the states a lead MAY set, not to
 * the missing two above: it is in the same self-reported-claim category as
 * `working`/`input_required`/`failed` — the lead saying "I'm done, PR's up,
 * waiting on merge", not a verified fact. `completed` stays the verifier's
 * exclusive call regardless of what the lead claims; a merged PR still only
 * auto-completes the task through src/studio/task-reap.ts's own merge check,
 * never through this route.
 *
 * Exported so the refusal message and the tests name one list, not two.
 */
export const LEAD_TASK_STATES: readonly TaskState[] = ["working", "input_required", "awaiting_merge", "failed"];

/**
 * A lead moves the state of its OWN task — board issue #41, half two.
 *
 * The gap: the in-container `fleet` (container/studio-fleet) had `spawn`,
 * `task ls`, `task show` and `task report` and no transition verb at all, so
 * a task a lead was ACTIVELY working sat at `submitted` until a coordinator
 * moved it by hand. Every monitor watching board state read `submitted` on a
 * healthy working studio and concluded it had stalled — a false negative in
 * the expensive direction, the same shape as an empty read.
 *
 * WHAT DOES NOT CHANGE, and is the whole reason this is a route rather than a
 * credential: the Worker remains the single writer of the board. The lead
 * names a destination; `transitionTask` above — untouched, compare-and-swap
 * included — is what actually writes the label. No agent-facing code path
 * anywhere calls GitHub's label API.
 *
 * Order of the four gates is deliberate and is itself the security property:
 *
 *   1. VOCABULARY, pure. An unknown word is a 400.
 *   2. ALLOWLIST, pure, BEFORE any I/O. An attempt to self-approve is refused
 *      without costing a single GitHub call, so it cannot even be observed as
 *      a read on the target issue, let alone a write.
 *   3. OWNERSHIP. `requireAssignedTask`'s existing gate, measured against the
 *      studio id the Worker resolved from the caller's spawn token — never a
 *      field of the request.
 *   4. COMPARE-AND-SWAP. `from` is read off the board rather than demanded
 *      from the caller: a lead has no reliable way to know its task's current
 *      state without a second round trip, and inventing one it could get
 *      wrong would turn every transition into a coin flip on a 409. The
 *      Worker's own read is the `from`, so the swap is between the Worker's
 *      read and the Worker's write — and `transitionTask`'s refusals for zero
 *      and for two state labels (the two drift shapes) still fire exactly as
 *      they do for the operator.
 */
export async function transitionStudioTask(
  api: BoardApi, repo: string, number: number, raw: unknown, studioId: string,
): Promise<BoardResult<BoardTask>> {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!isTaskState(body.to)) {
    return {
      ok: false, status: 400,
      message: `unknown state ${JSON.stringify(body.to)} — one of ${TASK_STATES.join("|")}`,
    };
  }
  const to = body.to;
  if (!LEAD_TASK_STATES.includes(to)) {
    return {
      ok: false, status: 403,
      message: `a lead may not move its own task to "${to}" — it may set ${LEAD_TASK_STATES.join(", ")} ` +
        "and nothing else. `completed` is the verdict of whoever verifies the work, not of whoever did it; " +
        "report your result (fleet task report " + number + ") and let the verifier close it.",
    };
  }

  const owned = await requireAssignedTask(api, repo, number, studioId);
  if (!owned.ok) return owned;

  const observed = taskStates(owned.value.labels);
  if (observed.length !== 1) {
    // Deliberately NOT forwarded to transitionTask with an invented `from`:
    // zero labels would read there as a missing request field (a 400 telling
    // the lead to send something it cannot know) rather than as what it is —
    // an issue whose state this Worker did not write.
    return {
      ok: false, status: 409,
      message: observed.length === 0
        ? `task #${number} carries no board state label (labels: ${owned.value.labels.join(", ") || "none"}) — ` +
          "the Worker did not write this issue's state, so it will not overwrite it"
        : `task #${number} carries ${observed.length} state labels (${observed.join(", ")}) — ` +
          "another writer touched this issue; fix the labels by hand before the Worker moves it again",
    };
  }

  return transitionTask(api, repo, number, { from: observed[0], to });
}

/**
 * `commentEnvelope` behind the ownership gate, with `sender` STAMPED rather
 * than accepted.
 *
 * Same rule and same reason as `msg_id` (src/board/envelope.ts's header): a
 * field a caller can set is a field a caller can forge, and an envelope
 * signed as another studio is the wrong-agent-contamination class arriving
 * with a signature. The studio id the Worker resolved from the spawn token
 * overwrites whatever the body said, silently — there is nothing for the
 * caller to correct, since the correct value is the only one it could ever
 * have used.
 */
export async function commentStudioEnvelope(
  api: BoardApi, repo: string, number: number, raw: unknown, msgId: string, studioId: string,
): Promise<BoardResult<{ url: string; envelope: EnvelopeDoc }>> {
  const owned = await requireAssignedTask(api, repo, number, studioId);
  if (!owned.ok) return owned;
  const body = typeof raw === "object" && raw !== null ? raw : {};
  return commentEnvelope(api, repo, number, { ...body, sender: studioId }, msgId);
}

/**
 * The brief a studio is provisioned WITH — resolved server-side, at spawn or
 * provision time, into the block that gets appended to its lead's system
 * prompt (src/board/brief.ts's renderBriefPrompt).
 *
 * Gated by the SAME ownership check a studio's own read is, which is what
 * stops a parent studio (or an operator typo) handing a child a task that
 * belongs to somebody else: the Worker derives the child's id itself, and
 * this refuses any task not labelled for that id.
 */
export async function resolveBriefPrompt(
  api: BoardApi, repo: string, number: number, studioId: string,
): Promise<BoardResult<string>> {
  const owned = await requireAssignedTask(api, repo, number, studioId);
  if (!owned.ok) return owned;
  return { ok: true, value: renderBriefPrompt(owned.value, studioId) };
}

/**
 * The brief for whichever OPEN task currently carries `studioId`'s label —
 * the sibling `resolveBriefPrompt` above does not answer, because it needs a
 * task NUMBER a caller may not have. Two real callers have no number to give
 * it: adoption (`fleet task assign` points a studio at a task it was never
 * spawned for) and recycle/a bodyless re-provision (src/studio/provision.ts's
 * `resolveBringupEnv`), which carry no `cfg.briefPrompt` at all and never
 * did. Both need "whatever this studio is currently on the hook for", not
 * "task #N specifically" — which is exactly what a `studio:` label lookup
 * answers and a number never could.
 *
 * Never throws — the same total, fail-open posture provision.ts's own
 * `resolveMemoryIndex` documents for the same reason: a board hiccup must
 * never block provisioning. `listTasks` itself can both reject (a thrown
 * upstream failure) and resolve `{ ok: false }`; either is logged and
 * answered with `null`, same as "no task assigned" would be.
 *
 * Filtered to OPEN tasks only: `listTasks` also returns a closed-but-labeled
 * issue for the board UI's own reasons (a terminal state label outlives
 * sprint close), and a closed task is not live work to hand a freshly
 * adopted studio.
 *
 * Sorted by `updatedAt` DESCENDING when more than one open task carries the
 * label. This file's own `isStaleBacklog` already documents `updatedAt` as
 * the age signal this codebase uses for a task — reused here as a PROXY for
 * "most recently assigned", not a dedicated assignment timestamp (none
 * exists): `assignTask`'s own lineage comment is itself a write, so pointing
 * a studio at a task is what bumps that task's `updatedAt` in the first
 * place.
 *
 * When more than one open task is found, the rendered prompt is PREFIXED
 * with a note naming the chosen (newest) task and listing the others — a
 * lead must never silently receive one of several assigned tasks with
 * nothing on the page to say the others exist.
 */
export async function resolveLatestAssignedBrief(
  api: BoardApi, repo: string, studioId: string,
): Promise<{ prompt: string; taskNumber: number; title: string } | null> {
  let result: BoardResult<BoardTaskView[]>;
  try {
    result = await listTasks(api, repo, { assignedTo: studioId });
  } catch (err) {
    console.error(`board: assigned-task lookup failed for ${studioId}@${repo}`, err);
    return null;
  }
  if (!result.ok) {
    console.error(`board: assigned-task lookup failed for ${studioId}@${repo} (${result.status}): ${result.message}`);
    return null;
  }

  // #124 review: board state, not issue open — a terminal state leaves the
  // issue open, and a re-provisioned studio was handed a COMPLETED brief.
  const open = result.value.filter((t) => t.open && t.state !== null && LIVE_TASK_STATES.includes(t.state));
  if (open.length === 0) return null;

  const sorted = [...open].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const [newest, ...others] = sorted;
  let prompt = renderBriefPrompt(newest, studioId);
  if (others.length > 0) {
    const otherNumbers = others.map((t) => `#${t.number}`).join(", ");
    prompt = `Note: ${sorted.length} open tasks are currently assigned to you; this brief is for the ` +
      `most recently assigned, #${newest.number}. Also open: ${otherNumbers}.\n\n${prompt}`;
  }
  // `title` is additive: board issue #213's bring-up delivery wake
  // (`deliverAssignedTaskOnBringup`, src/studio/do.ts) needs it to build the
  // SAME one-line `assignDigest` pointer a running studio's assign-time wake
  // already uses — never `prompt` above, which is a multi-line brief and
  // would arrive at a live pane as several broken half-prompts (see
  // `assignDigest`'s own doc comment in src/board/assign-wake.ts).
  return { prompt, taskNumber: newest.number, title: newest.title };
}

/** Issue #137, PR #143 fix-first review: which live states earn a bring-up
 *  re-delivery wake. Originally narrower than `LIVE_TASK_STATES` — `submitted`
 *  was excluded on the theory that the ordinary fresh-assignment wake
 *  (`wakeOnAssign`, assign-wake.ts) already covers it. That theory is wrong:
 *  `wakeOnAssign` itself REFUSES to type into a STOPPED studio at assignment
 *  time (its own refusal message: "no wake was sent, because starting its
 *  container costs money silently. Provision it and the task is delivered on
 *  bring-up."), leaving the task in `submitted` with no wake ever sent. Only
 *  the bring-up path (this filter) keeps that promise, so `submitted` has to
 *  qualify here too — making this byte-identical to `LIVE_TASK_STATES`. Kept
 *  as its own named export anyway: it is a SEPARATE policy decision ("what
 *  earns a bring-up re-delivery wake") from LIVE_TASK_STATES's ("what counts
 *  as work still owed"), even though the two currently agree on every state. */
export const REBRIEF_TASK_STATES: readonly TaskState[] = LIVE_TASK_STATES;

/**
 * Issue #137: every OPEN task currently assigned to `studioId` in a
 * `REBRIEF_TASK_STATES` state (`submitted`, `working`, or `input_required`)
 * — the sibling of `resolveLatestAssignedBrief`
 * above, widened from "the single newest assigned task" to "every task still
 * genuinely in flight", because a container replacement leaves a fresh pane
 * with zero memory of ANY of them, not only the most recent one.
 *
 * Same `listTasks(api, repo, {assignedTo: studioId})` call
 * `resolveLatestAssignedBrief` makes, and the same fail-open-to-`[]` posture
 * on a thrown error or `{ok:false}` (logged, then answered `[]`) — a board
 * hiccup at bring-up must never block provisioning, exactly as that
 * function's own doc comment argues.
 *
 * Sorted newest-updated-first, same `updatedAt` proxy
 * `resolveLatestAssignedBrief` uses — every entry here gets delivered, so the
 * order does not change the outcome, only makes it deterministic to test.
 */
export async function openTasksNeedingRebrief(
  api: BoardApi, repo: string, studioId: string,
): Promise<{ taskNumber: number; title: string }[]> {
  let result: BoardResult<BoardTaskView[]>;
  try {
    result = await listTasks(api, repo, { assignedTo: studioId });
  } catch (err) {
    console.error(`board: open-tasks-needing-rebrief lookup failed for ${studioId}@${repo}`, err);
    return [];
  }
  if (!result.ok) {
    console.error(`board: open-tasks-needing-rebrief lookup failed for ${studioId}@${repo} (${result.status}): ${result.message}`);
    return [];
  }
  const open = result.value.filter((t) => t.open && t.state !== null && REBRIEF_TASK_STATES.includes(t.state));
  const sorted = [...open].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return sorted.map((t) => ({ taskNumber: t.number, title: t.title }));
}

/**
 * The one live task, if any, that `studioId` currently holds — open, not
 * drifted, in a LIVE_TASK_STATES state, carrying THIS studio's own
 * `studioLabel`. Same membership discipline `requireAssignedTask` documents:
 * checked directly against `studioLabel(studioId)` rather than trusting
 * `listTasks`'s `assignedTo` filter alone, in case a test double (or a future
 * BoardApi implementation) does not honor it.
 *
 * PR #9 review, blocker B1: this used to also require JUNIOR_LABEL, and its
 * boolean answer (as `hasJuniorAuthorizedTask`) WAS the whole of the
 * `/fleet/junior` gate. That made a GitHub label load-bearing for
 * authorization — and a studio's own repo-scoped `gh` token can add a label
 * to its own issue (`gh issue edit <n> --add-label junior`), which is a
 * studio granting itself the very permission this gate exists to withhold.
 * The label still gets WRITTEN (createTask, when the maestro's own
 * filed-with-`--junior` request asks for it) and still SHOWS on `fleet task
 * ls`/`show` (cli/task-format.ts's `[junior]` marker) — cosmetic uses, not
 * security ones. The actual decision now lives in D1
 * (src/junior/authz.ts's isJuniorAuthorized), keyed by the task NUMBER this
 * function resolves, and written exactly once by createTask's own caller
 * (src/board/routes.ts's handleBoard) — a route nothing but the maestro's
 * Cloudflare-Access-gated `fleet task new --junior` can ever reach. This
 * module stays free of that binding on purpose (see this file's own header),
 * so the D1 check happens in src/junior/route.ts, which combines the task
 * this function finds with authz.ts's own answer.
 *
 * A board error is returned, never read as "no task" — same fail-closed
 * posture the boolean version always had.
 */
export async function findLiveAssignedTask(
  api: BoardApi, repo: string, studioId: string,
): Promise<BoardResult<BoardTask | null>> {
  const r = await listTasks(api, repo, { assignedTo: studioId });
  if (!r.ok) return r;
  const mine = studioLabel(studioId);
  const found = r.value.find((t) =>
    t.open && t.state !== null && LIVE_TASK_STATES.includes(t.state) && t.labels.includes(mine));
  return { ok: true, value: found ?? null };
}

/**
 * `resolveLatestAssignedBrief`'s sibling for `fleet destroy`'s refusal gate
 * (board task #124's code review, not #118's) — deliberately NOT built by
 * reusing that function, because its fail-open-to-`null` posture (a board
 * hiccup answers "no brief", same as "no task assigned") is correct for a
 * bringup fallback but wrong for a destructive-action gate: `destroy` must
 * fail CLOSED on a lookup failure, not silently proceed as if no open task
 * existed. Same `listTasks(api, repo, { assignedTo: studioId })` call
 * `resolveLatestAssignedBrief` makes, but the `BoardResult` it gets back is
 * propagated AS-IS on failure — never caught, never collapsed to a boolean —
 * so the caller (routes.ts's `openTaskChecker`) can tell "confirmed no open
 * task" apart from "couldn't tell".
 */
export async function openAssignedTasks(
  api: BoardApi, repo: string, studioId: string,
): Promise<BoardResult<{ number: number; drifted: boolean }[]>> {
  const tasks = await listTasks(api, repo, { assignedTo: studioId });
  if (!tasks.ok) return tasks;
  // Board #55 defect A: GitHub's open/closed is NOT the board's state — a
  // terminal board state leaves the issue open until sprint close — so
  // `open` alone refused on work the board already called finished and
  // trained `--force` by reflex. Live = open AND in a state a studio still
  // owns work for. Board issue #110: this used to be computed as "not
  // terminal", a two-bucket (live vs terminal) model that broke the moment
  // `awaiting_merge` added a third bucket — neither terminal (the issue must
  // stay open until merge) nor live (the lead's part is already done, so
  // `destroy` has nothing left to protect). Positive membership in
  // LIVE_TASK_STATES is the fix; a drifted task (`state` null) still counts
  // as live, so this gate still fails closed exactly as before.
  return {
    ok: true,
    value: tasks.value
      .filter((t) => t.open && (t.state === null || LIVE_TASK_STATES.includes(t.state)))
      .map((t) => ({ number: t.number, drifted: t.state === null })),
  };
}
