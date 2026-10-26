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

/** One leg's OPS-allowlist entry, normalized. The OPS file may write either
 *  shape (see parseGateSecretsAllowlist's own per-entry parsing) -- a plain
 *  array (back-compat, `head` absent) or `{secrets, head}`; every entry this
 *  type ever describes, after parsing, is this normalized object, so nothing
 *  downstream (secrets-scope.ts) ever branches on which shape the file used. */
export interface GateSecretsLegEntry {
  /** The secret NAMEs this leg may receive. */
  secrets: readonly string[];
  /** #1376: when true, this leg's own `@head`/`@head-<n>` union-plan copy
   *  (fanout.ts's headLegName -- the name a leg a PR ADDS to its own
   *  fleet.json runs under) receives the SAME grants as this leg, under the
   *  exact same trust filter (secrets-scope.ts's trustedForSecrets) -- never
   *  a separate or looser check. Absent/false: no head grants at all, the
   *  #1346 default, unchanged. Explicit ops opt-in ONLY: a PR cannot set
   *  this itself, the same reason it cannot add its own allowlist entry --
   *  this file never lives in the PR's own repo. */
  head?: boolean;
}

/** repo (owner/name) -> leg name -> that leg's normalized OPS-allowlist
 *  entry. A name inside `secrets` is an opaque label here -- never a value,
 *  an env var, or a binding name; secrets-registry.ts is the only place a
 *  name resolves to anything real, and secrets-scope.ts is the only place
 *  this type is read. */
export type GateSecretsAllowlist = Readonly<Record<string, Readonly<Record<string, GateSecretsLegEntry>>>>;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** #1380: the reserved top-level key `parseTrustOwnApp` reads. Never a repo
 *  slug (every real repo key contains "/"). */
const TRUST_OWN_APP_KEY = "trustOwnApp";

/** The only keys the object form (`{secrets, head?}`) ever reads. */
const LEG_ENTRY_KEYS: ReadonlySet<string> = new Set(["secrets", "head"]);

/** One leg's raw OPS-file value, normalized to `GateSecretsLegEntry`, or null
 *  on anything malformed (a bad `secrets` field, a non-boolean `head`, or a
 *  shape that is neither a string array nor `{secrets, head?}`).
 *  `context` (e.g. "acme/example/\"leg\"") names the entry in a warning only
 *  -- it changes no parsed value. #1376 security review r1 LOW: the schema
 *  (`secrets-config.schema.json`) declares `additionalProperties: false` for
 *  the object form, but the parser itself silently ignored any extra key
 *  instead of saying so -- an operator typo (`"heads": true` instead of
 *  `"head"`) would otherwise parse as a quiet no-grant with no signal why.
 *  Warned, never dropped: an unknown key changes nothing about the grant
 *  itself, so it is not treated as malformed the way a bad `secrets`/`head`
 *  value is. */
function parseLegEntry(raw: unknown, context: string): GateSecretsLegEntry | null {
  if (isStringArray(raw)) return { secrets: raw };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isStringArray(r.secrets)) return null;
  if (r.head !== undefined && typeof r.head !== "boolean") return null;
  for (const key of Object.keys(r)) {
    if (!LEG_ENTRY_KEYS.has(key)) {
      console.warn(`gate-secrets allowlist: ${context} has an unknown key "${key}" -- ignored, no grant change`);
    }
  }
  return r.head === true ? { secrets: r.secrets, head: true } : { secrets: r.secrets };
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
  const out: Record<string, Record<string, GateSecretsLegEntry>> = Object.create(null);
  for (const [repo, legs] of Object.entries(raw as Record<string, unknown>)) {
    // #1380: the one reserved top-level key that is never a repo slug (every
    // real repo key contains "/"; this one never does) -- parseTrustOwnApp,
    // below, reads it from this SAME raw value instead.
    if (repo === TRUST_OWN_APP_KEY) continue;
    if (typeof legs !== "object" || legs === null || Array.isArray(legs)) {
      console.warn(`gate-secrets allowlist: repo "${repo}" entry is not an object -- dropped`);
      continue;
    }
    const perLeg: Record<string, GateSecretsLegEntry> = Object.create(null);
    for (const [leg, value] of Object.entries(legs as Record<string, unknown>)) {
      const entry = parseLegEntry(value, `${repo}/"${leg}"`);
      if (entry !== null) {
        perLeg[leg] = entry;
      } else {
        console.warn(`gate-secrets allowlist: ${repo}/"${leg}" is not a string array or {secrets, head?} -- dropped`);
      }
    }
    out[repo] = perLeg;
  }
  return out;
}

/**
 * #1380 security review r1 MED: fleet-wide (never per-repo) boolean opt-in,
 * trusting ONLY this Worker's own configured GitHub App for gate-scoped
 * secrets, on top of the ordinary human-collaborator trust path. Top-level,
 * not per-repo: "the fleet's own GitHub App" is one identity across every
 * repo this fleet gates, and studios across every gated repo open PRs
 * through the SAME App. A top-level `trustOwnApp` key never collides with a
 * repo entry: every repo key is an `owner/repo` slug, which always contains
 * "/", while "trustOwnApp" never does.
 *
 * Originally a free-form list of trusted App slugs (`trustApps: string[]`) --
 * replaced after security review r1 found the companion "App id matches"
 * cross-check was dead code (the only JWT-authenticated endpoint available,
 * `GET /repos/{owner}/{repo}/installation`, can only ever confirm THIS
 * Worker's own App is installed on a repo, never verify which App actually
 * authored a given PR) and, worse, that an operator naming any OTHER real
 * bot's slug in that list (even by a config mistake, e.g. "dependabot")
 * would grant it trust with nothing left to catch the error. A boolean has
 * no such failure mode: there is no slug to mistype, and the one slug this
 * code ever compares against (secrets-scope.ts's `trustedForSecrets`) is
 * this Worker's OWN, read fresh from `GET /app` -- never operator input.
 *
 * Absent -> false (feature OFF, the #1346/#1376 default, unchanged). Present
 * but not a boolean -> false, WARNED (security review r1 LOW: a typo like
 * `"trustOwnApp": "true"` must be visible, not a silent no-op) -- same
 * fail-closed rule every other malformed shape in this file follows. Read
 * from the SAME raw JSON `parseGateSecretsAllowlist` itself parses
 * (workflow.ts parses both from one fetch), never a second file or fetch.
 */
export function parseTrustOwnApp(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const value = (raw as Record<string, unknown>)[TRUST_OWN_APP_KEY];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    console.warn(`gate-secrets allowlist: "${TRUST_OWN_APP_KEY}" is ${JSON.stringify(value)}, not a boolean -- treated as false`);
    return false;
  }
  return value;
}

/** `allowlist[repo]`, matched case-insensitively -- the same rule
 *  fleet.json's own `gates` map already follows (config.ts's
 *  gateMapEntry). Undefined when the repo has no entry at all. */
export function gateSecretsRepoEntry(
  allowlist: GateSecretsAllowlist, repo: string,
): Readonly<Record<string, GateSecretsLegEntry>> | undefined {
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
