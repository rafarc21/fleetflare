# Fix: `leadType` never persisted on a glm-lead studio's first provision (board issue #300)

## The bug (confirmed live)

`fleet spawn web-studio --new --lead glm` boots a studio pointed at the
GLM route, but every call gets `403 this route serves glm-led studios
only`.

## Root cause, quoted from the issue

- `do.ts`'s `ensureSpawnToken` (lines 4665-4683) runs first, at
  `do.ts:7211` inside `provisionUngated`, and WRITES the studio's D1/
  storage row (via `recordStudioFn`) — but only ever seeds `doClass` on a
  fresh row:
  ```ts
  const status: StudioStatus = {
    ...(existing ?? freshStatus(idFallback)),
    ...(existing === undefined && doClass !== undefined ? { doClass } : {}),
    spawnTokenHash: tokenHash,
  };
  ```
  `leadType` is never seeded here at all, even though `doClass` is.
- Only AFTER that write does `provisionUngated` call
  `resolveLeadType(await this.ctx.storage.get<StudioStatus>(STATUS_KEY),
  cfg.leadType)` (`do.ts:7220`) — this falls back to `cfg.leadType`
  ("glm") correctly for the LAUNCH decision (container gets the GLM env
  vars), but the fallback value is never written back to storage.
- Separately, `provision.ts`'s own seed guard (line 2535):
  `...(existing === null && cfg.leadType !== undefined ? { leadType:
  cfg.leadType } : {})` — by the time `runProvision` reads `existing`
  (`provision.ts:3772`), `ensureSpawnToken` has ALREADY written the row
  (with `doClass`/`spawnTokenHash` set), so `existing` is never `null`
  here — this guard can never fire on a real spawn.
- Net effect: the container launches with GLM env vars (correct, from the
  `resolveLeadType` fallback), but the persisted `StudioStatus` row has NO
  `leadType` field at all. `anthropic-route.ts`'s auth gate
  (`authenticateGlmLeadRequest`, reads `studioRow?.leadType !== "glm"`)
  checks the PERSISTED row, sees `leadType` is `undefined`, not `"glm"`,
  and refuses every call with 403 — the studio is permanently broken from
  the moment it's spawned.

## The fix

1. `ensureSpawnToken` (`do.ts`) gains a new optional `leadType?: "claude"
   | "glm"` parameter, positioned alongside `doClass`. Its write block now
   also seeds `leadType`, guarded by the SAME strict `existing ===
   undefined && leadType !== undefined` condition `doClass` already uses
   just above it — fires ONLY on a brand-new row, never on an
   already-existing row that simply happens to be missing the field.
   (An earlier draft of this fix used the looser `existing?.leadType ===
   undefined && leadType !== undefined`, by analogy to `resolveLeadType`'s
   own transient, non-persisting fallback shape — a fresh-context review
   caught that the analogy doesn't hold for a PERSISTED write: see
   "Backfill repair — deliberately not implemented" below for why that
   shape was rejected.)
2. `provisionUngated`'s call site (`do.ts:7211`) threads `cfg.leadType`
   through as the new argument — `cfg` is in scope there.
3. `restartUngated`'s call site (`do.ts:7498`) is left unchanged (no 5th
   argument, defaults to `undefined`) — a restart has only the studio id,
   no `ProvisionConfig`, so it has nothing to repair FROM, same as it
   already does for `doClass`.

## `recycle()` — traced, not assumed

`recycle()` (`do.ts:7659`) does not call `ensureSpawnToken` directly for
its spawn-token step (it uses the storage-only `loadOrMintSpawnToken`
instead, deliberately — see that call's own comment). Its *re-provision*
step, however, goes through `recycleWithSync`'s `provision` callback
(`do.ts:7887`, `(c) => this.provisionCore(c, "recycle", ctx)`), which
calls `provisionUngated(cfg, ...)` — the exact call site this fix patches,
with the exact same `cfg: ProvisionConfig` object `recycle()` itself
received, passed straight through (`recycleWithSync`'s own `provision(cfg)`
call, do.ts:1893/1935). So the DO-layer plumbing for recycle to
self-repair a broken row via this fix does exist.

**But**: the real-world driving call site, `routes.ts`'s `recycle` POST
handler (~line 1228), builds that `cfg: ProvisionConfig` from only
`repo`/`role`/`instance`/`projectCard`/`freshSession`/`forceMappedAccount`
— it never puts `leadType` on it at all. So in practice, `cfg.leadType`
is always `undefined` at the one real call site that drives `recycle()`,
which means the new guard's `leadType !== undefined` half never fires
there today. **A `fleet recycle` of an already-broken glm studio does NOT
self-repair via this fix** — not because the plumbing is missing, but
because the route never forwards `leadType` into recycle's `cfg`. Fixing
that is a separate, out-of-scope change (not requested by #300, and not
attempted here).

## Backfill repair — deliberately not implemented

The issue's own text (#300) asks for a "set-once backfill... repairs
studios spawned on the buggy build" behavior: a studio that was already
spawned before this fix landed (so its row has no `leadType` at all),
self-repairing the next time it is re-provisioned/restarted/recycled with
a `leadType` hint available.

This fix does NOT deliver that, by design:

- The only guard shape that could make a repair like that fire —
  `existing?.leadType === undefined && leadType !== undefined` — is also
  true for an already-provisioned, already-running studio whose row
  simply never carried the field (every studio from before #249 shipped,
  or spawned on a buggy build in between). That is NOT a narrow
  "repair-only" condition; it is indistinguishable, at this call site,
  from "any existing row missing the field," and would silently flip
  `leadType` on a studio that has been running as `"claude"` the whole
  time the instant anything threads a non-undefined hint through this
  parameter.
- This codebase already found and fixed exactly this hazard, for this
  exact field, in a different write path: `provision.ts`'s own seed guard
  (lines 2520-2535) used to be keyed off `existing?.leadType === undefined`
  and was changed to the strict `existing === null` specifically because,
  per that fix's own comment, "a later re-provision/restart/recycle of
  THAT studio must never read cfg.leadType at all, no matter what value it
  happens to carry." Reinstating the loose shape here, in a sibling write
  path for the identical field, would reintroduce the same already-fixed
  bug one function over.
- It is also currently unreachable safely: the only real-world call site
  that could drive a repair is `fleet recycle`, and (per "`recycle()` —
  traced, not assumed" above) `routes.ts`'s `recycle` POST handler never
  puts `leadType` on the `cfg: ProvisionConfig` it builds, so
  `cfg.leadType` is always `undefined` there today regardless of which
  guard shape `ensureSpawnToken` uses. There is no currently-wired caller
  that both (a) targets an existing, already-broken row and (b) supplies
  a real `leadType` hint — so the loose guard would buy no actual repair
  capability today, only the hazard above.

Repairing an already-broken, already-running studio (one spawned before
#249, or on a buggy build in between) requires a destroy + respawn with
`--lead glm` today, not a recycle — until/unless a future task adds safe,
explicit `--lead` plumbing to the recycle path (threading a real
`leadType` through `routes.ts`'s recycle handler into `cfg`), at which
point the strict guard here is exactly what that future recycle call would
rely on: it still only fires for a truly fresh row, so that future work
would need its own, deliberate, narrowly-scoped repair path — not a loosening
of this guard.

## `provision.ts:2535`'s own seed guard — confirmed genuinely a no-op now

By the time `runProvision` reads `existing` off storage, `ensureSpawnToken`
has already run (and, after this fix, already seeded `leadType` on a fresh
row) — so `existing` is never `null` with a missing `leadType` at that
point any more. Confirmed by the new end-to-end test below: the row
`runProvision` sees already carries `leadType: "glm"` before its own guard
is even evaluated.

## Required test (per the issue's own instruction)

A new end-to-end DO test, following `test/studio.account-gate-do.test.ts`'s
own technique (a real `StudioDO.prototype`-backed instance, not a
hand-made `StudioStatus` fixture): provision with `leadType: "glm"` on a
genuinely fresh (no pre-seeded row) studio, read the row back two
independent ways (the DO's own storage, and the real D1 registry row
`recordStudioFn` wrote, via `listStudios`), and confirm `leadType ===
"glm"` both times — then present that studio's real, DO-minted spawn token
to the real `handleFleetAnthropicMessages` route and confirm it is not
refused with the `leadType` gate's 403.

RED: written and run first against the unfixed code — the row comes back
missing `leadType`, and the route 403s. GREEN: same test, after the fix.

## Files touched

- `apps/fleet/src/studio/do.ts` — `ensureSpawnToken`'s new `leadType`
  parameter and write-guard; `provisionUngated`'s call site threading
  `cfg.leadType` through.
- `apps/fleet/test/studio.glm-leadtype-persist-do.test.ts` — new
  end-to-end DO test (RED then GREEN).
- `apps/fleet/test/studio.refresh.test.ts` — added "an EXISTING row with
  no leadType (a pre-#249/buggy-build row) is never backfilled by a later
  leadType hint," mirroring the sibling `doClass` test ("an EXISTING row's
  doClass is never overwritten by a later doClass hint") — proves the
  strict guard holds and the field is never silently backfilled onto an
  existing row even when a non-undefined hint is offered.

## Review

Small, bounded, TDD fix — per house convention for a scoped bugfix of
this size (see #251/#246's own plan docs). No separate code-review/QA
round.
