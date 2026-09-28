# syncSession readiness never recorded when the sync tick throws (board issue #24)

## The bug, per the issue's own diagnosis (not re-derived here)

`apps/fleet/src/studio/do.ts`, `StudioDO.syncSession()` (~line 1935, before this
fix):

```ts
async syncSession(): Promise<void> {
  try {
    await syncSessionTick(this.syncDeps(), this.ctx.storage, this.selfId());
    await mirrorBurnToRegistry(this.ctx.storage, (s) => recordStudio(this.env, s));
    await checkAndRecordReadiness(this.syncDeps(), this.ctx.storage, this.selfId(), (s) => recordStudio(this.env, s));
  } catch (err) {
    console.error("studio session sync failed", err);
  } finally {
    await this.schedule(SYNC_SESSION_SECONDS, "syncSession");
  }
}
```

Three `await`s share ONE `try`. The comments directly above the second and
third calls claim "same try/catch as the sync tick above, so a mirror/check
failure logs and never blocks the reschedule" — describing per-step isolation
that does not exist. If `syncSessionTick` itself throws (measured, real: a
fresh container whose claude hasn't written `/root/.claude/projects` yet —
`tar: .claude/projects: Cannot stat: No such file or directory`), the catch
swallows it, but `mirrorBurnToRegistry` and `checkAndRecordReadiness` never
run at all. `finally` still reschedules, so the loop survives and repeats the
same failure every `SYNC_SESSION_SECONDS` (300s) forever, and
`StudioStatus.readiness` is never stamped — `fleet ls`'s READY column shows
`?` forever for a studio that may actually be healthy.

Measured live (Worker tail, version `6921687f`, 2026-09-22):
`demosite-life--maestro` spawned, tmux alive, READY `?`/CHECKED `-` 15 minutes
later. Same shape on `sample--scratch` and `acme-os--pilot` — general,
not one studio.

## The fix

Give each of the three steps its own `try/catch`, each logging its own
distinct message, so a Worker tail can tell which step failed and one step's
failure can never suppress the other two. `finally`'s unconditional reschedule
is unchanged — same `SYNC_SESSION_SECONDS`, same cadence, regardless of any
step's outcome.

`StudioDO` is container-backed and cannot be constructed under
`vitest-pool-workers` (do.ts's own file-header comment: `env.STUDIO.get(...)
.fetch(...)` throws "Containers have not been enabled for this Durable Object
class"). This file's own established pattern for exactly this problem is
`restartWithSync` (~line 303): the DO method's real logic lives in an
EXPORTED PURE FUNCTION that a real `StudioStorage & SessionSyncStorage` (a
real `this.ctx.storage`) satisfies structurally, and the thin class method
just calls it. `syncSession()`'s three-step body is that same shape of thing,
so it gets the same treatment: extracted into a new exported pure function,
`syncSessionCycle`.

```ts
export async function syncSessionCycle(
  syncDeps: SessionSyncDeps,
  storage: StudioStorage & SessionSyncStorage,
  idFallback: string,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
): Promise<void> {
  try {
    await syncSessionTick(syncDeps, storage, idFallback);
  } catch (err) {
    console.error(`studio ${idFallback}: session sync tick failed`, err);
  }
  try {
    await mirrorBurnToRegistry(storage, recordStudioFn);
  } catch (err) {
    console.error(`studio ${idFallback}: burn mirror failed`, err);
  }
  try {
    await checkAndRecordReadiness(syncDeps, storage, idFallback, recordStudioFn);
  } catch (err) {
    console.error(`studio ${idFallback}: readiness check failed`, err);
  }
}
```

The DO method becomes a thin wrapper, same reschedule-in-`finally` idiom every
other scheduled callback in this file already uses (`shipTranscript()`,
`refreshToken()`):

```ts
async syncSession(): Promise<void> {
  try {
    await syncSessionCycle(this.syncDeps(), this.ctx.storage, this.selfId(), (s) => recordStudio(this.env, s));
  } finally {
    await this.schedule(SYNC_SESSION_SECONDS, "syncSession");
  }
}
```

`syncSessionTick`, `mirrorBurnToRegistry`, `checkAndRecordReadiness` are
untouched — not one line — matching the issue's explicit boundary ("the body,
not the three functions it calls").

## TDD — red then green

New tests live in `apps/fleet/test/studio.session.test.ts`, reusing this
file's own existing fixtures (`fakeSyncDeps`, `fakeSessionStorage`) widened
locally (matching the file's established per-file-fakes convention, same as
`test/studio.burn.test.ts`'s own `fakeBurnStorage`) into a combined
`StudioStorage & SessionSyncStorage` fake seeded with a `STATUS_KEY` (so
`mirrorBurnToRegistry`/`checkAndRecordReadiness` have something to act on
instead of no-op skipping — see both functions' own doc comments, quoted in
the issue).

Core regression test: `fakeSyncDeps({ statCode: 1, statStderr: "tar: ..." })`
makes the real `syncSessionTick` genuinely reject with `"session tar/stat
failed"` — the exact real-world failure mode from the issue (`tar:
.claude/projects: Cannot stat`). Written first, run against the ORIGINAL
(shared-try) `syncSession`-shaped code path to confirm RED: readiness was
never recorded despite the tick's failure. Then `syncSessionCycle` (the fix)
is applied and the same test goes GREEN: `recordStudioFn` is still called
with a stamped `readiness`, and `STATUS_KEY` carries it, even though the tick
rejected.

Additional tests: `mirrorBurnToRegistry` also still runs when the tick
rejects (both downstream steps survive, not just one); nothing-fails case
still runs all three exactly once, in order; a failure in the MIDDLE step
(`mirrorBurnToRegistry`, forced via a `storage.get` that throws only for
`BURN_KEY`) does not block the third step (`checkAndRecordReadiness`) either
— full three-way isolation. The reschedule itself lives only in the DO
method (`this.schedule`, unreachable under `vitest-pool-workers` — same
container-backed constraint as the rest of the class) — not independently
assertable at `syncSessionCycle`'s boundary; it is unchanged (still the DO
method's own `try/finally` around one call, same `SYNC_SESSION_SECONDS`),
which is why the extraction stops exactly at the three-step body and leaves
the reschedule as the thin wrapper's job.

## Boundary

Touched: `apps/fleet/src/studio/do.ts` (`syncSession()` method +
`syncSessionCycle`, nothing else in this large file),
`apps/fleet/test/studio.session.test.ts`, this plan doc, `.fleet/done.json`.
`syncSessionTick`, `mirrorBurnToRegistry`, `checkAndRecordReadiness`
unchanged. Nothing under `container/`, `src/github/`, `src/board/`,
`cli/orca-workspace.ts`, blueprint files, `gates/`.

## Verification plan

`cd apps/fleet && bun run check`, `bun run test`, `bun run bun-test` — all
three lanes, per the issue's own explicit requirement ("`bun run test` alone
is HALF the suite").
