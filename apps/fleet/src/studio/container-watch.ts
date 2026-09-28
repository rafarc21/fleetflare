// Issue #95: "recorded stopped, container running (billing)" detector.
// OBSERVATION ONLY — nothing here stops, starts or execs anything.
//
// The signal is the Containers runtime's own `ctx.container.running`, read
// inside the studio's DO. It is a property read, not an exec: sbExec STARTS a
// container that is not running, so checking that way would cause the very
// billing it is looking for. Measured 2026-09-24: 30+ plain RPCs into the
// stopped demosite-life--maestro DO (12:26-13:49Z) placed no container.
import { STATUS_KEY, OPERATION_KEY, OPERATION_STALE_MS, type StudioStorage } from "./provision";
import type { StudioStatus } from "./types";

/** Every 5th minute of the Worker's minute cron. */
export const WATCH_EVERY_MINUTES = 5;

export function isWatchMinute(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() % WATCH_EVERY_MINUTES === 0;
}

/**
 * Record (or clear) the mismatch on THIS studio's own status, and mirror it
 * to its registry row.
 *
 * Only a `stopped` studio is judged: a running container is expected
 * everywhere else. And not while an operation holds the #86 in-flight lock:
 * provision keeps the status `stopped` for its whole bring-up, and the
 * container running under it is that provision's own, not a leak. Same
 * freshness rule decideHeal (do.ts) applies — a stale lock is a dead
 * isolate's wreckage and is ignored; a released lock is `null` (#103).
 *
 * Writes only on a change, so a studio that stays off (or stays leaking)
 * costs no write, and `since` keeps the FIRST sighting. The first sighting is
 * also logged: a keep_alive:false container can go back to sleep on its own
 * and clear the mark, and the log line is then the only evidence left.
 */
export async function observeContainer(
  storage: StudioStorage,
  running: boolean,
  record: (s: StudioStatus) => Promise<void>,
  now: Date,
): Promise<void> {
  const status = await storage.get(STATUS_KEY);
  if (status?.state !== "stopped") return;
  const inFlight = await storage.get(OPERATION_KEY);
  if (inFlight != null) {
    const age = now.getTime() - new Date(inFlight.since).getTime();
    if (Number.isFinite(age) && age >= 0 && age < OPERATION_STALE_MS) return;
  }
  const prev = status.containerRunningSince ?? null;
  const next = running ? (prev ?? now.toISOString()) : null;
  if (next === prev) return;
  if (prev === null) console.log(`container watch: ${status.id} is recorded stopped but its container is RUNNING (billing)`);
  const updated: StudioStatus = { ...status, containerRunningSince: next };
  await storage.put(STATUS_KEY, updated);
  await record(updated);
}

/**
 * The cron's fan-out: ask each studio the registry records as stopped. One
 * unreachable DO is logged and skipped, never the end of the sweep.
 */
export async function watchStoppedContainers(
  studios: StudioStatus[],
  probe: (id: string) => Promise<unknown>,
): Promise<void> {
  for (const s of studios) {
    if (s.state !== "stopped") continue;
    try {
      await probe(s.id);
    } catch (err) {
      console.error(`container watch failed for ${s.id}`, err);
    }
  }
}
