// Issue #56: how often a studio's container has been replaced — the churn a
// coordinator needs to see, since each replacement costs the lead a full
// re-bootstrap (clone, install, dev server, seed).
//
// The unit is a container GENERATION: transcript.ts's ship tick sees a new
// boot-id at TRANSCRIPT_BOOT_ID_PATH (one per container lifetime) and appends
// here in the same atomic write that records the new boot-id — once per
// generation, whatever caused it (fleet recycle, destroy+spawn, image
// rollout, platform restart). A restart that re-runs bring-up on the SAME
// container keeps its /workspace and its boot-id, so it is not counted.
//
// Own DO-storage key, attached to `Observed` by do.ts's withObserved, so it
// reaches the D1 row (`observed.restarts`) through the one seam every row
// already crosses. A row written before this existed simply lacks the field.

import type { BringupVia } from "./observed";

export const RESTARTS_KEY = "containerRestarts";

/** The window `fleet ls` counts churn over. */
export const RESTART_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Hard cap on `recent`, whatever the window holds. */
const RECENT_MAX = 100;

export interface RestartEvent {
  /** When the ship tick first saw the new container. */
  at: string;
  /** The bring-up that last ran before it was seen (`Observed.session.via`):
   *  recycle/provision/failover = the fleet replaced it; restart/heal = it
   *  was replaced underneath and bring-up rebuilt it. Null when unknown. */
  via: BringupVia | null;
}

export interface RestartLog {
  /** Lifetime count since this Worker started counting. Never pruned. */
  total: number;
  /** Events inside the last RESTART_WINDOW_MS as of the latest write. */
  recent: RestartEvent[];
}

export interface RestartStorage {
  get(key: typeof RESTARTS_KEY): Promise<RestartLog | undefined>;
}

function recentOf(log: RestartLog | null | undefined): RestartEvent[] {
  return Array.isArray(log?.recent) ? log.recent : [];
}

function inWindow(e: RestartEvent, nowMs: number): boolean {
  const at = Date.parse(e?.at);
  return Number.isFinite(at) && nowMs - at < RESTART_WINDOW_MS;
}

export function recordRestart(log: RestartLog | undefined, at: Date, via: BringupVia | null): RestartLog {
  const nowMs = at.getTime();
  const kept = recentOf(log).filter((e) => inWindow(e, nowMs));
  return {
    total: (Number(log?.total) || 0) + 1,
    recent: [...kept, { at: at.toISOString(), via }].slice(-RECENT_MAX),
  };
}

/** Replacements in the last 24h of `now` — evaluated at READ time, since a
 *  stopped studio never writes again. Malformed entries count as none. */
export function restartsInWindow(log: RestartLog | null | undefined, now: Date): number {
  return eventsInWindow(log, now).length;
}

export function eventsInWindow(log: RestartLog | null | undefined, now: Date): RestartEvent[] {
  return recentOf(log).filter((e) => inWindow(e, now.getTime()));
}
