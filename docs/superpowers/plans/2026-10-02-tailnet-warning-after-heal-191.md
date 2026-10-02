# Tailnet warning missing from READY after a heal (#191)

**Board issue:** https://github.com/rafarc21/fleetflare/issues/191

## Symptom

2026-10-01 21:17Z, on a Worker build with #189/#190's "tailscale up
failure is non-fatal" fix already live: two studios self-healed on
fresh containers right after a rollout (`healBareContainer` -> bare
container -> `restartStudio("heal")` -> cloned, ran bring-up again).
`fleet ls` HOST showed `-` (expected — no tailnet). READY showed plain
`provisioned`, never `provisioned (tailnet: quota reached)` — the
warning #190 added specifically to save diagnosis time on exactly this
case.

## What was already ruled out (read #190/#191's own history before
picking this up again)

The marker-reading machinery itself — `runProvisionedCheck` (do.ts),
`readinessOf`, `checkAndRecordReadiness`, `cleanReadiness`,
`formatReady` (cli/readiness-format.ts) — is unit-tested end to end for
the plain provision/restart path
(test/studio.readiness.test.ts:113, "provisioned + tailnet marker
line") and passes. A new test added in this round
(test/studio.self-heal.test.ts, "the real heal path — issue #191")
replicates the FULL sequence a heal actually runs — `checkAndRecordReadiness`
(pre-heal, bare) -> a `heal()` that carries the stale readiness forward
exactly as `runRestart` does, then calls `checkAndRecordReadiness` again
(post-heal, provisioned+warning) -> `healBareContainer`'s own
`BARE_SELF_HEALED` note — using the REAL exported functions, not a
hand-mocked `heal` that only pokes `STATUS_KEY`. That test is GREEN: the
do.ts/provision.ts TS plumbing that threads a verdict's `warning` field
through storage and the registry is sound.

This means the defect is not in that plumbing. It is upstream of it: in
whether `tailscale up` ever gets a real `TS_AUTHKEY` to try during a
heal's own bring-up exec.

## Root cause

`container/studio-bringup.sh`'s tailscale-up region (lines ~262-283)
reads `${TS_AUTHKEY:-}` from its own inherited process environment. An
EMPTY value takes the "TS_AUTHKEY not set, skipping tailscale up" branch
(line 264), which **clears** `tailnet-down` — the same thing it does for
a studio that never configured a tailnet at all. It does **not** write a
warning. A studio in that branch reads back as plain `provisioned`, HOST
`-` — exactly the measured symptom, and a message that is indistinguishable
from "this studio was never meant to have a tailnet."

`TS_AUTHKEY` never arrives via `roleEnv` (the persisted per-studio env
`runRestart`/`runProvision` thread into `BRINGUP_CMD`'s own per-exec
`env` argument) — confirmed by reading `RoleEnv`/`StudioEnv` (types.ts):
neither carries it. It has only ever arrived via the CONTAINER's
inherited process environment, set by `do.ts`'s `this.envVars`
(`studioEnvVars`/`launchFields`), which that file's own doc comment
(do.ts ~3225-3245) calls "start config": applied by
`@cloudflare/containers`' `Container.startContainerIfNotRunning` only
when the SDK actually issues `this.container.start(startConfig)` — and
that call is skipped outright whenever `this.container.running` already
reads `true` (confirmed by reading
`node_modules/@cloudflare/containers/dist/lib/container.js:660-667`:
`if (this.container.running) { ...; return 0; }`, no `envVars` read at
all on that branch).

`StudioDO.restartUngated` (do.ts ~6479-6569) — the method
`restartStudio("heal")` calls, which `healBareContainer`'s own `heal()`
parameter is wired to — reassigns `this.envVars` from a fresh
`launchFields(...)` call, but only PUSHES it to the container inside:

```
if (!this.ctx.container?.running) {
  ...
  if (!this.ctx.container?.running) await sbAwaitReady(this);
  ...
}
```

`sbAwaitReady` (the one call whose underlying SDK method,
`startAndWaitForPorts`, actually issues `.start(startConfig)` with fresh
`envVars`) never runs when `this.ctx.container?.running` already reads
`true`. That is exactly the state issue #38's own doc comments (do.ts
~2788-2792, ~6551-6556) already describe for a post-rollout heal:
"a container image rollout replaces the container UNDER this DO, so
restart is routinely the FIRST THING TO TOUCH a brand new, empty
filesystem" — from the Worker's own point of view the binding never
stopped being "running" across the replacement, so the one call that
would have re-pushed `envVars` (TS_AUTHKEY included) onto the
replacement instance never fires. `runRestart`'s own bring-up exec
(`bringUpAndVerify`, provision.ts) then runs against a container whose
inherited env may still be missing the secret entirely.

This is consistent with every measured fact at once:

- HOST `-`: no tailnet was ever attempted (TS_AUTHKEY empty), not that
  one was attempted and failed.
- READY plain `provisioned`: the "not set, skip" branch clears the
  marker rather than setting a warning.
- Bring-up still reports `provisioned`/claude running: claude's own
  credential (`CLAUDE_CODE_OAUTH_TOKEN`) and session history are
  unaffected either way — this gap is specific to `TS_AUTHKEY`, the one
  var `tailscale up` needs and the one var no per-exec `roleEnv` has ever
  carried.

This is also why no EXISTING test caught it: `restartUngated` is a
`StudioDO` method, and `StudioDO` cannot be constructed under
`vitest-pool-workers` (do.ts's own header, and provision.ts's header —
"Containers have not been enabled for this Durable Object class"). The
defect lives in exactly the one piece of glue no unit test can reach
directly; only the extracted, testable halves on either side of it
(`checkAndRecordReadiness`, `runRestart`) were ever covered.

## Fix

`apps/fleet/src/studio/provision.ts`:

- `ProvisionDeps.tsAuthKey?: string` — a new, optional, per-call
  override. Documented as riding `BRINGUP_CMD`'s own per-exec env
  (`sbExec`'s `env` argument), never the container's inherited env,
  specifically because `studio-bringup.sh` consumes it entirely inside
  its own tailscale-up region — BEFORE tmux even exists — so it never
  needed the tmux-session-inherited lifetime `this.envVars`/container
  start config exists for in the first place. A per-exec override is
  exactly as correct and sidesteps the SDK's
  start-vs-already-running bookkeeping entirely.
- `bringUpAndVerify` (the one function both of `runRestart`'s two
  bring-up attempts call) now builds
  `deps.tsAuthKey ? { ...roleEnv, TS_AUTHKEY: deps.tsAuthKey } : roleEnv`
  and execs `BRINGUP_CMD` with THAT, instead of `roleEnv` alone. Absent
  `tsAuthKey` (every existing test fixture, and any future caller that
  does not wire it) is a no-op — behavior is byte-identical to before
  this fix.

`apps/fleet/src/studio/do.ts`:

- `StudioDO.deps()` (the `ProvisionDeps` both `provision()` and
  `restartUngated()` build fresh on every call — never cached) now
  supplies `tsAuthKey: this.env.TS_AUTHKEY ?? ""`, the same Worker
  secret `studioEnvVars` already reads for the container-level
  `envVars` path. The `?? ""` mirrors that existing convention exactly
  (do.ts ~3717-3721's own comment: "empty string, not omitted... reads
  empty and unset identically"), so `bringUpAndVerify`'s falsy check
  behaves the same whether the secret is truly unset or an empty string.

No change to `container/studio-bringup.sh` — it already reads
`${TS_AUTHKEY:-}` from its own process env regardless of whether that
env came from the container's inherited environment or a per-exec
override; both arrive the same way from the script's point of view.

## Out of scope

- The OTHER container-level `envVars` (`CLAUDE_CODE_OAUTH_TOKEN`,
  `STUDIO_ID`, `FLEET_SPAWN_TOKEN`, `FLEET_WORKER_URL`) are untouched.
  Each of those is either consumed by a process that MUST inherit it
  through tmux (claude itself, started later in the same script, in a
  pane every future attach needs to still see it) or is harmless when
  stale (the same secret value, not rotated by a rollout) — neither
  shares `TS_AUTHKEY`'s specific shape of "consumed entirely within one
  exec, before tmux exists, and silently degrades to a DIFFERENT,
  indistinguishable behavior (marker cleared, not set) when absent".
  Widening this fix to those vars is a separate, larger change this
  issue does not ask for.
- `restartUngated`'s own `!this.ctx.container?.running` gate (do.ts
  ~6510-6525) is untouched — fixing the SDK-level staleness there (so
  `sbAwaitReady` genuinely fires on a post-rollout heal) would also
  work, but is a materially larger, less certain change (it depends on
  exact `@cloudflare/containers`/`@cloudflare/sandbox` internals this
  repo does not control) for a problem this smaller, targeted,
  provably-correct per-exec override already closes.
- `runProvision`'s own direct `BRINGUP_CMD` call (provision.ts ~2536)
  is untouched: a provision always reaches a genuinely fresh container
  through its own `sbAwaitReady`-gated start path (never an
  already-"running" replacement), so it was never exposed to this gap.

## Test plan

1. **Reproduction, closes the coverage gap the bug hid behind**
   (`apps/fleet/test/studio.self-heal.test.ts`, new describe block "the
   real heal path — issue #191, tailnet warning after heal"): calls the
   REAL `checkAndRecordReadiness` twice (pre-heal bare, post-heal
   provisioned+warning) composed the way `restartUngated` really
   composes them, through `healBareContainer`. GREEN before and after
   this fix — it proves the do.ts/provision.ts readiness plumbing was
   never the defect, and stands as permanent regression coverage for
   that claim.
2. **The actual fix, RED then GREEN**
   (`apps/fleet/test/studio.replacement.test.ts`, new describe block
   "runRestart — TS_AUTHKEY reaches bring-up on its own per-exec env
   (issue #191)"):
   - RED (confirmed before the fix): a `ProvisionDeps` with
     `tsAuthKey: "<fake>"` and a `sbExec` fake that records the `env`
     argument per command; `restartWithStorage` runs; the `BRINGUP_CMD`
     call's recorded env is asserted to include
     `TS_AUTHKEY: "<fake>"`. Failed with `undefined` before the fix.
   - GREEN (after the fix): same test passes, and persisted `roleEnv`
     fields (`STUDIO_NAME`, etc.) are asserted present alongside it,
     proving the override is additive.
   - A second test asserts the no-op case: a `ProvisionDeps` with no
     `tsAuthKey` at all gets the EXACT same env object bring-up always
     got before this fix (`toEqual(STUDIO_ENV)`), proving no existing
     caller's behavior changed.

## Verification

- `bun run test -- test/studio.replacement.test.ts
  test/studio.self-heal.test.ts test/studio.readiness.test.ts
  test/studio.provision.test.ts` — all green.
- `npx tsc --noEmit` (root project) — clean.
- Full gate (`bun run check`, `bun run test`, `bun run bun-test`,
  `bun run english-check`, `bun run test-lies-check`) run one at a time
  from `apps/fleet/`, results recorded in this task's completion record.
