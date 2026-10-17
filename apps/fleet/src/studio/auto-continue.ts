import type { Activity } from "./activity";
import type { BoardTaskState } from "../board/types";

export const AUTO_CONTINUE_IDLE_MS = 10 * 60_000;
export const AUTO_CONTINUE_EVERY_MS = 20 * 60_000;
export const AUTO_CONTINUE_MAX_NUDGES = 6;

/** DO key: `{ taskNumber, nudgeCount, lastNudgeAt, escalated }`. */
export const AUTO_CONTINUE_KEY = "autoContinue";

export interface AutoContinueState {
  taskNumber: number;
  /** Nudges already sent for `taskNumber`. */
  nudgeCount: number;
  /** Last nudge ISO, or null. */
  lastNudgeAt: string | null;
  /** Escalation already raised for `taskNumber` after the cap. */
  escalated: boolean;
}

export interface AutoContinueInput {
  leadType: "claude" | "glm";
  activity: Activity | null;
  now: Date;
  task: { number: number; state: BoardTaskState | null; open: boolean } | null;
  lastNudgeAt: string | null;
  nudgeCountForTask: number;
  alreadyEscalated: boolean;
}

export type AutoContinueDecision =
  | { kind: "nudge"; taskNumber: number }
  | { kind: "escalate"; taskNumber: number }
  | { kind: "none" };

/** The one-line prompt, the same pointer-free "do it now" shape #1112 asks
 *  for. One line always: a literal newline in the TUI is a submit. */
export function autoContinuePrompt(taskNumber: number): string {
  return `Continue your board task #${taskNumber} now; do not stop between steps.`;
}

/**
 * The decision. Guard order matters and is the test surface: lead type, then
 * the activity state (idle already means the claude window is active, no
 * modal is open, the input box is empty, and "esc to interrupt" is absent —
 * every other state fails this gate), then idle age, then the board task
 * (open, submitted/working only), then the 20-minute rate window, then the
 * per-task cap.
 */
export function shouldAutoContinue(input: AutoContinueInput): AutoContinueDecision {
  if (input.leadType !== "glm") return { kind: "none" };
  const act = input.activity;
  if (act === null || act.state !== "idle") return { kind: "none" };
  const idleMs = input.now.getTime() - Date.parse(act.since);
  if (!Number.isFinite(idleMs) || idleMs < AUTO_CONTINUE_IDLE_MS) return { kind: "none" };
  if (input.task === null || !input.task.open) return { kind: "none" };
  if (input.task.state !== "submitted" && input.task.state !== "working") return { kind: "none" };
  const lastMs = Date.parse(input.lastNudgeAt ?? "");
  if (Number.isFinite(lastMs) && input.now.getTime() - lastMs < AUTO_CONTINUE_EVERY_MS) return { kind: "none" };
  if (input.nudgeCountForTask >= AUTO_CONTINUE_MAX_NUDGES) {
    return input.alreadyEscalated ? { kind: "none" } : { kind: "escalate", taskNumber: input.task.number };
  }
  return { kind: "nudge", taskNumber: input.task.number };
}

/** The storage slice idleAutoContinue touches — narrow keyed port. */
export interface AutoContinueStorage {
  get(key: typeof AUTO_CONTINUE_KEY): Promise<AutoContinueState | undefined>;
  put(key: typeof AUTO_CONTINUE_KEY, value: AutoContinueState): Promise<void>;
}

/** Side-effect ports, injected so the tick is testable with no DO. */
export interface IdleAutoContinueDeps {
  now: () => Date;
  leadType: "claude" | "glm";
  activity: Activity | null;
  findTask: () => Promise<{ number: number; state: BoardTaskState | null; open: boolean } | null>;
  wake: (prompt: string) => Promise<{ ok: boolean }>;
  escalate: (taskNumber: number) => Promise<void>;
}

/**
 * One auto-continue evaluation, run from the ship tick while the lead is
 * idle. Cheap gates (lead type, activity) run before any board read; the
 * board read itself is skipped while the 20-minute window has not elapsed and
 * the cap is not yet due to escalate. Never throws — a board hiccup waits for
 * the next tick, same posture staleShellNudge keeps.
 */
export async function idleAutoContinue(deps: IdleAutoContinueDeps, storage: AutoContinueStorage, id: string): Promise<void> {
  if (deps.leadType !== "glm") return;
  const act = deps.activity;
  if (act === null || act.state !== "idle") return;
  const idleMs = deps.now().getTime() - Date.parse(act.since);
  if (!Number.isFinite(idleMs) || idleMs < AUTO_CONTINUE_IDLE_MS) return;
  const prev = (await storage.get(AUTO_CONTINUE_KEY)) ?? null;
  const lastMs = Date.parse(prev?.lastNudgeAt ?? "");
  const rateLimited = Number.isFinite(lastMs) && deps.now().getTime() - lastMs < AUTO_CONTINUE_EVERY_MS;
  const escalationDue = (prev?.nudgeCount ?? 0) >= AUTO_CONTINUE_MAX_NUDGES && !(prev?.escalated ?? false);
  if (rateLimited && !escalationDue) return;
  const task = await deps.findTask();
  const nudgeCountForTask = prev?.taskNumber === task?.number ? prev.nudgeCount : 0;
  const alreadyEscalated = prev?.taskNumber === task?.number && prev.escalated;
  const decision = shouldAutoContinue({
    leadType: deps.leadType, activity: act, now: deps.now(), task,
    lastNudgeAt: prev?.lastNudgeAt ?? null, nudgeCountForTask, alreadyEscalated,
  });
  if (decision.kind === "none") return;
  if (decision.kind === "nudge") {
    const outcome = await deps.wake(autoContinuePrompt(decision.taskNumber));
    if (!outcome.ok) return;
    await storage.put(AUTO_CONTINUE_KEY, {
      taskNumber: decision.taskNumber, nudgeCount: nudgeCountForTask + 1,
      lastNudgeAt: deps.now().toISOString(), escalated: false,
    });
    return;
  }
  try {
    await deps.escalate(decision.taskNumber);
    await storage.put(AUTO_CONTINUE_KEY, {
      taskNumber: decision.taskNumber, nudgeCount: nudgeCountForTask,
      lastNudgeAt: deps.now().toISOString(), escalated: true,
    });
  } catch (err) {
    console.error(`studio ${id}: auto-continue escalation failed, next tick retries`, err);
  }
}