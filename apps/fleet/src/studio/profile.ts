import type { Env } from "../env";
import { parseStudioId } from "./ids";

// Issue #107 (#70 ask 3): container instance_type is fixed per Durable
// Object CONTAINER CLASS at deploy time (wrangler.jsonc containers[]) — see
// blueprint.ts's Role.instance_type doc comment for the full ruling. This is
// the actual per-role selection that ruling says is missing: a role in this
// set provisions into the STUDIO_BIG container class instead of the default
// STUDIO one. release-studio is first because it runs heavy local-ci gates
// (full test suite + bundler builds) and hits the memory ceiling — see
// docs/superpowers/specs/2026-09-25-release-studio-ci-steward-design.md.
export const BIG_PROFILE_ROLES: ReadonlySet<string> = new Set(["release-studio"]);

/** True when `role` provisions into the bigger container class. */
export function isBigProfileRole(role: string): boolean {
  return BIG_PROFILE_ROLES.has(role);
}

/**
 * The DO namespace a studio id's role routes through — env.STUDIO_BIG for a
 * BIG_PROFILE_ROLES role, env.STUDIO otherwise. An id that fails to parse
 * (defensive only — every real caller already validates the id first) falls
 * back to the default namespace rather than throwing: this is a routing
 * helper, not a validator.
 */
export function studioNamespace(env: Env, id: string): Env["STUDIO"] {
  const parsed = parseStudioId(id);
  return parsed && isBigProfileRole(parsed.role) ? env.STUDIO_BIG : env.STUDIO;
}

/** The DO stub for a studio id — routes through studioNamespace above.
 *  Replaces the `env.STUDIO.get(env.STUDIO.idFromName(id))` one-liner that
 *  used to appear at every call site; now every call site routes through
 *  this one function instead of hardcoding env.STUDIO. */
export function getStudioStub(env: Env, id: string): ReturnType<Env["STUDIO"]["get"]> {
  const ns = studioNamespace(env, id);
  return ns.get(ns.idFromName(id));
}
