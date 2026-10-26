// #1346: the OPS-repo-only allowlist for gate-scoped secrets. Lives in
// FLEET_OPS_REPO (../ops-repo.ts), never in the gated repo's own fleet.json
// -- a PR edits its OWN repo's fleet.json (config.ts's gate block), never
// the ops repo, so it can never add itself to this file. The run-time fetch
// (FLEET_OPS_REPO -> fetchRepoFile at GATE_SECRETS_ALLOWLIST_PATH) is wired
// in workflow.ts, the same shape leak-gate.ts's OPS_DENYLIST_PATH already
// uses (mintRepoToken with contents: read, fetched at "HEAD").
//
// Pure parsing only here -- no fetch, no binding -- so bun test loads this
// file directly, same split load-config.ts/config.ts already use for
// fleet.json's own gate block.

/** `gate-secrets.json`'s path inside FLEET_OPS_REPO. Schema documented in
 *  secrets-config.schema.json, next to this file. */
export const GATE_SECRETS_ALLOWLIST_PATH = "gate-secrets.json";

/** repo (owner/name) -> leg name -> the secret NAMEs that leg may receive.
 *  A name is an opaque label here -- never a value, an env var, or a binding
 *  name; secrets-registry.ts is the only place a name resolves to anything
 *  real, and secrets-scope.ts is the only place this type is read. */
export type GateSecretsAllowlist = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** The OPS file, parsed. Fail closed on anything malformed: a bad top level
 *  returns an empty allowlist (every leg gets nothing), a bad per-repo value
 *  drops that repo, a bad per-leg value drops that leg -- one broken entry
 *  never widens into "grant everything" and never throws, mirroring
 *  leak-gate.ts's own parseDenylist rule for the sibling OPS file. */
export function parseGateSecretsAllowlist(raw: unknown): GateSecretsAllowlist {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, string[]>> = {};
  for (const [repo, legs] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof legs !== "object" || legs === null || Array.isArray(legs)) continue;
    const perLeg: Record<string, string[]> = {};
    for (const [leg, names] of Object.entries(legs as Record<string, unknown>)) {
      if (isStringArray(names)) perLeg[leg] = names;
    }
    out[repo] = perLeg;
  }
  return out;
}

/** `allowlist[repo]`, matched case-insensitively -- the same rule
 *  fleet.json's own `gates` map already follows (config.ts's
 *  gateMapEntry). Undefined when the repo has no entry at all. */
export function gateSecretsRepoEntry(
  allowlist: GateSecretsAllowlist, repo: string,
): Readonly<Record<string, readonly string[]>> | undefined {
  const key = repo.toLowerCase();
  return Object.entries(allowlist).find(([name]) => name.toLowerCase() === key)?.[1];
}
