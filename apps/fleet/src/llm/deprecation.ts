// Issue #1476: CF retires Workers AI model ids with no signal into this
// repo — kimi-k2.7-code and deepseek-v4-pro-0813 both went dead while still
// `smokePassed: true` in the pool, so a studio kept reaching a 500 5028
// until an operator noticed and filed the issue. Pure check only: the live
// `wrangler ai models list --json` fetch that supplies `catalog` lives in
// scripts/model-smoke.ts (maestro-only, needs real Cloudflare credentials —
// never available inside a studio container, same constraint as the smoke
// script's own live inference calls).
//
// Round 2 (#1476): confirmed against real catalog output that a retired id
// does NOT carry a `planned_deprecation_date` — it is simply ABSENT from the
// `wrangler ai models list --json` list entirely (0 of 52 live models
// currently carry that field). So retirement detection is catalog-ABSENCE
// first; `planned_deprecation_date` is a secondary, forward-looking signal
// for a model CF has flagged but not yet dropped (it may never fire against
// today's real data, but CF could set the field before actually dropping a
// model next time, so the logic stays).

export type DeprecationStatus = "ok" | "warn" | "retired";

/** The subset of a `wrangler ai models list --json` catalog entry this check
 *  reads. CF's own field name, kept as-is rather than renamed, so a reader
 *  diffing against the live catalog output sees the same key. */
export interface ModelCatalogEntry {
  id: string;
  planned_deprecation_date?: string | null;
}

/**
 * `"retired"` when `targetId` is absent from `catalog` entirely (CF dropped
 * it with no forward signal — model-smoke.ts must fail fast, never spend a
 * live inference call on a dead id), or when a present entry's
 * `planned_deprecation_date` is already in the past. `"warn"` when present
 * and inside `warnDays` of that date (model-smoke.ts prints and continues —
 * the id still works today). `"ok"` otherwise, including when the catalog
 * lists no deprecation date at all for a present entry.
 */
export function checkDeprecation(
  catalog: readonly ModelCatalogEntry[], targetId: string, now: number, warnDays = 14,
): DeprecationStatus {
  const entry = catalog.find((e) => e.id === targetId);
  if (entry === undefined) return "retired";
  const raw = entry.planned_deprecation_date;
  if (raw === null || raw === undefined) return "ok";
  const deprecatesAt = new Date(raw).getTime();
  if (deprecatesAt <= now) return "retired";
  if (deprecatesAt <= now + warnDays * 24 * 60 * 60 * 1000) return "warn";
  return "ok";
}
