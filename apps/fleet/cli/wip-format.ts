// Board issue #208, part 2 — surfacing the periodic WIP safety-net sync
// (`Observed.wipSyncedAt`, do.ts's `wipSync`/`recordWipSyncOnSuccess`, pushed
// by rescue.ts's `wipSyncCmd` to the per-container-boot
// `fleet/rescue/<studio>/wip/<bootStamp>` ref) in `fleet ls`'s own table and
// `fleet inspect`'s own per-studio lines.
// Sibling to restart-format.ts — that file's own RST column is the exact
// model this one follows: a pure formatter reading one `Observed` field, plus
// a short column legend, same convention.
import { formatAge } from "./readiness-format";
import type { Observed } from "../src/studio/observed";
import type { StudioStatus } from "../src/studio/types";

/** `fleet ls` WIP column legend, same shape `RESTART_LEGEND`
 *  (restart-format.ts) already uses. Fix round (#208 PR #215 review, minor
 *  (a)): names the trailing `!` a failed last attempt now gets, so an
 *  operator reading the column cold knows what it means. */
export const WIP_LEGEND =
  "WIP column: age since the last periodic WIP safety-net check (fleet/rescue/<studio>/wip/<boot>); " +
  "trailing '!' = last attempt FAILED; '-' = never checked";

/**
 * Board issue #208 — the ref `wipSyncCmd` (rescue.ts) pushes to. Fix round
 * (#208 PR #215 review item 1): the real ref is now scoped PER CONTAINER
 * BOOT (`fleet/rescue/<studio>/wip/<bootStamp>`, `Observed.wipBootStamp`) —
 * `bootStamp`, when known, gives the EXACT, byte-identical ref `wipSyncRef`
 * (rescue.ts) itself would produce. Absent/null (no confirmed boot stamp
 * yet for this row, or a caller with no `Observed` in hand at all — e.g.
 * survival-brief.ts's own composer) falls back to a `/*` glob, naming the
 * neighborhood rather than printing a literal ref that may not exist.
 * Duplicated rather than imported, same convention survival-delivery.ts's
 * own `rescueBranchPrefix` already follows for the identical reason (that
 * function's own doc comment): this is a thin CLI formatter and has no
 * business pulling in rescue.ts's own exec/push machinery for one string.
 */
export function wipSyncRefEcho(studioId: string, bootStamp?: string | null): string {
  return bootStamp ? `fleet/rescue/${studioId}/wip/${bootStamp}` : `fleet/rescue/${studioId}/wip/*`;
}

/**
 * `-` while never checked — `observed.wipLastCheck`/`wipSyncedAt` both
 * absent/null, or a row from an older Worker that never had either field at
 * all. Same "unknown, not an error" convention `formatRestartCell`
 * (restart-format.ts) already uses for a null `restarts` log. An
 * unparseable timestamp also reads `-`: a garbled age is worse than
 * admitting there is nothing honest to say.
 *
 * Fix round (#208 PR #215 review, minor (a)): `wipSyncedAt` ALONE could not
 * distinguish "nothing to sync, checked recently" (same `-`/stale age as "no
 * tick has run in a while") from "the last few attempts have all FAILED"
 * (same age as a genuinely healthy, recently-pushed row) — both looked
 * identical, or both looked like nothing happened. `observed.wipLastCheck`
 * (stamped on EVERY attempt, success or failure — do.ts's
 * `recordWipLastCheck`) is preferred when present: its own age, with a
 * trailing `!` when the last attempt FAILED. Absent (a row written before
 * this field existed) falls back to the original `wipSyncedAt`-only
 * behavior unchanged.
 */
export function formatWipCell(s: StudioStatus, now: Date): string {
  const check = s.observed?.wipLastCheck;
  if (check != null) {
    const ms = Date.parse(check.at);
    if (!Number.isNaN(ms)) {
      const seconds = Math.max(0, Math.floor((now.getTime() - ms) / 1000));
      const age = formatAge(seconds);
      return check.result === "failed" ? `${age}!` : age;
    }
  }
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
 *
 * Fix round (#208 PR #215 review, minor (a)): a SECOND line is appended,
 * ONLY when `observed.wipLastCheck.result === "failed"`, naming how long
 * ago the last FAILED attempt was — additive, never replacing the first
 * line, so an existing `toEqual([one line])` fixture (a row with no
 * `wipLastCheck` at all) keeps matching unchanged.
 *
 * Issue #231 (fix 5) — read this closely before touching either value below:
 * `ref` (from `wipBootStamp`) IDENTIFIES which ref to go look at; its own
 * embedded stamp is the container's BOOT time, not a sync time, and is easy
 * to misread as one if a reader goes looking at the ref's bare name on
 * GitHub with no other context (the incident this fix exists for was exactly
 * that misread — see this issue's own "Measured" section). `at` (from
 * `wipSyncedAt`) is the ACTUAL last push time, computed fresh here, every
 * render. The two are deliberately kept as separate values, never derived
 * from one another, and the line below renders them in that order (ref
 * first, "last synced <age>" second) so a reader sees the real age
 * immediately next to the ref, rather than having to compute "is this stamp
 * the sync time or something else" themselves. Confirmed on review: no other
 * call site in this file (or `formatWipCell`, `fleet ls`'s own column) ever
 * derives an age from `wipBootStamp` — both already read `wipSyncedAt`/
 * `wipLastCheck.at` exclusively for timing. The survival brief's own WIP
 * line (survival-brief.ts's `wipSyncLine`) now renders the identical
 * ref-next-to-real-age pairing — see that function's own fix (#231 fix 2a).
 */
export function formatWipInspectLines(studioId: string, observed: Observed | undefined, now: Date): string[] {
  if (observed === undefined) return [];
  const ref = wipSyncRefEcho(studioId, observed.wipBootStamp);
  const at = observed.wipSyncedAt;
  const lines: string[] =
    at == null
      ? [`wip sync:     ${ref} — never synced`]
      : (() => {
          const ms = Date.parse(at);
          if (Number.isNaN(ms)) return [`wip sync:     ${ref} — synced at ${at}`];
          const seconds = Math.max(0, Math.floor((now.getTime() - ms) / 1000));
          return [`wip sync:     ${ref}, last synced ${formatAge(seconds)} ago`];
        })();
  const check = observed.wipLastCheck;
  if (check?.result === "failed") {
    const ms = Date.parse(check.at);
    if (!Number.isNaN(ms)) {
      const seconds = Math.max(0, Math.floor((now.getTime() - ms) / 1000));
      lines.push(`wip sync:     last attempt FAILED ${formatAge(seconds)} ago`);
    }
  }
  return lines;
}
