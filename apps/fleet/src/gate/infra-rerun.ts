// #1119: the infra-only auto-rerun decision. Pure: no I/O, no bindings, so
// bun test can load it. workflow.ts reads the decision, creates the rerun
// instance and posts the rerun status.
import type { LegResult } from "./verdict";

/** A leg error whose cause is the platform or host, not the code: a Workflows
 *  internal error, a lost connection, a container that never started, exited
 *  or answered, or a leg past its deadline. */
const INFRA_CAUSE = new RegExp([
  "internal workflows error",
  "Network connection lost",
  "gate container (did not start|failed|exited)",
  "gate server (unreachable|HTTP \\d+)",
  "exceeded \\d+ min without a result",
  "no progress past its deadline",
  ": HTTP 503\\b",
].join("|"));

/** An error leg is infra-class by its cause. A leg whose first attempt was red
 *  is not: its "; first:" cause is a real test failure, so the leg is not infra. */
export function isInfraLegFailure(result: LegResult): boolean {
  if (result.state !== "error") return false;
  const description = result.description ?? "";
  if (description.includes("; first:")) return false;
  return INFRA_CAUSE.test(description);
}

/** One auto-rerun for an all-infra run. Any red leg, any non-infra error, or a
 *  run that is itself a rerun (`rerunOf` set) is final: no re-run. */
export function infraRerunDecision(results: LegResult[], rerunOf: string | undefined): boolean {
  if (rerunOf !== undefined) return false;
  const errors = results.filter((r) => r.state === "error");
  if (errors.length === 0) return false;
  if (results.some((r) => r.state === "failure")) return false;
  return errors.every(isInfraLegFailure);
}

/** The status a run posts when it re-runs instead of ending with an error verdict. */
export function rerunStatusArgs(runId: string): { state: "pending"; description: string } {
  return { state: "pending", description: `rerun after infra error (run ${runId.slice(0, 8)})` };
}
