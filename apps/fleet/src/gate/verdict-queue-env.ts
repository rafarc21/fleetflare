// #1276 item 3: the D1-backed verdict-post queue, and the cron that drains it.
//
// Kept apart from verdict-queue.ts (which stays pure, no D1) so the bun-test
// project can load the queue shape and the reset-time rule without pulling in
// D1. The real queue is one JSON array over fleet_state, same statement shape
// drain.ts's gateDrainQueue already uses.
import { getFlag, setFlag } from "../state";
import {
  GATE_VERDICT_QUEUE_KEY, type QueuedVerdictPost, type VerdictQueue,
} from "./verdict-queue";

export function gateVerdictQueue(db: D1Database): VerdictQueue {
  return {
    async peek(): Promise<QueuedVerdictPost[]> {
      const raw = await getFlag(db, GATE_VERDICT_QUEUE_KEY);
      if (raw === null) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as QueuedVerdictPost[]) : [];
      } catch {
        // Fail-closed: a corrupt queue drops nothing and re-posts nothing.
        return [];
      }
    },
    async append(post: QueuedVerdictPost): Promise<void> {
      const entry = JSON.stringify(post);
      await db
        .prepare(
          `INSERT INTO fleet_state (key, value, ts) VALUES (?, json_array(json(?)), ?)
           ON CONFLICT(key) DO UPDATE SET value = json_insert(value, '$[#]', json(?)), ts = excluded.ts`,
        )
        .bind(GATE_VERDICT_QUEUE_KEY, entry, Date.now(), entry)
        .run();
    },
    async remove(post: QueuedVerdictPost): Promise<void> {
      // Same json_remove-by-path shape as drain.ts's gateDrainQueue.remove, with
      // the same two miniflare-D1 quirks that forced the explicit subselect and
      // the WHERE EXISTS guard (see that function's own comment).
      const entry = JSON.stringify(post);
      await db
        .prepare(
          `UPDATE fleet_state SET value = json_remove(
             value,
             (SELECT '$[' || CAST(e.key AS TEXT) || ']'
              FROM json_each((SELECT value FROM fleet_state WHERE key = ?)) e
              WHERE e.value = json(?) LIMIT 1)
           ), ts = ? WHERE key = ? AND EXISTS (
             SELECT 1 FROM json_each((SELECT value FROM fleet_state WHERE key = ?)) e
             WHERE e.value = json(?)
           )`,
        )
        .bind(GATE_VERDICT_QUEUE_KEY, entry, Date.now(), GATE_VERDICT_QUEUE_KEY, GATE_VERDICT_QUEUE_KEY, entry)
        .run();
    },
  };
}

/** The every-minute cron's drain: re-post every verdict whose reset time has
 *  passed, removing each from the queue once its post is confirmed. A post that
 *  fails stays queued (replayed next minute). Runs only while the gate runner
 *  is on, same switch every other gate cron path checks first. */
export async function drainVerdictQueue(
  env: { FLEET_GATE_RUNNER?: string; DB: D1Database }, post: (p: QueuedVerdictPost) => Promise<void>,
): Promise<void> {
  if (env.FLEET_GATE_RUNNER !== "on") return;
  const queue = gateVerdictQueue(env.DB);
  const now = Date.now();
  for (const p of await queue.peek()) {
    if (p.resetAt > now) continue;
    try {
      await post(p);
      await queue.remove(p);
    } catch (err) {
      console.error(`gate verdict queue: re-post failed for ${p.repo}@${p.sha.slice(0, 8)}`, err);
      // left queued; replayed next minute (its resetAt still gates the retry)
    }
  }
}

/** Rewrites the queue's value in place — used by tests only, to seed or clear
 *  the queue without going through append/remove. */
export async function __setVerdictQueueForTests(db: D1Database, posts: QueuedVerdictPost[]): Promise<void> {
  await setFlag(db, GATE_VERDICT_QUEUE_KEY, JSON.stringify(posts), Date.now());
}