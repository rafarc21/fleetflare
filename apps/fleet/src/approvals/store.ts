import type { GateAction } from "../tasks/types";

export type ApprovalState = "pending" | "approved" | "rejected" | "executed" | "failed";

export interface ApprovalRow {
  id: string;
  eventId: string;
  project: string;
  action: GateAction;
  params: Record<string, string>;
  state: ApprovalState;
  requestedTs: number;
  decidedTs: number | null;
  decidedBy: string | null;
  chatId: string;
  messageId: number | null;
  result: string | null;
}

export interface NewApproval {
  id: string;
  eventId: string;
  project: string;
  action: GateAction;
  params: Record<string, string>;
  chatId: string;
}

interface Row {
  id: string; event_id: string; project: string; action: string;
  params: string; state: string; requested_ts: number;
  decided_ts: number | null; decided_by: string | null;
  chat_id: string; message_id: number | null; result: string | null;
}

function toApproval(r: Row): ApprovalRow {
  return {
    id: r.id,
    eventId: r.event_id,
    project: r.project,
    action: r.action as GateAction,
    params: JSON.parse(r.params) as Record<string, string>,
    state: r.state as ApprovalState,
    requestedTs: r.requested_ts,
    decidedTs: r.decided_ts,
    decidedBy: r.decided_by,
    chatId: r.chat_id,
    messageId: r.message_id,
    result: r.result,
  };
}

export async function createApproval(
  db: D1Database, input: NewApproval, now: number,
): Promise<ApprovalRow> {
  await db
    .prepare(
      `INSERT INTO approvals (id, event_id, project, action, params, state, requested_ts, chat_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      input.id, input.eventId, input.project, input.action,
      JSON.stringify(input.params), now, input.chatId,
    )
    .run();
  const row = await getApproval(db, input.id);
  if (!row) throw new Error(`approval ${input.id} vanished immediately after insert`);
  return row;
}

export async function getApproval(db: D1Database, id: string): Promise<ApprovalRow | null> {
  const r = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<Row>();
  return r ? toApproval(r) : null;
}

export async function setApprovalMessageId(
  db: D1Database, id: string, messageId: number,
): Promise<void> {
  await db
    .prepare(`UPDATE approvals SET message_id = ? WHERE id = ?`)
    .bind(messageId, id)
    .run();
}

/**
 * Transitions pending -> approved|rejected, once. The `state = 'pending'`
 * predicate is the whole idempotency guarantee: Telegram redelivers callback
 * queries and a human can double-tap before the keyboard is edited away.
 * Returns false when the row is missing or already decided.
 */
export async function decideApproval(
  db: D1Database,
  id: string,
  state: "approved" | "rejected",
  decidedBy: string,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE approvals SET state = ?, decided_by = ?, decided_ts = ?
       WHERE id = ? AND state = 'pending'`,
    )
    .bind(state, decidedBy, now, id)
    .run();
  return res.meta.changes > 0;
}

export async function finishApproval(
  db: D1Database, id: string, state: "executed" | "failed", result: string,
): Promise<void> {
  await db
    .prepare(`UPDATE approvals SET state = ?, result = ? WHERE id = ?`)
    .bind(state, result.slice(0, 2000), id)
    .run();
}

export async function recentApprovalsFor(
  db: D1Database, project: string, action: GateAction, sinceTs: number,
): Promise<ApprovalRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM approvals
       WHERE project = ? AND action = ? AND requested_ts >= ?
       ORDER BY requested_ts DESC`,
    )
    .bind(project, action, sinceTs)
    .all<Row>();
  return (res.results ?? []).map(toApproval);
}
