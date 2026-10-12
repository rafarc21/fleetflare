// One guarded decoder for every CLI read of a studio row: a Worker older or
// newer than the CLI during a deploy window answers a shape a bare `as
// StudioStatus` cast would wave through, leaving `state` undefined. Type-only
// imports (no runtime graph) so the Worker's own src/studio can use it too.
import type { StudioStatus, StudioState } from "../src/studio/types";

/** The four states the CLI branches on — the StudioState union as a value. */
export const STUDIO_STATES: readonly StudioState[] = ["provisioning", "running", "degraded", "stopped"];

/**
 * One untrusted wire row, or null on any miss — never a throw, never a
 * rebuild: a pass-through type guard, so callers keep every field this
 * function does not name (observed, readiness, burn, ...). `id`/`state`/
 * `error` are the three fields the CLI itself branches on, so those are the
 * three that must actually be there.
 */
export function parseStudioStatus(raw: unknown): StudioStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  if (!(STUDIO_STATES as readonly string[]).includes(r.state as string)) return null;
  // Absent (undefined) is NOT a null here on purpose: the writer-side
  // registry always persists `error` explicitly, so a wire row without it
  // is a different shape than this CLI was built for.
  if (typeof r.error !== "string" && r.error !== null) return null;
  return r as unknown as StudioStatus;
}

/** A listing route's whole body: every element must decode, else null —
 *  one bad row rejects the listing rather than being silently dropped. */
export function parseStudioStatusArray(raw: unknown): StudioStatus[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: StudioStatus[] = [];
  for (const element of raw) {
    const decoded = parseStudioStatus(element);
    if (decoded === null) return null;
    rows.push(decoded);
  }
  return rows;
}
