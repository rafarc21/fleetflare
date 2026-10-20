// #1232: the gate drain flag and its pending queue. A Worker deploy sets
// `gate_drain` while it drains running gate runs, so a run started mid-leg
// would be killed by the deploy. While the flag is set, a pull_request
// delivery (autoRunFromEnv) and the manual start route both queue instead of
// start. The every-minute cron (drainPendingGateRuns) releases the queue once
// the flag clears. A pending status still goes up for the queued PR, so GitHub
// never sees the head without a gate (#1191).
import type { PullRequestAutoRun } from "./auto-run";
import { getFlag, flagIsSet } from "../state";

export const GATE_DRAIN_FLAG = "gate_drain";
export const GATE_DRAIN_QUEUE_KEY = "gate_drain_pending";

/** The pending queue, stored as one JSON array over fleet_state. `append` and
 *  `remove` are each one D1 statement (json_insert / json_remove by path), so a
 *  concurrent append and a release remove never lose an entry — no read-then-
 *  write whole-queue rewrite. */
export interface GateDrainQueue {
  peek(): Promise<PullRequestAutoRun[]>;
  /** Atomically appends one pending run, in a single statement. */
  append(pr: PullRequestAutoRun): Promise<void>;
  /** Atomically removes one queued entry (matched by repo/pr/headSha). */
  remove(pr: PullRequestAutoRun): Promise<void>;
}

export function gateDrainQueue(db: D1Database): GateDrainQueue {
  return {
    async peek(): Promise<PullRequestAutoRun[]> {
      const raw = await getFlag(db, GATE_DRAIN_QUEUE_KEY);
      if (raw === null) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as PullRequestAutoRun[]) : [];
      } catch {
        // Fail-closed: a corrupt queue drops nothing and starts nothing.
        return [];
      }
    },
    async append(pr: PullRequestAutoRun): Promise<void> {
      const entry = JSON.stringify(pr);
      await db
        .prepare(
          `INSERT INTO fleet_state (key, value, ts) VALUES (?, json_array(json(?)), ?)
           ON CONFLICT(key) DO UPDATE SET value = json_insert(value, '$[#]', json(?)), ts = excluded.ts`,
        )
        .bind(GATE_DRAIN_QUEUE_KEY, entry, Date.now(), entry)
        .run();
    },
    async remove(pr: PullRequestAutoRun): Promise<void> {
      // json_remove by path, in one statement. Two miniflare-D1 quirks forced a
      // deviation from the plain form: (1) the implicit `json_each(value)`
      // correlation is NOT resolved here — the path subquery returns NULL — so
      // the row is read through an explicit subselect; (2) json_remove(value,
      // NULL) returns NULL (not the input) on SQLite, tripping the value NOT
      // NULL constraint, so a WHERE EXISTS guard keeps the UPDATE a no-op for
      // an already-removed (or never-queued) entry. Matched by repo/pr/headSha:
      // `$.pr` extracts a number, matching pr.pr, a number; repo/headSha are strings.
      await db
        .prepare(
          `UPDATE fleet_state SET value = json_remove(
             value,
             (SELECT '$[' || CAST(e.key AS TEXT) || ']'
              FROM json_each((SELECT value FROM fleet_state WHERE key = ?)) e
              WHERE json_extract(e.value, '$.repo') = ? AND json_extract(e.value, '$.pr') = ? AND json_extract(e.value, '$.headSha') = ? LIMIT 1)
           ), ts = ? WHERE key = ? AND EXISTS (
             SELECT 1 FROM json_each((SELECT value FROM fleet_state WHERE key = ?)) e
             WHERE json_extract(e.value, '$.repo') = ? AND json_extract(e.value, '$.pr') = ? AND json_extract(e.value, '$.headSha') = ?
           )`,
        )
        .bind(GATE_DRAIN_QUEUE_KEY, pr.repo, pr.pr, pr.headSha, Date.now(), GATE_DRAIN_QUEUE_KEY, GATE_DRAIN_QUEUE_KEY, pr.repo, pr.pr, pr.headSha)
        .run();
    },
  };
}

/** A drain flag older than this is a crashed/abandoned run's: it reads as
 *  not-draining and is cleared, so one stuck flag never blocks every gate.
 *  Longer than the 15-min wait cap plus the deploy itself. */
export const GATE_DRAIN_STALE_MS = 20 * 60_000;

/** Deletes the drain flag only while it still carries the ts this caller read:
 *  a fresh flag re-set between the read and this delete (a new deploy) must
 *  survive, never be wiped by a stale read (#1232 review). */
export async function clearStaleDrainFlag(db: D1Database, stamp: number): Promise<void> {
  if (!Number.isFinite(stamp)) {
    // A non-numeric ts (a corrupt row stores TEXT, never a number) can never
    // match a numeric stamp. Delete it by its storage type, still conditional
    // so a fresh numeric re-set between the read and this delete survives.
    await db
      .prepare(`DELETE FROM fleet_state WHERE key = ? AND typeof(ts) NOT IN ('integer', 'real')`)
      .bind(GATE_DRAIN_FLAG)
      .run();
    return;
  }
  await db
    .prepare(`DELETE FROM fleet_state WHERE key = ? AND ts = ?`)
    .bind(GATE_DRAIN_FLAG, stamp)
    .run();
}

/** Whether a Worker deploy is currently draining running gate runs. A flag set
 *  more than GATE_DRAIN_STALE_MS ago is stale (the deploy script's trap clears
 *  it on every path, so a surviving old flag is a crashed run): it reads as
 *  not-draining and is cleared, never blocking a gate. */
export async function gateDraining(db: D1Database): Promise<boolean> {
  if (!(await flagIsSet(db, GATE_DRAIN_FLAG))) return false;
  const row = await db
    .prepare(`SELECT ts FROM fleet_state WHERE key = ?`)
    .bind(GATE_DRAIN_FLAG)
    .first<{ ts: number }>();
  const stamp = Number(row?.ts);
  // A non-numeric ts (NaN) must read stale, never "draining forever".
  if (!Number.isFinite(stamp) || Date.now() - stamp > GATE_DRAIN_STALE_MS) {
    await clearStaleDrainFlag(db, stamp);
    return false;
  }
  return true;
}