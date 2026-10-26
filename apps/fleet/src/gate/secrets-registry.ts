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
// file directly. do.ts is the only caller that resolves a name to a real
// value, by reading `this.env[def.envVar]`.

export interface SecretDef {
  /** The Env key holding this name's real value. Absent for a name whose
   *  value is minted per-run instead of stored (see "workers-ai" below). */
  envVar?: string;
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
  "workers-ai": {},
};

export function isKnownSecretName(name: string): boolean {
  return Object.hasOwn(SECRET_REGISTRY, name);
}

export function secretDef(name: string): SecretDef | undefined {
  return SECRET_REGISTRY[name];
}
