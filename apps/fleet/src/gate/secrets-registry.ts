// #1346: the Worker-side registry a gate-secret NAME resolves to. The OPS
// repo's allowlist (secrets-config.ts) may only GRANT a name from here to a
// (repo, leg) pair -- it can never invent one. Adding a new named secret is
// a code change + deploy (this file, plus `wrangler secret put` for its
// envVar), the same cost as adding any other Worker secret today.
//
// A name with no envVar (workers-ai) has no stored value at all: its secret
// is a run-scoped token minted per leg (secrets-ai-token.ts), never a Worker
// secret -- see docs/superpowers/specs/2026-10-26-gate-scoped-secrets-design.md.
//
// Pure: no cloudflare:workers import, no Env type, so bun test loads this
// file directly. do.ts is the only caller with a real Env and a real mint
// function -- resolveGrantedSecrets (below) takes both as plain injected
// values so the resolution loop itself stays testable here, same split
// leg-env.ts's own header describes for do.ts/run-leg.ts.

export interface SecretDef {
  /** The Env key holding this name's real value. Mutually exclusive with
   *  `minted`. */
  envVar?: string;
  /** True for a name whose value is minted per-run by do.ts, never stored as
   *  a Worker secret (the Workers AI proxy route's run-scoped token, below).
   *  Mutually exclusive with `envVar`. */
  minted?: true;
}

/** Operator: add one entry per staging credential a browser/AI leg needs,
 *  plus a matching `wrangler secret put <envVar>` (scripts/deploy.sh secret
 *  put, never a bare `wrangler secret put`). The name is a label the OPS
 *  repo's allowlist grants to a (repo, leg) pair -- never the value, never
 *  the env var name itself, so an OPS-file read never discloses where the
 *  real value lives. Staging-only, by discipline: nothing here can verify
 *  that at write time -- see the design doc's "Operator responsibility." */
export const SECRET_REGISTRY: Readonly<Record<string, SecretDef>> = {
  "staging-login": { envVar: "GATE_SECRET_STAGING_LOGIN" },
  // #1346: Workers AI proxy route (floor mode, T4). No stored value: a
  // run-scoped bearer token is minted per leg instead (secrets-ai-token.ts).
  "workers-ai": { minted: true },
};

export function isKnownSecretName(name: string): boolean {
  return Object.hasOwn(SECRET_REGISTRY, name);
}

export function secretDef(name: string): SecretDef | undefined {
  return SECRET_REGISTRY[name];
}

/**
 * #1346: resolves every already-granted name (req.secretNames, already fully
 * gated by secrets-scope.ts before this ever runs) to a real value -- an
 * unset Worker secret, or `mintMinted` declining (e.g. no signing key
 * configured), silently drops that one name, never throws and never fails
 * the leg: a leg command missing a secret it expected is that leg's own
 * failure to surface, not this resolver's. `env` is a plain record (do.ts
 * passes its real Env, cast once there) and `mintMinted` is injected (do.ts's
 * real call mints an AI run token; a test supplies a fake), so this whole
 * loop is pure and bun-testable despite resolving real Worker secrets at
 * call time.
 */
export async function resolveGrantedSecrets(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  mintMinted: (name: string) => Promise<string | undefined>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const def = secretDef(name);
    if (def === undefined) continue;
    const value = def.minted === true ? await mintMinted(name) : def.envVar === undefined ? undefined : env[def.envVar];
    if (value !== undefined && value !== "") out[name] = value;
  }
  return out;
}
