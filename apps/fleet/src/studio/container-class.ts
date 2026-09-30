import type { StudioDOClass } from "./types";

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
 * Which DO class a role qualifies for IN PRINCIPLE — role alone, nothing
 * else. Deliberately in its own file, imported neither from Env nor from
 * registry.ts: provision.ts (a `cli`-project-reachable module, via
 * failover.ts -> cli/reap.ts) needs this pure role->class function without
 * pulling env.ts's Worker-only ambient types (D1Database,
 * DurableObjectNamespace, ...) into the `cli`/`bun` type-check project —
 * see profile.ts's own header for the Env-aware routing half this feeds.
 *
 * Issue #107 fix-first round 2: DO NOT call this to decide what doClass
 * value gets WRITTEN into a persisted row. It has no way to know whether
 * env.STUDIO_BIG is actually bound in THIS deploy — the container/ change
 * that wires it ships in a separate, batched rollout (see the issue's own
 * body) — so a write made purely from role during that window can stamp
 * "STUDIO_BIG" on a studio that was actually created under STUDIO, and a
 * later read (once the binding exists) would believe the lie and orphan the
 * real container. Every write site uses profile.ts's realDoClassForRole
 * instead, which takes `env` and answers the write-safe question. This
 * function stays useful only for the "does this role qualify at all"
 * question (isBigProfileRole is usually the more direct way to ask that).
 */
export function doClassForRole(role: string): StudioDOClass {
  return isBigProfileRole(role) ? "STUDIO_BIG" : "STUDIO";
}
