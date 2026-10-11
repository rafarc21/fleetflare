# Plan — #404 S5-F6: one bounded poll-loop util for ff attach-wait + accounts watch

Two READ-ONLY bounded poll loops hand-roll the same shape: bounded `for (;;)`,
one stderr progress line per iteration, Bun.sleep between, budget measured from
a caller-supplied start — cli/ff.ts waitProvisioned (:351-371, WAIT_TIMEOUT_MS/
POLL_MS/TICK_MS, secs(), ticker()) and cli/accounts.ts watchAccounts (:372-400,
WATCH_INTERVAL_MS, its own comment says it copies waitProvisioned's shape).
accounts.ts's copy drifted: no ticker heartbeat, so a slow GET reads as a hang.

## Steps

1. RED: `test/bun/poll.test.ts` — poll util direct tests with injected clock/
   sleep: budget exhausts (returns timeout after budget measured from
   caller-supplied `at`, not loop entry), first non-null read wins,
   tick cadence fires per interval, ticker stopper clears the interval.
   Helper does not exist yet — test fails to import.
2. GREEN: `cli/poll.ts` (pure, clock/sleep injected): `poll()` bounded loop +
   `ticker()` heartbeat. Migrate ff.ts waitProvisioned + ticker + secs onto it;
   migrate accounts.ts watchAccounts onto it (heartbeat stays ff-only:
   --watch already prints one line per iteration, and the byte-identity
   boundary forbids new output — the slow-GET heartbeat drift stays open
   as follow-up). All operator-facing lines byte-identical.
3. Verify: `bun test test/bun/poll.test.ts test/bun/ff-no-tty.test.ts
   test/bun/ff-new-race.test.ts test/bun/ff-new-main.test.ts
   test/bun/ff-file-task-retry.test.ts test/bun/accounts-cli.test.ts` (25
   baseline pass + new), then `bun run check`, `bun run english-check`.

## Design notes

- `poll` signature: `poll({ at, budgetMs, sleepMs, sleep, now, read, tick })` —
  `at` = caller-supplied start (budget counts from it, not loop entry: the
  spawn POST blocks most of a bring-up); `read()` returns the loop body's
  result, called each iteration; tick fires each interval. accounts --watch
  passes no budget (runs until SIGINT) — budget optional.
- `ticker(what, tickMs)`: existing ff.ts shape, returns own stopper.
- ff.ts's WAIT_TIMEOUT_MS/POLL_MS/TICK_MS consts move to callers; poll.ts owns
  no timings.
- Two-way door: pure code. Scope: ff + accounts only — rescue-all, destroy/
  recycle pollAfterNoAnswer, deploy probes stay out (Claude lane, sweep-2).
