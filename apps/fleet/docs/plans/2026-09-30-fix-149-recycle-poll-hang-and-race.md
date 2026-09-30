# Recycle poll: cap the fake-fetch test fixture and close the operationInFlight race (board issue #149)

Follow-up from #139 review (code merged). Two independent asks against
`apps/fleet/cli/recycle-outcome.ts` and its test file.

## Ask 1 — the test-gap: an unbounded-loop mutant hangs instead of failing

### The problem

`test/cli.recycle-outcome.test.ts`'s "a status that never lands this
recycle's bring-up is polled EXACTLY RECYCLE_POLL_ATTEMPTS times" test
(~line 279) is the one test that should go red the instant a future mutant
breaks `pollAfterNoAnswer`'s own loop bound (e.g. `attempt <= deps.attempts`
mutated to `true`, or the bound otherwise removed). It does not: the test's
own `noSleep` fake (`async (): Promise<void> => {}`, ~line 69) resolves
already-settled, so under a broken unbounded loop the `await
deps.sleep(...)` call never actually yields the microtask queue back to a
macrotask boundary. Node keeps running the loop's body synchronously enough,
turn after turn, that the macrotask queue — where vitest's own per-test
timeout (`setTimeout`-based) lives — never gets serviced. The test HANGS the
whole process rather than failing fast. A hang is strictly worse than a red
test for CI/local runs: it wedges instead of reporting.

### The fix: what the issue suggested, versus what actually works here

The issue offered two candidate fixes (yield via `setImmediate`, or cap the
fake and throw past it) and predicted the throw-alone would not be enough
(correctly — `readStatus`'s own try/catch swallows it, turning it into just
another failed poll attempt). Both candidates were tried and verified BY
RUNNING THE ACTUAL MUTATION (see "Verification" below), not assumed from
reasoning alone, and the investigation found the real picture is more
specific than the issue's own write-up assumed:

1. **`noSleep` yielding a real macrotask, alone, does not close the gap
   either** — not for the reason the issue anticipated. `pollAfterNoAnswer`'s
   own `if (attempt < deps.attempts) await deps.sleep(...)` guard only calls
   `sleep` while `attempt` is still below `deps.attempts` (6). Under the
   `attempt <= deps.attempts` → unconditional-`true` mutant, `attempt` grows
   past 6 almost immediately, and that guard then gates `sleep` off
   PERMANENTLY — the loop runs from then on purely on `readStatus`'s own
   microtask chain, with `sleep` never invoked again regardless of how it
   yields.
2. **Even when `sleep` *is* still being called every iteration, vitest's own
   per-test timeout was verified NOT to reliably rescue a microtask-tight
   loop in this repo's actual test runtime.** `vitest-pool-workers` executes
   the test body inside a real `workerd` isolate (a separate process, not
   plain Node) — confirmed by hand with a synthetic reproduction (a tight
   `while (true) { await sleepViaSetImmediate(); }` loop, run through
   `requestRecycle`'s own call shape): neither the `--testTimeout` CLI flag
   nor an explicit low `it(..., ms)` third argument caused the test to fail
   inside a 15s+ external wall-clock bound; the process had to be killed
   externally every time. A synthetic isolated probe (a bare loop with no
   other call chain) DID respect `testTimeout` correctly, so the difference
   is specific to the real call shape here, not a blanket "testTimeout never
   works" claim — but it means this specific hang cannot be assumed
   self-healing via vitest's own timeout, in this environment.

**The fix that was verified to actually work**: bound the fake `/status`
handler's own reply sequence with a **trap**, not a throw. Up to a cap (20 —
comfortably above the legitimate `RECYCLE_POLL_ATTEMPTS = 6`, comfortably
below "never"), replies never satisfy `bringupLanded` (the real scenario
this test targets). The cap+1'th reply, though, IS a row that satisfies
`bringupLanded` (fresh `via: "recycle"` session, fresh readiness, no
operation in flight). A correctly bounded loop never reaches the trap — it
still stops at exactly 6 calls, still reports `timeout-pending`, completely
unaffected. A loop that ignores its own bound runs past 6, reaches the trap
after a small, FIXED number of additional calls — resolved through ordinary
microtask recursion, no macrotask/timer wait required at all, so it
resolves in milliseconds regardless of whether `sleep`/`setImmediate` is
ever invoked — and returns `timeout-provisioned` instead of
`timeout-pending`: a normal, fast `AssertionError`, not a hang. This is the
one change that was actually run against the mutation and observed to fail
in ~30ms rather than hang.

`noSleep` was still changed to yield via `setImmediate` (harmless, and a
reasonable defensive improvement in its own right for any future mutant
shape where `sleep` genuinely keeps being called every iteration) — but it
is explicitly NOT relied upon as the thing that closes this specific gap.
The trap-row fake is what does.

Neither fix touches production code — both are test-fixture hardening only,
scoped to `test/cli.recycle-outcome.test.ts`.

### Verification method (mutation check, not a conventional RED/GREEN unit test)

Temporarily mutate `pollAfterNoAnswer`'s loop bound in
`cli/recycle-outcome.ts` (`for (let attempt = 1; attempt <= deps.attempts; attempt++)`
→ `for (let attempt = 1; ; attempt++)`, an unconditionally-true loop), then
run JUST the affected test:

```
timeout 15 bun run test -- test/cli.recycle-outcome.test.ts -t "EXACTLY RECYCLE_POLL_ATTEMPTS"
```

Confirm this now fails FAST and CLEANLY (a real assertion error, well inside
the 15s wall-clock bound — observed: ~32ms) rather than hanging past it.
Then revert the mutation and confirm the full file is green again (17/17).

## Ask 2 — the real race: operationInFlight must be null before reporting success

### The race, in my own words

`bringupLanded` (cli/recycle-outcome.ts ~261) decides "this status row
proves THIS recycle's own bring-up landed" using three conditions: `state
=== "running"`, a fresh `observed.session` with `via === "recycle"` and
`session.at >= startedAt`, and `readiness.checkedAt >= startedAt`. All three
are about freshness of TIMESTAMPS written by the Worker — none of them is
about WHO wrote them or WHY.

Two things independent of recycle's own operation can write a fresh-looking
`readiness.checkedAt` onto the exact same status row while a poll is in
flight:

- `checkAndRecordReadiness`, called every tick from `syncSession`'s periodic
  loop (`do.ts` ~2824, "Board issue #24 fix" — the doc comment right above
  it), runs on `SYNC_SESSION_SECONDS`'s own independent schedule, with no
  awareness of whether a recycle is currently running against the same
  studio.
- `fleet ls --fresh` can also trigger an on-demand readiness check.

Either of these can stamp a new `readiness.checkedAt` at/after `startedAt`
purely by coincidence of timing — nothing about that write says "recycle's
own `recycleVerdict` produced this", only "some readiness check ran
recently". Combined with a `session.at` that is ALSO still fresh from
`via: "recycle"` (written earlier by `provisionCore`'s own bring-up steps,
well before recycle's own post-provision readiness check even starts), a
poll landing in this window can see all three of today's conditions
satisfied by a readiness write that has nothing to do with recycle's
verdict — while recycle's own `recycleVerdict` might still be running, or
about to flip `state` to `"degraded"` moments later. `bringupLanded` would
wrongly return `true`, and `requestRecycle` would wrongly report
`timeout-provisioned` (a false success) for a recycle that is not actually
done, or that is about to fail.

`operationInFlight` (do.ts's `OPERATION_KEY`/`statusDetailWithStorage`,
~3190-3211; `OperationInFlight` type + `op: "recycle"` in
`src/studio/provision.ts` ~695) is the one signal that answers "who, why":
it is written non-null for the ENTIRE span of recycle's own atomic
destroy-to-reprovision window (do.ts ~1490, `storage.put(OPERATION_KEY, {
op: "recycle", ... })`, cleared only at ~1665 once that whole operation has
either succeeded or thrown). `checkAndRecordReadiness`'s own periodic tick
and `fleet ls --fresh`'s on-demand check do not take or check this lock at
all — they can write `readiness` freely, in or out of an in-flight
operation.

So: once `operationInFlight` reads `null`, recycle's own atomic operation
has FULLY finished (one way or the other) — there is no window left in
which an interloping write could be mistaken for recycle's own in-progress
verdict, because recycle's own operation is not in progress anymore at all.
A `session`/`readiness` pair that ALSO looks fresh at that same instant is
therefore provably not a snapshot taken mid-operation: either it is
recycle's OWN final write (the common case — `recycleWithSync` clears
`OPERATION_KEY` only after building its final status row), or it predates
`startedAt` entirely and already failed the timestamp checks. Requiring
`operationInFlight === null` as a FOURTH condition closes exactly this
specific window, without weakening any of the existing three checks.

### The fix

1. Widen the type `readStatus`/`bringupLanded` treat the status JSON as.
   `GET /studio/:id/status` already returns `operationInFlight` in its JSON
   body (`statusDetailWithStorage`'s own return type, do.ts ~3193) — it is
   only not visible to `StudioStatus`-typed callers. Add a small
   intersection type in `cli/recycle-outcome.ts`:
   ```ts
   type StatusWithOperation = StudioStatus & { operationInFlight: OperationInFlight | null };
   ```
   imported `OperationInFlight` from `../src/studio/provision.ts`. Widen
   `readStatus`'s own return type (status-poll.ts) from `StudioStatus` to
   this intersection — it is the more localized, honest change: every
   caller of `readStatus` reads a real `/status` JSON body that already
   carries this field at runtime, so the type was simply incomplete before,
   not being narrowed for a good reason.
2. `bringupLanded`'s signature takes the same intersection type, and adds
   `status.operationInFlight === null` as a fourth required condition,
   alongside the existing three, before returning `true`.
3. `RecycleReport.status` stays typed as `StudioStatus | null` (its public
   surface does not need to grow) — only the internal poll path's status
   value widens.

### Test plan (TDD, RED first)

In `test/cli.recycle-outcome.test.ts`:

1. Extend `statusRow()`'s helper (~line 35) with an `operationInFlight`
   parameter, defaulting to `null` (the common/normal case), so every
   EXISTING test that does not care about this field keeps passing
   unchanged.
2. New RED test: a status row with `state: "running"`, a fresh
   `session.via === "recycle"` + fresh `at`, a fresh `readiness.checkedAt`
   — every one of today's three conditions satisfied — but
   `operationInFlight` NON-null (e.g. `{ op: "recycle", since: <a time
   before startedAt> }`, simulating an unrelated periodic/`--fresh` write
   landing while recycle's own operation is still genuinely in flight).
   Confirm RED against pre-fix code: `bringupLanded` wrongly returns
   `true`, `requestRecycle` wrongly reports `kind: "timeout-provisioned"`.
3. Implement the fix (operationInFlight type widening + the 4th
   condition). Confirm the new test goes GREEN (now reports
   `timeout-pending`, polls all `RECYCLE_POLL_ATTEMPTS` times since the row
   never clears).
4. Add a companion "still succeeds" test: same fresh session/readiness,
   `operationInFlight: null` — proves the fix does not regress the normal
   success path.
5. Update the two existing tests whose fixtures now need an explicit
   `operationInFlight: null` to keep passing once the row helper stops
   defaulting it to something the new check would reject (in practice the
   default param handles this, but the "timed-out request, then status
   shows THIS recycle's own bring-up landed" test at ~line 73 and "a row
   that lands on a LATER poll is still the success it is" at ~line 242 are
   re-checked explicitly against the new field).

Run with `vitest run apps/fleet/test/cli.recycle-outcome.test.ts` only — no
full suite, no build alongside it. Typecheck (`bun run check` / repo tsc)
run alone, never concurrently with a test run.
