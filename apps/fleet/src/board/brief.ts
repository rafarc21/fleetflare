// The task BODY — §5's "self-contained brief: objective, output format,
// boundaries". Pure: a raw request body in, a validated brief and a markdown
// string out, no I/O, so every rule below is unit-tested directly rather than
// through a live issue.
//
// The three sections are a HARD floor, not a template suggestion. §5's own
// evidence: bad task specs cause 43.8% of multi-agent failures, and the team
// that reads this brief gets no conversation to repair it with — it reads the
// issue, works, and dies. A brief missing its boundaries is how a team
// rewrites a Dockerfile nobody asked it to touch.
//
// Scope is the one thing NOT enforced here: "one deliverable of substantial
// scope, never a micro-step" is a judgement made at the sprint meeting, and a
// character count cannot stand in for it. What this file guarantees is that
// whatever scope was chosen arrives complete.

import { parseStudioId } from "../studio/ids";

export interface TaskBrief {
  title: string;
  objective: string;
  outputFormat: string;
  boundaries: string;
  /** Sprint (§5: sprint = milestone). Null = not on a sprint board yet. */
  milestone: string | null;
  /**
   * The studio that owns this task, or null for an unassigned one (a task
   * written at a sprint meeting before anyone decides who takes it).
   *
   * A studio id, validated against the id grammar here so a typo becomes a
   * 400 instead of a label nothing will ever match. It is written as a label
   * by board.ts's createTask and by nothing else — see types.ts's
   * STUDIO_LABEL_PREFIX for why assignment is a label at all.
   */
  assignee: string | null;
  /**
   * Issue #139: the caller's idempotency key, one per `fleet task new`
   * invocation and replayed unchanged on retry. Rendered into the body as a
   * hidden marker so a retry after a lost response (GitHub created the issue,
   * then answered 520) finds that issue instead of filing a duplicate. See
   * board.ts's createTask. Optional: a caller that sends none gets the old
   * create-every-time behaviour.
   */
  idempotencyKey?: string;
  /** Maestro's per-task authorization for the junior skill. Absent = not
   *  authorized. Becomes the `junior` label (types.ts JUNIOR_LABEL). */
  junior?: boolean;
}

// GitHub's own limits, not ours — a longer title/body is refused by the API
// with a 422 that says nothing useful about which field was the problem.
// Checked here so the caller learns which one, before a token is minted.
export const TASK_TITLE_MAX = 256;
export const TASK_BODY_MAX = 65_536;

// Tight on purpose: the key is written into an HTML comment, so nothing that
// could close the comment (or smuggle markdown) gets through.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** The hidden marker createTask writes and looks for. */
export function taskKeyMarker(key: string): string {
  return `<!-- fleet-task-key: ${key} -->`;
}

export type BriefResult =
  | { ok: true; brief: TaskBrief }
  | { ok: false; message: string };

function requiredText(raw: Record<string, unknown>, field: string): string | null {
  const v = raw[field];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseBrief(raw: unknown): BriefResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, message: "task brief must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  const title = requiredText(body, "title");
  if (title === null) return { ok: false, message: "task brief needs a non-empty title" };
  if (title.length > TASK_TITLE_MAX) {
    return { ok: false, message: `title is ${title.length} chars, over GitHub's ${TASK_TITLE_MAX}-char issue title limit` };
  }

  // Named one at a time so the message says WHICH section is missing. A
  // single "brief is incomplete" would send the caller re-reading its own
  // payload to find out.
  const objective = requiredText(body, "objective");
  if (objective === null) return { ok: false, message: "task brief needs a non-empty objective — what deliverable this task produces" };
  const outputFormat = requiredText(body, "outputFormat");
  if (outputFormat === null) return { ok: false, message: "task brief needs a non-empty outputFormat — what the team hands back" };
  const boundaries = requiredText(body, "boundaries");
  if (boundaries === null) return { ok: false, message: "task brief needs non-empty boundaries — what this task must not touch" };

  // Absent, null and blank all mean the same thing: no sprint. A non-string
  // does not — that is a caller sending the wrong shape, and swallowing it
  // would silently drop the task off the sprint board.
  let milestone: string | null = null;
  const rawMilestone = body.milestone;
  if (rawMilestone !== undefined && rawMilestone !== null) {
    if (typeof rawMilestone !== "string") return { ok: false, message: "milestone must be a string (the sprint's title)" };
    milestone = rawMilestone.trim() === "" ? null : rawMilestone.trim();
  }

  // Same "absent, null and blank all mean the same thing" rule milestone
  // above follows, plus a grammar check: an assignee that is not a studio id
  // could never match a label the Worker writes, so accepting one would file
  // a task nobody can ever be handed.
  let assignee: string | null = null;
  const rawAssignee = body.assignee;
  if (rawAssignee !== undefined && rawAssignee !== null) {
    if (typeof rawAssignee !== "string") return { ok: false, message: "assignee must be a string (a studio id)" };
    const trimmed = rawAssignee.trim();
    if (trimmed !== "") {
      if (!parseStudioId(trimmed)) {
        return { ok: false, message: `assignee ${JSON.stringify(trimmed)} is not a studio id — expected "<repo>--<role>"` };
      }
      assignee = trimmed;
    }
  }

  // Boolean only: a string "true" from a hand-rolled request is a caller bug,
  // and quietly treating it as yes would authorize a junior nobody chose.
  const rawJunior = body.junior;
  if (rawJunior !== undefined && rawJunior !== null && typeof rawJunior !== "boolean") {
    return { ok: false, message: "junior must be a boolean" };
  }

  const brief: TaskBrief = {
    title, objective, outputFormat, boundaries, milestone, assignee,
    ...(rawJunior === true ? { junior: true } : {}),
  };
  const rawKey = body.idempotencyKey;
  if (rawKey !== undefined && rawKey !== null) {
    if (typeof rawKey !== "string" || !IDEMPOTENCY_KEY.test(rawKey)) {
      return { ok: false, message: "idempotencyKey must be 8-128 chars of [A-Za-z0-9_-]" };
    }
    brief.idempotencyKey = rawKey;
  }
  const body_ = renderTaskBody(brief);
  if (body_.length > TASK_BODY_MAX) {
    return { ok: false, message: `task body is ${body_.length} chars, over GitHub's ${TASK_BODY_MAX}-char issue body limit` };
  }
  return { ok: true, brief };
}

/**
 * The issue body a human reads on the phone and a team reads as its whole
 * instruction set.
 *
 * The footer is not decoration: the single-writer rule is invisible in
 * GitHub's own UI, where every label is one click away for anyone with write
 * access. An issue that does not carry the rule gets hand-labelled, and the
 * drift class the Worker exists to prevent starts on the board itself.
 */
export function renderTaskBody(brief: TaskBrief): string {
  return [
    "## Objective",
    "",
    brief.objective,
    "",
    "## Output format",
    "",
    brief.outputFormat,
    "",
    "## Boundaries",
    "",
    brief.boundaries,
    "",
    "---",
    "",
    "Fleet board task. The Worker is the single writer of state labels — " +
      "do not label, close or reopen this issue by hand.",
    "",
    ...(brief.idempotencyKey === undefined ? [] : [taskKeyMarker(brief.idempotencyKey), ""]),
  ].join("\n");
}

/**
 * The brief as the lead's own instruction block — what gets appended to the
 * role/studio system prompt at bring-up (src/studio/blueprint.ts's
 * roleBringupEnv, src/studio/studio-blueprint.ts's studioBringupEnv), so a
 * studio provisioned FOR a task starts with that task in hand instead of
 * booting into an empty prompt and waiting to be told.
 *
 * Rendered here rather than in the blueprint modules for the same reason
 * renderTaskBody is here: this is board vocabulary (an issue number, an issue
 * url, the single-writer rule), and the blueprint modules must not have to
 * know any of it. They receive a finished string.
 *
 * Three things this block MUST carry, and none of them is optional:
 *   - the issue url, so the lead can point a human at the same board row;
 *   - the report verb, spelled out as the exact command — a lead that does
 *     not know how to report invents a channel, and §2's whole point is that
 *     there is no channel except the board;
 *   - the single-writer rule, restated, because the lead has `gh` and could
 *     otherwise close its own issue and call that "done".
 */
export function renderBriefPrompt(
  task: { number: number; url: string; title: string; body: string }, studioId: string,
): string {
  return [
    `## Your task — board issue #${task.number}`,
    "",
    `${task.url}`,
    "",
    `**${task.title}**`,
    "",
    // An ADOPTED task (P5 §3) can be an issue the operator typed on his phone with a
    // title and nothing else, so the body is not guaranteed to be a rendered
    // brief — or to exist. A blank section would boot a lead into a prompt
    // that LOOKS complete and says nothing; saying the body is empty is what
    // makes "ask before inventing scope" the obvious next move.
    task.body.trim() === ""
      ? "_This issue has no body — the title above is the entire brief. " +
        "Ask before inventing scope for it._"
      : task.body.trim(),
    "",
    "---",
    "",
    `You were provisioned for this task and no other. You are \`${studioId}\` on the board.`,
    "",
    `Read it back any time: \`fleet task show ${task.number}\`. Your own tasks: \`fleet task ls\`.`,
    "",
    `Report by envelope comment, never by messaging anyone: \`fleet task report ${task.number}\` ` +
      "with the envelope JSON on stdin (run `fleet task report` with no arguments for the shape).",
    "",
    // Board issue #41, half two. A verb a lead is never told about is a verb
    // that does not exist — and the measured failure was tasks sitting at
    // `submitted` while the studio worked, which every monitor watching the
    // board read as a stalled studio.
    `Move your own state as you go: \`fleet task state ${task.number} working\` the moment you start, ` +
      `then \`input_required\` if you are blocked on an answer, \`awaiting_merge\` once you have ` +
      `reported your result (\`fleet task report\`) with a PR and there is nothing left for you to do ` +
      `but wait on the merge, or \`failed\` if you cannot finish. ` +
      "Those four, and no others.",
    "",
    "You may NOT mark this task `completed`. That is the verdict of whoever verifies the work, " +
      "not of whoever did it — report your result and let the verifier close it. " +
      "The Worker is the single writer of the board: you ask, it writes. " +
      "Never label, close or reopen the issue yourself — not with `gh`, not by hand.",
    "",
  ].join("\n");
}
