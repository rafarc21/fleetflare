# Async /run-leg: step.waitForEvent so no gate invocation holds a >20-min await

Issue: https://github.com/rafarc21/fleetflare/issues/1396. Refs
https://github.com/rafarc21/fleetflare/issues/1393,
https://github.com/rafarc21/fleetflare/issues/1390,
https://github.com/rafarc21/fleetflare/issues/715. Date 2026-10-26.
Status: proposal, design only. No code in this PR (the task's own Boundaries:
`docs/superpowers/specs` now, `apps/fleet/src/gate/*` later, as its own
implementation task(s)).

## Non-goals

- Not a redesign of the leg plan (`fanout.ts`'s `planLegs`/`planUnionLegs`/
  `carriedGreenByLeg`), the verdict roll-up (`verdict.ts`), the trust/secrets
  filter (`secrets-scope.ts`), or the merge-precheck/bundle-leg machinery. All
  of that sits *above* the one call this doc changes (how a leg's own
  container run is dispatched and awaited) and is untouched by it.
- Not a fix for every possible Workflows internal error. It removes the ONE
  class this task is scoped to: an invocation killed because a single
  `step.do` callback held an open await past Workflows' own per-invocation
  wall-clock cutoff. A genuinely different internal error (a platform outage,
  a storage failure) is out of scope here, same as it is out of scope for
  `infra-rerun.ts`'s existing classifier.
- Not a change to the container/gate-server protocol's `/run` and `/result`
  endpoints (`container/gate-server.ts`, out of this repo's own `apps/fleet`
  tree per `run-leg.ts`'s own split) — the container still answers 202
  (running) / 200 (done) the same way; only WHO polls it and HOW the answer
  reaches the Workflow changes.
- Not a cost-driven rewrite. The cost section below is honest about the
  likely savings (DO duration, mainly) but this task exists for *correctness*
  (#1393's data loss), not for a cost target.

## Problem (measured, #1393)

A 2026-10-26 consumer run (`gate-7ccb1a8d1104768c-266bd371…-rmvpt03xy`) had
its `start-vitest-8-1` step fail 3 times with `WorkflowInternalError: Attempt
failed due to internal workflows error` at 22:04, 22:39 and 22:58Z — each
attempt roughly 20-35 min apart, each one a FRESH container that had, in
fact, **already finished successfully**: `shard-vitest-8.json`,
`-try2.json`, `-try3.json` in R2 each held `{state: "success"}`, 1929/1929
tests. The step's own `catch` (`leg-run.ts`'s `attempt()` closure, the `catch
(err)` block around `dispatch(...)`) never saw any of this — it only reads
R2 inside its own `catch`, and `storedLegResult` only runs when `dispatch`
itself rejects, not when the surrounding Workflows *invocation* is killed out
from under it before the callback can even reach its own `catch`. The result:
`fanout.ts` counted the leg red, `infra-rerun.ts`'s `INFRA_CAUSE` regex
matched `"internal workflows error"` and classified it infra, and the WHOLE
RUN (every leg, not just this one) was auto-rerun once (#1119) — discarding
real, already-green work three separate times before the run's one
auto-rerun budget (#1148: a rerun is never rerun again) was spent on a leg
that was never actually broken.

**Root cause, not just the symptom.** Cloudflare Workflows caps how long a
single `run()` *invocation* may stay alive before the engine recycles it —
publicly documented as roughly 20 minutes of wall-clock per invocation, a
separate budget from a step's own `timeout` config
(`LegStepConfig.timeout`, `"30 minutes"` today, `leg-run.ts:70-73`). A
`step.do` callback that itself holds one long `await` — here, `runLeg`'s
`dispatch` closure (`workflow.ts:617-624`) calling
`stub.fetch("https://gate-runner/run-leg", ...)`, which (`do.ts:88-92`)
awaits `runLegWithSecrets` → `runLegInContainer` → `runOnServer`'s own
in-request poll loop (`run-leg.ts:265-288`, `await sleep(POLL_MS)` in a loop
bounded only by the leg's `timeoutMin`, up to 25 min, or the step's own
28-min `legStepDeadlineMs` cap) — can run past that ~20-min invocation
ceiling even though it is still comfortably under its OWN step timeout and
deadline. Workflows does not wait for the step to finish; it recycles the
invocation, the in-flight `step.do` is abandoned mid-flight, and the retried
invocation's own `catch` never ran (there was no `catch` — the call simply
never returned to that JS context at all). This is not a corner case this
design works around after the fact: it is the direct, structural consequence
of putting a 20-30 min operation inside one invocation's one open await.

**Why `leg-run.ts`'s existing fallbacks don't already cover this.** Every
recovery path in the current code (`storedLegResult` in the `catch` block,
`#1122`'s "a transport loss reads R2", `#1321`'s SIGTERM/SIGKILL R2
read-back) fires from INSIDE the same `step.do` callback, after `dispatch`
itself rejects or the request completes. None of them fire when the
*invocation itself* is killed before the callback can run its own cleanup —
there is no code running at that point to read anything. The only way to
make this reliable is to never again let one invocation's one open await
span the leg's whole run.

## Current architecture (for contrast)

```
Workflow (GateWorkflow.run)
  step.do("start-<leg>", async () => {          <- one Workflows "step"
    const res = await stub.fetch("/run-leg")    <- ONE long-held DO call…
    ...
  })

GateRunnerDO.fetch("/run-leg")                   <- …answers only when the
  await runLegWithSecrets(..., () =>                whole leg is over
    runLegInContainer(req, deps))               <- starts container, waits
                                                     up to 180s for ready,
                                                     then polls /result every
                                                     POLL_MS until done or
                                                     the leg's own deadline
```

One HTTP request-response pair spans the ENTIRE leg, both at the Workflow
step level and at the DO fetch-handler level. `test/bun/gate-leg-run.test.ts`
encodes this as an explicit invariant today (`:123-128`): *"only one step per
leg, and no waitForEvent: the start step is the whole leg."* That test is
exactly the assumption this design replaces — it will need to be rewritten,
not just extended, by the implementation PR.

## New architecture

```
Workflow (GateWorkflow.run)
  step.do("dispatch-<leg>", async () => {        <- SHORT step: starts the
    await stub.fetch("/run-leg")                     container, returns
  })                                                  once accepted, never
                                                       once the leg is done
  step.waitForEvent("leg-done:<attemptId>", {    <- hibernates; no open
    type: "leg-done", timeout: <leg timeout+grace>}   invocation while
  )                                                   waiting
  // fallback loop, see "In-flight replay" below
  step.sleep("60 seconds")
  step.do("check-r2-<leg>-<n>", () => readR2(...))

GateRunnerDO.fetch("/run-leg")
  start container, persist request + wake-target in ctx.storage
  ctx.storage.setAlarm(now + first tick)
  return 202 immediately                          <- NEVER awaits the leg

GateRunnerDO.alarm()                               <- wakes on its own,
  one poll tick (same classification runOnServer       independent of any
    does today: ready-wait, port-retry, /result        Workflow invocation
    poll, container-exited check, leg deadline)
  not done yet -> re-arm alarm, return
  done -> write the attempt's outcome to R2,
          GATE_WORKFLOW.get(instanceId).sendEvent(
            {type: "leg-done", payload: {attemptId, outcome}})
          destroy the container
```

The container/gate-server protocol (`/run`, `/result`) is unchanged — the
DO still polls it exactly the way `runOnServer` does today. What moves is
WHO is awake while that polling happens: today it's the Workflow invocation,
blocked on one `fetch`; after this change it's the DO, waking briefly on its
own alarm, with the Workflow invocation suspended (hibernated, not polling,
not billed — see "Cost," below) in between.

### The DO becomes a tiny state machine

Today's `runLegInContainer`/`runOnServer` (`run-leg.ts:119-289`) is a single
function with local variables (`checkedR2`, `postStarted`, `legStarted`)
living in its own closure for the call's lifetime. An alarm-driven DO cannot
keep that — it may be evicted between alarms (that is the whole point of an
alarm: wake a possibly-evicted object). The per-attempt state becomes
explicit, persisted in `ctx.storage` across alarm ticks:

```ts
interface RunLegAlarmState {
  req: GateLegRequest;
  instanceId: string;        // GATE_WORKFLOW instance to sendEvent to
  attemptId: string;         // correlates the event to the right waitForEvent
  phase: "starting" | "port-retry" | "polling";
  postStarted?: number;      // set once phase enters "port-retry"
  legStarted?: number;       // set once phase enters "polling"
  checkedR2?: true;
}
```

`GateRunnerDO.fetch("/run-leg")` does the part that is ALREADY bounded well
under 20 min today — `c.start()` (synchronous, schedules the container) and,
optionally, the up-to-180s `waitUntilRunning` wait — then writes this state,
schedules the first alarm, and returns 202. (Whether `waitUntilRunning`
itself moves into the first alarm tick, so `/run-leg` returns in
milliseconds rather than up to 180s, is an implementation choice, not a
correctness one: 180s is nowhere near the 20-min ceiling either way. Moving
it into the alarm is the cleaner split — `/run-leg` becomes "accept and
schedule," period — and is this doc's recommendation.)

`GateRunnerDO.alarm()` reads the state, performs exactly ONE unit of work —
one port-fetch, one `/result` poll, one container-running check — matching
the existing branch-for-branch logic in `runOnServer`:

| Today (`runOnServer`, one call) | New (`alarm()`, one tick) |
|---|---|
| `waitUntilRunning` poll loop (`READY_POLL_MS`) | one `c.running` check; re-arm at `READY_POLL_MS` if not yet, until `READY_TIMEOUT_MS` budget exhausted |
| port-retry loop (`PORT_RETRY_MS`, budget `PORT_RETRY_BUDGET_MS`) | one `port.fetch("/run")` attempt; re-arm at `PORT_RETRY_MS` on refusal, until the budget is spent |
| poll loop (`POLL_MS`) | one `port.fetch("/result")` attempt; re-arm at `POLL_MS` if 202 |
| `now() - legStarted >= minutes*60_000` deadline check | same check, each tick, before polling again |
| container-stopped / R2 read-back (`#1122`) | same check, each tick |

Every TERMINAL branch today (infra description, or a real `LegResult`) stays
exactly the same classification logic — `isNoInstance`, the `NO_INSTANCE_*`
constants, `READY_TIMEOUT_MS`/`PORT_RETRY_BUDGET_MS`/`POLL_MS`, the leg
deadline wording (`"<leg> exceeded <n> min without a result"`, #1390's own
rule that this is a REAL red body, never infra) — none of that classification
code needs to change; it just runs across many short alarm ticks instead of
one long poll loop, and its OUTPUT (a `LegOutcome`) is written once to a new
R2 key and carried in a `sendEvent` payload, instead of being a function
return value.

### The attempt-outcome record (new)

Today, an infra outcome (`{kind: "infra", description}`) only ever exists as
the 503 HTTP response body of the one synchronous call — nothing persists
it, because the synchronous caller IS the thing that needs it. Once the DO's
poll loop runs independently of any particular Workflow invocation, infra
outcomes need a durable home too, the same way a real `LegResult` already
gets one (the container's own R2 write, `outbound-handler.ts`'s
`shard-<leg>.json`). This design adds ONE new R2 key per attempt, written by
the DO itself (never the container), holding whichever outcome the alarm
loop reached:

```
gate/<owner>/<repo>/runs/<pr>/<runId>/outcome-<leg>-<attemptId>.json
{ "kind": "result", "result": { "state": "success", ... } }
// or
{ "kind": "infra", "description": "gate container did not start within 180 s" }
```

Written with the SAME write-once contract `outbound-handler.ts` already uses
for every other result key (`onlyIf: { etagDoesNotMatch: "*" }`,
`run-leg.ts`'s own put calls follow the same pattern) — so if the alarm
fires twice for the same terminal tick (Cloudflare alarms are at-least-once,
never exactly-once), the second write is a harmless no-op, never a second,
possibly-different outcome overwriting the first. This record is:

- the thing `step.waitForEvent`'s matching payload is built from (inlined
  directly, when small enough — a `LegResult`'s `description` is already
  capped at `MAX_DESCRIPTION_CHARS` = 2000 chars, `leg-run.ts:23`, comfortably
  inside Workflows' event payload limit), **and**
- the thing the fallback R2 read (below) looks up — ONE key to check,
  regardless of whether the attempt ended in a real result, an infra
  failure, or the leg's own deadline, so the fallback path is a single
  lookup, not three different ones.

## Coverage, point by point (per the task's own list)

### Retries

Today, `leg-run.ts`'s `attempt()` closure is called twice per leg
(`start-<leg>`, then `retry-<leg>` when the first is retryable —
`isRetryable`: a red test, `"install failed"`, or `"clone failed:"`), and
EACH of those steps additionally gets Workflows' own automatic step-retry
(`LEG_STEP_CONFIG.retries`, `limit: 2`, used via `ctx.attempt` /
`tryNo` for the infra-retry-within-a-step loop, #1231/#1321). That automatic
step-retry depended on `dispatch` REJECTING (throwing) inside the step
callback — Workflows retries a step whose callback throws. In the new
design, `dispatch` (the short `step.do("dispatch-<leg>", …)`) only throws
for a synchronous accept failure (the DO's own `/run-leg` handler erroring
before it even schedules the container — fast, rare, and exactly the shape
`step.do`'s own automatic retry is built for), never for anything that
happens AFTER the container has started. Everything that happens after
start — container never came up, server unreachable, container exited mid
leg — is now a terminal OUTCOME the alarm loop classifies and reports via
the attempt-outcome record, not a thrown step error.

So the "try again on infra" loop that `ctx.attempt`/`tryNo` drove today
becomes EXPLICIT application code around the dispatch+wait pair, rather than
implicit Workflows step-retry:

```ts
for (let tryNo = 1; tryNo <= MAX_TRIES; tryNo++) {
  const attemptId = crypto.randomUUID();
  await step.do(`dispatch-${leg}-try${tryNo}`, DISPATCH_CONFIG, () => dispatchRunLeg(...));
  const outcome = await waitForLegOutcome(step, instanceId, attemptId, deadlineMs);
  if (outcome.kind === "result") return outcome.result;         // real body: done, win or lose
  if (elapsedMs() >= totalDeadlineMs) return finalInfraError(causes); // #1390's own total cap
  causes.push(outcome.description);                              // infra: loop, same as today's catch
}
```

This is a faithful, deliberate re-expression of the SAME state machine
`runLegStep` already encodes (`start-<leg>` → maybe `retry-<leg>`, each with
its own up-to-3-try infra loop, `totalLegWallMs` capping the whole thing) —
just with the try-loop made explicit in `leg-run.ts`'s own code instead of
split between there and Workflows' automatic step-retry semantics. The
public shape of `runLegStep` (one `LegRunResult` out, the same
`redFirst`/flaky-retry/combined-causes behavior) does not need to change;
its INTERNALS do.

### Infra classification

Unchanged taxonomy (`infra-rerun.ts`'s `INFRA_CAUSE`, `isNoInstance`,
`NO_INSTANCE_DESCRIPTION`) — every string this design's alarm loop can
produce is one the classifier already recognizes, because the classification
logic itself does not move. What changes is WHO decides infra-vs-result
(the DO's alarm loop, reading the SAME `LegOutcome` shape `runOnServer`
returns today) and WHEN the Workflow side learns about it (via the
attempt-outcome record + event, not a thrown exception it catches
synchronously). One genuinely new infra cause this design adds: the
Workflow's own fallback path (below) exhausting its last resort — "no
attempt-outcome record found after the leg's full timeout+grace, and no
event arrived" — which is itself DO/alarm-infrastructure failure, correctly
infra-classified (a new, narrowly-scoped addition to `INFRA_CAUSE`, named
something like `"leg outcome never arrived"`, distinct from every existing
cause so it is separately greppable in a live incident).

**The #1393 failure mode specifically stops recurring at its root**, not by
a special case: there is no longer any single invocation holding a 20-35 min
open await, so Workflows has nothing in that shape left to kill. The
`"internal workflows error"` string stays in `INFRA_CAUSE` for whatever
OTHER cause might still produce it (a step genuinely timing out at its own
30-min `LegStepConfig.timeout`, a platform-level Workflows outage) — this
design does not remove that line, it removes the ONE call shape that made it
fire on healthy, already-green work.

### Deadline (#1390)

#1390's own rule — *a leg past its own deadline is a final red verdict,
never infra-retried, and the retry's own infra loop must still halt at
`totalLegWallMs`* — is preserved exactly, just relocated: the per-attempt
deadline check (`now() - legStarted >= minutes * 60_000` in `runOnServer`
today) runs inside the alarm loop's "polling" phase, each tick, before
re-arming; the WHOLE-LEG cap (`totalLegWallMs`, start step + infra retries +
retry step) runs in the explicit try-loop shown above, the same
`elapsedMs() >= totalDeadlineMs` check `leg-run.ts:230` already makes. `#1390`'s
own fix (`run-leg.ts`'s deadline answers a real 200 red body, never a 503)
needs ZERO changes: the alarm loop's deadline branch still produces
`{kind: "result", result: {state: "error", description: "<leg> exceeded <n>
min without a result"}}`, written to the attempt-outcome record exactly as
any other result would be, so `isRetryable`/`isInfraLegFailure` see the
identical shape they see today.

### Watchdog touch (#1387)

Today, `touch()` (stamps `GATE_STALL_MS` progress, `auto-run.ts`) fires once
per step's FIRST `ctx.attempt` — i.e., once per genuinely NEW container, never
on a Workflows-internal step retry of the same attempt. In the explicit
try-loop above, there is no implicit step-retry counter to key off of
anymore: `touch()` is called once per NEW `tryNo` in that loop, i.e. once per
actual `dispatch-<leg>-try<N>` step that starts a genuinely fresh container —
the same semantics, expressed directly instead of inferred from
`ctx.attempt`. `GATE_STALL_MS` itself (37 min, `auto-run.ts:58`, sized to
exceed `totalLegWallMs`'s worst case plus the step retry delay) does not need
to change: the new design's worst-case wall time per leg is the SAME
`totalLegWallMs`, just reached via many short steps + waits instead of one
long one — 37 min of headroom still comfortably covers it. One thing to
verify at implementation time: `step.waitForEvent`'s own wait time — does it
count toward the Workflow instance being considered "live" the same way an
open step does, for whatever liveness signal the watchdog itself reads
(`GateRunInstance.status()`)? This doc assumes a hibernating wait is still a
"live" instance by Workflows' own `status()` contract (not `errored`, not
`terminated`) — flagged as an open question below, not asserted as verified.

### Carry/union legs

Both are plan-time decisions, strictly upstream of this design's scope:

- **Carry** (`carriedGreenByLeg`, #1230): a leg whose result is reused from a
  prior run is never dispatched at all — no DO, no container, no
  dispatch/wait pair. Unaffected by this design by construction.
- **Union / `@head`** (`planUnionLegs`, #1091; `head: true` opt-in grants,
  #1376): a leg added under a `<leg>@head` name for a PR that edits
  `fleet.json` is a NEW PLANNED LEG with its own name — it goes through
  `runLeg`/`runLegStep` exactly like any other leg, under its own name, so
  it goes through the new dispatch+wait protocol unchanged. Nothing about
  union planning or head-leg secret grants (`secrets-scope.ts`'s
  `headLegBaseName`) reads or depends on HOW a leg's own run is awaited.

### In-flight replay at deploy

This is the design's real new risk, and the task names it explicitly. Two
separate replay hazards, both already present in today's Workflows model in
weaker form, both sharpened by adding `step.waitForEvent`:

1. **A mid-run deploy replays `step.do` history.** This is not new —
   `step.do`'s whole contract is "replay returns the cached result, never
   re-runs the callback" (already relied on throughout `leg-run.ts`, e.g.
   "Made inside the callback: a Workflows step retry re-runs it, so every try
   gets its own runner DO. A replayed step returns its recorded result,"
   `leg-run.ts:218-219`). The new `dispatch-<leg>-try<N>` steps are no
   different: a replay after a deploy returns the cached 202-accept result,
   never re-dispatches a second container for the same `attemptId`.

2. **`step.waitForEvent` across a replay is the genuinely new hazard.**
   Public Cloudflare Workflows behavior (to be re-verified against the
   actual `@cloudflare/workers-types` version this repo pins,
   `^4.20260702.1`, before implementation — not asserted here as already
   confirmed) is that an event sent to an instance BEFORE that instance has
   reached the matching `waitForEvent` call may not be delivered to it: the
   instance has to already be waiting. A mid-run deploy that causes the
   Workflow engine to replay up to (but not yet past) a `waitForEvent` call
   — while the DO's alarm, running independently, ALREADY fired and sent its
   event during the gap — is exactly the scenario where a `sendEvent` could
   be lost. This is precisely why the task's own design names a fallback,
   and why this doc makes it a HARD requirement, not an optional
   belt-and-suspenders:

   > **The event is a latency optimization, never the sole correctness
   > mechanism. The attempt-outcome R2 record is the single source of
   > truth.** A leg's outcome is only ever "whatever `outcome-<leg>-
   > <attemptId>.json` in R2 says" — `waitForEvent` exists purely so the
   > common case does not need to poll R2 every 60s for up to 25+ minutes.

   Concretely: `step.waitForEvent(name, {type: "leg-done", timeout: <leg
   timeout + grace>})` is raced (conceptually — Workflows steps are
   sequential, so this is really "whichever resolves/elapses first in
   sequence") against a periodic fallback of `step.sleep("60 seconds")` then
   a SHORT `step.do("check-r2-<leg>-<n>", …)` that just reads the one
   attempt-outcome key. Whichever notices the outcome first (the event, or
   the next R2 check) is authoritative; if the event never arrives at all
   (lost, as above, or the DO's own alarm never fired — a true platform
   fault), the R2-poll loop still finds the record the moment it exists,
   bounded by the same `leg timeout + grace` the `waitForEvent`'s own
   timeout already uses. Only if BOTH the event AND every fallback R2 check
   come up empty all the way past that deadline does the Workflow conclude
   "leg outcome never arrived" (a new, narrow infra cause, see above) — and
   even then, this is no worse than today's behavior when a leg truly hangs
   past its deadline with no result anywhere.

   A corollary: the attempt-outcome record must be written (and the event
   sent) in that ORDER — R2 write first, `sendEvent` second — never the
   reverse, so a `sendEvent` success never implies a record exists that
   actually is not there yet. (Already how `isSignalKill`/`storedLegResult`
   reason about the container's own R2 writes today: R2 is the ground
   truth, HTTP/event signals are just faster ways to learn what R2 already
   has.)

3. **A deploy mid-ALARM** (the DO's own code is mid-upgrade when an alarm
   fires) is a narrower, pre-existing Durable Objects concern, not new to
   this design: Cloudflare alarms are at-least-once and survive a DO's own
   eviction/restart by design (that is the entire point of using one here
   instead of an in-memory timer). The write-once R2 contract
   (`etagDoesNotMatch: "*"`) already makes a duplicate/retried alarm tick
   safe — the worst case is one wasted alarm invocation that tries to write
   a record that is already there and gets a conflict, which this design
   treats as "someone else already finished this attempt," not an error.

### Cost

Two separate billing surfaces change in OPPOSITE directions in magnitude,
and this doc states the honest, unverified-until-measured version of both
rather than asserting a specific dollar number:

- **Durable Object duration (likely cheaper).** Today, `GateRunnerDO`'s
  `/run-leg` fetch handler is a SINGLE open request for the leg's entire
  wall time (up to `legStepDeadlineMs`, ~28 min worst case) — Durable
  Objects bill wall-clock duration while a request is open, including time
  spent in an `await sleep(POLL_MS)` poll loop (`run-leg.ts:265-288`), not
  just active CPU. The new design replaces that one long-open request with
  many SHORT alarm invocations (one `/run` or `/result` fetch each, plus
  bookkeeping), each closing as soon as its one tick of work is done — the
  DO object itself is not "open" between ticks. This should meaningfully
  cut DO duration-billing per leg, though the actual multiplier depends on
  Cloudflare's current DO pricing model for alarms specifically (not
  re-verified here) and is worth confirming with real billing data once this
  ships, not assumed.
- **Workflows step count and engine time (roughly neutral-to-cheaper).**
  Today: 1-2 steps per leg (`start-<leg>`, maybe `retry-<leg>`), each one
  `step.do` call, billed as Workflows normally bills a step. New: more steps
  per leg (a short `dispatch-<leg>-try<N>` per attempt, plus however many
  `step.waitForEvent`/`step.sleep`+R2-check cycles the fallback loop needs
  before the event arrives) — MORE steps, but each one is cheap and brief,
  and `step.waitForEvent` is specifically a HIBERNATING wait: Cloudflare's
  own stated design for Workflows event-waiting is that a suspended instance
  is not actively billed while waiting for an event, the same way `step.sleep`
  does not bill the sleep duration itself. The expected net effect is
  roughly neutral on Workflows' own billing surface, slightly MORE steps
  offset by each one doing much less (and never risking the #1393 failure
  mode's wasted whole-run reruns, which is itself a real cost item today —
  #1393's one incident alone re-ran every leg of a run three times over for
  nothing).
- **Net:** this design is motivated by correctness (#1393), not cost, but
  the honest expectation is it is cost-neutral-to-favorable, not a
  regression, PLUS it removes a real, measured source of wasted whole-run
  reruns. Confirm with real post-ship billing data before citing a number
  anywhere operator-facing.

## New request/response contract

```ts
// GateLegRequest (leg-env.ts) gains two fields, both required once this
// ships -- the DO's alarm needs them to report back, and they were
// previously implicit in which Workflow instance happened to be holding
// the open fetch call:
interface GateLegRequest {
  // ...every existing field, unchanged...
  /** #1396: the GATE_WORKFLOW instance to sendEvent back to on completion. */
  instanceId: string;
  /** #1396: this attempt's own id -- echoed back in the sendEvent payload's
   *  `type`/correlation so the right waitForEvent (and no other leg's, no
   *  other attempt's) resolves. The same id already minted in leg-run.ts's
   *  attempt() closure (`crypto.randomUUID()`) and used for gateRunnerName --
   *  reused here, never a second id. */
  attemptId: string;
}

// /run-leg's response is no longer the leg's own LegResult/infra body --
// it is a thin accept/reject:
//   202 {} -- container start scheduled, poll via waitForEvent/R2 from here
//   4xx/5xx -- a SYNCHRONOUS accept failure (bad request, no container
//              binding, image not bound) -- these are rare, fast, and
//              Workflows' own step-retry on throw is still the right tool
//              for them, unchanged from today.
```

## Testing (bun-testable, pure logic kept out of `do.ts`/`workflow.ts`)

Following this repo's own established split (`run-leg.ts`/`leg-run.ts` hold
the pure logic; `do.ts`/`workflow.ts` are the thinnest possible glue that
imports `cloudflare:workers`, so bun test can load and pin everything that
actually decides something):

1. **Alarm-tick decision function**, extracted so `do.ts`'s real `alarm()`
   is just "load state, call this, persist/re-arm/terminal per its answer":
   `nextAlarmStep(state, now, pollResult): {kind: "re-arm", at: number, state: RunLegAlarmState} | {kind: "terminal", outcome: LegOutcome}`
   — every branch in the table above (ready-wait, port-retry, poll, deadline,
   container-stopped) becomes a pure case bun test can hit directly, the
   same way `runOnServer`'s branches are exercised indirectly today via
   `run-leg.test.ts`'s fake container/clock.
2. **Explicit try-loop**, replacing the `ctx.attempt`-keyed loop in
   `runLegStep`: still pure, still takes a fake `step`/`dispatch`/clock, same
   test shape `gate-leg-run.test.ts` already uses — rewrite (not just
   extend) the `"no waitForEvent"` test (`:123-128`) into its positive form:
   *"a retryable infra outcome re-dispatches a fresh attemptId, up to
   totalLegWallMs."*
3. **Attempt-outcome record (de)serialization**: round-trip + malformed-body
   fail-closed tests, the same shape `legResultReader`/`storedLegResult`
   already get today.
4. **Fallback cadence**: the `step.sleep(60s)` + R2-check loop's own
   iteration count/timeout math, pure, independent of real Workflows timing.
5. **touch() call-count**: one call per NEW `tryNo` in the explicit loop,
   zero calls on a replayed/cached step — the direct descendant of #1387's
   existing `touch`-gating test.
6. Every existing `infra-rerun.ts`/`verdict.ts`/`fanout.ts` test stays
   green unchanged: none of those modules' own inputs or contracts move.

## Open questions for operator review

Stated honestly, not asserted as already resolved — these need a real check
against this repo's pinned `@cloudflare/workers-types` / live Workflows
behavior before (or during) the implementation PR, not assumed true here:

1. Exact `step.waitForEvent`/`instance.sendEvent` type signatures and
   payload size limit, for this repo's pinned Workflows API version.
2. Whether an event sent before the matching `waitForEvent` is registered is
   dropped, queued, or delivered to a replay — this doc assumes "may be
   dropped" (the conservative, fail-safe assumption) and designs the R2
   fallback to not depend on the answer either way, but confirming the real
   answer would let the fallback's poll interval be tuned instead of
   guessed.
3. Whether a Workflow instance parked in `waitForEvent` reads as "live" (not
   stalled) to whatever surfaces `GateRunInstance.status()` today, for the
   watchdog's own purposes — flagged under "Watchdog touch," above.
4. Real Durable Objects alarm billing, to replace the "likely cheaper, not
   yet measured" cost language above with a number, post-ship.

## Rollout

A fleet-wide flag in the same shape `GATE_BUNDLE`/`bundleStepEnabled`
already use (`leg-run.ts:518-520`) — gate this behind an explicit env flag
plus per-repo opt-in, so the first repo to carry it is a deliberate choice,
not every gated repo at once, and the OLD synchronous `/run-leg` path stays
live (same `do.ts`, branched on the flag) until the new path has run clean
on real traffic. This is a one-way-door-adjacent change (it touches the one
file that bridges every gate run, `workflow.ts`) and should be reviewed with
that weight, same as #1390 was labeled.
