// Ship-tick cadence (30s) the 90s activity-staleness budgets derive from —
// the 30 is the design spec's own number: an operator watching the grid card
// wants the hot-tail preview near-live, and R2 chunk cost is negligible at
// this cadence (docs/superpowers/specs/2026-08-16-studio-memory-p2-design.md).
// Both HOOK_STALE_BUDGET_MS and ACTIVITY_DO_STALE_SECONDS are
// 3 × this constant: three consecutive ticks with no fresh observation is
// the "too stale to trust" shape both budgets share, and bumping this one
// number moves both budgets together. Zero imports — a pure leaf imported
// by do.ts, activity.ts, cli/readiness-format.ts so no raw 90 twins
// (do.ts imports activity.ts, so the constant cannot live in either).
export const SHIP_TRANSCRIPT_SECONDS = 30;
