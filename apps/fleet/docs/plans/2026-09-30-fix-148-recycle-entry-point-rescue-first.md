# A test proving rescue-first survives `StudioDO.recycle()`'s own `--account mapped` wrapper (board issue #148)

## The gap, as the maestro's own review found it (follow-up from #135)

Board issue #131 ask 2 added `fleet recycle <id> --account mapped`, wired
through `routes.ts`'s `?account=mapped` query param into
`ProvisionConfig.forceMappedAccount` (`types.ts`). `StudioDO.recycle()`
(`src/studio/do.ts`) handles it as the very first thing it does:

```ts
async recycle(cfg: ProvisionConfig, discardUnsynced = false): Promise<StudioStatus> {
  if (cfg.forceMappedAccount) {
    await refuseUnlessMappedAccountLaunchable(this.env, this.selfId(), this.ctx.storage, this.recordFn());
    await clearForceMappedAccount(this.ctx.storage, this.recordFn());
  }
  await launchAccountOrRefuse(this.env, this.ctx.storage, this.selfId(), this.recordFn(), false);
  ...
  const result = await this.allowingStart((ctx) => recycleWithSync(
    this.syncDeps("rescue"), this.ctx.storage, this.selfId(),
    () => this.destroy(),
    async () => { ... },
    (c) => this.provisionCore(c, "recycle", ctx),
    async (s) => recordStudio(this.env, await withObserved(this.ctx.storage, s)), cfg,
    resolveMemoryRepo, commitFile, { discardUnsynced, lastSyncedAt: () => this.lastSyncedAt() },
    this.ctx.storage, ctx, ...
  ));
  ...
}
```

`discardUnsynced` (from routes.ts's own separate `?discard-unsynced=true` query
param) is a parameter entirely independent of `forceMappedAccount` — the
rescue-push-before-destroy guarantee (issue #16/#96/#62, enforced entirely
inside `recycleWithSync`) must hold exactly the same whether or not the caller
also asked for `--account mapped`.

`test/studio.recycle-guard.test.ts` already covers that guarantee thoroughly —
a failed probe refuses, a confirmed rescue-push failure refuses, an
unconfirmed one refuses too — but every single test in that file calls the
exported `recycleWithSync(...)` function DIRECTLY. None of them ever go
through `StudioDO.recycle()`'s own wrapper. A mutant that folds
`cfg.forceMappedAccount` into the `discardUnsynced` `recycleWithSync` is
handed (e.g. `{ discardUnsynced: discardUnsynced || cfg.forceMappedAccount ===
true, ... }`) would sail through that whole file green, since none of its
tests ever exercise the wrapper that would carry the bug.

Code is correct today (confirmed by reading the current wrapper, reproduced
above) — this is a pure test-gap: prove the guarantee holds at the REAL entry
point a `fleet recycle <id> --account mapped` call actually goes through.

## The test added

`test/studio.recycle-mapped-rescue-do.test.ts`, new file. Same
`Object.create(StudioDO.prototype)` real-DO-prototype fixture technique
`test/studio.account-gate-do.test.ts` already established (fake
`ctx`/`storage`/`container`/`env`, a real `env` from `cloudflare:test` merged
with overrides, `vi.spyOn` on `@cloudflare/sandbox`'s `Sandbox.prototype`'s
parent `startAndWaitForPorts`/`start` to prove no container was ever started).

New wrinkle this test needed that `studio.account-gate-do.test.ts` did not:
the rescue path actually execs into the container (`sbExec`, `sandbox-api.ts`)
to probe (`printf ok`), sync the session, and run the rescue-push script, all
on EXEC_CLASSES.rescue's pinned session (`fleet-rescue`), which routes through
`SandboxHandle.execWithSessionToken`, not `.exec`. The fixture fakes
`execWithSessionToken` directly on the fake DO object (the real `sbExec`
adapter calls it on `this`, and a real `StudioDO` IS a `Sandbox`, same as
`container`/`ctx` are faked rather than the SDK itself). Commands arrive
wrapped in `sbExec`'s own kill-deadline (`timeout -k <grace> <secs> bash -c
'<cmd>'`) — a small `unwrapKillDeadline` helper strips that back to the raw
command so the fake can match against the same cmd shapes
`test/studio.recycle-guard.test.ts`'s own `liveDeps` fixture already uses
(`"printf ok"`, `mkdir -p` prefix for the session tar/stat, `status
--porcelain` for the rescue-push script itself).

The env fixture (`MAPPED_LAUNCHABLE`) maps `fleetflare` to its own slot 1
(`CLAUDE_ACCOUNT_BY_REPO: '{"fleetflare":1}'`) with
`CLAUDE_CODE_OAUTH_TOKEN` SET — a LAUNCHABLE mapped account (unlike
`studio.account-gate-do.test.ts`'s own `MAPPED_MISSING`, which maps to a slot
whose secret is absent, on purpose, to test the refusal-before-recycle path).
This is the case `--account mapped` exists for: a mapped, launchable slot, so
`refuseUnlessMappedAccountLaunchable` and both `launchAccountOrRefuse` calls
resolve `ok`, and the wrapper falls all the way through into
`recycleWithSync`.

The single test: `recycle({ repo: "fleetflare", role: "web-studio",
forceMappedAccount: true }, false)` — mapped forced, `discardUnsynced` NOT
requested — against a container whose rescue-push script's stdout is
`RESCUE_FAILED agent-a1 push`. Asserts:

- the rejection message starts with `RECYCLE_REFUSED_PREFIX`
- it names the failed worktree (`"agent-a1"`) and the escape hatch
  (`fleet recycle <id> --discard-unsynced`)
- `destroy()` is NEVER called (spied directly on the DO instance)
- no container start observed (`started()`, same helper
  `studio.account-gate-do.test.ts` already uses)
- the probe actually ran (`"printf ok"` is in the recorded exec calls) — so
  this refusal is provably rescue's, not an accidental re-trip of the
  mapped-account gate itself.

## Mutation check (the point of this task)

Temporarily edited `StudioDO.recycle()`'s call into `recycleWithSync` to fold
`cfg.forceMappedAccount` into the guard it passes:

```ts
resolveMemoryRepo, commitFile, { discardUnsynced: discardUnsynced || cfg.forceMappedAccount === true, lastSyncedAt: () => this.lastSyncedAt() },
```

Ran the new test alone: **RED** — `recycle()` returned a status instead of
refusing (the confirmed rescue-push failure was silently discarded, exactly
the incident shape #96/#16 exist to prevent). Reverted the edit (confirmed
`git diff` on `do.ts` was empty again), reran: **GREEN**.

`test/studio.recycle-guard.test.ts` was NOT re-run against the mutant (it
cannot see it at all — every one of its tests calls `recycleWithSync`
directly, never `StudioDO.recycle()`), which is exactly the gap this task
closes.

## Board issue #149

Not attempted — time-boxed per the dispatch note. `recycle poll: fake fetch
must cap calls; require operationInFlight===null for success` touches
`cli/recycle-outcome.ts`'s poll loop and its interaction with
`operationInFlight`/periodic readiness stamps, unfamiliar machinery this round
never had to read. Left for a separate, dedicated round rather than bolted on
here.
