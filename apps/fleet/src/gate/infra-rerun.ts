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
// #1278 ask 1: account at capacity, the no-instance fail-fast outcome. Kept
  // infra-class so a saturated fleet's legs earn the one auto-rerun, never a
  // false red on healthy code.
  "gate capacity: no container instance",
  // #1284: combineCauses may cut the "a result" tail of the deadline cause
  // ("exceeded 8 min without …"), so match the part that always survives (a
  // superset of the old "… without a result").
  "exceeded \\d+ min without",
  "no progress past its deadline",
  ": HTTP 503\\b",
  // Workflows' own step timeout, and an AbortSignal.timeout on a leg call (#1135).
  "[Ee]xecution timed out",
  "operation was aborted",
  // #1230: the outbound git proxy's own two failure shapes, surfaced inside a
  // checkout/clone/fetch failed: description — the proxy connection dropped, or
  // its git-protocol stream was garbled. Neither is the code under test.
  "remote end hung up",
  "bad line length",
  // #1283: a GitHub 429 on a lazy blob fetch or checkout is the shared token's
  // limit, not the code under test.
  "returned error: 429",
  "HTTP 429",
  // #1321: a container the platform SIGTERM/SIGKILL'd writes "exited 143/137";
  // the kill is infra (a Workflows internal error), never the code under test.
  "exited 1(43|37)",
].join("|"));

/** An error leg is infra-class by its cause. A leg whose first attempt was red
 *  (`redFirst`, set by runLegStep) is not: a real test failure is never infra,
 *  even when its retry then lost the connection. */
export function isInfraLegFailure(result: LegResult & { redFirst?: boolean }): boolean {
  if (result.state !== "error" || result.redFirst === true) return false;
  return INFRA_CAUSE.test(result.description ?? "");
}

/** The id prefix of an infra rerun's instance: rerun-<the first run's id> (#1119). */
const RERUN_PREFIX = "rerun-";

/** The instance id of the rerun of one run. Deterministic, so a replayed or second start names the same instance. */
export function rerunInstanceId(runId: string): string {
  return `${RERUN_PREFIX}${runId}`;
}

/** Whether an instance is an infra rerun. A rerun is final: it is never rerun again (#1148). */
export function isRerunInstance(runId: string): boolean {
  return runId.startsWith(RERUN_PREFIX);
}

/** Creates the rerun instance. A create that throws is a replayed step when
 *  the rerun instance exists: it is already running, so it is success. That is
 *  asked of the instance, never of the error text, which differs by runtime
 *  (#1135). When the instance cannot be read back, the outcome is unknown: the
 *  create's error is rethrown, so the caller's step retries (#1148 item 4). A
 *  create that failed with no instance behind it throws too, and the caller
 *  posts the final error verdict once its retries run out. */
export async function startInfraRerun(
  create: () => Promise<unknown>, get: () => Promise<unknown>,
): Promise<true> {
  try {
    await create();
    return true;
  } catch (err) {
    try {
      await get();
      return true;
    } catch {
      throw err;
    }
  }
}

export type InfraRerunOutcome = "started" | "superseded";

/** Starts the rerun, then takes the PR's run pointer. A rerun that does not take
 *  the pointer (a newer run already holds it) is ended, so one run stays live
 *  per head. A start that rejects propagates, so its step retries (#1148). */
export async function launchInfraRerun(deps: {
  create: () => Promise<unknown>;
  get: () => Promise<unknown>;
  handOff: () => Promise<boolean>;
  terminate: () => Promise<void>;
}): Promise<InfraRerunOutcome> {
  await startInfraRerun(deps.create, deps.get);
  if (await deps.handOff()) return "started";
  try {
    await deps.terminate();
  } catch (err) {
    console.error("gate: superseded infra rerun not ended", err);
  }
  return "superseded";
}

/** Points the PR's run index at the rerun, like a normal start (#1084 must see
 *  it), but only while the first run still holds the pointer: one conditional
 *  write, never a read then a write (#1135). A newer push's run keeps the
 *  pointer, so the rerun never takes it back. Returns whether the handoff landed. */
export function recordInfraRerun(
  index: Pick<GateRunIndex, "handOff">,
  input: { repo: string; pr: number; headSha: string; runId: string; instanceId: string; at: number },
): Promise<boolean> {
  return index.handOff(input.repo, input.pr, input.instanceId, {
    headSha: input.headSha, runId: input.runId, progressedAt: input.at,
  });
}

/** Whether a rerun's start result reads as started. The boolean true is what a deploy from
 *  before the outcome union cached for this step: on replay it is still a started rerun (#1148 review). */
export function rerunStarted(result: unknown): boolean {
  return result === "started" || result === true;
}

/** The rerun's pending status, posted after the run stamps its progress. The stamp comes
 *  first: the watchdog reads it, so a stale stamp lets it end this run in the middle of its
 *  own rerun start (#1148 review). #1226: `post` now throws instead of returning whether it
 *  failed — it propagates, same as any other step failure. */
export async function announceInfraRerun(deps: {
  touch: () => Promise<void>;
  post: () => Promise<void>;
}): Promise<void> {
  await deps.touch();
  await deps.post();
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

/** The status a run posts when it re-runs instead of ending with an error verdict.
 *  The rerun's full id, not a cut (#1144): a cut tag is shared by every rerun. */
export function rerunStatusArgs(runId: string): { state: "pending"; description: string } {
  return { state: "pending", description: `rerun after infra error (run ${runId})` };
}
