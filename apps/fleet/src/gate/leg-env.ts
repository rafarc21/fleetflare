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
  /** #1346: the secret NAMEs this leg is granted — already fully gated by
   *  secrets-scope.ts's grantedSecretNames in workflow.ts (fork guard +
   *  OPS-repo allowlist + registry membership) before this request is ever
   *  built. Names only, never a value: do.ts is where each name resolves to
   *  a real value (secrets-registry.ts, or a minted run token), exactly as
   *  legGitToken mints the git token outside this request body rather than
   *  carrying it in. Absent or empty means no secrets for this leg. */
  secretNames?: string[];
}

/** No token field, no URL field: the R2 keys below are plain keys, not
 *  credentials — the Worker-side outbound handler is what authorizes a plain
 *  fetch to one of these keys. GATE_PRIVATE is a switch, not a credential: it
 *  picks which host the container clones from, and the Worker holds the token.
 *  `secretValues` (name -> resolved value) is a SEPARATE parameter, never a
 *  field read off `req`, for the same reason `gateOutboundProps` takes
 *  `gitToken` as a separate parameter below: the request body only ever
 *  carries names (`req.secretNames`), resolved outside this request by do.ts. */
export function buildLegEnvVars(req: GateLegRequest, secretValues?: Record<string, string>): Record<string, string> {
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
    ...buildSecretEnvVars(secretValues),
  };
}

/** #1346: a granted secret name's own container env var, e.g.
 *  "staging-login" -> "GATE_SECRET_STAGING_LOGIN". Every non-alnum run
 *  becomes one underscore, so a name with a hyphen (the only punctuation
 *  secrets-config.schema.json's examples use) maps predictably. */
export function secretEnvVarName(name: string): string {
  return `GATE_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** The container env vars for this leg's granted secrets. `secretValues` is
 *  name -> resolved value, built by do.ts (secrets-registry.ts lookups, plus
 *  the minted AI token) — never derived from the request body itself, which
 *  only ever carries names. A name with no resolved value (an unset Worker
 *  secret, a registry entry removed after the OPS file still lists it) is
 *  silently skipped, never an empty-string env var. */
export function buildSecretEnvVars(secretValues: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(secretValues ?? {})) {
    if (value !== "") out[secretEnvVarName(name)] = value;
  }
  return out;
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
 *  the git proxy 403s for it. `secretValues`' own VALUES (never its names) ride
 *  along as `props.secretValues` (#1346): the one thing the outbound handler's
 *  PUT path needs to redact a granted secret out of this leg's own result
 *  before it reaches R2 — see secrets-redact.ts. Nothing else is granted to
 *  the container. */
export function gateOutboundProps(
  req: GateLegRequest, gitToken?: string, secretValues?: Record<string, string>,
): GateOutboundProps {
  const bundle = {
    ...(req.bundleKey === undefined ? {} : { bundleKey: req.bundleKey }),
    ...(req.bundleKey !== undefined && req.leg === BUNDLE_LEG ? { bundleWriter: true } : {}),
  };
  const values = Object.values(secretValues ?? {}).filter((v) => v !== "");
  const secrets = values.length === 0 ? {} : { secretValues: values };
  if (req.private !== true || gitToken === undefined) return { resultKey: req.resultKey, ...bundle, ...secrets };
  return { resultKey: req.resultKey, repo: `${req.owner}/${req.repo}`, gitToken, ...bundle, ...secrets };
}
