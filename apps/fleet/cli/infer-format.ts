// Issue #934: `fleet ls`'s INFER column — how many lead-inference calls each
// studio made in the last 30 min and how many of them returned ok. Pure
// formatting/threshold logic only, split out of cli/fleet.ts for the SAME
// Bun-free-module reason cli/readiness-format.ts's own header documents:
// cli/fleet.ts pulls in `node:os`/`node:fs` and `Bun.file`/`Bun.spawn`, fine
// under cli/tsconfig.json's own `"types": ["bun"]`, but importing it from
// ANYWHERE under test/ would drag those Bun-touching declarations into the
// ROOT tsconfig.json's compilation graph too, and that project's `types`
// array has no "bun" entry. Keeping this pure (no node:*/Bun imports) means
// a test can import it directly — and these pins live in the bun lane anyway
// (test/bun/cli.fleet-ls-infer.test.ts) only because that is where the PRS
// column's own precedent lives, not because the module needs it.
//
// The origin story (the issue's own): a GLM/kimi/deepseek-led studio blocked
// on Workers AI 429/5xx reads `running` in `fleet ls` with every number frozen
// — silence looks like progress. On 2026-10-15 one studio made 0 output for
// 5h and nobody saw it. The junior_usage_log table already records every lead
// inference call (mode: "lead", written by anthropic-route.ts's logUsage);
// this module is the rendering half of the CLI read of that table.

/** One studio's lead-inference traffic in the INFER window (issue #934):
 *  total lead calls and how many of them returned ok. The shape of
 *  /studio/junior/usage/lead's per-row answer (aggregateLeadUsage's
 *  SUM(ok)/COUNT(*), src/junior/usage.ts) — `ok` is a positive count of
 *  successes, never a count of failures, so a future ok-shape change can
 *  only extend this interface, never reinterpret it. */
export interface LeadInferUsage { calls: number; ok: number }

/** The INFER window: the last 30 minutes of lead calls, per the issue
 *  ("last 30 min"). Exported so tests pin the window instead of a magic
 *  number, same posture as ACTIVITY_DO_STALE_SECONDS — and cmdLs derives
 *  its `?since=` cutoff from it, so the route's window and the cell's
 *  legend can never drift apart. */
export const INFER_WINDOW_MS = 30 * 60 * 1000;

/** Issue #934: when calls >= this AND ok-rate < 50%, the READY cell also
 *  reads "inference-blocked" — the row is alive but its lead is not getting
 *  answers. Ten calls is the floor a 5-hour silent stall can never slip
 *  under: too few calls means the studio has not been trying (idle or
 *  Claude-led), which is a different fact from trying and failing. */
export const INFER_BLOCKED_MIN_CALLS = 10;

export function isLeadInferenceBlocked(u: LeadInferUsage | undefined): boolean {
  // calls <= 0 cannot happen off a real route row (a GROUP BY only answers
  // studios with rows), but this module is pure and its inputs are not
  // guarded elsewhere: a 0-call entry must read as "no traffic", never as a
  // blocked verdict, and never divide by zero either.
  return u !== undefined && u.calls >= INFER_BLOCKED_MIN_CALLS && u.ok / u.calls < 0.5;
}

/** The INFER cell: "<ok>/<calls> <pct>%" (e.g. "12/48 25%"); "-" when the
 *  studio has no lead rows in the window (Claude-led or idle), and "-" for
 *  a 0-call row too — same false-clean rule the PRS column carries: a
 *  NaN% figure must never print, and "could not look" must never read as
 *  "looked and found none". A 100% ok-rate renders "48/48 100%", never a
 *  bare "48/48" — the pct is half the reading, not decoration. */
export function formatInfer(u: LeadInferUsage | undefined): string {
  if (u === undefined || u.calls <= 0) return "-";
  const pct = Math.floor((u.ok / u.calls) * 100);
  return `${u.ok}/${u.calls} ${pct}%`;
}
