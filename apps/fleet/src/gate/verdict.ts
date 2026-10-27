// #715 Task 4: gate verdict fan-in. Pure: no I/O, no env, no imports.
//
// State machine (spec: "error never silently downgraded to failure"):
//   - any leg missing a report -> pending (until closeOutMissing runs at deadline)
//   - any leg "error" (timeout, missing report, infra crash) -> error
//   - else any leg "failure" (red tests, returned as data) -> failure
//   - else every leg "success" -> success
// "First" erroring/failing leg is read in CONFIGURED order (expectedLegs), not
// arrival order: legs run in parallel, so arrival order is not deterministic.
//
// Flake policy mirrors localci.sh:198-207: a failed leg reruns once; the rerun
// outcome is an INPUT to resolveFlake. Nothing here runs a rerun.

export type LegState = "success" | "failure" | "error";
export interface LegResult { leg: string; state: LegState; description?: string }

export type Verdict =
  | { state: "pending" }
  | { state: "success" }
  | { state: "failure"; description: string }
  | { state: "error"; description: string };

// Verdict POST outcome lives beside the verdict, never folded into its state.
export interface GateOutcome { verdict: Verdict; postError: string | null }

export function aggregateVerdict(expectedLegs: string[], results: LegResult[]): Verdict {
  const byLeg = new Map(results.map((r) => [r.leg, r]));
  if (expectedLegs.some((leg) => !byLeg.has(leg))) return { state: "pending" };

  for (const leg of expectedLegs) {
    const r = byLeg.get(leg)!;
    if (r.state === "error") return { state: "error", description: errorDescription(expectedLegs, byLeg, r) };
  }
  for (const leg of expectedLegs) {
    const r = byLeg.get(leg)!;
    if (r.state === "failure") return { state: "failure", description: r.description ?? `${leg} failed` };
  }
  return { state: "success" };
}

/** #1395: an infra error used to hide every real red leg behind it — a run
 *  read "GateRunnerDO crashed" while two legs had genuinely failed. List the
 *  real failures alongside the error, in configured leg order, so a red leg is
 *  never invisible in the verdict description. The error stays the headline
 *  (the verdict state is still "error"), and with no failure present the
 *  description is exactly what it was before. */
function errorDescription(
  expectedLegs: string[], byLeg: Map<string, LegResult>, error: LegResult,
): string {
  const red = expectedLegs.filter((leg) => byLeg.get(leg)!.state === "failure");
  if (red.length === 0) return error.description ?? `${error.leg} errored`;
  const list = red.map((leg) => `${leg}: ${byLeg.get(leg)!.description ?? "failed"}`).join(", ");
  return `${error.description ?? `${error.leg} errored`}; red: ${list}`;
}

// Call at the deadline: every leg still unreported becomes "error" (timeout or
// missing report), so the verdict resolves to error rather than hanging pending.
export function closeOutMissing(expectedLegs: string[], results: LegResult[]): LegResult[] {
  const reported = new Set(results.map((r) => r.leg));
  const missing: LegResult[] = expectedLegs
    .filter((leg) => !reported.has(leg))
    .map((leg) => ({ leg, state: "error", description: `${leg} timed out or missing report` }));
  return [...results, ...missing];
}

// One rerun per failed leg. Only "failure" reruns; "error" is infra and is never
// rerun. A rerun input replaces the first result for that leg.
export function resolveFlake(first: LegResult, rerun?: LegResult): LegResult {
  if (first.state !== "failure" || rerun === undefined) return first;
  if (rerun.leg !== first.leg) throw new Error(`rerun leg ${rerun.leg} does not match ${first.leg}`);
  if (rerun.state === "success") return { leg: first.leg, state: "success", description: "passed on flake rerun" };
  return rerun;
}

export function outcome(verdict: Verdict, postError: string | null): GateOutcome {
  return { verdict, postError };
}
