// Issue #1476: CF retires Workers AI model ids with no signal into this
// repo — kimi-k2.7-code and deepseek-v4-pro-0813 both went dead while still
// `smokePassed: true` in the pool, so a studio kept reaching a 500 5028
// until an operator noticed and filed the issue. Pure check only: the live
// `wrangler ai models --json` fetch that supplies `entry` lives in
// scripts/model-smoke.ts (maestro-only, needs real Cloudflare credentials —
// never available inside a studio container, same constraint as the smoke
// script's own live inference calls).

export type DeprecationStatus = "ok" | "warn" | "retired";

/** The subset of a `wrangler ai models --json` catalog entry this check
 *  reads. CF's own field name, kept as-is rather than renamed, so a reader
 *  diffing against the live catalog output sees the same key. */
export interface ModelCatalogEntry {
  planned_deprecation_date?: string | null;
}

/**
 * `"retired"` once `planned_deprecation_date` is in the past (model-smoke.ts
 * must fail fast, never spend a live inference call on a dead id).
 * `"warn"` inside `warnDays` of that date (model-smoke.ts prints and
 * continues — the id still works today). `"ok"` otherwise, including when
 * the catalog lists no deprecation date at all.
 */
export function checkDeprecation(
  entry: ModelCatalogEntry, now: number, warnDays = 14,
): DeprecationStatus {
  const raw = entry.planned_deprecation_date;
  if (raw === null || raw === undefined) return "ok";
  const deprecatesAt = new Date(raw).getTime();
  if (deprecatesAt <= now) return "retired";
  if (deprecatesAt <= now + warnDays * 24 * 60 * 60 * 1000) return "warn";
  return "ok";
}
