---
# fix #1241: gate drain follow-ups after #1238

## What

Five review items on the #1232 gate drain, all Worker-side (plus deploy.sh one-liner).

(a) edited entries not idempotent on replay. `startEditedGateRun` ends a live
    same-head edit run then starts a fresh `-e<now>`; `drainPendingGateRuns`
    re-runs the release (a `remove()` throw after a start, or overlapping cron
    replays) so an edited PR is killed and restarted repeatedly. Fix: on the
    release path, reuse a live same-head edit run instead of starting fresh.
(b) `remove()` (drain.ts) is a read-then-write whole-queue rewrite, not atomic;
    `claim()` is dead code. Fix: atomic `remove`, drop `claim`.
(c) non-numeric `ts` compares NaN -> gateDraining reads "draining" forever.
    Fix: treat a non-finite ts as stale.
(d) deploy.sh: the set-flag `d1 execute` succeeding but the overall line rc
    non-zero leaves `GATE_DRAIN_FLAG_SET=0`, so the trap will not clear the
    flag until TTL. Fix: mark the flag set BEFORE the set write.
(e) tests: SIGINT clears the flag; a failing clear keeps the rc; edited replay.

## Fix

- (a) release path: when `pr.edited`, call a new `startEditedGateRun` path that
  reattaches to a live run the index records for the head (the `-e` run it
  already started) instead of `endIfLive` + fresh create. Non-edited stays
  `startGateRun` (already idempotent by sha).
- (b) `remove`: one `json_remove(value, '$[#]')`-style D1 statement keyed on the
  entry index, or a filtered `json_group_array`; drop `claim` from interface,
  impl, and its only test.
- (c) `gateDraining`: `const stamp = Number(row?.ts); if (!Number.isFinite(stamp) || Date.now() - stamp > GATE_DRAIN_STALE_MS)`.
- (d) deploy.sh: move `GATE_DRAIN_FLAG_SET=1` to before the set-flag write.
- (e) tests for each.

## Boundaries

apps/fleet/src/gate/{drain,auto-run,auto-run-env}.ts + scripts/deploy.sh + tests.
Worker change; no container/image/migration.

## Verify

`cd apps/fleet && bunx vitest run test/gate-drain.test.ts
test/gate-routes.test.ts test/github.webhook-pull-request-gate.test.ts` then
`bun test test/bun/gate-auto-run.test.ts test/bun/deploy-gate-drain.test.ts`
then `bun run check` last.
---