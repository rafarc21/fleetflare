# Studio Instance Profile (Issue #107 / #70 ask 3)

**Goal:** give `release-studio` (the QA/gate role) a bigger container instance
size than every other role, without changing sizing for anyone else.

**Spec:** board issue #107, `https://github.com/rafarc21/fleetflare/issues/107`.
Background ruling this completes: `src/studio/blueprint.ts`'s `Role.instance_type`
doc comment (Fleet Spawn P3, R-P3-3) — that field is parsed but deliberately
never read, because sizing a role differently means giving it its own
Durable Object CONTAINER CLASS, which nothing before this issue added.

## Problem

Cloudflare's Container Durable Objects fix instance size (CPU/memory class)
PER CONTAINER CLASS at deploy time (`wrangler.jsonc`'s `containers[].
instance_type`) — there is no per-DO-instance runtime override. Before this
change there was exactly one container class for studios (`StudioDO`), so
every studio of every role got the same instance_type. `release-studio` runs
heavy local-ci gates (full test suite + bundler builds — see
`docs/superpowers/specs/2026-09-25-release-studio-ci-steward-design.md`,
"Studio budget: ceiling 11.65 GiB") and hits that shared ceiling. Raising the
ceiling for everyone raises the cost for everyone; release-studio needs its
own class.

## Design

A studio id is `<repo>--<role>` or `<repo>--<role>--<n>`
(`src/studio/ids.ts`'s `parseStudioId`), so the role name is always cheaply
recoverable from the id string alone — no network/DB read needed. So:

- A second Durable Object container class, `StudioBigDO` — identical to
  `StudioDO` in every way (same class body, zero behavior difference) except
  its own container class, so `wrangler.jsonc` can give it a different
  `instance_type`.
- A static, role-name-keyed, pure function (`src/studio/profile.ts`) that
  picks which binding a given studio id routes through: `env.STUDIO_BIG` for
  a role in `BIG_PROFILE_ROLES` (`release-studio` today), `env.STUDIO`
  otherwise.
- Every call site that used to do `env.STUDIO.get(env.STUDIO.idFromName(id))`
  now routes through `profile.ts`'s `getStudioStub(env, id)` instead, so a
  release-studio spawn's actual provisioning call lands on the bigger class.

No schema changes to blueprint parsing, no D1 registry column, no
per-request GitHub fetch. `Role.instance_type` stays exactly what it was —
recorded, never read — since the directory-based `Studio`-shaped roles
(release-studio, web-studio, maestro) don't even carry that field; the
routing here is a static predicate over the role NAME, not that field.

## Files touched

- `apps/fleet/src/studio/profile.ts` (new) — `BIG_PROFILE_ROLES`,
  `isBigProfileRole`, `studioNamespace`, `getStudioStub`.
- `apps/fleet/test/studio.profile.test.ts` (new) — unit coverage for the
  above against a fake `Env`.
- `apps/fleet/src/env.ts` — new `STUDIO_BIG: DurableObjectNamespace<StudioDO>`
  binding.
- `apps/fleet/src/studio/do.ts` — `export class StudioBigDO extends StudioDO {}`.
- `apps/fleet/src/index.ts` — `export { StudioBigDO } from "./studio/do";`
  (wrangler.jsonc containers[] needs a matching export or boot fails), plus
  the container-watch call site routed through `getStudioStub`.
- `apps/fleet/wrangler.test.jsonc` / `apps/fleet/wrangler.example.jsonc` —
  new `durable_objects.bindings` entry, a new migration tag, and a new
  `containers[]` entry for `StudioBigDO` (same image as `StudioDO`, smaller
  `max_instances`, HELD FOR BATCHED ROLLOUT per the container/ change policy).
- `apps/fleet/src/studio/routes.ts`, `apps/fleet/src/github/webhook.ts`,
  `apps/fleet/src/board/routes.ts` — every `env.STUDIO.get(env.STUDIO.
  idFromName(id))` call site swapped for `getStudioStub(env, id)`, so a
  studio id's role decides the class it provisions into wherever it is
  addressed, not just at spawn time. `routes.ts`'s own header/inline
  comments claiming it is "the one file allowed to call env.STUDIO.get(...)"
  are corrected to reflect that `profile.ts` (and now every caller through
  its helper) also touches the binding.
- `apps/fleet/src/studio/blueprint.ts` — one short addendum to the existing
  `Role.instance_type` doc comment, noting this issue built the actual
  per-role container-class selection as a role-NAME predicate in
  `profile.ts`, not by reading this field.

## Test plan

1. `apps/fleet/test/studio.profile.test.ts` (new, written RED first):
   `isBigProfileRole` for every known role; `studioNamespace`/`getStudioStub`
   against a fake `Env` with two distinguishable fake namespaces, covering a
   `release-studio` id (bare and `--n` instance), every other role's id, and
   a malformed id (falls back to `STUDIO`).
2. `apps/fleet/test/studio.spawn.test.ts` — one additional test proving the
   REAL `spawnDeps(...).provisionChild` call path (routes.ts, unmodified
   logic) routes a `"<repo>--release-studio"` child through whatever
   `env.STUDIO_BIG` is bound to, not `env.STUDIO` — using the same two-fake-
   namespace pattern the file's existing `fakeStudioNamespace()` already
   establishes for `env.STUDIO` (a live container-backed DO cannot be
   constructed under vitest-pool-workers, so this proves the routing code
   path, not a real container boot).
3. Full verification, run one command at a time (never in parallel — shared
   memory ceiling): `bun run check`, `bun run test`, `bun run bun-test`,
   `bun run apps/fleet/scripts/english-check.ts`.
