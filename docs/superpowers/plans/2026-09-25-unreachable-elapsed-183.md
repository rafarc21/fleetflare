# Time-based unreachable detection (board issue #183)

## Background

Issue #85 PR1 (round 5/6) tightened the ship tick's own exec-level deadline
(`SHIP_EXEC_DEADLINE_MS` = `EXEC_CLASSES.ship.timeoutMs` (20s) +
`DEADLINE_SLACK_MS` (7s) + 3s margin = 30s) to stop double-counting a
merely-slow-but-alive container as unreachable. Composed with the ship
tick's own self-perpetuating 30s reschedule (next tick scheduled
`SHIP_TRANSCRIPT_SECONDS` AFTER the current tick's body finishes, not a fixed
cadence), the old fixed 3-consecutive-failures threshold now took measured
89s/120s/141s (up to ~5 minutes worst case with other alarm callbacks queued
ahead) to flag `unreachable` — not the spec's original ~90s goal. The
maestro accepted that gap in PR1 and tracked the real fix as this board
issue.

## The fix

Board issue #183's own stated output: **unreachable iff ≥2 consecutive
failed ship ticks AND now − lastShipOkAt ≥ 90s. Tick cadence unchanged.**

1. **`Observed.lastShipOkAt: string | null`** (`observed.ts`) — the last time
   a ship tick actually SUCCEEDED, updated on EVERY success, not merely one
   that clears a prior failure streak. Deliberately distinct from
   `unreachableSince` (stamped at the FIRST FAILURE of a streak, one tick
   cycle AFTER the real last success — using it as a "last known good" proxy
   would systematically understate real elapsed downtime by that gap).

2. **`isUnreachable(observed, now)`** (`observed.ts`) — the single shared
   predicate: `execFailures >= 2 && lastShipOkAt !== null && now -
   lastShipOkAt >= 90_000`. A null `lastShipOkAt` (never recorded — right
   after this field's first deploy, or a pre-#183 `Observed` record) is
   "elapsed unknown", never treated as unreachable on failure count alone.
   Used by BOTH the DO-side write-trigger and the render-side gate, so they
   can never disagree.

3. **`runShipTickWithObservation`** (`do.ts`):
   - Failure path: the immediate, out-of-cadence D1 write now fires on
     `isUnreachable` transitioning false->true (computed once with the
     pre-increment failure count, once with the post-increment count, both
     at the same `now`), replacing the old `failures === 3` check.
     `unreachableSince`'s own stamping (at failure 1) is unchanged.
   - Success path: `lastShipOkAt` updates unconditionally, added to the
     existing `reachabilityPatch` object — one accepted extra DO-storage
     write every ~30s. Investigated first whether this could ride an
     existing unconditional write for zero added cost (the way
     `lastSnapshotAt` was believed to): it can't — `shipTranscriptTick`'s own
     unconditional per-tick write (`TRANSCRIPT_TAIL_KEY`) belongs to a
     deliberately separate, narrower storage port (`TranscriptStorage`) this
     feature's own architecture keeps apart from `ObservedStorage`, and
     `lastSnapshotAt` itself turns out NOT to ride an existing write either —
     `recordSnapshotOnSuccess` issues its own separate `mergeObserved` call.
     See do.ts's own doc comment at the write site for the full reasoning.

4. **`cli/readiness-format.ts`** — `readyOverride` and `formatUnreachableLine`
   (`formatObservedLines`) both now gate on `isUnreachable` instead of the
   old `execFailures >= 3` literal. `formatObservedLines` gained a
   `now: Date = new Date()` parameter to make the time check testable
   (`cli/fleet.ts`'s call site rides the default).

5. **Docs** — `docs/superpowers/specs/2026-09-24-row-tells-truth-design.md`'s
   Goal section restates the ~90s goal as current, keeping the measured
   89/120/141s figures as history describing the now-superseded count-based
   gate. `do.ts`'s `withExecDeadline` doc comment gets a trailing note for
   the same reason.

## Real-timing finding (worth flagging)

The RED test in `test/studio.observation-tick.test.ts` drives a fully
realistic "exec hangs the whole deadline, every tick" scenario using the
REAL `SHIP_EXEC_DEADLINE_MS`/`SHIP_TRANSCRIPT_SECONDS` constants (30s each).
Worked arithmetic from a genuine success at T0:

- tick 2 fails at `T0 + 30s (reschedule) + 30s (hung exec's own deadline)` =
  `T0 + 60s` → 1 failure, 60s elapsed — correctly NOT unreachable yet.
- tick 3 fails at `(T0+60s) + 30s + 30s` = `T0 + 120s` → 2 failures, **120s**
  elapsed — correctly crosses the 90s threshold.

120s, not the board issue's own loose "~84-90s" estimate. The rule still
correctly reports unreachable in this scenario (120s ≥ 90s), just later than
the issue's own estimate assumed — that estimate implicitly assumes a
fast-failing exec, not one that hangs the full deadline every time before
resolving as a failure. Both numbers land well inside "much better than the
old 89-141s+ count-based gate", which is the goal this fix actually restores.

## Files touched

- `apps/fleet/src/studio/observed.ts` — `Observed.lastShipOkAt`,
  `emptyObserved()`, `isUnreachable`, `UNREACHABLE_ELAPSED_MS`.
- `apps/fleet/src/studio/do.ts` — `runShipTickWithObservation`'s
  failure/success paths, `SHIP_EXEC_DEADLINE_MS` exported for tests,
  `withExecDeadline`'s doc comment.
- `apps/fleet/cli/readiness-format.ts` — `readyOverride`,
  `formatUnreachableLine`/`formatObservedLines`.
- `apps/fleet/test/studio.observation-tick.test.ts` — new RED-then-GREEN
  suite for the time-based rule, using the real production constants.
- `apps/fleet/test/studio.observed.test.ts`,
  `apps/fleet/test/studio.session.test.ts`,
  `apps/fleet/test/cli.fleet.test.ts`,
  `apps/fleet/test/studio.rate-limited.test.ts` — fixture updates for the
  new `Observed.lastShipOkAt` field and the new render gate.
- `docs/superpowers/specs/2026-09-24-row-tells-truth-design.md` — Goal
  section, READY table row, storage-section correction.
