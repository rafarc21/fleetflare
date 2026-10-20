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
 *  comment warns about. `write` replaces the whole array and is only for the
 *  single every-minute drain writer. */
export interface GateDrainQueue {
  peek(): Promise<PullRequestAutoRun[]>;
  /** Atomically appends one pending run, in a single statement. */
  append(pr: PullRequestAutoRun): Promise<void>;
  write(runs: PullRequestAutoRun[]): Promise<void>;
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
    async write(runs: PullRequestAutoRun[]): Promise<void> {
      await setFlag(db, GATE_DRAIN_QUEUE_KEY, JSON.stringify(runs), Date.now());
    },
  };
}

/** Whether a Worker deploy is currently draining running gate runs. */
export async function gateDraining(db: D1Database): Promise<boolean> {
  return flagIsSet(db, GATE_DRAIN_FLAG);
}