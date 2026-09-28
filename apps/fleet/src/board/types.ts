// The board's vocabulary — P4 §5/§6. GitHub Issues IS the board (a Worker DO
// table was rejected outright: invisible to the operator, no URL per task, no
// mobile app, no comments). Everything in this directory reads and writes
// that board; nothing else in the fleet may.
//
// Two rulings are encoded here rather than left to callers:
//
//   1. The state vocabulary is A2A's, borrowed verbatim, so a later migration
//      to that protocol is a RENAME and not a rewrite. Six states, closed
//      set, no synonyms.
//   2. The Worker is the board's SINGLE WRITER of state. Agents never label,
//      close, or reopen an issue. That is what kills the state-drift class
//      the websites fleet already paid for once — a merged PR whose issue
//      still claimed "in progress". Deploy truth is measured from branch +
//      host, NEVER from a label.
//
// `taskStates` lives beside the vocabulary, not in the module that consumes
// it, because two readers of one closed set is one drift risk too many:
// src/board/api.ts maps a raw issue with it and src/board/board.ts gates a
// transition on it.

export const TASK_STATES = [
  "submitted", "working", "input_required", "completed", "failed", "canceled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Finished work. None of these closes the issue — sprint close does. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ["completed", "failed", "canceled"];
/** Work still owed: what a studio may be briefed on. */
export const LIVE_TASK_STATES: readonly TaskState[] = ["submitted", "working", "input_required"];

export function isTaskState(raw: unknown): raw is TaskState {
  return typeof raw === "string" && (TASK_STATES as readonly string[]).includes(raw);
}

/** Junior (Workers AI delegation): a task carrying this label lets its
 *  assigned studio call /fleet/junior while the task is live. Written only by
 *  createTask, only when the maestro filed it with `fleet task new --junior`. */
export const JUNIOR_LABEL = "junior";

/**
 * Every board state label carried by one issue, in vocabulary order.
 *
 * Returns a LIST, not a single state, on purpose: "no state label" and "two
 * state labels" are both real, both mean a writer other than this Worker
 * touched the issue, and both have to be distinguishable from a healthy
 * single-state issue by the caller that refuses to write over them. Collapse
 * that to `TaskState | null` here and the ambiguous case becomes
 * indistinguishable from the absent one.
 */
export function taskStates(labels: string[]): TaskState[] {
  return TASK_STATES.filter((s) => labels.includes(s));
}

/**
 * §5 assignment: WHICH studio owns this task. A label, for three reasons, and
 * the first is the only one that is about safety:
 *
 *   1. Labels are already the Worker's own channel — it is the single writer
 *      of them, and no agent-facing route adds one. Assignment therefore
 *      inherits, unchanged, the property that keeps state honest: a studio
 *      cannot assign itself anything.
 *   2. GitHub filters issues by label SERVER-side, so "the tasks assigned to
 *      me" is one request with the filter applied before the response is
 *      built — a studio never receives a row it may not read, rather than
 *      receiving the board and being trusted to drop the rest.
 *   3. It is visible on the phone, in the GitHub UI, with no tooling.
 *
 * The two rejected alternatives, and why: GitHub's own `assignee` needs a
 * GitHub USER, and a studio is not one (the App installation cannot assign a
 * non-collaborator, and inventing a user-to-studio map is a second identity
 * system). A body field would put assignment inside the brief prose that
 * src/board/brief.ts renders for humans, which means parsing it back out with
 * a second, weaker parser and losing the server-side filter entirely.
 */
export const STUDIO_LABEL_PREFIX = "studio:";

/** The assignment label for one studio id. Never call this with anything but
 *  a studio id the Worker itself resolved — see board.ts's createTask, which
 *  is the only writer. */
export function studioLabel(studioId: string): string {
  return `${STUDIO_LABEL_PREFIX}${studioId}`;
}

/**
 * Every studio-assignment label carried by one issue, as the ids inside them.
 *
 * A LIST, not one id, for exactly the reason taskStates above returns one:
 * zero and two are both real, both mean a writer other than this Worker
 * touched the issue, and a caller deciding whether to hand a brief over has
 * to be able to tell them apart from a healthy single assignment.
 *
 * Values are carried VERBATIM, including one that is not a valid studio id.
 * A hand-typed `studio:oops` is drift and has to stay visible; silently
 * dropping it would make a mislabelled task read as unassigned. Nothing is
 * granted by a bad value either way — every ownership check compares against
 * an id the Worker resolved from a spawn token, never against this list's
 * shape.
 */
export function taskAssignees(labels: string[]): string[] {
  return labels
    .filter((l) => l.startsWith(STUDIO_LABEL_PREFIX))
    .map((l) => l.slice(STUDIO_LABEL_PREFIX.length))
    .filter((id) => id !== "");
}

/**
 * P5 §3: BACKLOG = on the board, no studio assigned. That is the whole
 * definition — not a label, not a state, not a list somebody maintains.
 *
 * It has to be derived rather than stored for the reason the feature exists:
 * the operator files an issue from his phone with raw `gh issue create`, and a
 * definition that depended on the Worker having stamped something would make
 * that issue invisible — filed, and inert. Anything with no `studio:` label
 * is backlog, however it arrived.
 */
export function isBacklog(labels: string[]): boolean {
  return taskAssignees(labels).length === 0;
}

/**
 * How long a task sits unassigned before the Worker flags it stale.
 *
 * Three days: longer than the two-day sprint a task could plausibly be
 * waiting out, so "survived a whole sprint with nobody on it" is the signal
 * rather than "filed yesterday evening".
 */
export const BACKLOG_STALE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The states that mean something OTHER than "waiting for someone to pick this
 * up", so an unassigned task carrying one is not stale:
 *   - `input_required` is the blocker state — it is waiting on an answer, and
 *     the answer is what unblocks it, not an assignment;
 *   - the three terminal states are finished work, and flagging finished work
 *     as neglected is pure noise on a board the operator reads on his phone.
 */
const NOT_STALE_STATES: readonly TaskState[] = ["input_required", "completed", "failed", "canceled"];

/**
 * P5 §3's stale flag: age + no blockers + no assignment, computed MECHANICALLY
 * and nothing more. What to do about it is Maestro's judgement — this function
 * deliberately has no opinion, files nothing, and pings nobody. Detection is
 * mechanical; the call is judgement, and an agent that auto-triaged the two
 * together is exactly what the design refused.
 *
 * Age is measured from `updatedAt`, not from creation: a task somebody
 * commented on yesterday is being talked about, and "nothing has happened to
 * this in three days" is the signal worth surfacing. An unparseable timestamp
 * is never stale — a flag raised by a formatting surprise would be worse than
 * no flag at all.
 */
export function isStaleBacklog(
  task: Pick<BoardTask, "labels" | "open" | "updatedAt">, nowMs: number,
): boolean {
  if (!task.open || !isBacklog(task.labels)) return false;
  if (taskStates(task.labels).some((s) => NOT_STALE_STATES.includes(s))) return false;
  const updated = Date.parse(task.updatedAt);
  return !Number.isNaN(updated) && nowMs - updated >= BACKLOG_STALE_MS;
}

/** One task as the fleet sees it. `state` is null whenever `taskStates` did
 *  not find exactly one label — the drift signal, carried rather than
 *  hidden; `labels` rides along so a caller can say WHAT it found. */
export interface BoardTask {
  number: number;
  /** The issue's own html_url. The reason Issues won over a DO table: every
   *  task is addressable, on the phone, without this fleet running. */
  url: string;
  title: string;
  /** The issue body — the brief itself (src/board/brief.ts). Carried on
   *  every task because GitHub returns it on the list endpoint too, so a
   *  team reading its own brief costs no extra call. */
  body: string;
  state: TaskState | null;
  labels: string[];
  /**
   * The studio this task belongs to, or null when `taskAssignees` did not
   * find exactly one — same drift-carrying shape `state` above uses, and
   * for the same reason. Null covers both "nobody owns this yet" and "two
   * writers disagree about who does"; `labels` rides along so a caller can
   * say which it found.
   */
  assignee: string | null;
  /** Sprint. §5: sprint = milestone, board = milestone-filtered issue list. */
  milestone: string | null;
  /** GitHub's own open/closed, which is NOT the board's state vocabulary —
   *  sprint close is what closes an issue, and that is a later task. A
   *  terminal board state (completed/failed/canceled) leaves the issue open. */
  open: boolean;
  updatedAt: string;
}

/**
 * One task as a LIST row — the board plus the one thing a single task cannot
 * know about itself: whether it has been sitting there.
 *
 * Separate from BoardTask rather than a field on it, because `stale` is not a
 * property of the issue. It is a property of the issue AND the clock, and
 * every other BoardTask producer (a create, a transition, a show) returns a
 * task at the instant it was written, where the answer is trivially no.
 */
export interface BoardTaskView extends BoardTask {
  /** P5 §3, stamped server-side by src/board/board.ts's listTasks. */
  stale: boolean;
}

export const ENVELOPE_INTENTS = ["request", "result", "error", "clarify", "escalate"] as const;
export type EnvelopeIntent = (typeof ENVELOPE_INTENTS)[number];

export const ENVELOPE_STATUSES = ["ok", "partial", "failed", "blocked"] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

/** §6: `{path|pr|url, kind, digest}`. At least one locator, or the artifact
 *  names nothing and the evidence trail has a hole in it. */
export interface EnvelopeArtifact {
  kind: string;
  path?: string;
  pr?: string;
  url?: string;
  digest?: string;
}

/**
 * P5 guardrails spec §4: where a HUMAN checks the deliverable landed — URL,
 * steps to reproduce, expected result. Every studio, every task, every
 * domain — not code-only, unlike `evidence` above (build/lint/check/test,
 * which only a code-writing studio can produce). Required on every graded
 * result (intent "result" — ok, partial, failed or blocked): the Stop gate
 * demands it the same way it already demands test evidence. Optional on
 * every other envelope shape, which has nothing finished yet to verify.
 * See src/board/envelope.ts's parseEnvelope for the exact rule and
 * test/board.envelope.test.ts for the satisfiability tests (a
 * wrongly-firing gate wedges the studio).
 */
export interface EnvelopeVerification {
  url: string;
  steps: string[];
  expected: string;
}

/**
 * §6's envelope, stored verbatim in its own shape (snake_case, nested
 * envelope/payload/notes) — the schema is the migration surface, so it is
 * not renamed on the way in or out.
 *
 * `msg_id` and `schema_version` are absent from what a caller sends: they are
 * the single writer's stamp, minted here, and a caller that could set them
 * could forge threading. See src/board/envelope.ts's parseEnvelope.
 */
export interface EnvelopeDoc {
  envelope: {
    msg_id: string;
    task_id: number;
    sender: string;
    intent: EnvelopeIntent;
    schema_version: string;
  };
  payload: {
    status: EnvelopeStatus;
    artifacts: EnvelopeArtifact[];
    /** Commands run, checks passed. §6: no unverified claims. */
    evidence: string[];
    /** §4: absent unless intent is "result" — see EnvelopeVerification. */
    verification?: EnvelopeVerification;
    /** Structural slot so the schema never forces a guess — fail-to-ask is
     *  6.8-11.65% of agent failures. Empty is an answer; absent is not. */
    open_questions: string[];
    /** Key decisions and assumptions, against the implicit-decision class. */
    context_digest: string[];
    /** §8's memory pipeline, later. Carried now so envelopes written today
     *  are still harvestable then. */
    learnings: string[];
  };
  notes: string;
}
