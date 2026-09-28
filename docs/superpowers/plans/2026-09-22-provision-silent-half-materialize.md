# Provision reports `running` over a half-materialized container (board issue #28)

## Q1 — what happens when `provisionWithStorage` throws or never resolves

`apps/fleet/src/studio/do.ts:1637`:
`const status = await provisionWithStorage(this.deps(), this.ctx.storage, cfg, this.env.AGENT_REPO);`
— no try/catch of its own around this line, anywhere in `provision()`
(`do.ts:1561-1666`).

`provisionWithStorage` (`provision.ts:1408-1424`) calls `runProvision`
(`provision.ts:1210-1297`), which DOES wrap the whole resolve/clone/bring-up
sequence in one try/catch (`1235-1293`). A nonzero clone exit throws at
`1246-1248`; a nonzero bring-up exit throws at `1279-1281`; any other thrown
error inside the try (a blueprint fetch failure, a `setKeepAlive` rejection,
etc.) lands in the same place. All of it is caught at `1283`, which sets
`status = {...status, state: "degraded", error: redactSecrets(...)}` (`1292`)
and unconditionally `await deps.recordStudio(status)` (`1295`) before
returning.

Confirmed: for a THROWN error or a NONZERO exit code from either exec, the
error genuinely IS persisted to `status.error`. This path is not silent. The
measured incident (`error: null`, `state: "running"`) is therefore NOT
explained by an uncaught throw or a nonzero exit — both execs genuinely
returned exit 0 to this code. The silence is not in the error-handling path;
it is that nothing independently confirms the on-disk RESULT matches what the
exit code claimed.

## Q2 — is the provision route fire-and-forget

No. `apps/fleet/src/studio/routes.ts:466`:
`return Response.json(await stub.provision(cfg));` — genuinely awaits the full
DO method. `provision()` genuinely awaits `provisionWithStorage`'s full chain
(clone exec, rescue-discovery exec, session-restore, bring-up exec — all
sequential `await`s inside `runProvision`). `sbExec`
(`apps/fleet/src/studio/sandbox-api.ts:70-75`) genuinely awaits the real
`@cloudflare/sandbox` SDK's `sb.exec(cmd)` call and returns its real exit
code/stdout/stderr.

BUT: `BRINGUP_CMD`'s own script does not wait for claude to become
responsive. `provision.ts:420-421`'s own doc comment states it directly:
"Bring-up does NOT launch claude synchronously — it `send-keys` the launch
line into the tmux window and returns immediately". So `bringupRes.code === 0`
proves the SCRIPT ran to completion (clone attempted, materialization
attempted, claude's launch QUEUED) — it does NOT prove the clone/
materialization actually landed on disk, nor that claude started.

## Q3 — reconciling schedules-armed-after vs. ticks-observed-during

Confirmed sequential, not concurrent: `do.ts:1637`
(`await provisionWithStorage(...)`) completes before `do.ts:1648-1659` arms
`refreshToken`/`shipTranscript`/`syncSession`. For any `shipTranscript` tick
to have fired at all during the broken window, `provisionWithStorage` must
have genuinely RESOLVED — proving `provision()` succeeded from the Worker's
own perspective, and schedules got armed exactly as designed. The two facts
are not contradictory: they are both true, and they point at the same gap.

`shipTranscriptTick` (`apps/fleet/src/studio/transcript.ts`) execs into
WHATEVER CONTAINER CURRENTLY BACKS THE SANDBOX at tick time, not necessarily
the same container instance clone/bring-up ran against. `shipTranscript()`'s
own doc comment (`do.ts:1958-1970`) states the design explicitly: "Ship
failure NEVER touches state/error/lastRefreshError — transcript is
observability. Your DO catch logs and continues." — a deliberate,
already-correct catch-log-reschedule-never-touch-state design for its own
concern.

So a tick against an empty/reset container hits `shipTranscriptTick`'s own
`"no-file"` skip path (transcript.ts, `ShipResult.skipped`), logs quietly,
reschedules — indistinguishable from "genuinely nothing new happened this
tick," the NORMAL outcome for a healthy studio between real work.

**The silence**: nothing anywhere, ever, after the original clone/bring-up
exit codes came back clean, independently re-verifies that the container's
actual on-disk state still matches what provisioning configured. Every later
tick trusts it, forever, with no periodic or terminal re-check tied back to
what was actually cloned.

## The fix

Inside `runProvision` (`apps/fleet/src/studio/provision.ts`), immediately
after the bring-up exec's exit-code check succeeds and before
`status = {...status, state: "running", ...}`: two new, cheap, synchronous
`deps.sbExec` checks, exit-code only (no stdout marker parsing — keeps the
existing blanket `vi.fn(async () => ({code: 0, ...}))` test fixtures
compatible with zero changes required to them):

1. `test -d /workspace/${cfg.repo}/.git` — the clone landed. A nonzero exit
   throws `"bring-up reported success but /workspace/${cfg.repo}/.git is
   missing -- clone did not land on this container"`.
2. Studio path only (`"STUDIO_NAME" in resolved.bringupEnv &&
   resolved.bringupEnv.STUDIO_NAME !== ""`): `test -d "$HOME/.claude/agents"`
   — bring-up's own unconditional `mkdir -p ~/.claude/agents` for a studio
   (`container/studio-bringup.sh:324`, runs regardless of roster size). A
   nonzero exit throws `"bring-up reported success but ~/.claude/agents is
   missing -- studio materialization did not land on this container"`. Gated
   on studio because a plain role never gets this directory (measured:
   `websites--pilot`, HOOK=0 SKILLS=0) and must not be failed over its
   absence.

Both throws land in the SAME existing catch block (`1283`) that already sets
`state: "degraded"` and persists `status.error` — no new error-handling
path added, one more thing that can throw into the existing, already-correct
chain.

This closes the WITHIN-PROVISION-CALL version of the gap: if the clone step
and this new check happen to land on different containers because of a
mid-provision swap, the mismatch is caught immediately, synchronously, within
the SAME `provision()` call, before it ever reports success.

**Explicitly out of scope, not solved here**: a container swap that happens
AFTER `provision()` has already returned and been verified correct. That is a
later-arriving class of event a synchronous provision-time check can never
observe — it would need a periodic or terminal re-check independent of the
original provision call, which is a different, bigger feature. Named as
residual risk, not attempted.

No retry added anywhere — the issue's own ruling: a retry would quietly
re-attempt and potentially succeed the second time with zero record that the
first attempt silently failed, exactly the pattern being removed. The fix is
visibility (`status.error`), not automatic recovery.

**`runRestart` (`provision.ts:1379-1408`) deliberately not extended.** It
execs `BRINGUP_CMD` and sets `state: "running"` on a clean exit code with
zero post-check — structurally the same shape as the bug just fixed in
`runProvision`. Reasoning for leaving it alone here: `runRestart` never
destroys/replaces the container first — only `recycleWithSync` (`do.ts`) does
that, and it already routes through the now-fixed `runProvision`. Restart
heals/recreates the tmux session on the SAME container, so the specific
"clone exec and a later exec land on different container instances"
mechanism this fix closes may not apply the same way to a bare restart. This
is reasoning, not something empirically measured the way the `runProvision`
incident was — not something to silently assume forever. Worth a look in a
future task if a restart ever shows the same "looks healthy, isn't" symptom.

**`provisionedCheckCmd`/`harnessCheckSnippet` (`provision.ts:628-706`) not
reused for this fix, on purpose.** That check is much richer — claude
actually running in tmux, every skill resolvable, every member file present,
hooks installed and referenced in `settings.json` — but has built-in polling
waits (`PROVISIONED_CHECK_TRIES=20` + `CAVEMAN_FLAG_TRIES=10`, up to ~30s)
designed for POST-RECYCLE polling (`checkProvisionedWithRetry`, called from
`do.ts`'s `recycleWithSync`), not for adding latency to every single
`provision()` call. The new fix instead adds two narrow, immediate `test -d`
checks specifically because they are synchronous and cheap, not because the
richer check sitting right there in the same file wasn't known about.

## TDD

New tests in `apps/fleet/test/studio.provision.test.ts`. Red: fake `sbExec`
returns `code: 0` for the clone command and `BRINGUP_CMD`, but `code: 1` for
the new verification command(s) — asserted against the CURRENT (pre-fix) code
first, confirming it reports `state: "running", error: null` (the exact
measured incident). Green: same fixture, after the fix, asserts
`state: "degraded"` with a clear, distinct `error` naming the missing path.
Existing regression: clone + bring-up + both verification checks all succeed
→ still `state: "running", error: null`, no false positive.

## Boundary

Touched: `apps/fleet/src/studio/provision.ts` (`runProvision` only — no new
top-level exported functions, no changes to any other function in the file),
`apps/fleet/test/studio.provision.test.ts`, this plan doc, `.fleet/done.json`.
Not touched: `apps/fleet/src/studio/do.ts`, `container/studio-bringup.sh`,
`checkAndRecordReadiness`, `checkProvisionedWithRetry`, `syncSessionCycle`,
board files, github files. No deploy.

## Verification plan

From `apps/fleet/`: `bun run check`, `bun run test`, `bun run bun-test` — all
three lanes, per the issue's own explicit requirement ("`bun run test` alone
is HALF the suite").
