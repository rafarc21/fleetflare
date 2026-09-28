import { appendEvent } from "../events/log";
import { makeEvent, type FleetEvent } from "../events/schema";
import { routeDecision } from "../events/rules";
import { sendCard, editCard, type InlineButton } from "../telegram/api";
import { createApproval, setApprovalMessageId } from "../approvals/store";
import { GATE_LABELS, type TaskStatus } from "./types";
import type { AgentRuntime } from "../agents/runtime";

/** Everything the DO must persist between polls. Plain data, no methods. */
export interface TaskRecord {
  taskId: string;
  agentId: string;
  project: string;
  thread: string | null;
  chatId: string;
  liveMessageId: number | null;
  startedTs: number;
  lastHeartbeat: number;
  failedPolls: number;
  /** How many milestones have already been logged and rendered. */
  shownMilestones: number;
}

export interface LoopDeps {
  db: D1Database;
  runtime: AgentRuntime;
  botToken: string;
  now: number;
  maxTaskSeconds: number;
  maxFailedPolls: number;
}

export type LoopOutcome =
  | { kind: "continue"; task: TaskRecord }
  | { kind: "terminal"; task: TaskRecord };

function rid(): string {
  return crypto.randomUUID().slice(0, 8);
}

function card(task: TaskRecord, milestones: string[]): string {
  const lines = milestones.map((m) => `• ${m}`).join("\n");
  return `Working — ${task.taskId}\n${lines}`;
}

/**
 * Appends the event to D1 and returns it. The event log is the record;
 * routing and notification, when needed, are the caller's job (see
 * terminalMessage, which uses the returned event to gate a human send).
 */
async function report(
  deps: LoopDeps, task: TaskRecord, to: string, body: string,
): Promise<FleetEvent> {
  const evt = makeEvent(
    {
      from: task.agentId, to, kind: "report",
      project: task.project, thread: task.thread, ref: task.taskId, body,
    },
    deps.now, rid(),
  );
  await appendEvent(deps.db, evt);
  return evt;
}

/**
 * Logs first, unconditionally — the log is the record even of a message
 * `routeDecision` goes on to refuse (strictly better than Day 1, which
 * dropped a refused reply with no trace at all). Only the Telegram send is
 * gated. `recent: []` — the escalation-dedupe branch never fires here since
 * neither this kind nor an approval_request is ever "escalation"; populated
 * dedupe is deferred to Spec B.
 */
async function terminalMessage(deps: LoopDeps, task: TaskRecord, body: string): Promise<void> {
  const evt = await report(deps, task, "human", body);

  const decision = routeDecision(evt, []);
  if (!decision.allow) {
    await report(deps, task, task.agentId, `suppressed: ${decision.reason}`);
    return;
  }
  if (!decision.toHuman) return;

  try {
    await sendCard(deps.botToken, task.chatId, body);
  } catch (err) {
    // Never unwind a logged event over a delivery failure. Day 1 rule.
    console.error("terminal notify failed", err);
    // console.error only reaches a Workers log nobody reads. Record it as
    // its own event too, so it exists somewhere queryable from D1 — the
    // operator is often unattended when this fires. `to: task.agentId`, not
    // "human": this is a report about a failed delivery TO human, so
    // addressing it to "human" would put it in the same queried inbox as
    // the reply that never arrived.
    await report(
      deps, task, task.agentId,
      `telegram delivery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * One poll cycle. Pure with respect to the Durable Object: everything it needs
 * arrives in deps, everything it changes comes back in the returned TaskRecord.
 * The DO persists that record and reschedules; it holds no logic of its own.
 */
export async function advanceTask(deps: LoopDeps, task: TaskRecord): Promise<LoopOutcome> {
  // Budget first, before spending another poll on a task that is already over.
  if ((deps.now - task.startedTs) / 1000 > deps.maxTaskSeconds) {
    try {
      await deps.runtime.abort();
    } catch (err) {
      console.error("abort failed", err);
    }
    await terminalMessage(
      deps, task,
      `Task ${task.taskId} aborted: exceeded the ${deps.maxTaskSeconds}s budget.`,
    );
    return { kind: "terminal", task };
  }

  let status: TaskStatus;
  try {
    status = await deps.runtime.status();
  } catch (err) {
    const failedPolls = task.failedPolls + 1;
    if (failedPolls >= deps.maxFailedPolls) {
      await terminalMessage(
        deps, task,
        `Task ${task.taskId} lost: container unreachable after ${failedPolls} polls. ` +
        `Last error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: "terminal", task: { ...task, failedPolls } };
    }
    // Below threshold: still worth a queryable record. Day 1 recorded a
    // runtime failure on the first occurrence; a transient container blip
    // must not be invisible in D1 until it crosses maxFailedPolls.
    await report(
      deps, task, task.agentId,
      `poll ${failedPolls}/${deps.maxFailedPolls} failed: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "continue", task: { ...task, failedPolls } };
  }

  let next: TaskRecord = { ...task, failedPolls: 0, lastHeartbeat: deps.now };

  // New milestones: log every one, render all of them into the single card.
  const fresh = status.milestones.slice(next.shownMilestones);
  if (fresh.length > 0) {
    for (const m of fresh) {
      await report(deps, next, next.agentId, m.text);
    }
    const all = status.milestones.map((m) => m.text);
    try {
      if (next.liveMessageId === null) {
        next.liveMessageId = await sendCard(deps.botToken, next.chatId, card(next, all));
      } else {
        await editCard(deps.botToken, next.chatId, next.liveMessageId, card(next, all));
      }
    } catch (err) {
      console.error("live card update failed", err);
    }
    next.shownMilestones = status.milestones.length;
  }

  if (status.state === "running" || status.state === "idle") {
    return { kind: "continue", task: next };
  }

  if (status.state === "failed") {
    await terminalMessage(
      deps, next, `Task ${next.taskId} failed: ${status.error ?? "no error reported"}`,
    );
    return { kind: "terminal", task: next };
  }

  // done
  if (status.pendingApproval) {
    const id = `appr_${deps.now.toString(36)}_${rid()}`;
    const eventBody =
      `${GATE_LABELS[status.pendingApproval.action]} — ` +
      `${JSON.stringify(status.pendingApproval.params)}`;
    const evt = makeEvent(
      {
        from: next.agentId, to: "human", kind: "approval_request",
        project: next.project, thread: next.thread, ref: id, body: eventBody,
      },
      deps.now, rid(),
    );
    await appendEvent(deps.db, evt);
    await createApproval(
      deps.db,
      {
        id, eventId: evt.id, project: next.project,
        action: status.pendingApproval.action,
        params: status.pendingApproval.params,
        chatId: next.chatId,
      },
      deps.now,
    );

    // Same gate as terminalMessage, same reasoning: the approval_request
    // event and its D1 row are already logged above unconditionally; only
    // the Telegram send is gated. recent: [] — see terminalMessage's note.
    const decision = routeDecision(evt, []);
    if (!decision.allow) {
      await report(deps, next, next.agentId, `suppressed: ${decision.reason}`);
      return { kind: "terminal", task: next };
    }

    if (decision.toHuman) {
      const buttons: InlineButton[] = [
        { text: "Approve", callbackData: `${id}:yes` },
        { text: "Reject", callbackData: `${id}:no` },
      ];
      try {
        const messageId = await sendCard(
          deps.botToken, next.chatId,
          `${GATE_LABELS[status.pendingApproval.action]}?\n${eventBody}`,
          buttons,
        );
        await setApprovalMessageId(deps.db, id, messageId);
      } catch (err) {
        // The row stays pending and queryable even if the message never lands.
        console.error("approval card failed", err);
        await report(
          deps, next, next.agentId,
          `telegram delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { kind: "terminal", task: next };
  }

  const cost = status.costUsd === null ? "" : ` (cost $${status.costUsd})`;
  await terminalMessage(
    deps, next, `${status.result ?? `Task ${next.taskId} done.`}${cost}`,
  );
  return { kind: "terminal", task: next };
}
