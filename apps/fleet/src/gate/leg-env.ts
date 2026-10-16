// #715 gate runner: the pure leg-request → container env-var mapping, split
// out of do.ts so it is unit-testable under bun test. do.ts imports
// @cloudflare/containers and the Env type (which pulls worker-typed files),
// neither of which the bun-typed test project can load.
//
// Plain R2 keys, never a presigned URL: a presigned URL is itself a bearer
// credential, forgeable by the PR code it is meant to gate.

import type { GateOutboundProps } from "./outbound-handler";

/** #1080: the leg that fetches and builds the run's bundle, once, before the
 *  other legs start. Its result never joins the verdict. */
export const BUNDLE_LEG = "bundle";

export interface GateLegRequest {
  owner: string; repo: string; commit: string; leg: string;
  installCmd: string; legCmd: string;
  resultKey: string; baselineKeys: string[];
  /** #715: a private repo clones through the Worker git proxy, not github.com. */
  private?: boolean;
  /** The PR's base branch name, for the container's stale-base check. */
  baseRef: string;
  /** The PR number, for fetching a fork PR's head. */
  pr: string;
  /** The leg's own deadline in minutes. Absent means the default (25). */
  timeoutMin?: number;
  /** The run's image key (#1066), a lookup into the operator's images map. Absent means the default. */
  image?: string;
  /** #1080: the run's bundle key. Every leg reads it; the bundle leg writes it. Absent: clone, as before. */
  bundleKey?: string;
  /** #1080 HIGH 1: the PR's merge base. Sent only with a bundle key: a snapshot leg merges with it. */
  mergeBase?: string;
}

/** No token field, no URL field: the R2 keys below are plain keys, not
 *  credentials — the Worker-side outbound handler is what authorizes a plain
 *  fetch to one of these keys. GATE_PRIVATE is a switch, not a credential: it
 *  picks which host the container clones from, and the Worker holds the token. */
export function buildLegEnvVars(req: GateLegRequest): Record<string, string> {
  return {
    GATE_REPO: `${req.owner}/${req.repo}`,
    GATE_COMMIT: req.commit,
    GATE_LEG: req.leg,
    GATE_INSTALL_CMD: req.installCmd,
    GATE_LEG_CMD: req.legCmd,
    GATE_RESULT_KEY: req.resultKey,
    GATE_BASELINE_KEYS: req.baselineKeys.join(","),
    GATE_PRIVATE: req.private === true ? "1" : "0",
    GATE_BASE_REF: req.baseRef,
    GATE_PR: req.pr,
    ...(req.bundleKey === undefined ? {} : { GATE_BUNDLE_KEY: req.bundleKey }),
    ...(req.bundleKey === undefined || req.mergeBase === undefined ? {} : { GATE_MERGE_BASE: req.mergeBase }),
  };
}

/** #715: the one git token this leg's proxy uses, minted at leg start. Only a
 *  private leg mints. A public leg gets undefined and no mint call. */
export async function legGitToken(
  req: GateLegRequest,
  mint: (repo: string) => Promise<string>,
): Promise<string | undefined> {
  if (req.private !== true) return undefined;
  return mint(`${req.owner}/${req.repo}`);
}

/** The interceptor's props for this leg: its own result key. A private leg with
 *  a minted token also gets the one repo the git proxy will serve and that token.
 *  A public leg, or a private leg with no token, gets no repo and no token, so
 *  the git proxy 403s for it. Nothing else is granted to the container. */
export function gateOutboundProps(req: GateLegRequest, gitToken?: string): GateOutboundProps {
  const bundle = {
    ...(req.bundleKey === undefined ? {} : { bundleKey: req.bundleKey }),
    ...(req.bundleKey !== undefined && req.leg === BUNDLE_LEG ? { bundleWriter: true } : {}),
  };
  if (req.private !== true || gitToken === undefined) return { resultKey: req.resultKey, ...bundle };
  return { resultKey: req.resultKey, repo: `${req.owner}/${req.repo}`, gitToken, ...bundle };
}
