import type { TaskRecord } from "./loop";
import { setFlag } from "../state";

export const STALE_MS = 3 * 60 * 1000;

export interface Stale {
  task: TaskRecord;
  staleMs: number;
}

/**
 * Which running tasks have stopped being polled. A stale heartbeat does not
 * mean the container died — advanceTask already handles that. It means the
 * DO's own schedule stopped firing, which nothing else can notice.
 *
 * Pure and total: the cron handler does the I/O, this decides.
 */
export function staleTasks(
  records: (TaskRecord | null)[], now: number, thresholdMs = STALE_MS,
): Stale[] {
  return records
    .filter((r): r is TaskRecord => r !== null)
    .map((task) => ({ task, staleMs: now - task.lastHeartbeat }))
    .filter((s) => s.staleMs > thresholdMs);
}

/**
 * The fleet_state key tracking how many consecutive re-arm attempts a task
 * has needed. Shared by scheduled() (src/index.ts, which increments it every
 * minute the task is still stale) and pollTask (src/agents/do.ts, which
 * clears it below) so the two sides can't drift onto different keys for the
 * same task.
 */
export function rearmKey(taskId: string): string {
  return `rearm:${taskId}`;
}

/**
 * Resets a task's re-arm counter AND its alert flag. Called from
 * pollAndClearRearm (src/agents/do.ts, itself pollTask's only call per
 * cycle), gated on shouldClearRearm(result) — i.e. on every poll that
 * actually completed (advanceTask returned "continue" or "terminal"), not
 * on the schedule merely firing.
 *
 * Gated because a poll that ends in kind:"error" (advanceTask itself
 * threw) leaves the task unchanged and its heartbeat frozen at the
 * pre-throw value — clearing on that outcome would reset the counter on
 * every 5s retry while scheduled() (src/index.ts) reads it only every 60s,
 * making its "two in a row" alert structurally unreachable for exactly the
 * throw class the watchdog exists to catch: an unguarded
 * appendEvent/createApproval failure, which MAX_FAILED_POLLS never counts
 * (it only increments inside runtime.status()'s own catch block, a
 * different path from advanceTask throwing; report() in tasks/loop.ts has
 * no try/catch anywhere in its chain). See shouldClearRearm in
 * src/agents/do.ts for the extracted decision.
 *
 * Some reset is still needed: without one the counter only ever grows — an
 * isolated hiccup early in a long task's life that self-heals the moment
 * /rearm reschedules it would leave a residual count behind, and an
 * unrelated hiccup much later in the same task would combine with that
 * residue to false-trigger the "two in a row" alert in scheduled() even
 * though the two were never actually consecutive.
 *
 * Both flags, because alertedKey's only other call site, scheduled()
 * (src/index.ts), only ever sets it, never clears it — clearing rearmKey
 * alone would leave a taskId permanently muted after its first alert:
 * every later stale episode on that SAME taskId would alert zero more
 * times, forever, even after a full recovery in between. That is the
 * opposite of alertedKey's own documented contract (below): "alert once
 * per stuck episode," not a permanent mute. Clearing both flags in this
 * one place — the one function that already knows a recovery just
 * happened — is what keeps that contract true.
 */
export async function clearRearm(db: D1Database, taskId: string, now: number): Promise<void> {
  await setFlag(db, rearmKey(taskId), "0", now);
  await setFlag(db, alertedKey(taskId), "0", now);
}

/**
 * The fleet_state key tracking whether the operator has already been
 * alerted for this task's current stale episode. Same taskId-namespacing
 * reasoning as rearmKey. scheduled() (src/index.ts) is the only reader and
 * the only setter — it writes "1" once a send actually succeeds. clearRearm
 * (above) is the only clearer, resetting it to "0" on the same recovery
 * signal that resets rearmKey, so "alert once per taskId" is "alert once
 * per stuck episode," not a permanent mute either across a task's unrelated
 * future runs OR across that same task's own later episodes — see
 * clearRearm's doc comment for the one clear that keeps that true.
 */
export function alertedKey(taskId: string): string {
  return `alerted:${taskId}`;
}

/**
 * True only the first time a task crosses the two-consecutive-failures
 * threshold — one alert per stale episode, not one per minute. Without
 * the dedupe, scheduled() would re-send the identical Telegram message
 * every single minute the task stayed stuck, and an operator who mutes
 * the channel is exactly the failure spec §12 exists to prevent. The
 * caller persists "already alerted" (alertedKey) once the send actually
 * succeeds, so a delivery failure is retried next minute rather than
 * silenced.
 *
 * A one-shot flag, not a backoff: simplest shape that closes the spam. The
 * operator may prefer re-alerting every N minutes instead of total silence
 * after the first — a real product call, not something this shape locks
 * in.
 */
export function shouldAlert(attempts: number, alreadyAlerted: boolean): boolean {
  return attempts >= 2 && !alreadyAlerted;
}
