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
 * Issue #241 item 5: `Observed.wipLastCheck` is now PER-TARGET (one entry
 * per target named this tick — main checkout vs each member worktree's own
 * ref), never one blended value — see that field's own doc comment
 * (observed.ts) for the full bug this fixes. `fleet ls`'s own WIP column has
 * room for exactly one age, so this rolls every named target down to the
 * SINGLE worst one, by priority: a FAILED target always wins (the floor
 * requirement this item exists for — a lead must never see "pushed" while a
 * target's own safety net is genuinely broken), then a real PUSH (the most
 * informative outcome among the rest), then the two quiet-but-abnormal
 * skips, then plain CLEAN last (nothing happened, nothing to say). Ties
 * within the same priority keep whichever entry `Object.values` visits
 * first — this map is rebuilt fresh every tick (never merged across ticks),
 * so a genuine tie only ever means "either one is an equally honest answer".
 */
const WIP_CHECK_PRIORITY: Record<"pushed" | "clean" | "markers-only" | "no-checkout" | "failed", number> = {
  failed: 0, pushed: 1, "no-checkout": 2, "markers-only": 3, clean: 4,
};

type WipCheckEntry = { at: string; result: "pushed" | "clean" | "markers-only" | "no-checkout" | "failed" };

/**
 * Maestro review round 1 on PR #245 (issue #241), MAJOR 1 — `wipLastCheck`
 * changed TYPE, from one blended `{at,result}` object to a per-target map,
 * with no back-compat either direction:
 *   - OLD record (written before this field became a map): the WHOLE stored
 *     value itself IS `{at: "...", result: "failed"}`. Read as a
 *     `Record<target,{at,result}>`, `Object.values` yields the bare STRINGS
 *     `"..."`/`"failed"` as "entries" -- neither has a `.result` property,
 *     so the failure silently vanishes.
 *   - NEW record read by an old reader expecting the flat shape: symmetric
 *     problem the other way (see `recordWipLastCheck`'s own back-compat
 *     write, do.ts, for the fix on THAT side).
 * Duck-typed ONCE here, so `worstWipCheck` below and `formatWipInspectLines`
 * share the identical normalized shape rather than two copies of the same
 * logic that could drift. A key whose own VALUE is itself `{at,result}`
 * -shaped (`typeof v.at === "string" && typeof v.result === "string"`) is a
 * REAL per-target entry and always wins over the top-level decoration
 * `recordWipLastCheck` now also stamps onto the SAME object (its own
 * `at`/`result` keys) for old-reader back-compat -- those two keys are only
 * ever read as a target when NO real per-target entry exists at all, i.e.
 * the stored value genuinely is the OLD flat shape. `LEGACY_WIP_CHECK_KEY`
 * is a parenthesized sentinel (never a bare ref name -- every real target is
 * a `/`-bearing git ref) so it can never collide with a genuine target.
 */
const LEGACY_WIP_CHECK_KEY = "(legacy)";

function normalizeWipLastCheck(stored: unknown): Record<string, WipCheckEntry> {
  if (stored == null || typeof stored !== "object") return {};
  const obj = stored as Record<string, unknown>;
  const targets: Record<string, WipCheckEntry> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (
      value !== null && typeof value === "object" &&
      typeof (value as Partial<WipCheckEntry>).at === "string" &&
      typeof (value as Partial<WipCheckEntry>).result === "string"
    ) {
      targets[key] = value as WipCheckEntry;
    }
  }
  if (Object.keys(targets).length > 0) return targets;
  if (typeof obj.at === "string" && typeof obj.result === "string") {
    return { [LEGACY_WIP_CHECK_KEY]: { at: obj.at, result: obj.result as WipCheckEntry["result"] } };
  }
  return {};
}

function worstWipCheck(checks: unknown): WipCheckEntry | null {
  const normalized = normalizeWipLastCheck(checks);
  let best: WipCheckEntry | null = null;
  for (const c of Object.values(normalized)) {
    if (best === null || WIP_CHECK_PRIORITY[c.result] < WIP_CHECK_PRIORITY[best.result]) best = c;
  }
  return best;
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
 *
 * Issue #241 item 5: `wipLastCheck` is now per-target — `worstWipCheck`
 * above picks the ONE entry to render (see its own doc comment); an empty
 * map (no target has ever been named, e.g. every tick so far quiet AND
 * somehow never named main either) falls back to `wipSyncedAt` unchanged,
 * same as an absent map always has.
 */
export function formatWipCell(s: StudioStatus, now: Date): string {
  const checks = s.observed?.wipLastCheck;
  const check = checks != null ? worstWipCheck(checks) : null;
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
 * ONLY when the last attempt FAILED, naming how long ago that was —
 * additive, never replacing the first line, so an existing
 * `toEqual([one line])` fixture (a row with no `wipLastCheck` at all) keeps
 * matching unchanged.
 *
 * Issue #241 item 5: `wipLastCheck` is now per-target, and more than one
 * target can be FAILED in the SAME tick (the exact bug-report scenario this
 * item fixes) — unlike `formatWipCell`'s own single-line rollup (`fleet
 * ls` has room for exactly one age), this detailed view has room to name
 * every one: one "last attempt FAILED for <target>" line PER failed target,
 * sorted by target name for deterministic output, never collapsing
 * multiple failures into one line.
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
  const checks = observed.wipLastCheck;
  if (checks != null) {
    // Maestro review round 1 on PR #245 (issue #241), MAJOR 1 — same
    // normalization `worstWipCheck` uses above, so an OLD flat-shaped record
    // still surfaces its own FAILED line here instead of being read as a
    // target-less map with nothing to iterate.
    const normalized = normalizeWipLastCheck(checks);
    for (const target of Object.keys(normalized).sort()) {
      const check = normalized[target]!;
      if (check.result !== "failed") continue;
      const ms = Date.parse(check.at);
      if (Number.isNaN(ms)) continue;
      const seconds = Math.max(0, Math.floor((now.getTime() - ms) / 1000));
      lines.push(`wip sync:     last attempt FAILED for ${target} ${formatAge(seconds)} ago`);
    }
  }
  return lines;
}
