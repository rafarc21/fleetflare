// Issue #56: container restart churn in `fleet ls` — the RST column and a
// RESTARTS line for a studio churning hard. Reads `observed.restarts`
// (src/studio/restarts.ts); the 24h count is evaluated against the reader's
// clock, since a stopped studio never writes again.
import { eventsInWindow, restartsInWindow } from "../src/studio/restarts";
import type { StudioStatus } from "../src/studio/types";

/** Replacements in 24h at which `fleet ls` names the studio under the table. */
export const RESTART_CHURN_24H = 3;

export const RESTART_LEGEND =
  "RST column: <containers replaced in the last 24h>/<since tracking began>; '-' = not tracked yet";

/** `-` while the count is unknown (no baseline yet, or a row from an older
 *  Worker); `0/0` once tracked and never replaced since. */
export function formatRestartCell(s: StudioStatus, now: Date): string {
  const log = s.observed?.restarts;
  if (log == null) return "-";
  return `${restartsInWindow(log, now)}/${Number(log?.total) || 0}`;
}

export function formatRestartChurn(studios: StudioStatus[], now: Date): string[] {
  const lines: string[] = [];
  for (const s of studios) {
    const log = s.observed?.restarts;
    const events = eventsInWindow(log, now);
    if (!log || events.length < RESTART_CHURN_24H) continue;
    // Which bring-up rebuilt each replaced container, in first-seen order.
    const byVia = new Map<string, number>();
    for (const e of events) {
      const via = e.via ?? "unknown";
      byVia.set(via, (byVia.get(via) ?? 0) + 1);
    }
    const split = [...byVia].map(([via, c]) => `${via} ${c}`).join(", ");
    lines.push(
      `RESTARTS ${s.id}: container replaced ${events.length}x in 24h (${Number(log.total) || 0} total; ${split}) -- each one re-bootstraps the studio`,
    );
  }
  return lines;
}
