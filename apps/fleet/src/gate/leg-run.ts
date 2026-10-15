// #715: the one-leg step GateWorkflow runs. Pure: no Workflow/DO bindings, so
// bun test can load it. workflow.ts passes in the real step and dispatcher.
//
// The GateRunnerDO answers /run-leg synchronously with the leg's LegResult.
// That return value is the step result. A red test is data (state "failure"),
// never a throw. Any non-2xx is infra: the step throws, Workflows retries it
// once, and a second failure becomes this leg's "error".
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

/** Runs one leg as one start-<leg> step. Never throws: every failure becomes
 *  this leg's LegResult, so the other legs still finish. */
export async function runLegStep(
  step: LegStepRunner,
  dispatch: (planned: PlannedLeg) => Promise<Response>,
  planned: PlannedLeg,
): Promise<LegResult> {
  try {
    return await step.do(
      `start-${planned.leg}`,
      // One retry for an infra failure. timeout is per attempt; Workflows step
      // wall time itself is unlimited.
      { retries: { limit: 1, delay: "15 seconds", backoff: "constant" }, timeout: "30 minutes" },
      async () => {
        const res = await dispatch(planned);
        if (!res.ok) throw new Error(`start ${planned.leg} failed (${res.status})`);
        const normalized = normalizeLegResult(planned.leg, (await res.json()) as LegResult);
        return {
          ...normalized,
          description: normalized.description?.slice(0, MAX_DESCRIPTION_CHARS),
        };
      },
    );
  } catch {
    // Retries spent or a bad body. Infra: error, never a silent pass.
    return { leg: planned.leg, state: "error", description: `${planned.leg} did not report a result` };
  }
}
