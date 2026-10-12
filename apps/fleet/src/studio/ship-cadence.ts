// Ship-tick cadence (30s) the 90s activity-staleness budgets derive from —
// imported by do.ts, activity.ts, cli/readiness-format.ts so no raw 90 twins.
// Both HOOK_STALE_BUDGET_MS and ACTIVITY_DO_STALE_SECONDS are
// 3 × this constant: three consecutive ticks with no fresh observation is
// the "too stale to trust" shape both budgets share, and bumping this one
// number moves both budgets together. Zero imports — a pure leaf do.ts,
// activity.ts, and cli/readiness-format.ts can all reach without a cycle
// (do.ts imports activity.ts, so the constant cannot live in either).
export const SHIP_TRANSCRIPT_SECONDS = 30;
