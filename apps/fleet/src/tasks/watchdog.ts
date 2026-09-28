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
 * Fix round 1 (task 10a review, Important finding): an earlier version
 * called this unconditionally, before pollOnce even ran, on the reasoning
 * that a failed poll was "already handled by MAX_FAILED_POLLS in
 * tasks/loop.ts." Wrong for the throw class that actually matters here —
 * MAX_FAILED_POLLS only increments inside runtime.status()'s own catch
 * block, a different path entirely from advanceTask itself throwing (an
 * unguarded appendEvent/createApproval failure; report() in tasks/loop.ts
 * has no try/catch anywhere in its chain). That throw makes pollOnce return
 * kind:"error" with the task UNCHANGED, so an unconditional clear reset the
 * counter on every 5s retry forever, making scheduled()'s "two in a row"
 * alert structurally unreachable — silencing the watchdog for exactly the
 * failure class it exists to catch, even while staleTasks() kept correctly
 * flagging the task as stale on every tick. See shouldClearRearm in
 * src/agents/do.ts for the extracted decision.
 *
 * Without a reset at all (unconditional or gated) the counter only ever
 * grows: an isolated hiccup early in a long task's life that self-heals the
 * moment /rearm reschedules it would leave a residual count behind, and an
 * unrelated hiccup much later in the same task would combine with that
 * residue to false-trigger the "two in a row" alert in scheduled() even
 * though the two were never actually consecutive.
 *
 * Final re-review residual: an earlier version cleared only rearmKey.
 * alertedKey has exactly one other call site, scheduled() (src/index.ts),
 * which only ever sets it, never clears it — so once a taskId crossed the
 * alert threshold and alerted, every later stale episode on that SAME
 * taskId alerted zero more times, forever, even after a full recovery in
 * between. That is the opposite of alertedKey's own documented contract
 * (below): "alert once per stuck episode," not a permanent mute. Clearing
 * both flags in this one place — the one function that already knows a
 * recovery just happened — is what keeps that contract true instead of
 * just written down.
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
 * clearRearm's doc comment for the final-review fix that made the latter
 * half of that claim true instead of merely intended.
 */
export function alertedKey(taskId: string): string {
  return `alerted:${taskId}`;
}

/**
 * Carve-out C (final-review fix wave). scheduled()'s alert had no backoff
 * and no dedupe: once a stale task crossed attempts >= 2, it re-sent the
 * identical Telegram message every single minute for as long as the task
 * stayed stuck, forever — a muted alert is exactly the failure spec §12
 * exists to prevent. True only the first time the threshold is crossed for
 * a given taskId; the caller persists that (alertedKey) once the send
 * actually succeeds, so a delivery failure is retried next minute rather
 * than silenced.
 *
 * A one-shot flag, not a backoff: simplest fix that closes the silent-spam
 * failure. The operator may prefer a backoff (re-alert every N minutes)
 * instead of total silence after the first — a real product call, not
 * something this fix locks in.
 */
export function shouldAlert(attempts: number, alreadyAlerted: boolean): boolean {
  return attempts >= 2 && !alreadyAlerted;
}
