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
 *  leak-gate.ts's own parseDenylist rule for the sibling OPS file. Every drop
 *  is logged (the repo/leg NAME only, never the malformed value itself) so a
 *  typo in a hand-edited OPS file is visible, not silently eaten.
 *
 *  Built with `Object.create(null)`, not `{}`: the allowlist's own keys come
 *  from an external file, and a plain object literal's inherited
 *  Object.prototype would let a key literally named "__proto__" pollute it on
 *  assignment (`out[repo] = ...` is a normal property SET, unlike
 *  Object.entries' own read, which only sees own-enumerable JSON properties
 *  safely). A null-prototype object has no such setter to trigger. */
export function parseGateSecretsAllowlist(raw: unknown): GateSecretsAllowlist {
  const empty: GateSecretsAllowlist = Object.create(null);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty;
  const out: Record<string, Record<string, string[]>> = Object.create(null);
  for (const [repo, legs] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof legs !== "object" || legs === null || Array.isArray(legs)) {
      console.warn(`gate-secrets allowlist: repo "${repo}" entry is not an object -- dropped`);
      continue;
    }
    const perLeg: Record<string, string[]> = Object.create(null);
    for (const [leg, names] of Object.entries(legs as Record<string, unknown>)) {
      if (isStringArray(names)) {
        perLeg[leg] = names;
      } else {
        console.warn(`gate-secrets allowlist: ${repo}/"${leg}" is not a string array -- dropped`);
      }
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

/**
 * #1346 security review r1 item 3 / correctness review r1 item 1: whether a
 * trusted PR's unreadable OPS allowlist should fail the WHOLE run, pulled out
 * as its own pure function (rather than an inline `if` in workflow.ts, which
 * `cloudflare:workers` keeps bun test from ever loading) so a future revert
 * of this guard fails a real test, not just a manual re-check.
 *
 * `allowlist === null` means the fetch or parse itself failed -- distinct
 * from a deliberately absent/empty file, which parses to `{}`
 * (parseGateSecretsAllowlist's own rule) and is never a failure: "the
 * operator never turned this on" is not the same thing as "we don't know
 * what the operator configured." An untrusted PR never fails here either --
 * it was never going to receive a grant regardless of what the file says.
 *
 * Returns the failure description to post and return, or null when the run
 * should proceed as normal.
 */
export function gateSecretsAllowlistFailure(trusted: boolean, allowlist: GateSecretsAllowlist | null): string | null {
  if (!trusted) return null;
  if (allowlist !== null) return null;
  return "gate-secrets: OPS allowlist unavailable";
}
