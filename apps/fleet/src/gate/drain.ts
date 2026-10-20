// #1232: the gate drain flag and its pending queue. A Worker deploy sets
// `gate_drain` while it drains running gate runs, so a run started mid-leg
// would be killed by the deploy. While the flag is set, a pull_request
// delivery (autoRunFromEnv) and the manual start route both queue instead of
// start. The every-minute cron (drainPendingGateRuns) releases the queue once
// the flag clears. A pending status still goes up for the queued PR, so GitHub
// never sees the head without a gate (#1191).
import type { PullRequestAutoRun } from "./auto-run";
import { getFlag, setFlag, flagIsSet } from "../state";

export const GATE_DRAIN_FLAG = "gate_drain";
export const GATE_DRAIN_QUEUE_KEY = "gate_drain_pending";

/** The pending queue, stored as one JSON array over fleet_state. `append` is
 *  one D1 statement (json_insert), so two concurrent deliveries both land —
 *  never the read-then-write lost update src/state.ts's incrementCounter
 *  comment warns about. `claim` atomically removes the whole array in one
 *  DELETE ... RETURNING, so the cron's release cannot race a concurrent append
 *  (a concurrent append after the delete writes a fresh row, never lost). */
export interface GateDrainQueue {
  peek(): Promise<PullRequestAutoRun[]>;
  /** Atomically appends one pending run, in a single statement. */
  append(pr: PullRequestAutoRun): Promise<void>;
  /** Atomically removes and returns the whole queue. */
  claim(): Promise<PullRequestAutoRun[]>;
  /** Removes one queued entry (matched by headSha) after its run started. */
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
    async claim(): Promise<PullRequestAutoRun[]> {
      const row = await db
        .prepare(`DELETE FROM fleet_state WHERE key = ? RETURNING value`)
        .bind(GATE_DRAIN_QUEUE_KEY)
        .first<{ value: string }>();
      if (row === null) return [];
      try {
        const parsed: unknown = JSON.parse(row.value);
        return Array.isArray(parsed) ? (parsed as PullRequestAutoRun[]) : [];
      } catch {
        // A corrupt queue is dropped (and its row removed): nothing to start.
        return [];
      }
    },
    async remove(pr: PullRequestAutoRun): Promise<void> {
      const runs = await this.peek();
      const kept = runs.filter((r) => !(r.repo === pr.repo && r.pr === pr.pr && r.headSha === pr.headSha));
      await setFlag(db, GATE_DRAIN_QUEUE_KEY, JSON.stringify(kept), Date.now());
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
  const stamp = row?.ts ?? 0;
  if (Date.now() - stamp > GATE_DRAIN_STALE_MS) {
    await clearStaleDrainFlag(db, stamp);
    return false;
  }
  return true;
}