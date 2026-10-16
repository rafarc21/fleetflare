// #1119: the infra-only auto-rerun decision. Pure: no I/O, no bindings, so
// bun test can load it. workflow.ts reads the decision, creates the rerun
// instance and posts the rerun status.
import type { GateRunIndex } from "./auto-run";
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
  // Workflows' own step timeout, and an AbortSignal.timeout on a leg call (#1135).
  "[Ee]xecution timed out",
  "operation was aborted",
].join("|"));

/** An error leg is infra-class by its cause. A leg whose first attempt was red
 *  (`redFirst`, set by runLegStep) is not: a real test failure is never infra,
 *  even when its retry then lost the connection. */
export function isInfraLegFailure(result: LegResult & { redFirst?: boolean }): boolean {
  if (result.state !== "error" || result.redFirst === true) return false;
  return INFRA_CAUSE.test(result.description ?? "");
}

/** Creates the rerun instance. A create that throws is a replayed step when
 *  the rerun instance exists: it is already running, so it is success. That is
 *  asked of the instance, never of the error text, which differs by runtime
 *  (#1135). Any failure with no instance behind it is not started, and the
 *  caller posts the final error verdict. */
export async function startInfraRerun(
  create: () => Promise<unknown>, get: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await create();
    return true;
  } catch (err) {
    try {
      await get();
      return true;
    } catch {
      // No such instance: the create really failed.
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("gate: infra rerun create failed", message);
    return false;
  }
}

/** Points the PR's run index at the rerun, like a normal start (#1084 must see
 *  it), but only while the first run still holds the pointer: one conditional
 *  write, never a read then a write (#1135). A newer push's run keeps the
 *  pointer, so the rerun never takes it back. Returns whether the handoff landed. */
export function recordInfraRerun(
  index: GateRunIndex,
  input: { repo: string; pr: number; headSha: string; runId: string; instanceId: string; at: number },
): Promise<boolean> {
  return index.handOff(input.repo, input.pr, input.instanceId, {
    headSha: input.headSha, runId: input.runId, progressedAt: input.at,
  });
}

/** The status a poller sees for a run that may have handed off to its infra
 *  rerun (#1119): a complete run with a `rerun` in its output reports the
 *  rerun's status, so `fleet gate run` waits for the rerun's own verdict. */
export async function statusFollowingRerun<S extends { status: string; output?: unknown }>(
  first: S,
  getRerun: (rerunId: string) => Promise<S>,
): Promise<S> {
  const rerunId = (first.output as { rerun?: unknown } | undefined)?.rerun;
  if (first.status !== "complete" || typeof rerunId !== "string") return first;
  return getRerun(rerunId);
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
