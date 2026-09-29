/**
 * Issue #96: the price of recycling a studio whose container cannot answer.
 *
 * Measured 2026-09-24: the BETA coordinator recycled wedged studios 3 times
 * believing it a free repair. Each recycle's probe failed, so session sync and
 * rescue-push were skipped, and up to 63 minutes of conversation were
 * discarded — while the lead was often still alive (a commit landed 8 minutes
 * after one of those recycles). Nothing in the output named a price. Every
 * line here exists so it does.
 *
 * Wording rule (maestro amendment): commits landing after a wedge are a
 * reliable POSITIVE — the lead is alive, do not recycle. NO commits is never
 * evidence of death: a lead between push points looks identical to a dead one.
 * Nothing here may phrase "no commits" as permission to recycle.
 */

/** Largest whole unit, same scale `fleet ls`'s CHECKED column uses. */
export function formatSnapshotAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * What the last synced snapshot is worth. `undefined` = the lookup itself
 * failed (age unknown); `null` = no snapshot exists at all.
 */
export function recycleCostLine(
  lastSyncedAt: Date | null | undefined, now: Date,
  // #113: destroy quotes the same price for the provision that follows it.
  restorer = "a recycle",
): string {
  const lead = "The LEAD MAY STILL BE WORKING — ";
  if (lastSyncedAt === undefined) {
    return lead + `${restorer} restores the last synced snapshot (age unknown: the lookup failed) ` +
      "and discards everything since.";
  }
  if (lastSyncedAt === null) {
    return lead + `${restorer} finds no synced snapshot and discards the whole session.`;
  }
  const age = formatSnapshotAge(now.getTime() - lastSyncedAt.getTime());
  return lead + `${restorer} restores the last synced snapshot (${age} old) and discards everything since.`;
}

/** The liveness rule, stated once so every surface quotes it identically. */
export const LIVENESS_RULE =
  "Commits landing after the wedge mean the lead is alive: do not recycle. " +
  "No commits is NOT evidence of death — a lead between push points looks identical to a dead one. " +
  "A pane read through attach can be a stale frame: a status-bar clock frozen across two reads means it is.";

/** Every refusal starts with this — routes.ts maps it to 409. A prefix, not
 *  an error class: Workers RPC keeps an error's message but not its class. */
export const RECYCLE_REFUSED_PREFIX = "recycle refused: ";

/** Issue #16: rescue-push CONFIRMED a worktree's work never landed (a
 *  RescuePushFailedError). Same refusal destroy.ts already makes; `detail`
 *  is that error's message, already redacted by the caller. */
export function recycleRescueFailedRefusal(id: string, detail: string): string {
  return RECYCLE_REFUSED_PREFIX +
    `rescue-push confirmed it could not save this studio's work before recycle: ${detail} ` +
    `To discard anyway, as a stated choice: fleet recycle ${id} --discard-unsynced`;
}

/** Issue #62: rescue-push could not CONFIRM anything (the exec threw, was
 *  killed, or hit its deadline): unknown state, refused like a confirmed
 *  failure. `detail` is already redacted by the caller. */
export function recycleRescueUnconfirmedRefusal(id: string, detail: string): string {
  return RECYCLE_REFUSED_PREFIX +
    `rescue-push could not confirm this studio's work was saved before recycle (${detail}); ` +
    "unpushed work may be lost. " +
    `To discard anyway, as a stated choice: fleet recycle ${id} --discard-unsynced`;
}

export function recycleRefusal(id: string, probeMs: number, lastSyncedAt: Date | null | undefined, now: Date): string {
  return RECYCLE_REFUSED_PREFIX +
    `the container did not answer an ${probeMs / 1000}s probe, so session sync, rescue-push and ` +
    "learning harvest cannot run. " + recycleCostLine(lastSyncedAt, now) + " " +
    "Also lost: uncommitted and unpushed work inside the container. " + LIVENESS_RULE + " " +
    `To discard anyway, as a stated choice: fleet recycle ${id} --discard-unsynced`;
}
