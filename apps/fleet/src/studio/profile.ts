import type { Env } from "../env";
import { parseStudioId } from "./ids";
import { getStudioRow } from "./registry";
import type { StudioStatus } from "./types";
// The pure role->class functions live in their own Env-free module — see
// that file's own header for why: provision.ts needs doClassForRole without
// pulling this file's Env/registry.ts import chain into the `cli`/`bun`
// type-check project. Re-exported here so every EXISTING consumer of this
// file (test/studio.profile.test.ts, routes.ts) keeps importing them from
// "./profile" unchanged.
import { isBigProfileRole, doClassForRole, BIG_PROFILE_ROLES } from "./container-class";

export { BIG_PROFILE_ROLES, isBigProfileRole, doClassForRole };

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
 * provisioned, ever) is the ONE case a fresh role-based class is chosen —
 * there is no existing container identity to protect yet, and this is
 * exactly the value provision.ts's freshStatus is about to independently
 * compute (same pure function, same input, guaranteed to agree — see that
 * function's own comment). Every other case (row exists, doClass present OR
 * absent) uses the recorded value, never role.
 */
export async function getStudioStub(env: Env, id: string): Promise<ReturnType<Env["STUDIO"]["get"]>> {
  const row = await getStudioRow(env, id);
  if (row) return getStudioStubForRow(env, row);
  const parsed = parseStudioId(id);
  return getStudioStubForRow(env, { id, doClass: doClassForRole(parsed?.role ?? "") });
}
