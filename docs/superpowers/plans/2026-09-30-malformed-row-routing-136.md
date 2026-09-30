# Malformed registry row must never re-derive doClass from role (issue #136)

Follow-up to #107/#122, filed separately since #122 already merged — caught
in that PR's own review as a fourth instance of the same bug class.

## The bug

`registry.ts`'s `getStudioRow` returns `null` for BOTH "this id was never
provisioned" and "this id has a row, but it's malformed JSON and unreadable"
— the same `null`, indistinguishable by the caller. Its only production
caller, `profile.ts`'s `getStudioStub`, treats `row === null` as license to
compute a FRESH, role-derived `doClass` via `realDoClassForRole`. For a
malformed `release-studio` row, that means routing to `STUDIO_BIG` (when
bound) even though the corrupted row might belong to a studio that's
actually been running under `STUDIO` all along — the exact orphan-risk class
#107 closed for "row exists with a recorded class" and "row absent", just
missed for "row exists but unreadable".

## The fix

`getStudioRow` keeps its existing null-for-both contract (other callers —
`studio.spawn-atomic.test.ts`, `studio.spawn.test.ts`,
`studio.registry.test.ts`'s own malformed-row test — depend on it staying
that way). A new, lower-level `getStudioRowLookup` returns a three-state
result (`found` / `absent` / `malformed`) instead, built on the same D1 read
`getStudioRow` now delegates to (no duplicated query).

`getStudioStub` (the one place the distinction matters) switches to
`getStudioRowLookup`:

- `found` -> routes on the recorded row, unchanged.
- `malformed` -> forces `doClass: "STUDIO"` explicitly (never
  `realDoClassForRole`/role-derived), plus a `console.error` distinct from
  the lower-level parse-error log already in `getStudioRowLookup` — two loud
  signals, one naming the row corrupt, one naming the routing decision
  forced safe.
- `absent` -> unchanged, the one case with no existing container identity to
  protect, so a fresh role/env-derived class is fine.

`types.ts`'s `StudioStatus.doClass` doc comment gets a short addendum
pointing at this third case.

## Files touched

- `apps/fleet/src/studio/registry.ts` — `getStudioRowLookup` (new),
  `getStudioRow` reimplemented on top of it
- `apps/fleet/src/studio/profile.ts` — `getStudioStub` switches from
  `getStudioRow` to `getStudioRowLookup`, forces `STUDIO` on `malformed`
- `apps/fleet/src/studio/types.ts` — `doClass` doc comment addendum
- `apps/fleet/test/studio.registry.test.ts` — `getStudioRowLookup` unit
  tests (found/absent/malformed); existing `getStudioRow` malformed test
  left unchanged
- `apps/fleet/test/studio.spawn.test.ts` — the critical regression test:
  malformed `release-studio` row, `STUDIO_BIG` bound, `getStudioStub` must
  still resolve `STUDIO`
- This plan doc

## TDD

RED first: `getStudioRowLookup` doesn't exist yet (compile failure), and the
regression test in `studio.spawn.test.ts` exercises current `getStudioStub`
behavior, which (today) computes `realDoClassForRole(env, "release-studio")`
-> `STUDIO_BIG` for a malformed row, since the real test env has
`STUDIO_BIG` bound. Confirmed red before implementing, then green after.

## Verification

Run one at a time, from `apps/fleet/`, per the shared gate-lock rule:

1. `bun run check`
2. `bun run test`
3. `cd /workspace/fleetflare && bun run apps/fleet/scripts/english-check.ts`

Results captured in the report back to the lead.
