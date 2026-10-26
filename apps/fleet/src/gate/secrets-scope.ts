// #1346: the one function every gate-scoped secret grant passes through.
// Pure: no fetch, no binding, no secret value -- this file only ever decides
// a list of NAMEs, never resolves one to a value (secrets-registry.ts/do.ts
// do that, after this guard already ran).
import { gateSecretsRepoEntry, type GateSecretsAllowlist } from "./secrets-config";
import { isKnownSecretName } from "./secrets-registry";

/**
 * Four independent guards, checked in this order on purpose -- cheapest and
 * most load-bearing first:
 *   1. fork guard      -- `sameRepo === false` grants nothing, unconditionally,
 *                          whatever the allowlist says. This is the one check
 *                          that makes every PR from a fork a no-op here.
 *   2. repo guard      -- the OPS allowlist has no entry for this repo.
 *   3. leg guard       -- this repo's entry does not name this leg.
 *   4. registry guard  -- a name the OPS file lists but this Worker's own
 *                         registry never defined grants nothing (defense in
 *                         depth against an OPS-file typo or a stale entry
 *                         left behind after a registry entry was removed).
 */
export function grantedSecretNames(
  allowlist: GateSecretsAllowlist, repo: string, leg: string, sameRepo: boolean,
): string[] {
  if (!sameRepo) return [];
  const forRepo = gateSecretsRepoEntry(allowlist, repo);
  if (forRepo === undefined) return [];
  const names = forRepo[leg];
  if (names === undefined) return [];
  return names.filter(isKnownSecretName);
}
