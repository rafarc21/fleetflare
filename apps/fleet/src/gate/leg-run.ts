// #715: the one-leg step GateWorkflow runs. Pure: no Workflow/DO bindings, so
// bun test can load it. workflow.ts passes in the real step and dispatcher.
//
// The GateRunnerDO answers /run-leg synchronously with the leg's LegResult.
// That return value is the step result. A red test is data (state "failure"),
// never a throw. Any non-2xx is infra: the step throws, Workflows retries it
// once, and a second failure becomes this leg's "error".
import type { GateLegRequest } from "./leg-env";
import { normalizeLegResult, type PlannedLeg } from "./fanout";
import type { LegResult } from "./verdict";

/** Workflows caps a step result at 1 MiB; a leg description has no reason to
 *  be near that, so it is bounded well under it. */
const MAX_DESCRIPTION_CHARS = 2000;

/** The one step config a leg uses. Literal types, so the object is assignable
 *  to Workflows' WorkflowStepConfig without importing cloudflare:workers here
 *  (the check tsconfigs for test/ cannot resolve that module). */
export interface LegStepConfig {
  retries: { limit: number; delay: "15 seconds"; backoff: "constant" };
  timeout: "30 minutes";
}

/** The slice of Workflows' WorkflowStep this module uses. */
export interface LegStepRunner {
  do(name: string, config: LegStepConfig, fn: () => Promise<LegResult>): Promise<LegResult>;
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
): Promise<LegResult> {
  const attempt = async (name: string): Promise<LegResult> =>
    step.do(name, LEG_STEP_CONFIG, async () => {
      const res = await dispatch(planned);
      if (!res.ok) {
        // A non-2xx (infra, 503) carries its cause in the body's `error`
        // field — surface it, cut to the description ceiling.
        let cause = `${planned.leg}`;
        try {
          const body = await res.json() as { error?: unknown };
          if (typeof body.error === "string" && body.error.length > 0) {
            cause = `${planned.leg}: ${body.error}`;
          }
        } catch { /* non-JSON body: keep the leg name as the cause */ }
        throw new Error(cause.slice(0, 200));
      }
      const normalized = normalizeLegResult(planned.leg, (await res.json()) as LegResult);
      return {
        ...normalized,
        description: normalized.description?.slice(0, MAX_DESCRIPTION_CHARS),
      };
    });

  const first = await attempt(`start-${planned.leg}`).catch((err: unknown) => {
    // Retries spent (infra). The thrown message already carries the cause.
    const message = err instanceof Error ? err.message : String(err);
    return { leg: planned.leg, state: "error", description: message.slice(0, MAX_DESCRIPTION_CHARS) } as LegResult;
  });

  // A red test is data, but it may be a flake: run it once more on a fresh
  // container. success/error are final; only failure retries.
  if (first.state !== "failure") return first;

  const retry = await attempt(`retry-${planned.leg}`).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return { leg: planned.leg, state: "error", description: message.slice(0, MAX_DESCRIPTION_CHARS) } as LegResult;
  });

  if (retry.state === "success") {
    return { leg: planned.leg, state: "success", description: "flaky: passed on retry" };
  }
  return retry;
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
