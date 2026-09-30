import type { Env } from "../env";
import { parseStudioId } from "./ids";
import { getStudioRow } from "./registry";
import type { StudioStatus, StudioDOClass } from "./types";
// The pure role->class functions live in their own Env-free module — see
// that file's own header for why: provision.ts needs doClassForRole without
// pulling this file's Env/registry.ts import chain into the `cli`/`bun`
// type-check project. Re-exported here so every EXISTING consumer of this
// file (test/studio.profile.test.ts, routes.ts) keeps importing them from
// "./profile" unchanged.
import { isBigProfileRole, doClassForRole, BIG_PROFILE_ROLES } from "./container-class";

export { BIG_PROFILE_ROLES, isBigProfileRole, doClassForRole };

/**
 * Issue #107 fix-first round 2: the doClass that is actually SAFE to persist
 * right now — unlike doClassForRole (container-class.ts), which only asks
 * "does this role qualify," this also asks "is env.STUDIO_BIG genuinely
 * reachable in THIS deploy." The container/ change that adds the real
 * StudioBigDO binding ships in a separate, batched rollout from this code
 * (see the issue's own body) — so there is a real window where the code is
 * live but the binding is not. Stamping "STUDIO_BIG" into a row during that
 * window, purely from role, would be a lie the row keeps telling forever:
 * the container was actually created under STUDIO (studioNamespace's own
 * fallback), but a later read — once the operator FINALLY deploys the
 * binding — would believe the row and route to a brand-new, empty
 * STUDIO_BIG DO, orphaning the real one. This is the ONLY function that
 * should ever decide what doClass value gets WRITTEN to a row; every write
 * site threads its result down rather than calling doClassForRole directly.
 */
export function realDoClassForRole(env: Env, role: string): StudioDOClass {
  return isBigProfileRole(role) && Boolean(env.STUDIO_BIG) ? "STUDIO_BIG" : "STUDIO";
}

/**
 * The DO namespace a studio routes through, given its RECORDED class.
 * `row.doClass` absent means STUDIO, unconditionally — never re-derived
 * from role (see StudioStatus.doClass). Falls back to `env.STUDIO`, logged,
 * when `env.STUDIO_BIG` itself is missing from Env (an older/forked fleet
 * config, or local `wrangler dev` before the operator adds the binding) —
 * a routing helper must degrade, never throw, when a binding it wants isn't
 * there yet.
 */
export function studioNamespace(env: Env, row: Pick<StudioStatus, "id" | "doClass">): Env["STUDIO"] {
  if (row.doClass === "STUDIO_BIG") {
    if (env.STUDIO_BIG) return env.STUDIO_BIG;
    console.warn(`profile: studio ${row.id} is recorded STUDIO_BIG but env.STUDIO_BIG is unset -- falling back to STUDIO`);
  }
  return env.STUDIO;
}

/** The DO stub for a row you already have in hand — no extra read. Use this
 *  when the caller already fetched/built the StudioStatus row (the grid
 *  renderer, a fresh spawn that knows its own role). */
export function getStudioStubForRow(env: Env, row: Pick<StudioStatus, "id" | "doClass">): ReturnType<Env["STUDIO"]["get"]> {
  const ns = studioNamespace(env, row);
  return ns.get(ns.idFromName(row.id));
}

/**
 * The DO stub for a bare studio id — looks up its registry row for the
 * RECORDED class. A row that does not exist at all (this id has never been
 * provisioned, ever) is the ONE case a fresh role/env-based class is chosen
 * — there is no existing container identity to protect yet, so there is
 * nothing a wrong guess here could orphan (unlike every WRITE site, this
 * call persists nothing; realDoClassForRole is used anyway, for the same
 * reason every role/env-dependent decision goes through it rather than the
 * blind doClassForRole — round 2's consistency rule, not a behavior change
 * for this read-only call). Every other case (row exists, doClass present OR
 * absent) uses the recorded value, never role.
 */
export async function getStudioStub(env: Env, id: string): Promise<ReturnType<Env["STUDIO"]["get"]>> {
  const row = await getStudioRow(env, id);
  if (row) return getStudioStubForRow(env, row);
  const parsed = parseStudioId(id);
  return getStudioStubForRow(env, { id, doClass: realDoClassForRole(env, parsed?.role ?? "") });
}
