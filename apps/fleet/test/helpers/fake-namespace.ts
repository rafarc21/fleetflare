// Board #373 (sweep-3 S3-F3): the DO-namespace fake shape — name-verbatim
// idFromName, a get() stub, and the `as unknown as` cast out to the env's
// namespace type — hand-written in 6 suites (grid, burn-window-expiry,
// fleet-resume, profile, paste, index). The helper owns ONLY that shape:
// every suite still builds its own stub methods locally and hands them
// here. This file is a plain vitest-side module, NOT a bun:test fixture —
// it has no `cloudflare:test` import on purpose: the vitest `env` binding
// stays in each suite, spread by envWithNs's base parameter, so this
// module loads under either runtime without workerd bindings.
import type { Env } from "../../src/env";

/** A per-suite DO stub: either one fixed object every get() returns, or a
 *  function get(id) dispatches to (per-id fakes, e.g. grid's tails map). */
export type NsStub = Record<string, unknown> | ((id: string) => Record<string, unknown>);

/** The extracted shape: idFromName(name) === name, get(id) === stub. An
 *  object stub also lands its own members on the namespace surface (the
 *  pinned envWithNs test reads a stub member straight off env.STUDIO); a
 *  function stub cannot, and doesn't need to — its per-id results only
 *  ever come back through get(). The spread comes first, so a stub member
 *  named `get`/`idFromName` can never shadow the real ones. */
export function nsWith(stub: NsStub): Env["STUDIO"] {
  return {
    ...(typeof stub === "function" ? {} : stub),
    idFromName: ((name: string) => name) as unknown as Env["STUDIO"]["idFromName"],
    get: ((id: string) =>
      typeof stub === "function" ? stub(id) : stub) as unknown as Env["STUDIO"]["get"],
  } as unknown as Env["STUDIO"];
}

/** Spread a base env (each suite's own `env` from cloudflare:test) with
 *  STUDIO swapped for the fake namespace. */
export function envWithNs(stub: NsStub, base: Env): Env {
  return { ...base, STUDIO: nsWith(stub) } as unknown as Env;
}
