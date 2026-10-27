# Async /run-leg: DO-alarm polling so no gate invocation holds a >20-min await

Issue: https://github.com/rafarc21/fleetflare/issues/1396. Refs
https://github.com/rafarc21/fleetflare/issues/1393,
https://github.com/rafarc21/fleetflare/issues/1390,
https://github.com/rafarc21/fleetflare/issues/715. Date 2026-10-26.
Status: proposal, design only. No code in this PR (the task's own Boundaries:
`docs/superpowers/specs` now, `apps/fleet/src/gate/*` later, as its own
implementation task(s)).

**Revised after design review r1 on PR
https://github.com/rafarc21/fleetflare/pull/1397.** The architecture (DO
alarm polling the container, independent of any one Workflow invocation) was
approved as right. **Decision: the Workflow side uses POLLING
(`step.sleep` + a short `step.do` R2 read), never
`step.waitForEvent`/`sendEvent`.** R2 is the single source of truth either
way, so the event layer added a second, race-prone path to the same fact
without buying anything a plain poll doesn't already give for free — dropped
entirely, along with the `instanceId`/`attemptId`-in-the-request plumbing
that only existed to address an event back to the right instance. r1 also
fixed one latent replay bug this redesign would otherwise have made much
worse (today's `legStarted = Date.now()` sits outside any `step.do`), had
this doc reuse the EXISTING result-key scheme instead of inventing a
parallel one, and added five sections it found missing entirely: container
lifetime across alarm gaps, secrets across alarm ticks, a write-once race
between the DO and the Workflow's own give-up path, checking for a
superseded run, and a concrete migration/cost budget with real numbers
instead of "likely cheaper."

**Revised again after design review r2 on PR
https://github.com/rafarc21/fleetflare/pull/1397 — final pass, no round 3.**
8 of r1's 10 items were right; r2 found 3 blockers in how they were
expressed and moved 5 smaller gaps into a new "Leftovers for the
implementation plan" section rather than blocking on them:

1. **The Workflow's NORMAL poll read must use the raw, unprefixed,
   summary-preserving reader** (`legResultReader`), never the
   transport-loss-recovery wrapper (`storedLegResult`, which drops `summary`
   and unconditionally marks every read as "recovered," wrongly triggering
   the SIGTERM/SIGKILL signal-kill reclassification on a container's own
   genuine report and turning a real red into an unwanted whole-run
   auto-rerun). r1's "Reusing the existing result-key scheme" section
   conflated the two readers; this revision separates them precisely —
   see that section, rewritten below.
2. **Every individual try needs its own unique result key, including a
   retry-step's OWN internal infra-retries** — r1 fixed this for the
   `start-<leg>` step (`infraRetryResultKey`, already correct today) but
   left the `retry-<leg>` step's internal tries sharing one `.retry.json`
   key, exactly the collision #1393 already measures (a stale try's write
   blocking a later try's real result). Fixed below, along with the R2
   key-regex update this actually requires (r1 incorrectly called
   `finalLegKey`/`evidenceKeyFor`/the result-key regex "untouched").
3. **No `Date.now()`/elapsed-time read in the Workflow function's own body
   between steps** — r1 stated the governing invariant correctly but then
   broke it in its OWN pseudocode (`now() - dispatch.startedAt`,
   `elapsedMs()`, both outside any `step.do`). Fixed below: every deadline
   decision is now made INSIDE the poll step itself, which already has a
   safe, in-callback `Date.now()` to work with.

The "Leftovers" section (new, near the end) explicitly carries the 5
smaller gaps r2 named but did not block on — the real step-count cost once
every try gets a unique key, `touch()`'s exact call site, a precise
"superseded" status check, the `@head`+`-tryN` key-regex interaction, and
having the DO write a live `/result` 200 straight to R2 itself rather than
depending on the container's own separate write landing in time — each
named for the implementation PR to resolve, not asserted as already solved
here.

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
- Not a cost-driven rewrite. The cost section below gives real step-count
  arithmetic, but this task exists for *correctness* (#1393's data loss), not
  a cost target.
- Not `step.waitForEvent`/`instance.sendEvent` — review r1's explicit
  decision. No event type, no `instanceId` threaded through the request body,
  no "event vs replay" race to reason about at all: R2 is the only channel.

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
not just extended, by the implementation PR (and its own wording will need
updating again, since the replacement is polling, not `waitForEvent` either).

## The governing invariant

Stated once, up front, because every section below is an application of it:

> **No step callback is long, and every step is idempotent.** A `step.do`
> callback does one quick unit of work and returns — never an open-ended
> wait. Any wall-clock value used for later deadline math (an attempt's own
> start time, in particular) is MINTED INSIDE a `step.do` callback and
> RETURNED as part of that step's result, never computed by a bare
> `Date.now()` in the Workflow function's own body between steps. Reading an
> already-resolved step's return value later is always safe (Workflows
> replay restores it verbatim); calling `Date.now()` a second time outside
> any step is not — a replay re-runs the surrounding function body but
> restores each step's CACHED result, so a `Date.now()` sitting between steps
> gets a fresh, different value on every replay.

This is CRIT, not stylistic: **today's code already has this bug**,
narrowly. `leg-run.ts:192`'s `const legStarted = Date.now();` sits in
`runLegStep`'s own body, OUTSIDE the `attempt()` closure's `step.do` calls —
a mid-run deploy that replays `runLegStep` recomputes `legStarted` fresh,
silently corrupting `totalDeadlineMs` math (`elapsed = Date.now() -
legStarted`, `leg-run.ts:229`) on that one replay. It has not caused a known
incident, likely because today's design has only 1-2 steps per leg and a
short window between `legStarted`'s assignment and its first use. This
design's whole point is MANY steps spanning one leg's full wall time — the
same bug, left as-is, would corrupt deadline math far more often. **The
implementation PR must fix both**: the new poll-loop steps per this design,
AND `legStarted`'s existing placement (move it inside the first `step.do` of
each `attempt()` call, return it, thread it through).

## New architecture (polling, per review r1's decision)

```
Workflow (GateWorkflow.run), one try:
  dispatch = await step.do(`dispatch-${leg}-try${tryNo}`, async () => {
    // mints attemptId + startedAt HERE, inside the step -- the governing
    // invariant, above. Starts the container; does NOT wait for it to be
    // ready (#1396 review r1 item 10 -- waitUntilRunning moves into the
    // DO's own alarm, not this step). resultKey is THIS try's own unique
    // key (review r2 item 2 -- see "Reusing the existing result-key scheme"
    // for exactly how it's derived for both the start AND retry steps).
    const res = await stub.fetch("/run-leg", { body: {...} });
    return parseDispatchReply(res, attemptId, startedAt, resultKey); // below
  });
  if (dispatch.kind === "terminal") return dispatch.result;  // DID-NOT-RUN,
                                                               // PAT-only
                                                               // refusal: no
                                                               // container
                                                               // ever ran
  // dispatch.kind === "accepted": poll loop, R2 only. Review r2 item 3:
  // NO now()/elapsedMs() read lives in this surrounding loop -- the poll
  // step itself reads the clock (safe: it's INSIDE a step.do) and returns
  // its own verdict, including whether ITS OWN read put this attempt past
  // its deadline. The loop only ever reads an already-resolved step result.
  for (let i = 1; ; i++) {
    await step.sleep("60 seconds");                           // free: does
                                                                // not count
                                                                // toward the
                                                                // step budget
    const tick = await step.do(`poll-${leg}-try${tryNo}-${i}`, async () => {
      const found = await readResultKey(dispatch.resultKey);   // raw read,
                                                                 // see below
      if (found !== undefined) return { kind: "found", result: found };
      const pastDeadline = Date.now() - dispatch.startedAt >= attemptDeadlineMs;
      return pastDeadline ? { kind: "deadline" } : { kind: "not-yet" };
    });
    if (tick.kind === "found") return tick.result;              // real result
                                                                 // OR a DO-
                                                                 // written
                                                                 // infra
                                                                 // outcome
    if (tick.kind === "deadline") {
      return await claimGiveUp(dispatch.resultKey, causes);     // write-once
                                                                 // race, see
                                                                 // "Deadline"
    }
    // "not-yet": loop, sleep again. A replay of this exact step returns its
    // cached "not-yet"/"found"/"deadline" verdict -- never re-reads R2 or
    // re-checks the clock for a tick that already resolved.
  }

GateRunnerDO.fetch("/run-leg")
  resolve git token + secrets (as today) -- a resolution FAILURE here is
  itself a terminal LegResult (DID-NOT-RUN / PAT-only refusal): answer 200
  with that body directly, NEVER start a container, NEVER schedule an alarm.
  Otherwise: c.start() (does not await "running"), persist state +
  secretValues to ctx.storage, ctx.container.setInactivityTimeout(...)
  (review r1 item 3 -- see "Container lifetime," below), schedule the first
  alarm, answer 202 immediately.

GateRunnerDO.alarm()                               <- wakes on its own,
  try { one poll tick (same classification runOnServer      independent of
    does today: ready-wait, port-retry, /result             any Workflow
    poll, container-exited check, leg deadline)              invocation
    not done yet -> re-arm alarm (15-30s), return
    done -> write the outcome to the SAME resultKey a         <- reuses the
            container would have used (write-once);               EXISTING
            destroy the container                                 key scheme
  } catch (err) { re-arm anyway -- never let an uncaught       <- #3 below:
    exception leave the alarm un-rearmed }                        alarms go
                                                                    dormant
                                                                    after 6
                                                                    failures
```

The container/gate-server protocol (`/run`, `/result`) is unchanged — the
DO still polls it exactly the way `runOnServer` does today. What moves is
WHO is awake while that polling happens: today it's the Workflow invocation,
blocked on one `fetch`; after this change it's the DO, waking briefly on its
own alarm, with the Workflow invocation itself only waking every 60s to take
one cheap R2 read.

## Reusing the existing result-key scheme (not a new "outcome record")

An earlier draft of this design (PR #1397, pre-review) invented a brand-new
R2 key per attempt (`outcome-<leg>-<attemptId>.json`) to hold a
discriminated `{kind: "result" | "infra", ...}` envelope. **Dropped per
review r1 item 6**, and r2 corrected two things r1 got wrong about HOW the
existing scheme is reused: which reader the Workflow's NORMAL read uses
(item 1), and that every individual try — not just `start-<leg>`'s own
internal infra-retries — needs its own unique key (item 2).

### The normal read: `legResultReader`, never `storedLegResult` (review r2 item 1)

`storedLegResult` (`leg-run.ts:371-386`) is NOT a general-purpose R2 reader —
it is a specific TRANSPORT-LOSS-RECOVERY wrapper: it unconditionally prefixes
every description with `R2_PREFIX` ("result read from R2 after transport
loss: ") and DROPS `summary` entirely, because its one existing call site
(`leg-run.ts`'s `catch` block, today) only ever runs when the Workflow's OWN
call to the DO has already failed — "this is a recovery, not the normal
answer" is true by construction there. Wrapping EVERY poll read in this same
function, as r1's draft did, would make it true of literally every leg,
including the overwhelming common case where the container finished cleanly
and the Workflow's poll step is just the FIRST and only place anything reads
R2 at all:

- `summary` would be silently dropped from every successful leg's own
  result — a real regression, not a recovery-path compromise.
- Every description would read as "recovered after a transport loss" even
  when nothing was ever lost — misleading in a live incident.
- Worse, correctness: `isSignalKill` + the `R2_PREFIX` check
  (`leg-run.ts:271-279`, today) would fire on a container's OWN deliberate,
  live self-report of `"exited 143/137"` (e.g. a `timeout -s KILL`-wrapped
  leg command hitting its own timeout, a real, deterministic red) and
  reclassify it as infra — exactly the bug review r2 named: *"a real OOM /
  'exited 137/143' into infra → whole-run auto-rerun on real red."*

**Fix:** the Workflow's poll step reads with the RAW reader,
`legResultReader` (`leg-run.ts:357-366`), widened (type-only — the runtime
JSON already carries it) to expose `summary`. A value found this way is a
CONTAINER-authored record (the container is the only party that ever
computes a `summary`, or decides `state`, by actually running the leg's own
command) and is trusted exactly as-is — no prefix, no reclassification, the
same "a live response is the real answer" rule #1321 already applies to a
LIVE gate-server response, generalized here to "any record the container
itself wrote is as good as a live response," because in this design the
container's own R2 write IS the only channel left; there is no longer a
separate "live" channel for the Workflow to prefer over it.

`storedLegResult`'s OWN prefix+signal-kill logic still exists, SCOPED
NARROWLY: only the DO's own synthesized "I could not reach this container at
all" conclusion (below) ever carries that marking — and since the DO's own
fixed infra-description strings (`"gate container did not start within 180
s"`, `"gate container exited mid-leg"`, etc.) never contain `"exited
143/137"`, `isSignalKill` never actually fires on a DO-authored record in
practice. The rule is kept for audit-trail consistency with today's
wording, not because it changes an outcome — see "Leftovers," below, for the
narrower case (the DO's own container-transport-loss recovery INSIDE
`alarm()`, `run-leg.ts`'s existing `storedLegResult` call sites) this
doc resolves via the write-once race, next.

### Who writes what, and the write-once race between a container's own report and the DO's own guess

- **A real result** (success/failure/a container-side error, INCLUDING the
  container's own live-observed `"exited 143/137"`) is written by the
  container itself, to this try's own key (below) — completely unchanged
  from today.
- **An infra outcome** the DO itself concludes — no container ever started
  (image not bound, no instance available), the container never answered
  past its own retry budgets, or this try hit its own leg-timeout deadline
  with nothing ever written — has no container around to report it. Today
  this only ever exists as the 503 body of the one synchronous call;
  nothing persists it. This design's one real addition: `alarm()`, upon
  concluding infra, ATTEMPTS a write-once PUT of
  `{state: "error", description: "<R2_PREFIX><cause>"}` to this try's key
  (`onlyIf: { etagDoesNotMatch: "*" }`, the SAME contract
  `outbound-handler.ts` already applies to every result write) — **before**
  assuming its own conclusion is correct.
  - If the write SUCCEEDS: nothing else exists at this key — the DO's own
    infra conclusion stands.
  - If the write CONFLICTS: the container's OWN record landed there first
    (it finished and reported, even if the DO's own `/result` poll happened
    to lose contact around the same time, e.g. a transient network blip
    between the DO and the container rather than an actual platform kill).
    `alarm()` reads the key back and treats THAT as the answer — a genuine
    container self-report always outranks the DO's own uncertain guess.

This is the write-once RACE pattern (review r1 item 5, review r2 extends it
to this second, narrower race) doing double duty: it is what makes "the DO
isn't sure, but will guess infra unless proven otherwise" both SAFE (never
clobbers a real container report, by construction — write-once literally
cannot) and CORRECT (prefers the container's own definitive answer whenever
it exists) without needing the DO to somehow "know" whether its own
transport hiccup really was a platform-level kill — it just doesn't matter
which one happened; whichever party had something concrete to report wins.

### One unique key per try, including the retry step's own internal retries (review r2 item 2)

Today, `leg-run.ts`'s `attempt()` closure already gives the `start-<leg>`
step's OWN internal infra-retries unique keys
(`targetFor = (tryNo) => tryNo === 1 ? planned : {...planned, resultKey:
infraRetryResultKey(planned.resultKey, tryNo)}`) — but the `retry-<leg>`
step's `targetFor` ignores `tryNo` entirely (`() => retryTarget`, always the
SAME `.retry.json` key). In the OLD synchronous design this was never a real
collision: each try's container lifecycle was fully sequential and
synchronous, so only one try was ever "live" at a time. In THIS design, an
earlier try's DO can still be independently polling (and could still
conclude and write) WHILE a later try has already started on a fresh
container — #1393's own measured failure is exactly this shape (three
independent attempts, overlapping in real time). Without a unique key per
try, try 2's real result (a genuine success!) could find `.retry.json`
ALREADY claimed by try 1's stale infra write, and be silently discarded —
the exact bug class this whole redesign exists to eliminate, reintroduced
by a key collision instead of an invocation kill.

**Fix:** apply `infraRetryResultKey` to the retry step's own tries too, the
same way the start step already does:

```ts
const retryTargetFor = (tryNo: number): PlannedLeg => {
  const base = { ...planned, resultKey: retryResultKey(planned.resultKey) };
  return tryNo === 1 ? base : { ...base, resultKey: infraRetryResultKey(base.resultKey, tryNo) };
};
```

— producing, for example, `shard-vitest-8.retry.json` (try 1, unchanged) and
`shard-vitest-8.retry-try2.json` (try 2, new). **This requires updating the
result-key regex, not leaving it "untouched"** (r1's draft incorrectly
claimed `finalLegKey`/`evidenceKeyFor`/the key regex needed no change):
`outbound-handler.ts`'s `RUN_RESULT_RE` today is
`` shard-[a-z0-9-]+(@head)?(\.retry)?\.json$ `` — the optional `(\.retry)?`
group must be immediately followed by `\.json$`, so it does NOT currently
accept a `-tryN` suffix AFTER `.retry` at all. The regex needs a
`(-try\d+)?` group added after `(\.retry)?`, e.g.
`` shard-[a-z0-9-]+(@head)?(\.retry)?(-try\d+)?\.json$ ``, so the container
is actually AUTHORIZED to PUT to its own try's key once this scheme is in
place. Two more call sites read this same key shape and MUST change too —
named precisely here, not deferred:

- **`log.ts`'s `tryRank`/`finalLegKey` (review r3).** `TRY_SUFFIX` today is
  `` /(?:-try(\d+)\.json|\.retry\.json)$/ `` — two alternatives, `-tryN.json`
  (ranked `N + 1`) or bare `.retry.json` (ranked `10_000`, "above every
  `-tryN`" because today `.retry` is always the LAST write). A key shaped
  `shard-vitest-8.retry-try2.json` matches the FIRST alternative (its tail is
  still literally `-try2.json`), ranking it `3` — LOWER than the plain
  `shard-vitest-8.retry.json`'s rank of `10_000`. `finalLegKey` keeps the
  HIGHER-ranked key, so it would pick the STALE try-1 `.retry` record over
  try 2's own, later, correct result — exactly backwards, and exactly the
  kind of silent wrong-answer `fleet gate log`'s own header comment warns
  against ("reading a stale SIGTERM try... misleads"). **Fix:** `TRY_SUFFIX`
  needs a THIRD alternative, `` \.retry-try(\d+)\.json$ ``, checked before the
  plain `-tryN.json` alternative (so it does not fall through to the wrong
  branch), ranked `10_000 + N` — strictly above the bare `.retry` (try 1) and
  strictly ordered among themselves by `N`, matching the real write order
  (try 2 happens after try 1, same as `-tryN` already orders against the
  bare first attempt).
- **`evidenceKeyFor` (`leg-env.ts:115-119`) and its outbound-handler
  counterpart `EVIDENCE_RE` (review r3).** Both today expect
  `(?:-try\d+)?(?:\.retry)?` — try-suffix BEFORE retry — the opposite order
  from the key this design actually produces (`.retry` then `-tryN`, since
  the try number belongs to the RETRY step's own internal attempts). For a
  browser leg, `evidenceKeyFor` returning `null` on `shard-vitest-8.retry-
  try2.json` means `GATE_EVIDENCE_DIR` is never set for that container at
  all — its spec evidence has nowhere authorized to land, and
  `browser-leg.ts`'s own evidence-based verdict contract (#1343) would then
  mark a perfectly fine run as DID-NOT-RUN for missing evidence. **Fix:**
  reorder both regexes to `(?:\.retry)?(?:-try\d+)?` — `evidenceKeyFor`'s own
  pattern AND `outbound-handler.ts`'s `EVIDENCE_RE` (`:56`), which authorizes
  the container's actual PUT under the exact directory `evidenceKeyFor`
  computed — fixing one without the other would leave the DO naming a
  directory the container is still refused from writing to.

The one interaction this doc does NOT fully resolve — `@head` union legs
combined with a retry-step's own `-tryN` (e.g. `shard-vitest-8@head.retry-
try2.json`) — is named precisely under "Leftovers," below, as its own item;
every NON-`@head` case above is fully specified here, not deferred.

## Coverage, point by point (per the task's own list, plus review r1's additions)

### Retries

Today, `leg-run.ts`'s `attempt()` closure is called twice per leg
(`start-<leg>`, then `retry-<leg>` when the first is retryable —
`isRetryable`: a red test, `"install failed"`, or `"clone failed:"`), and
EACH of those steps additionally gets Workflows' own automatic step-retry
(`LEG_STEP_CONFIG.retries`, `limit: 2`, used via `ctx.attempt` /
`tryNo` for the infra-retry-within-a-step loop, #1231/#1321). That automatic
step-retry depended on `dispatch` REJECTING (throwing) inside the step
callback — Workflows retries a step whose callback throws. In the new
design, `dispatch` (the short `step.do("dispatch-<leg>-try<n>", …)`) only
throws for a synchronous protocol-level failure (malformed request, no
container binding — fast, rare, and exactly the shape `step.do`'s own
automatic retry is built for), never for anything that happens AFTER the
container has started. Everything that happens after start — container
never came up, server unreachable, container exited mid-leg — is now a
terminal outcome the alarm loop classifies and WRITES TO THE RESULT KEY
(above), discovered by the Workflow's own poll loop, not a thrown step
error.

So the "try again on infra" loop that `ctx.attempt`/`tryNo` drove today
becomes EXPLICIT application code around the dispatch+poll pair, rather than
implicit Workflows step-retry:

```ts
let legStartedAt: number | undefined;  // set from the FIRST dispatch step's own return value, never Date.now() here
for (let tryNo = 1; tryNo <= MAX_TRIES; tryNo++) {
  const dispatch = await step.do(`dispatch-${leg}-try${tryNo}`, () => dispatchRunLeg(..., targetFor(tryNo)));
  legStartedAt ??= dispatch.startedAt;  // review r2 item 3: read from a resolved step, never computed here
  if (dispatch.kind === "terminal") return dispatch.result;       // DID-NOT-RUN etc, no container ran
  const outcome = await pollUntilDone(step, dispatch, attemptDeadlineMs); // the step.sleep+step.do loop above;
                                                                           // every clock read happens INSIDE
                                                                           // its own poll step, never here
  if (outcome.state !== "error" || !isInfraDescription(outcome.description)) return outcome; // real body
  // The total-deadline check is itself a step.do: it reads dispatch.startedAt (a resolved
  // value) and its OWN Date.now() inside the callback, never a bare elapsedMs() in this loop.
  const budget = await step.do(`budget-${leg}-try${tryNo}`, async () =>
    Date.now() - legStartedAt >= totalDeadlineMs);
  if (budget) return finalInfraError(causes);                     // #1390's own total cap
  causes.push(outcome.description);                                  // infra: loop, same as today's catch
}
```

This is a faithful, deliberate re-expression of the SAME state machine
`runLegStep` already encodes (`start-<leg>` → maybe `retry-<leg>`, each with
its own up-to-3-try infra loop, `totalLegWallMs` capping the whole thing) —
just with the try-loop made explicit in `leg-run.ts`'s own code instead of
split between there and Workflows' automatic step-retry semantics, with
`pollUntilDone` itself built from the `step.sleep`+`step.do` loop shown in
"New architecture," above, with every try (including the retry step's own
internal tries) getting its own unique key via `targetFor` (review r2 item
2, "Reusing the existing result-key scheme"), and with every deadline
decision made INSIDE a `step.do` callback, never a bare clock read in this
surrounding loop (review r2 item 3). The public shape of `runLegStep` (one
`LegRunResult` out, the same `redFirst`/flaky-retry/combined-causes
behavior) does not need to change; its INTERNALS do.

### Infra classification

Unchanged taxonomy (`infra-rerun.ts`'s `INFRA_CAUSE`, `isNoInstance`,
`NO_INSTANCE_DESCRIPTION`) — every string this design's alarm loop can
produce is one the classifier already recognizes, because the classification
logic itself does not move, and because infra outcomes now land in the
EXACT SAME `{state, description}` shape a real `LegResult` already uses
(above) — `isRetryable`/`isInfraLegFailure` need no new branches. What
changes is WHO decides infra-vs-result (the DO's alarm loop, same branches
`runOnServer` has today) and WHEN the Workflow side learns about it (its own
next 60s poll tick, reading the result key, never a thrown exception it
catches synchronously). One genuinely new infra cause: the Workflow's own
give-up path (its poll loop's `attemptDeadlineMs` elapsing with nothing in
R2 yet — see "Deadline," below) — narrowly scoped, distinct wording from
every existing cause so it stays separately greppable in a live incident.

**The #1393 failure mode specifically stops recurring at its root**, not by
a special case: there is no longer any single invocation holding a 20-35 min
open await, so Workflows has nothing in that shape left to kill. The
`"internal workflows error"` string stays in `INFRA_CAUSE` for whatever
OTHER cause might still produce it (a step genuinely timing out at its own
30-min `LegStepConfig.timeout`, a platform-level Workflows outage) — this
design does not remove that line, it removes the ONE call shape that made it
fire on healthy, already-green work.

### Deadline (#1390) and the write-once race

#1390's own rule — *a leg past its own deadline is a final red verdict,
never infra-retried, and the retry's own infra loop must still halt at
`totalLegWallMs`* — is preserved exactly, just relocated and now reached
from TWO independent places that must not conflict:

1. **The DO's own alarm loop** checks the SAME per-attempt deadline
   (`now() - legStarted >= minutes * 60_000`, moved into the alarm's
   polling phase, each tick) and, on expiry, writes the SAME red body
   (`"<leg> exceeded <n> min without a result"`, #1390's own wording) to the
   result key — exactly the branch `runOnServer` has today, just ticked
   instead of held open.
2. **The Workflow's own poll loop** ALSO has a deadline
   (`attemptDeadlineMs`, the same cap `leg-run.ts`'s try-loop already
   computes) — in case the DO itself never got to run its own check at all
   (a true platform fault: the alarm never fired, review r1 item 3's "alarms
   go dormant after 6 failed retries" being the sharpest version of this).
   When the Workflow's OWN deadline elapses with nothing found in R2 yet, it
   does not just synthesize an in-memory infra result and move on — **it
   also attempts to WRITE that outcome to the same result key**, with the
   same write-once contract (`onlyIf: { etagDoesNotMatch: "*" }`).

These two writers can race: the DO might finish and write a REAL result
(or its own deadline-infra write) in the same window the Workflow's poll
loop independently times out and tries to write its own give-up record.
Write-once makes this safe without coordination: **whichever write lands
first wins; the loser's PUT fails with a conflict, and the loser simply
reads the key back and uses THAT value** — never its own synthesized one,
and never a second, possibly-different value overwriting the first. This is
the same pattern `auto-run.ts`'s `GateRunIndex.handOff` already uses for a
different race ("one conditional write... False when a newer run holds
it") — conditional writes with a read-back on conflict, not a lock.

### Watchdog touch (#1387)

Today, `touch()` (stamps `GATE_STALL_MS` progress, `auto-run.ts`) fires once
per step's FIRST `ctx.attempt` — i.e., once per genuinely NEW container,
never on a Workflows-internal step retry of the same attempt. In the
explicit try-loop above, there is no implicit step-retry counter to key off
of anymore: `touch()` is called once per NEW `tryNo`, i.e. once per actual
`dispatch-<leg>-try<N>` step that starts a genuinely fresh container — the
same semantics, expressed directly instead of inferred from `ctx.attempt`.

**Review r1 item 8, additional:** this design's poll loop gives MANY more
natural checkpoints than today's single long-held call ever did — every 60s
`poll-<leg>-try<n>-<i>` step is a point where the Workflow is demonstrably
still making forward progress on this leg. `touch()` should ALSO fire on
each poll-step completion (or at minimum a bounded number of poll steps
apart), not only at attempt-start, so the interval between progress stamps
stays comfortably under `GATE_STALL_MS` (37 min, `auto-run.ts:58`) by
construction, rather than by coincidence of the leg's own timeout staying
under it. This tightens the external watchdog's real detection latency for
a GENUINELY stuck run (no DO, no alarm, no Workflow activity at all) at
zero extra cost — `touch()` already never throws and is cheap. It must be
called FROM INSIDE the poll step's own `step.do` callback (the same
governing invariant as every other side effect in this design), never from
the surrounding loop — a call outside a step would re-fire on every replay.
The exact cadence (every poll tick vs. every Nth) is named, not pinned,
here — see "Leftovers," below.

### Carry/union legs

Both are plan-time decisions, strictly upstream of this design's scope:

- **Carry** (`carriedGreenByLeg`, #1230): a leg whose result is reused from a
  prior run is never dispatched at all — no DO, no container, no
  dispatch/poll pair. Unaffected by this design by construction.
- **Union / `@head`** (`planUnionLegs`, #1091; `head: true` opt-in grants,
  #1376): a leg added under a `<leg>@head` name for a PR that edits
  `fleet.json` is a NEW PLANNED LEG with its own name — it goes through
  `runLeg`/`runLegStep` exactly like any other leg, under its own name, so
  it goes through the new dispatch+poll protocol unchanged. Nothing about
  union planning or head-leg secret grants (`secrets-scope.ts`'s
  `headLegBaseName`) reads or depends on HOW a leg's own run is awaited.

### In-flight replay at deploy

Two replay hazards, both already present in today's Workflows model in
weaker form:

1. **A mid-run deploy replays `step.do` history.** Not new — `step.do`'s
   whole contract is "replay returns the cached result, never re-runs the
   callback" (already relied on throughout `leg-run.ts`, e.g. "Made inside
   the callback: a Workflows step retry re-runs it, so every try gets its
   own runner DO. A replayed step returns its recorded result,"
   `leg-run.ts:218-219`). The new `dispatch-<leg>-try<N>` and
   `poll-<leg>-try<N>-<i>` steps are no different: a replay returns the
   cached accept-result or the cached "not found yet"/"found" answer, never
   re-dispatches a second container or re-reads R2 a second time for a
   step that already resolved.
2. **The governing invariant's own enforcement is what makes replay safe
   here**, not an event-delivery guarantee (review r1's whole reason for
   dropping `waitForEvent`): every value the poll loop's deadline math needs
   (`startedAt`, `attemptId`) is minted inside `dispatch-<leg>-try<N>` and
   returned, so a replay of the SURROUNDING function recomputes nothing —
   it reads the same cached values every time, from every step, in order.
   The ONLY thing read "live" on every poll tick is the R2 GET itself
   (necessarily so: that is the one piece of real information this loop is
   waiting to learn), and a GET is naturally idempotent — reading R2 twice,
   including once before and once after a mid-run deploy, is simply "read
   the same key twice," never a correctness hazard the way a duplicated
   SIDE EFFECT would be.

No `sendEvent`/`waitForEvent` race survives into this design at all —
review r1's decision removes the ENTIRE class of hazard the original draft
spent a whole section reasoning about (an event sent before a replayed
instance re-reaches its matching wait). R2 was always the real source of
truth; polling makes that the ONLY mechanism instead of a fallback for one.

### Container lifetime across alarm gaps (review r1 item 3, new)

A Durable Object's own `ctx.container` stops the container when the DO
itself goes idle, UNLESS `setInactivityTimeout()` is called to keep it alive
across gaps with no open request — which is exactly the shape this design
introduces (the DO is deliberately idle between alarm ticks; that idleness
is the whole cost win in "Cost," below). Without an explicit inactivity
timeout, the platform could stop the leg's own container between two alarm
ticks, which would read as "container exited mid-leg" (already a handled
branch, `run-leg.ts:269-271`) but for a reason that has nothing to do with
the leg itself — a false infra failure on perfectly healthy, still-running
work. **Fix:** the DO sets `ctx.container.setInactivityTimeout(...)`, sized
to comfortably exceed the alarm tick interval (below), when it starts the
container — so the platform's own idle-container policy never fires between
two ticks that are each only 15-30s apart.

A second, related hazard: **`alarm()` must never let an uncaught exception
escape without re-arming.** Cloudflare retries a failed alarm invocation on
its own backoff, but an alarm that keeps throwing goes DORMANT after 6
failed retries and never fires again — silently abandoning the leg (and its
billed, still-running container) with nothing left to notice. `alarm()`'s
entire body must be wrapped so that ANY exception (a transient R2 write
conflict that isn't the expected write-once case, an unexpected container
API error) still results in either a terminal write (if the state is
actually conclusive) or a re-armed alarm (if it is not) — never a silent
drop.

### Secrets across alarm ticks (review r1 item 4, new)

Today, `secretValues` (name → resolved value, including a possibly-minted
Workers AI run token, `do.ts`'s `mintAiToken`/`resolveGrantedSecrets`) is a
local variable in `do.ts`'s single `fetch` handler, alive for exactly the
one call's lifetime — built once, fed into `buildLegEnvVars` for the
container's own env, and fed again into `redactLegResultFields` right before
the handler returns, scrubbing any granted secret VALUE out of the leg's own
result body before it ever leaves the DO.

An alarm-driven DO cannot keep that local variable alive between ticks — it
may be evicted and re-hydrated by any later tick. Two consequences:

- `secretValues` (the already-resolved values, including the minted AI
  token) must be PERSISTED to `ctx.storage` when the container starts, and
  read back by whichever LATER tick reaches a terminal state and needs to
  redact the result it is about to write. It must never be recomputed
  (`resolveGrantedSecrets` called again) at that later tick: `mintAiToken`
  bakes in `Date.now()` at mint time for its TTL math
  (`do.ts:42-49`) — a re-mint at a different tick's `Date.now()` produces a
  DIFFERENT token than the one already baked into the container's own env
  vars, which would be simply wrong (the container is running with the
  FIRST token; a redaction pass using a second, different token value would
  fail to scrub the first one out of the leg's own stdout/description if it
  ever echoed there).
- The persisted `secretValues` must be DELETED from `ctx.storage` once the
  attempt reaches ANY terminal state (success, failure, or infra) — the
  same "a secret's plain value exists only as long as the leg that needs it
  needs it" discipline `#1346`'s whole gate-scoped-secrets design already
  relies on (`docs/superpowers/specs/2026-10-26-gate-scoped-secrets-design.md`),
  now extended to this DO's own durable storage, not just the container's
  process environment.

A related fix to the request/response contract (review r1 item 4's second
half): `dispatchRunLeg` (the DO's `/run-leg` handler) must be able to return
a SYNCHRONOUS terminal `LegResult` directly, not just a 202 accept — the
two existing early-outs in `do.ts`'s handler (`legGitToken` mint failure →
`PAT_ONLY_REFUSAL`/"private clone token unavailable"; `firstUnresolvedSecret`
→ `"DID-NOT-RUN: secret \"<name>\" unresolved"`) both happen BEFORE any
container ever starts, and stay exactly that: a real 200 body, right away,
no alarm ever scheduled. The dispatch step's own return type is a union —
`{kind: "terminal", result: LegResult} | {kind: "accepted", resultKey,
startedAt}` — and the try-loop (above) checks for `"terminal"` before ever
entering the poll loop.

### Superseded runs (review r1 item 7, new)

A Workflow instance this leg belongs to can itself stop mattering before the
leg's own container finishes — #1119's infra-rerun creates a NEW instance
and the original is abandoned (never re-run again, #1148); a human could
cancel a run. In today's design this was nearly moot: the one open
`stub.fetch` call was tied 1:1 to the ONE invocation holding it, so an
abandoned instance's own abort/teardown naturally ended the call too (or, at
worst, wasted one already-in-flight leg). In this design, the DO's alarm
runs entirely independently — nothing inherently stops it from polling (and
billing) a container for a run nobody is waiting on anymore.

**Fix:** every FEW alarm ticks (not every tick — this is a real extra RPC
cost per check, review r1's own framing), the DO calls
`env.GATE_WORKFLOW.get(instanceId).status()` (the same `GateRunInstance`
shape `auto-run.ts` already defines) and, if the status is no longer live,
destroys its own container and stops re-arming. This needs `instanceId` to
remain in the request body for THIS purpose alone (unrelated to the dropped
`sendEvent` plumbing) — the DO still needs to know which instance it is
working on behalf of, just never to address an event back to it. The exact
set of Workflows status values this check should treat as "still live" (a
`waiting`/`paused` instance — e.g. one of its OTHER legs is mid-`step.sleep`
— must count as live, never as superseded) is named precisely under
"Leftovers," below, as `isLiveStatus`, rather than asserted here.

### Cost

**Durable Object duration (real reduction, not just "likely").** Today,
`GateRunnerDO`'s `/run-leg` fetch handler is a SINGLE open request for the
leg's entire wall time (up to `legStepDeadlineMs`, ~28 min worst case) —
Durable Objects bill wall-clock duration while a request is open, including
time spent in an `await sleep(POLL_MS)` poll loop, not just active CPU. The
new design replaces that one long-open request with many SHORT alarm
invocations (review r1 item 10: **15-30s per tick**, not the container's own
5s `POLL_MS` — a DO wake is a real billed event, unlike an in-process
`sleep`, so the tick interval should be coarser than the old in-request poll
ever needed to be) — the DO object is not "open" between ticks at all.

**Workflows step count — a concrete budget, not a guess (review r1 item
11, revised by review r2's own count once every try gets a unique key).**
Workflows bills (and caps) STEPS, not wall time: 10,000 steps per instance
on the paid plan, 25,000 max — and `step.sleep` does not count toward that
limit, only `step.do` does. At the review's own 60s poll interval, a
worst-case 35-min wait (25-min leg timeout + 10-min grace) is
`35 * 60 / 60 = 35` `step.do` poll calls for ONE try. Review r2 item 2's own
fix (every try gets its own unique key, including the `retry-<leg>` step's
internal infra-retries, not just `start-<leg>`'s) means a leg's worst case
is up to 3 tries in `start-<leg>` (1 initial + 2 infra-retries) PLUS up to 3
tries in `retry-<leg>` (same shape) = **6 total tries**, each up to 35 poll
steps plus 1 dispatch step: `6 * 36 = 216` steps per leg, worst case. A run
with 30 parallel legs (a large PR) is then `~6,480` steps worst case —
still comfortably inside the 10,000-step paid-plan budget, though with
real headroom reduced from r1's (incorrect, 3-tries-not-6) ~3,240 estimate.
This is still the number that makes "polling instead of an event" an easy
call: the step cost of polling every 60s is small and bounded, known in
advance, not a guess — it is simply a tighter budget than r1 first
calculated, now that every try correctly gets its own key.

**Net:** this design is motivated by correctness (#1393), not cost, but the
real expectation — now backed by the arithmetic above, not just intuition —
is DO duration drops meaningfully and Workflows' own step budget has
comfortable headroom even at a large PR's worst case, PLUS it removes a
real, measured source of wasted whole-run reruns (#1393's one incident alone
re-ran every leg of a run three times over for nothing). Confirm the DO
duration-billing multiplier with real post-ship data before citing a dollar
figure anywhere operator-facing — the step-count math above is solid; the
per-alarm-tick DO pricing is not independently re-verified in this doc.

## New request/response contract

```ts
// GateLegRequest (leg-env.ts) gains one field -- `instanceId`, kept ONLY for
// the superseded-run check (above), never for addressing an event:
interface GateLegRequest {
  // ...every existing field, unchanged...
  /** #1396: the GATE_WORKFLOW instance this attempt belongs to, so the DO's
   *  alarm can check env.GATE_WORKFLOW.get(instanceId).status() every few
   *  ticks and stop polling (destroy its container) once the instance is no
   *  longer live -- never used to address an event; there is no event. */
  instanceId: string;
}

// /run-leg's response is one of three shapes:
//   200 { state, description?, summary? } -- a TERMINAL LegResult reached
//        before any container ever started (DID-NOT-RUN: unresolved secret;
//        PAT-only private-clone refusal). No alarm is ever scheduled.
//   202 {} -- container start scheduled; poll the leg's own resultKey (the
//        SAME key the container itself would write to) from here.
//   4xx/5xx -- a synchronous protocol-level failure (malformed request, no
//        container binding, image not bound) -- rare, fast, and Workflows'
//        own step-retry on throw is still the right tool for them, unchanged
//        from today.
```

## Testing

Following this repo's own established split (`run-leg.ts`/`leg-run.ts` hold
the pure logic; `do.ts`/`workflow.ts` are the thinnest possible glue that
imports `cloudflare:workers`, so bun test can load and pin everything that
actually decides something) PLUS, per review r1 item 11, real engine tests
for the replay/alarm semantics bun test structurally cannot exercise:

**bun-testable, pure logic:**

1. **Alarm-tick decision function**, extracted so `do.ts`'s real `alarm()`
   is just "load state, call this, persist/re-arm/terminal/write per its
   answer": `nextAlarmStep(state, now, pollResult): {kind: "re-arm", at:
   number, state: RunLegAlarmState} | {kind: "terminal", outcome:
   StoredLegResult}` — every branch (ready-wait, port-retry, poll, deadline,
   container-stopped, superseded-instance check) becomes a pure case bun
   test can hit directly.
2. **Explicit try-loop**, replacing the `ctx.attempt`-keyed loop in
   `runLegStep`: still pure, still takes a fake `step`/`dispatch`/clock —
   rewrite (not just extend) the `"no waitForEvent"` test
   (`gate-leg-run.test.ts:123-128`) into its positive form: *"a retryable
   infra outcome re-dispatches a fresh attemptId, up to `totalLegWallMs`,
   via the poll loop, never a long-held single call."*
3. **Write-once races, both of them**: (a) the DO's write and the Workflow's
   own give-up write attempting the same key ("Deadline," above); (b) the
   DO's own "container unreachable, guessing infra" write racing a
   container's own genuine self-report arriving at the same key ("Who
   writes what," above) — in BOTH cases, whichever the fake bucket already
   holds wins, and the loser reads it back, never overwrites. Also: a value
   found via the normal poll read is NEVER run through `isSignalKill`/
   `R2_PREFIX` reclassification unless it carries the DO's own "I never
   reached this container" marking — a direct regression test for review r2
   item 1's bug (a container's own live-observed `"exited 143/137"` must
   stay `state: "failure"`, never get reclassified to infra).
4. **touch() call-count**: once per NEW `tryNo`, called from inside its own
   `step.do`, and per review r1 item 8, also across poll ticks within one
   healthy attempt — the direct descendant of #1387's existing
   `touch`-gating test.
5. **Container lifetime / dormant-alarm guards**: `setInactivityTimeout` is
   called with the container start, sized past the tick interval; `alarm()`'s
   own error-handling always re-arms or writes a terminal outcome, never
   neither.
6. **Unique key per try**: the retry step's own 2nd/3rd internal tries never
   reuse `.retry.json` — a direct regression test for review r2 item 2's
   collision (two tries' results must never be able to clobber each other).
7. Every existing `infra-rerun.ts`/`verdict.ts`/`fanout.ts` test stays green
   unchanged: none of those modules' own inputs or contracts move.

**Real-engine tests (`@cloudflare/vitest-pool-workers`, review r1 item 11)** —
this repo already has this harness (`test/gate-workflow-precheck.test.ts`,
`test/github.api-queries.test.ts`) for exactly this kind of claim that a pure
unit test cannot actually verify:

1. A step killed mid-run (simulating the actual #1393 invocation cut) does
   NOT lose the leg's own result — the next invocation's poll step finds it
   in R2.
2. A simulated replay keeps `attemptId`/`startedAt`/every step's name stable
   — the governing invariant, verified against the REAL engine's replay
   behavior, not an assumption about it.
3. An alarm chain across several ticks, INCLUDING a duplicate/redelivered
   alarm tick, reaches exactly one terminal write — confirms the write-once
   contract actually holds under the real at-least-once alarm semantics.
4. The DO-vs-Workflow write-once race (above) under the real R2 binding's
   own conditional-write behavior, not a fake bucket's approximation of it.

## Migration (review r1 item 9)

Rather than a bare env flag read live by every run, the mode is PINNED per
Workflow instance, replay-safely, the same way the governing invariant pins
every other wall-clock-adjacent value:

```ts
const mode = await step.do("leg-mode", async () =>
  legModeEnabled(this.env.GATE_ASYNC_LEGS, repo) ? "async-poll" : "sync-legacy");
```

A flag flip changes the mode only for runs that have not yet reached this
step — an in-flight instance that already resolved `"sync-legacy"` keeps
running the OLD synchronous `/run-leg` path start to finish, never flips
mid-run just because the live flag changed. `do.ts` keeps BOTH paths
(branched on the same mode, echoed in the request) until every in-flight
`"sync-legacy"` run has drained — bounded by the longest a run can possibly
take (`totalLegWallMs`'s worst case across every leg) after the flag's
default flips to `"async-poll"` for new runs. Only once no live instance can
still be running the old path does `do.ts`'s synchronous branch get deleted,
as its own separate, later PR. This is a one-way-door-adjacent change (it
touches the one file that bridges every gate run, `workflow.ts`) and should
be reviewed with that weight, same as #1390 was labeled.

## Leftovers for the implementation plan (review r2, named not solved)

Five gaps review r2 found but did not block on — each is a precise question
the implementation plan (the task's own "design doc first... then plan")
must answer, not a design decision this doc is making:

1. **Real step count at 6 tries, not 3** — already folded into "Cost,"
   above (~216/leg, ~6,480 for a 30-leg run); called out again here because
   it changes the HEADROOM argument (r1's ~3,240 estimate had roughly 3x the
   margin r2's corrected ~6,480 does) enough that the implementation plan
   should re-check it against this fleet's actual largest real PRs, not just
   a round "30 legs" estimate.
2. **`touch()`'s exact call site** — "Watchdog touch," above, states it must
   fire from inside a `step.do` callback, never the surrounding loop, but
   does not pin whether that is every poll tick or every Nth. Pin with a
   test once the poll step's own shape is implemented.
3. **A precise `isLiveStatus` helper** — "Superseded runs," above, needs an
   exact set of Workflows instance statuses that count as "still live" for
   the DO's own supersede check. A `waiting`/`paused` instance (mid-`step.
   sleep` on a DIFFERENT leg, say) must count as live; only a genuinely
   `terminated`/`errored` instance should trigger the DO stopping its own
   container. Pin this against the real Workflows API, not a guess.
4. **`@head` union legs combined with a retry-step's own `-tryN` suffix** —
   "One unique key per try," above, now fully resolves the PLAIN-leg case
   (`shard-<leg>.retry-try2.json`) across `RUN_RESULT_RE`, `EVIDENCE_RE`,
   `evidenceKeyFor`, and `log.ts`'s `tryRank`/`finalLegKey` (review r3). A
   union leg's own `@head` marker COMBINED with this same suffix
   (`shard-<leg>@head.retry-try2.json`) is the one remaining case this doc
   does not work through to the same level of precision — named here for the
   implementation PR to verify against each of those four call sites
   directly, not re-derived from scratch.
5. **The DO writing a live `/result` 200 straight to R2 itself** — today,
   and in every branch described above, the CONTAINER is the one that PUTs
   its own result to R2, on its own separate outbound channel, independent
   of whatever the DO's `/result` poll receives over HTTP. The DO's alarm
   loop, when it gets a LIVE 200 from `/result`, already HAS the full
   `LegResult` body in hand at that moment — rather than depending on the
   container's own, separately-timed R2 write landing before the Workflow's
   next poll tick (a race this design has not needed to assume away yet,
   but which the implementation should close), the DO could simply write
   that body (redacted, using the `secretValues` it already holds in
   `ctx.storage` per "Secrets across alarm ticks," above) to R2 itself,
   immediately, the moment it receives it. This removes a timing assumption
   rather than relying on it — named here for the implementation plan to
   decide, not asserted as required by this doc's own correctness argument
   (the design is correct either way; this would only make it tighter).
6. **Step names must phase-qualify, not just try-number-qualify (review r3
   plan nit).** This doc's own pseudocode names every dispatch step
   `` dispatch-${leg}-try${tryNo} `` for BOTH the `start-<leg>` phase and the
   `retry-<leg>` phase — a real name COLLISION (Workflows step names must be
   unique per instance; `start`'s own try 1 and `retry`'s own try 1 would
   otherwise both be named `dispatch-<leg>-try1`). The implementation plan
   should name them `` dispatch-start-${leg}-try${tryNo} `` /
   `` dispatch-retry-${leg}-try${tryNo} `` (and the matching
   `poll-start-...`/`poll-retry-...` names), mirroring the EXISTING
   `start-<leg>`/`retry-<leg>` step-name split this design otherwise
   preserves.

## Open questions for operator review

1. Real Durable Objects alarm billing, to replace "likely cheaper" with a
   measured number, post-ship (the step-count math above is solid; this one
   number is not independently verified in this doc).
2. The exact Workflows `status()` values this fleet's live API version
   returns for an instance parked between poll steps — needed to implement
   "superseded" detection (above) precisely, not assumed here (see
   "Leftovers" item 3, above, for the specific helper this becomes).
