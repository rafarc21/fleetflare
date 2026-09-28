# `wakeStudio` bypasses the stopped gate on the webhook path (board issue #82)

## Root cause (measured live: `wrangler tail fleetflare` hit containers `fleet ls` said were stopped)

`apps/fleet/src/studio/do.ts`'s `StudioDO.wakeStudio(prompt)` called the raw,
unconditional `runWake(...)` (`apps/fleet/src/studio/wake.ts`) directly — no
check of the studio's own recorded state, no check that the tmux pane was
even running the claude TUI. It has three callers, none of which had
established "stopped" before calling it:

1. `apps/fleet/src/github/webhook.ts:84` `wakeMaestro()` — fires on every
   GitHub webhook event for a repo. This is the leak the measurement caught:
   a webhook delivery to a repo whose maestro was deliberately stopped still
   started (and billed for) its container.
2. `apps/fleet/src/studio/routes.ts:181` `notifyMaestro()` — fires after a
   child studio spawns, to nudge the parent maestro.
3. `apps/fleet/src/studio/routes.ts:576` — the `/fleet/.../wake` HTTP action,
   the generic entry point.

The sibling method `wakeStudioOnAssignment` (`do.ts`, board issue #41) was
already correctly gated: it calls `runGatedWake` (`wake.ts`) with
`recordedState` read from `this.ctx.storage.get<StudioStatus>(STATUS_KEY)`.
`runGatedWake` implements exactly the two gates needed — GATE 1 refuses if
recorded state is `null` (never provisioned) or `"stopped"`; GATE 2 probes
the tmux pane (`pane_current_command`) and refuses if it isn't running
`claude` (a bash pane means a shell, not the TUI). Both gates are total —
they never throw, they return `{ok:false, error}`.

The sweep path (`sweepMaestro` → `sweepTick`) is NOT part of this bug: it
gates itself with its own `isStopped` check immediately before calling raw
`runWake` directly — it never goes through the `wakeStudio` DO method at
all. Left untouched, on purpose.

## The fix

One change point: `StudioDO.wakeStudio` (`do.ts`) now calls `runGatedWake`
instead of raw `runWake`, using the exact same `recordedState`/`exec` deps
shape `wakeStudioOnAssignment` already builds just below it in the same
file:

```ts
async wakeStudio(prompt: string): Promise<WakeOutcome> {
  const outcome = await runGatedWake(
    {
      recordedState: async () => (await this.ctx.storage.get<StudioStatus>(STATUS_KEY))?.state ?? null,
      exec: (cmd: string) => sbExec(this, cmd),
    },
    prompt,
  );
  if (outcome.ok && this.isMaestro()) await this.armSweep();
  return outcome;
}
```

This fixes all three callers uniformly — none of them changed, because the
gate now lives inside the one method all three already call.

`wakeStudio` and `wakeStudioOnAssignment` were deliberately NOT collapsed
into one method: they still differ on sweep-arming semantics.
`wakeStudioOnAssignment` intentionally does not arm the sweep (its own doc
comment explains why — arming is maestro's own supervision clock, and that
method's whole reason to exist is the studios that are not maestro).

Stale doc comments updated to match: `wakeStudio`'s own doc comment (now
states it runs `runGatedWake`, not raw `runWake`, and names all three
callers this closes the leak for), `wakeStudioOnAssignment`'s doc comment
(no longer claims `wakeStudio`'s callers "have already established" a wake
is safe), and `wake.ts`'s header comment above `runGatedWake` (no longer
claims the webhook's `wakeMaestro` and the sweep are `runWake`'s only two
callers — the sweep is now the only one left ungated by `wakeStudio`, on
purpose, not by oversight).

## TDD

`StudioDO` is container-backed and cannot be constructed under
vitest-pool-workers (`do.ts`'s own header states this; `test/studio.sweep.test.ts`
already works around it for `sweepMaestro`/`rearm` by pinning against the
class's own source text via the `TEST_STUDIO_DO_SRC` binding). Same
technique applied here, plus one genuinely constructable regression surface
(the `/wake` HTTP route's own fake, which the codebase's own convention
requires call the REAL exported gate function rather than a hand-copy — see
`recycle`/`destroyStudio`/`checkProvisioned` in `test/studio.routes.test.ts`
for the established precedent).

**`apps/fleet/test/studio.wake.test.ts`** — new `describe("StudioDO.wakeStudio
(source-pinned...)")`:
- `"runs the wake through runGatedWake, never the raw unconditional runWake"`
- `"answers the stopped/never-provisioned gate from THIS DO's own storage, never the D1 mirror"`
- `"still arms the sweep only on a landed, gated wake, maestro only"`

RED (before the fix): both of the first two failed — the pinned method body
was `const outcome = await runWake((cmd: string) => sbExec(this, cmd), prompt);`,
containing neither `runGatedWake(` nor the `recordedState`/STATUS_KEY deps
line. Confirmed by running `bun run test -- test/studio.wake.test.ts`, which
reported exactly those two assertions failing with the raw pre-fix method
body printed as the actual value.

GREEN (after the fix): all 20 tests in the file pass, including the 3 new
ones.

**`apps/fleet/test/studio.routes.test.ts`** — `fakeStudioNamespace`'s
`wakeStudio` fake changed from calling `runWake` directly to calling the
REAL exported `runGatedWake`, with two new injectable params
(`wakeRecordedState`, default `"running"`; `wakePaneProbeResult`, default a
claude-pane answer) so the `POST /studio/:id/wake` route's own tests can
prove the HTTP action's gate:
- existing `"hands the container the same command the real-tmux test executes"`
  updated: `wakeCmds` now includes the pane probe before the wake command
  (regression check — the happy path still wakes exactly as before, just
  behind the gate).
- new `"refuses a STOPPED studio without touching the container at all"` —
  zero exec calls, `ok:false`, error mentions "stopped".
- new `"sends no keystrokes when the pane is a bare shell, not the claude TUI"` —
  only the probe command is sent, `ok:false`, error mentions "bash".

The underlying gate behavior itself (stopped refusal, never-provisioned
refusal, bash-pane refusal, claude-pane pass-through, total on
throw/nonzero-exit) was already exhaustively covered by the pre-existing
`runGatedWake` tests in `studio.wake.test.ts` — those were not duplicated,
only the NEW wiring (does `wakeStudio` actually reach that gate) needed new
tests.

## Verification

All three from `apps/fleet/`:

```
$ bun run check
$ tsc --noEmit && tsc --noEmit -p container && tsc --noEmit -p cli && tsc --noEmit -p test-integration && tsc --noEmit -p test
(exit 0, no diagnostics)

$ bun run test
$ vitest run
 Test Files  86 passed (86)
      Tests  2200 passed (2200)
(exit 0)

$ bun run bun-test
$ bun test test/bun test/studio.files.test.ts test/studio.studio-blueprint.test.ts
 337 pass
 9 skip
 0 fail
Ran 346 tests across 31 files.
(exit 0)
```

## Boundary

Touched: `apps/fleet/src/studio/do.ts` (`wakeStudio` method body + its own
and `wakeStudioOnAssignment`'s doc comments only), `apps/fleet/src/studio/wake.ts`
(header comment above `runGatedWake` only, no logic change),
`apps/fleet/test/studio.wake.test.ts`, `apps/fleet/test/studio.routes.test.ts`,
this plan doc, `.fleet/done.json`.

Not touched: `apps/fleet/container/**` (worker-only, per dispatch), the sweep
path (`sweepMaestro`/`sweepTick`/`isStopped`), `runWake`/`runGatedWake`
themselves (both already correct, reused as-is), `notifyMaestro`'s own
injection-boundary tests in `test/studio.spawn.test.ts` (they stand in for
the whole DO at a higher abstraction and don't call the real `wakeStudio`
method — unaffected by this fix, no change needed). No deploy. The 3 leaked
maestro studios named in the issue were left alone — that is an operational
concern for the maestro, not this code fix.
