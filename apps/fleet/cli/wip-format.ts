// Board issue #208, part 2 — surfacing the periodic WIP safety-net sync
// (`Observed.wipSyncedAt`, do.ts's `wipSync`/`recordWipSyncOnSuccess`, pushed
// by rescue.ts's `wipSyncCmd` to the fixed `fleet/rescue/<studio>/wip` ref)
// in `fleet ls`'s own table and `fleet inspect`'s own per-studio lines.
// Sibling to restart-format.ts — that file's own RST column is the exact
// model this one follows: a pure formatter reading one `Observed` field, plus
// a short column legend, same convention.
import { formatAge } from "./readiness-format";
import type { Observed } from "../src/studio/observed";
import type { StudioStatus } from "../src/studio/types";

/** `fleet ls` WIP column legend, same shape `RESTART_LEGEND`
 *  (restart-format.ts) already uses. */
export const WIP_LEGEND =
  "WIP column: age since the last periodic WIP safety-net sync (fleet/rescue/<studio>/wip); '-' = never synced";

/**
 * Board issue #208 — the one ref `wipSyncCmd` (rescue.ts) ever pushes to.
 * BYTE-IDENTICAL to that file's own `wipSyncRef`, duplicated rather than
 * imported for the same reason survival-delivery.ts's own
 * `rescueBranchPrefix` duplicates its ref convention instead of importing
 * rescue.ts (that function's own doc comment): this is a thin CLI formatter
 * and has no business pulling in rescue.ts's own exec/push machinery for one
 * string.
 */
export function wipSyncRefEcho(studioId: string): string {
  return `fleet/rescue/${studioId}/wip`;
}

/**
 * `-` while never synced — `observed.wipSyncedAt` absent/null, or a row from
 * an older Worker that never had the field at all. Same "unknown, not an
 * error" convention `formatRestartCell` (restart-format.ts) already uses for
 * a null `restarts` log. An unparseable timestamp also reads `-`: a garbled
 * age is worse than admitting there is nothing honest to say.
 */
export function formatWipCell(s: StudioStatus, now: Date): string {
  const at = s.observed?.wipSyncedAt;
  if (at == null) return "-";
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return "-";
  const seconds = Math.max(0, Math.floor((now.getTime() - ms) / 1000));
  return formatAge(seconds);
}

/**
 * `fleet inspect`'s own WIP line(s) — the full ref name (unlike the `fleet
 * ls` column, which only has room for an age) plus the same age, or "never
 * synced" when absent. Returns an array, same `string[]` shape
 * `formatSessionForceArmedLine` (cli/inspect-request.ts) already uses, so a
 * caller composes it with one `for...of console.log` loop and a Worker that
 * sends no `observed` at all (routes.ts's "Worker->DO call failed" catch
 * branch, or one that predates this feature) adds nothing rather than
 * crashing on a field that was never there.
 */
export function formatWipInspectLines(studioId: string, observed: Observed | undefined, now: Date): string[] {
  if (observed === undefined) return [];
  const ref = wipSyncRefEcho(studioId);
  const at = observed.wipSyncedAt;
  if (at == null) return [`wip sync:     ${ref} — never synced`];
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return [`wip sync:     ${ref} — synced at ${at}`];
  const seconds = Math.max(0, Math.floor((now.getTime() - ms) / 1000));
  return [`wip sync:     ${ref}, last synced ${formatAge(seconds)} ago`];
}
