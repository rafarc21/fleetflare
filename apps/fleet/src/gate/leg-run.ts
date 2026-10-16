// #715: the one-leg step GateWorkflow runs. Pure: no Workflow/DO bindings, so
// bun test can load it. workflow.ts passes in the real step and dispatcher.
//
// The GateRunnerDO answers /run-leg synchronously with the leg's LegResult.
// That return value is the step result. A red test is data (state "failure"),
// never a throw. Any non-2xx is infra: the step throws, Workflows retries it
// once, and a second failure becomes this leg's "error".
import type { GateLegRequest } from "./leg-env";
import { normalizeLegResult, type LegRunMeta, type PlannedLeg } from "./fanout";
import type { LegResult } from "./verdict";

/** A leg's result as the step returns it: the DO's LegResult plus wall time and summary. */
export type LegRunResult = LegResult & LegRunMeta;

/** Workflows caps a step result at 1 MiB; a leg description has no reason to
 *  be near that, so it is bounded well under it. */
const MAX_DESCRIPTION_CHARS = 2000;

/** The infra-cause message ceiling: a leg's final description carries the
 *  503 body's error, cut to this many chars so it stays a one-line cause. */
const MAX_INFRA_CAUSE_CHARS = 200;

/** The first attempt's red description, cut to this many chars when the leg
 *  passes on retry, so the flake's cause stays in the one-line status. */
const MAX_FIRST_DESCRIPTION_CHARS = 150;

/** The one step config a leg uses. Literal types, so the object is assignable
 *  to Workflows' WorkflowStepConfig without importing cloudflare:workers here
 *  (the check tsconfigs for test/ cannot resolve that module). */
export interface LegStepConfig {
  retries: { limit: number; delay: "15 seconds"; backoff: "constant" };
  timeout: "30 minutes";
}

/** The slice of Workflows' WorkflowStep this module uses. */
export interface LegStepRunner {
  do(name: string, config: LegStepConfig, fn: () => Promise<LegRunResult>): Promise<LegRunResult>;
}

const LEG_STEP_CONFIG: LegStepConfig = {
  retries: { limit: 1, delay: "15 seconds", backoff: "constant" },
  timeout: "30 minutes",
};

/** Runs one leg: a start-<leg> step, and when that returns state "failure"
 *  (a red test, possibly flaky) a single retry-<leg> step with a fresh
 *  container. Never throws: every failure becomes this leg's LegResult, so
 *  the other legs still finish. */
export async function runLegStep(
  step: LegStepRunner,
  dispatch: (planned: PlannedLeg) => Promise<Response>,
  planned: PlannedLeg,
): Promise<LegRunResult> {
  const attempt = async (name: string, target: PlannedLeg): Promise<LegRunResult> =>
    step.do(name, LEG_STEP_CONFIG, async () => {
      // Timed inside the callback: a Workflow replay returns the recorded ms
      // instead of timing the replay.
      const started = Date.now();
      const res = await dispatch(target);
      if (!res.ok) {
        // A non-2xx (infra, 503) carries its cause in the body's `error`
        // field — surface it, cut to 200 chars. No usable body: name the HTTP status.
        let cause = `${planned.leg}: HTTP ${res.status}`;
        try {
          const body = await res.json() as { error?: unknown };
          if (typeof body.error === "string" && body.error.length > 0) {
            cause = `${planned.leg}: ${body.error}`;
          }
        } catch { /* non-JSON body: keep the HTTP status as the cause */ }
        throw new Error(cause.slice(0, MAX_INFRA_CAUSE_CHARS));
      }
      const normalized = normalizeLegResult(planned.leg, (await res.json()) as LegRunResult);
      return {
        ...normalized,
        description: normalized.description?.slice(0, MAX_DESCRIPTION_CHARS),
        ms: Date.now() - started,
      };
    });

  const first = await attempt(`start-${planned.leg}`, planned).catch((err: unknown): LegRunResult => {
    // Retries spent (infra). The thrown message already carries the cause.
    const message = err instanceof Error ? err.message : String(err);
    return { leg: planned.leg, state: "error", description: message.slice(0, MAX_DESCRIPTION_CHARS) };
  });

  // A red test is data, but it may be a flake: run it once more on a fresh
  // container. success/error are final; only failure retries.
  if (first.state !== "failure") return first;

  // The retry writes its own log: the first attempt's shard-<leg>.json stays as evidence.
  const retryTarget: PlannedLeg = { ...planned, resultKey: retryResultKey(planned.resultKey) };
  const retry = await attempt(`retry-${planned.leg}`, retryTarget).catch((err: unknown): LegRunResult => {
    const message = err instanceof Error ? err.message : String(err);
    return { leg: planned.leg, state: "error", description: message.slice(0, MAX_DESCRIPTION_CHARS) };
  });

  // Wall time covers both attempts.
  const ms = sumMs(first.ms, retry.ms);
  if (retry.state === "success") {
    const firstCause = (first.description ?? "failure").slice(0, MAX_FIRST_DESCRIPTION_CHARS);
    return {
      leg: planned.leg, state: "success", description: `flaky: passed on retry; first: ${firstCause}`, ms, summary: retry.summary,
    };
  }
  return { ...retry, ms };
}

/** The retry's R2 key: the leg's own key with ".retry" before ".json", so the
 *  container still PUTs only under its leg's resultKey. */
export function retryResultKey(resultKey: string): string {
  return resultKey.replace(/\.json$/, ".retry.json");
}

/** The sum of the attempts that were timed; undefined when none was. */
function sumMs(...parts: (number | undefined)[]): number | undefined {
  const timed = parts.filter((p): p is number => p !== undefined);
  return timed.length > 0 ? timed.reduce((a, b) => a + b, 0) : undefined;
}

/** The /run-leg request body for one planned leg of one PR. Pure, so the
 *  private flag and the PR's own owner/repo reach the DO by a tested path. */
export function legRequest(
  owner: string, repo: string, planned: PlannedLeg,
  pr: { baseRef: string; pr: string; private: boolean },
): GateLegRequest {
  return {
    owner, repo, commit: planned.commit, leg: planned.leg,
    installCmd: planned.installCmd, legCmd: planned.legCmd,
    resultKey: planned.resultKey, baselineKeys: planned.baselineKeys,
    private: pr.private, baseRef: pr.baseRef, pr: pr.pr,
  };
}
