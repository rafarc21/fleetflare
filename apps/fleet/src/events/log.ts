import type { EventKind, FleetEvent } from "./schema";

interface Row {
  id: string;
  ts: number;
  from_agent: string;
  to_agent: string;
  kind: string;
  project: string;
  ref: string | null;
  thread: string | null;
  body: string;
  requires_ack: number;
}

function toEvent(r: Row): FleetEvent {
  return {
    id: r.id,
    ts: r.ts,
    from: r.from_agent,
    to: r.to_agent,
    kind: r.kind as EventKind,
    project: r.project,
    ref: r.ref,
    thread: r.thread,
    body: r.body,
    requiresAck: r.requires_ack === 1,
  };
}

/**
 * Inserts the event and reports whether it actually landed. `id` is the
 * conflict target (schema: `id TEXT PRIMARY KEY`) — a caller that derives a
 * deterministic id (e.g. Telegram's `update_id`) gets a silent no-op instead
 * of a duplicate row when the same id is appended twice. Callers that don't
 * care (a fresh random id from `makeEvent` never collides) can keep
 * discarding the return value; `do.ts` does exactly that.
 */
export async function appendEvent(db: D1Database, e: FleetEvent): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO events (id, ts, from_agent, to_agent, kind, project, ref, thread, body, requires_ack)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(e.id, e.ts, e.from, e.to, e.kind, e.project, e.ref, e.thread, e.body, e.requiresAck ? 1 : 0)
    .run();
  return res.meta.changes > 0;
}

export async function readSince(db: D1Database, to: string, sinceTs: number): Promise<FleetEvent[]> {
  const res = await db
    .prepare(`SELECT * FROM events WHERE to_agent = ? AND ts > ? ORDER BY ts ASC`)
    .bind(to, sinceTs)
    .all<Row>();
  return (res.results ?? []).map(toEvent);
}
