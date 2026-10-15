// #715 gate runner: the pure leg-request → container env-var mapping, split
// out of do.ts so it is unit-testable under bun test. do.ts imports
// @cloudflare/containers and the Env type (which pulls worker-typed files),
// neither of which the bun-typed test project can load.
//
// Plain R2 keys, never a presigned URL: a presigned URL is itself a bearer
// credential, forgeable by the PR code it is meant to gate.

export interface GateLegRequest {
  owner: string; repo: string; commit: string; leg: string;
  installCmd: string; legCmd: string;
  resultKey: string; baselineKeys: string[];
}

/** No token field, no URL field: Phase 1's repo (rafarc21/fleetflare) is
 *  public, and the R2 keys below are plain keys, not credentials — the
 *  Worker-side outbound handler (a later task) is what authorizes a plain
 *  fetch to one of these keys. */
export function buildLegEnvVars(req: GateLegRequest): Record<string, string> {
  return {
    GATE_REPO: `${req.owner}/${req.repo}`,
    GATE_COMMIT: req.commit,
    GATE_LEG: req.leg,
    GATE_INSTALL_CMD: req.installCmd,
    GATE_LEG_CMD: req.legCmd,
    GATE_RESULT_KEY: req.resultKey,
    GATE_BASELINE_KEYS: req.baselineKeys.join(","),
  };
}
