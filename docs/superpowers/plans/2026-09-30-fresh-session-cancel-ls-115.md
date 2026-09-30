# fresh-session pending intent: cancel path + `fleet ls` visibility (board issue #115)

Follow-up of #100/#101 (`docs/superpowers/plans/2026-09-30-fresh-session-500-100.md`).

## Problem

Issue #100's fix gave `provisionWithStorage` a durable
`FRESH_SESSION_PENDING_KEY` (provision.ts): once a `--fresh-session` attempt
fails without reaching a CONFIRMED `state: "running"`, the marker stays
armed, and EVERY later provision — flagged or not — is forced to
`freshSession: true` until one attempt finally succeeds with the move
confirmed. Two gaps remained:

1. No way to cancel the stuck intent. An operator whose fresh-session was
   never going to succeed (say, a permanently unmountable old session) had
   no verb to make ordinary provisions ordinary again.
2. Nothing showed the pending state anywhere. `fleet ls`, `fleet inspect`,
   and every other read surface were silent about it — the exact "invisible
   armed state" class of bug `sessionForceArmedAt` (issue #228 item 5) closed
   for the unrelated force-next-sync override, left open here.

## Fix, piece 1: `fleet provision <id> --no-fresh-session`

`ProvisionConfig.cancelFreshSession?: boolean` (types.ts), parsed by
cli-args.ts's `provision` case using the same bespoke "known flags, each at
most once, unknown flag never silently ignored" shape `recycle`'s own
two-flag (`--discard-unsynced`/`--fresh-session`) parsing already uses, plus
an explicit mutual-exclusivity check (`--fresh-session` and
`--no-fresh-session` together is a usage error). `cli/fleet.ts`'s
`cmdProvision` gains a `cancelFreshSession` parameter, sent as
`?no-fresh-session=true` on the request URL — same query-string convention
`?fresh-session=true` already uses. `routes.ts`'s provision route reads the
param into `cfg.cancelFreshSession`, and refuses (400) a request carrying
BOTH `fresh-session=true` and `no-fresh-session=true` at once — never
silently resolved either way.

`provisionWithStorage` (provision.ts) clears `FRESH_SESSION_PENDING_KEY` to
`false` UNCONDITIONALLY (a cancel on an already-clear marker is a safe
no-op) and FIRST — before `runProvision` ever runs, same "durability first"
ordering the arm side already uses. The effective "requested fresh" for that
call is forced `false` regardless of any stale pending value or a
`cfg.freshSession: true` also present on the same call — cancel wins,
defensively, even though routes.ts already refuses that combination outright
(the floor for any other caller: direct `provisionWithStorage` calls,
tests). The provision then proceeds as an ordinary (non-fresh) call; the
existing end-of-function clearing block
(`if (requestedFresh && status.state === "running" && freshSessionConfirmed)`)
naturally does not fire on a cancel, since `requestedFresh` is false.

## Fix, piece 2: `fleet ls` visibility

`StudioStatus.freshSessionPending?: boolean` (types.ts), documented and
mirrored the same way `sessionForceArmedAt` is (issue #228 item 5's
pattern):

- `provisionWithStorage` stamps `status.freshSessionPending` by reading
  `FRESH_SESSION_PENDING_KEY` back from storage AFTER every write path above
  has run (cancel, arm, confirmed-clear) — right before the final
  `storage.put(STATUS_KEY, status)`, so the returned/persisted row is never
  stale.
- `do.ts`'s `mirrorBurnToRegistry` also reads `FRESH_SESSION_PENDING_KEY`
  fresh from storage every sync tick and mirrors it onto
  `updated.freshSessionPending` — same "reconfirmed every tick,
  self-healing regardless of which call site last touched the key"
  treatment `sessionForceArmedAt` gets in that same function. This is what
  keeps the row honest BETWEEN provisions (a prior attempt's later retry
  confirming the move, or a `--no-fresh-session` cancel issued between
  ticks).
- `cli/readiness-format.ts`'s `formatSessionGuards` gets one line per studio
  where `s.freshSessionPending` is true: `` `FRESH SESSION ${s.id}:
  fresh-session pending` `` — same per-studio extra-line shape
  `sessionForceArmedAt`/`burnPersistError`/`asideShip` already use. Its own
  doc comment is extended to describe the addition, matching how each prior
  addition to that function documents itself.

## Explicitly out of scope

`recycle`'s own `--fresh-session` flag and query param are untouched — no
`--no-fresh-session` counterpart on recycle, no `cancelFreshSession` reaching
`recycleWithSync`. The issue's own framing (and the reassignment) scoped this
to the `provision` verb; recycle already refuses a container it cannot
rescue outright and carries its own separate liveness/discard-unsynced
guard, a different enough shape that folding a cancel flag into it was not
attempted here.

## Test (RED then GREEN)

Extended/added, all TDD (RED confirmed before implementation, GREEN after):

- `test/studio.cli-args.test.ts`: existing `provision`/`recycle` parse
  assertions updated for the new `cancelFreshSession` field; new test
  `--no-fresh-session: cancels a pending intent; mutually exclusive with
  --fresh-session; repeats and strays are usage errors`.
- `test/studio.routes.test.ts`: new test
  `#115: provision ?no-fresh-session=true reaches the DO as
  cfg.cancelFreshSession; both at once is a 400`.
- `test/studio.fresh-session.test.ts`: existing #100 retry test extended to
  also assert `status.freshSessionPending`; new describe block
  `provisionWithStorage — cfg.cancelFreshSession clears a stuck pending
  intent (issue #115)` covering an armed-then-cancelled marker, a
  cancel-when-already-clear no-op, and cancel winning over a `freshSession:
  true` present on the same call.
- `test/cli.fleet.test.ts`: new test in `formatSessionGuards` —
  `a pending fresh-session intent gets its own line, silent once cleared`.
- `test/studio.burn.test.ts`: the one pre-existing full-row `toEqual`
  snapshot of `mirrorBurnToRegistry`'s write (a test unrelated to this
  feature, but directly hit by the new always-present `freshSessionPending`
  field on the mirrored row) updated to include `freshSessionPending: false`.

RED evidence (before implementation): `expected undefined to be true`
(`FRESH_SESSION_PENDING_KEY`/`freshSessionPending` assertions), `expected
[cmd: "usage", ...]` for the new `--no-fresh-session` parse cases (flag not
yet recognized), `expected [ …, undefined ] to include ... undefined` for the
route-layer `cfg.cancelFreshSession` wiring, and `expected [] to deeply
equal ["FRESH SESSION m--x: fresh-session pending"]` for `formatSessionGuards`.

GREEN (after implementation): all of the above pass; see Verification below
for exact counts.

## Verification

- `cd apps/fleet && npx vitest run test/studio.fresh-session.test.ts
  test/studio.cli-args.test.ts test/studio.routes.test.ts
  test/cli.fleet.test.ts` — 468/468 passed.
- Directly-impacted callers of `provisionWithStorage`/`mirrorBurnToRegistry`
  (to catch any full-row snapshot regressions from the new always-present
  `freshSessionPending` field): `npx vitest run
  test/directus.provision.test.ts test/studio.account-failover.test.ts
  test/studio.container-watch.test.ts test/studio.destroy-race.test.ts
  test/studio.observation.test.ts test/studio.provision.test.ts
  test/studio.recycle-guard.test.ts test/studio.refresh.test.ts
  test/studio.replacement.test.ts test/studio.self-heal.test.ts
  test/studio.spawn.test.ts test/studio.start-gate.test.ts
  test/studio.backup-guard.test.ts test/studio.readiness.test.ts
  test/studio.burn.test.ts test/studio.burn-window-expiry.test.ts
  test/studio.session.test.ts` (run in three batches) — 1134/1134 passed (one
  pre-existing full-row snapshot in `studio.burn.test.ts` updated, see
  above).
- `cd apps/fleet && flock /tmp/fleet-gate.lock bun run check` (5-tsconfig CI
  command): clean, no errors.
- `bun scripts/english-check.ts ../..`: `english-check: clean`.
- No full suite run (per house rules: one heavy gate at a time, and the
  targeted set above already exercises every call site this change touches).
