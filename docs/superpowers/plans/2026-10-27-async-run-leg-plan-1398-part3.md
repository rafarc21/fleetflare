# Async /run-leg + DO-alarm polling — Implementation Plan (Part 3 of 4)

> **Continued from [Part 1](2026-10-27-async-run-leg-plan-1398-part1.md)** (Goal/Architecture/Tech Stack/Spec/Global Constraints/Rollout) and [Part 2](2026-10-27-async-run-leg-plan-1398-part2.md) (Tasks 3-6). This file: Tasks 7-8. Next: [Part 4](2026-10-27-async-run-leg-plan-1398-part4.md) (Tasks 9-13 + Self-Review). Task numbering is continuous across all four files.


### Task 7: `runLegStepPolling` — the explicit try-loop + poll loop (Workflow side)

The biggest single task in this plan: the new function that replaces `runLegStep`'s reliance on Workflows' own automatic step-retry with an explicit dispatch+poll try-loop. Coexists with `runLegStep` — nothing calls this yet.

**Files:**
- Modify: `apps/fleet/src/gate/leg-run.ts`
- Test: `apps/fleet/test/bun/gate-leg-run.test.ts`

**Interfaces:**
- Consumes: `claimOrReadBack` (Task 6), `ClaimableBucket` (Task 6), `legResultReader` (existing, type-widened in this task, used directly — never `storedLegResult` for the normal read, spec review r2 item 1), `LegStepRunner` (now generic, Task 1), `asyncAttemptDeadlineMs`, `R2_PREFIX` (Task 4 / existing `leg-run.ts` export, reused — plan review r1 BLOCKER 2: the Workflow's own give-up write carries the SAME marker the DO's own writes do).
- Produces:
  - `interface PollingLegStepRunner { do<T>(name: string, config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T>; sleep(name: string, durationSeconds: number): Promise<void>; }` — Task 11 (`workflow.ts`) constructs this from the real `step`.
  - `type DispatchOutcome = { kind: "terminal"; result: LegRunResult } | { kind: "accepted"; resultKey: string; startedAt: number };`
  - `runLegStepPolling(step: PollingLegStepRunner, dispatch: (planned: PlannedLeg, attemptId: string) => Promise<DispatchOutcome>, planned: PlannedLeg, deps: LegRunDeps & { bucket: ClaimableBucket; pollIntervalSeconds?: number }): Promise<LegRunResult>` — Task 11 calls this (instead of `runLegStep`) when the pinned per-instance mode is `"async-poll"`.

**Governing-invariant checklist for this task (plan review r1 BLOCKER 1 — a prior draft violated all three)**:
1. `attemptId` is minted INSIDE the dispatch step's own callback, never in the surrounding function body.
2. The per-try elapsed-time check is its OWN `step.do` (`...-budget-<i>`), reading `now()` inside that callback — never a bare `now() - legStarted` comparison in the `for` loop around it.
3. `touch()` fires from INSIDE the dispatch step's own callback (guarded by the loop's own `tryNo` — a plain counter, not a wall-clock value, so reading it from the surrounding loop is safe), never a bare `if (tryNo === 1) await deps.touch?.()` outside any step.

- [ ] **Step 1: Widen `StoredLegResult` to carry `summary`**

In `apps/fleet/src/gate/leg-run.ts` (plan review r1 item 8 — the design's own "normal read" relies on this; today's runtime already preserves `summary` through `legResultReader`'s type cast, this is a type-only fix):

```ts
/** A leg's result as the container wrote it to R2: state, description, and
 *  (#1398) summary -- widened so runLegStepPolling's own normal read
 *  (legResultReader, never storedLegResult) can surface it, matching what
 *  the container already writes and what runLegStep's own live-response
 *  path already preserves today. */
export type StoredLegResult = { state: LegResult["state"]; description?: string; summary?: string };
```

- [ ] **Step 2: Write the failing tests**

Add to `apps/fleet/test/bun/gate-leg-run.test.ts` (new `describe` block):

```ts
// #1398: runLegStepPolling's own fake step needs BOTH do() and sleep() --
// sleep is a no-op in tests (no real waiting), do() runs its callback once
// per call (no Workflows-style automatic retry -- this new design's OWN
// try-loop drives retries explicitly, never an implicit step-retry).
function fakePollingStep() {
  const calls: string[] = [];
  return {
    calls,
    do: async <T>(name: string, _config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T> => {
      calls.push(name);
      return fn({ attempt: 1, step: { name, count: 1 } });
    },
    sleep: async (name: string) => { calls.push(`sleep:${name}`); },
  };
}

function fakeBucket(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    put: async (key: string, value: string) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return {};
    },
    get: async (key: string) => {
      const v = store.get(key);
      return v === undefined ? null : { json: async () => JSON.parse(v) };
    },
  };
}

describe("runLegStepPolling (#1398)", () => {
  it("a container-authored success in R2 on the first poll ends the attempt, summary AND ms intact", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      bucket.store.set(planned.resultKey, JSON.stringify({ state: "success", summary: "42 passed" }));
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 1_000 });
    expect(result).toMatchObject({ leg: "lint", state: "success", summary: "42 passed", ms: 1_000 });
    expect(step.calls.some((c) => c.startsWith("sleep:"))).toBe(true);
  });

  it("a DID-NOT-RUN/PAT-only terminal dispatch never enters the poll loop at all", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    const dispatch = async (): Promise<DispatchOutcome> => ({
      kind: "terminal", result: { leg: "lint", state: "error", description: 'DID-NOT-RUN: secret "x" unresolved' },
    });
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0 });
    expect(result).toMatchObject({ state: "error", description: 'DID-NOT-RUN: secret "x" unresolved' });
    expect(step.calls.some((c) => c.startsWith("sleep:"))).toBe(false);
  });

  it("a container's own live-observed 'exited 143/137' stays a REAL failure, never reclassified (review r2 item 1 regression test)", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      bucket.store.set(planned.resultKey, JSON.stringify({ state: "failure", description: "exited 137" }));
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0 });
    expect(result.state).toBe("failure"); // NOT "error" -- never reclassified as infra
    expect(result.description).toBe("exited 137"); // raw, never R2_PREFIX-marked
  });

  it("attemptId is minted inside the dispatch step: a replayed step (same name) never calls dispatch a second time (governing invariant, BLOCKER 1)", async () => {
    const bucket = fakeBucket();
    let dispatchCalls = 0;
    const seenAttemptIds: string[] = [];
    const dispatch = async (planned: PlannedLeg, attemptId: string): Promise<DispatchOutcome> => {
      dispatchCalls++;
      seenAttemptIds.push(attemptId);
      bucket.store.set(planned.resultKey, JSON.stringify({ state: "success" }));
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    // A step cache keyed by name, exactly mirroring Workflows' own replay
    // contract: the SECOND do() call for a name already seen returns the
    // FIRST call's result without re-invoking fn.
    const cache = new Map<string, unknown>();
    const replayingStep = {
      do: async <T>(name: string, _config: LegStepConfig, fn: () => Promise<T>): Promise<T> => {
        if (cache.has(name)) return cache.get(name) as T;
        const result = await fn();
        cache.set(name, result);
        return result;
      },
      sleep: async () => {},
    };
    // Run the WHOLE function twice against the SAME cache, simulating a
    // mid-run replay that re-executes runLegStepPolling's own body from
    // scratch but hits the SAME step cache for every step it already took.
    await runLegStepPolling(replayingStep, dispatch, PLANNED, { bucket, now: () => 0 });
    await runLegStepPolling(replayingStep, dispatch, PLANNED, { bucket, now: () => 0 });
    expect(dispatchCalls).toBe(1); // never re-dispatched
    expect(new Set(seenAttemptIds).size).toBe(1); // the SAME attemptId both times
  });

  it("an infra outcome (DO-written) retries with a fresh attemptId, up to the total deadline, never waitForEvent (positive form of the old gate-leg-run.test.ts invariant)", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    let tries = 0;
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      tries++;
      bucket.store.set(planned.resultKey, JSON.stringify(
        tries < 2 ? { state: "error", description: "gate container exited mid-leg" } : { state: "success" },
      ));
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: tries === 1 ? 0 : 1_000 };
    };
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, totalDeadlineMs: 100_000 });
    expect(result.state).toBe("success");
    expect(tries).toBe(2);
    expect("waitForEvent" in step).toBe(false);
  });

  it("a per-try give-up writes R2_PREFIX-marked via claimOrReadBack -- EXACT expectation, fully traced, not just 'ordering' (plan review r1 item 5)", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    let now = 0;
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      const startedAt = now;
      now += 100; // a little real time passes per try, so the TOTAL deadline (below) can trip deterministically
      return { kind: "accepted", resultKey: planned.resultKey, startedAt };
    };
    // Trace: try 1's own attempt deadline (stepDeadlineMs: 0) trips on its
    // first poll tick (now=100 by then, startedAt=0) -- claimOrReadBack
    // writes the R2_PREFIX-marked guess to planned.resultKey. That reads as
    // infra (isLegInfraDescription), so runPhase loops to try 2 -- but try
    // 2's own TOTAL-deadline check (now=100 >= totalDeadlineMs=100) fires
    // FIRST, before try 2 ever dispatches, with exactly ONE cause recorded
    // -- combineCauses of a single, short cause passes it through verbatim.
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => now, stepDeadlineMs: 0, totalDeadlineMs: 100 });
    const expectedDescription = `${R2_PREFIX}lint: no progress past its deadline`;
    expect(result).toMatchObject({ leg: "lint", state: "error", description: expectedDescription });
    expect(JSON.parse(bucket.store.get(PLANNED.resultKey)!)).toEqual({ state: "error", description: expectedDescription });
  });

  it("the poll step finds a container's own real result before ever reaching the give-up path (the common case)", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket({ [PLANNED.resultKey]: { state: "success" } }); // pre-populated: the container already wrote it
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> =>
      ({ kind: "accepted", resultKey: planned.resultKey, startedAt: 0 });
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, stepDeadlineMs: 0, totalDeadlineMs: 1_000 });
    // The poll step's own R2 read happens BEFORE the budget check in
    // dispatchAndPollOnce's own loop -- it finds the pre-populated success
    // on the very first tick, never reaching claimOrReadBack at all.
    expect(result.state).toBe("success");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts -t "runLegStepPolling"`
Expected: FAIL — not exported yet.

- [ ] **Step 4: Write minimal implementation**

In `apps/fleet/src/gate/leg-run.ts`:

```ts
/** #1398: the slice of Workflows' WorkflowStep the async/polling path needs
 *  -- do(), generic (Task 1), plus sleep(), which real Workflows exposes as
 *  step.sleep(name, duration) and which does NOT count toward the instance's
 *  step budget (spec "Cost"). */
export interface PollingLegStepRunner {
  do<T>(name: string, config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T>;
  sleep(name: string, durationSeconds: number): Promise<void>;
}

/** #1398: a dispatch call's own outcome -- a TERMINAL LegResult reached
 *  before any container ever started (DID-NOT-RUN, PAT-only refusal, spec
 *  "Secrets across alarm ticks"), or an ACCEPTED container start, carrying
 *  the governing-invariant-safe values (startedAt minted inside the
 *  dispatch step itself) later poll steps need. */
export type DispatchOutcome =
  | { kind: "terminal"; result: LegRunResult }
  | { kind: "accepted"; resultKey: string; startedAt: number };

const POLL_INTERVAL_SECONDS_DEFAULT = 60;

/** #1398: ONE try's own dispatch + poll loop. Returns the container-authored
 *  (or DO-written infra) LegResult once found, or the Workflow's own
 *  give-up result once this try's own deadline elapses with nothing in R2.
 *  Every governing-invariant-sensitive value (attemptId, each deadline
 *  check) is minted/computed strictly INSIDE its own step.do callback --
 *  this function's own surrounding `for` loop only ever reads already-
 *  resolved step results (plan review r1 BLOCKER 1). */
async function dispatchAndPollOnce(
  step: PollingLegStepRunner,
  dispatch: (planned: PlannedLeg, attemptId: string) => Promise<DispatchOutcome>,
  target: PlannedLeg,
  stepName: string,
  attemptDeadlineMs: number,
  deps: { bucket: ClaimableBucket; now: () => number; pollIntervalSeconds: number; readResult: (key: string) => Promise<StoredLegResult | undefined>; touch?: () => Promise<void> },
): Promise<LegResult & LegRunMeta> {
  let dispatched: DispatchOutcome;
  try {
    dispatched = await step.do(stepName, LEG_STEP_CONFIG, async () => {
      // Governing invariant: minted and used ENTIRELY inside this callback.
      const attemptId = crypto.randomUUID();
      await deps.touch?.();
      return dispatch(target, attemptId);
    });
  } catch (err) {
    // #1398 plan review r1 BLOCKER 3 (the other half -- workflow.ts's own
    // dispatch closure THROWS on a non-2xx; this is where that throw must
    // land once the step's own LEG_STEP_CONFIG.retries are exhausted, never
    // an unhandled rejection out of runLegStepPolling entirely). Same shape
    // runLegStep's own catch block already returns for this case.
    const message = err instanceof Error ? err.message : String(err);
    return { state: "error", description: message.slice(0, MAX_INFRA_CAUSE_CHARS) };
  }
  if (dispatched.kind === "terminal") return dispatched.result;
  for (let i = 1; ; i++) {
    await step.sleep(`${stepName}-sleep-${i}`, deps.pollIntervalSeconds);
    const tick = await step.do(`${stepName}-poll-${i}`, LEG_STEP_CONFIG, async () => {
      // #1398 review r2 item 1: the RAW reader, never storedLegResult --
      // a container-authored record (including its own live "exited
      // 143/137") is trusted exactly as-is, summary intact, never reclassified.
      const found = await deps.readResult(dispatched.resultKey);
      return found !== undefined ? { kind: "found" as const, result: found } : { kind: "not-yet" as const };
    });
    if (tick.kind === "found") return { ...tick.result, ms: deps.now() - dispatched.startedAt };
    // #1398 plan review r1 BLOCKER 1: the elapsed-time decision is its OWN
    // step, reading now() strictly inside this callback.
    const pastDeadline = await step.do(`${stepName}-budget-${i}`, LEG_STEP_CONFIG, async () =>
      deps.now() - dispatched.startedAt >= attemptDeadlineMs);
    if (pastDeadline) {
      // #1398 plan review r1 BLOCKER 2: R2_PREFIX-marked, same convention
      // every DO-authored write uses -- this is the Workflow's OWN guess,
      // and claimOrReadBack ensures a real, later-arriving result still wins.
      const claimed = await step.do(`${stepName}-giveup`, LEG_STEP_CONFIG, () =>
        claimOrReadBack(deps.bucket, dispatched.resultKey, {
          state: "error", description: `${R2_PREFIX}${target.leg}: no progress past its deadline`,
        }));
      return { ...claimed, ms: deps.now() - dispatched.startedAt };
    }
  }
}

/**
 * #1398 (spec "New architecture" / "Retries"): the explicit try-loop that
 * replaces Workflows' own automatic step-retry (runLegStep's `ctx.attempt`
 * usage) with real application code -- dispatch is now a SHORT step that
 * only throws for a synchronous protocol failure; everything after the
 * container starts is a terminal R2 outcome this loop discovers by polling,
 * never a thrown exception. Coexists with runLegStep: nothing calls this
 * yet (a later task wires it in behind the per-instance mode pin).
 */
export async function runLegStepPolling(
  step: PollingLegStepRunner,
  dispatch: (planned: PlannedLeg, attemptId: string) => Promise<DispatchOutcome>,
  planned: PlannedLeg,
  deps: LegRunDeps & { bucket: ClaimableBucket; pollIntervalSeconds?: number },
): Promise<LegRunResult> {
  const now = deps.now ?? Date.now;
  // #1398 plan review r1 BLOCKER 2: the per-attempt deadline this loop uses
  // is asyncAttemptDeadlineMs (run-leg-alarm.ts), NOT the sync path's own
  // legStepDeadlineMs -- it must stay strictly longer than the DO's own
  // worst-case total time, or the Workflow's give-up write could race a
  // still-legitimately-working DO under normal operation, not just a true fault.
  const attemptDeadlineMs = deps.stepDeadlineMs ?? asyncAttemptDeadlineMs(planned.timeoutMin);
  const totalDeadlineMs = deps.totalDeadlineMs ?? totalLegWallMs(planned.timeoutMin);
  const pollIntervalSeconds = deps.pollIntervalSeconds ?? POLL_INTERVAL_SECONDS_DEFAULT;
  const readResult = deps.readResult ?? (async () => undefined);
  const legStarted = await step.do(`leg-started-${planned.leg}`, LEG_STEP_CONFIG, async () => now());

  const runPhase = async (phaseName: "start" | "retry", targetFor: (tryNo: number) => PlannedLeg): Promise<LegResult & LegRunMeta> => {
    const causes: string[] = [];
    for (let tryNo = 1; ; tryNo++) {
      // #1398 plan review r1 BLOCKER 1: the TOTAL-deadline check is its own
      // step too -- tryNo itself is a safe, replay-stable loop counter (not
      // a wall-clock value), but the now()-vs-totalDeadlineMs comparison is not.
      const overBudget = await step.do(`total-budget-${planned.leg}-try${tryNo}`, LEG_STEP_CONFIG, async () =>
        now() - legStarted >= totalDeadlineMs);
      if (overBudget) {
        return {
          leg: planned.leg, state: "error",
          description: causes.length > 0 ? combineCauses(causes) : `${planned.leg} exceeded ${legTimeoutMin(planned.timeoutMin)} min without a result`,
        };
      }
      const target = targetFor(tryNo);
      // #1398 Leftovers item 6: phase-qualified step names -- dispatch-start-
      // and dispatch-retry- never collide on the same tryNo.
      const result = await dispatchAndPollOnce(
        step, dispatch, target, `dispatch-${phaseName}-${planned.leg}-try${tryNo}`, attemptDeadlineMs,
        { bucket: deps.bucket, now, pollIntervalSeconds, readResult, touch: tryNo === 1 ? deps.touch : undefined },
      );
      const isInfra = result.state === "error" && isLegInfraDescription(result.description);
      if (!isInfra) return result;
      causes.push(result.description ?? "infra");
    }
  };

  const first = await runPhase("start", (tryNo) => tryNo === 1 ? planned : { ...planned, resultKey: infraRetryResultKey(planned.resultKey, tryNo) });
  if (!isRetryable({ ...first, leg: planned.leg })) return { ...first, leg: planned.leg };

  const retryBase = { ...planned, resultKey: retryResultKey(planned.resultKey) };
  const retry = await runPhase("retry", (tryNo) => tryNo === 1 ? retryBase : { ...retryBase, resultKey: infraRetryResultKey(retryBase.resultKey, tryNo) });

  const ms = sumMs(first.ms, retry.ms);
  const firstCause = (first.description ?? "failure").slice(0, MAX_FIRST_DESCRIPTION_CHARS);
  if (retry.state === "success") {
    return { leg: planned.leg, state: "success", description: `flaky: passed on retry; first: ${firstCause}`, ms, summary: retry.summary };
  }
  if (first.state === "failure") return { ...retry, leg: planned.leg, ms, redFirst: true };
  const retryCause = retry.description ?? retry.state;
  return { ...retry, leg: planned.leg, ms, description: `${retryCause}; first: ${firstCause}`.slice(0, MAX_DESCRIPTION_CHARS) };
}

/** #1398: the infra-cause check this loop's own try-decision needs --
 *  SEPARATE from isInfraLegFailure (infra-rerun.ts), which ALSO excludes a
 *  redFirst result; this loop decides "retry this ONE phase's attempt,"
 *  infra-rerun.ts later decides "auto-rerun the WHOLE run." Reuses the SAME
 *  INFRA_CAUSE-shaped matching by checking for the DO's own known infra
 *  description prefixes, mirroring isRetryable's own R2_PREFIX-stripping
 *  pattern. Exported for the engine tests (Task 12) to exercise directly.
 */
export function isLegInfraDescription(description: string | undefined): boolean {
  if (description === undefined) return false;
  // "HTTP \d+" also covers a dispatch step's OWN thrown-and-caught protocol
  // failure (plan review r1 BLOCKER 3's catch, above: "<leg>: HTTP 503" etc)
  // -- a step-retry-exhausted dispatch failure retries on a fresh attempt
  // via THIS loop, the same category as every other infra cause.
  return /gate (container|server|capacity)|no progress past its deadline|HTTP \d+/.test(description);
}
```

`sumMs` already exists in this file (the non-exported helper `runLegStep` itself uses) — no change needed to it, just a second call site.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts`
Expected: PASS. Iterate on the implementation above until every new test (and every pre-existing test) passes — the sketch above is a strong starting point, not guaranteed byte-perfect; debug test failures against the SPEC's own stated behavior (cited in each test's own comment), not by loosening the assertion.

- [ ] **Step 6: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit && npx tsc --noEmit -p test/tsconfig.json`

- [ ] **Step 7: Commit**

```bash
git add apps/fleet/src/gate/leg-run.ts apps/fleet/test/bun/gate-leg-run.test.ts
git commit -m "feat(gate): add runLegStepPolling, the explicit dispatch+poll try-loop

#1398 (docs/superpowers/specs/2026-10-26-async-run-leg-design.md, 'New
architecture' + 'Retries'): replaces Workflows' own automatic step-retry
(ctx.attempt) with an explicit try-loop around a short dispatch step and a
step.sleep+step.do poll loop. The normal poll read uses legResultReader
directly (review r2 item 1, StoredLegResult widened for summary) -- a
container's own live 'exited 143/137' stays a real failure, never
reclassified as infra.

Plan review r1 BLOCKER 1 fixed: attemptId is minted strictly inside the
dispatch step's own callback (a replay test proves dispatch is never
called twice for the same step name); every elapsed-time decision (the
per-try attempt deadline AND the total-leg deadline) is its own step.do,
never a bare now() in the surrounding try-loop; touch() fires from inside
the dispatch step too.

BLOCKER 2: a give-up after the total deadline writes R2_PREFIX-marked via
claimOrReadBack -- same convention the DO's own writes use -- so a
late-arriving real result always wins over the Workflow's own guess. Uses
asyncAttemptDeadlineMs (Task 4), not the sync path's legStepDeadlineMs, so
this backstop stays strictly longer than the DO's own worst-case total time.

ms and the flaky-retry summary are preserved, matching runLegStep's own shape.

Coexists with runLegStep: unused by any live code path yet.

Refs #1398, #1396."
```

---

### Task 8: DO's `/run-leg` handler gains the async branch

**Files:**
- Modify: `apps/fleet/src/gate/do.ts`
- Modify: `apps/fleet/src/gate/leg-env.ts` (`GateLegRequest` gains `mode`/`instanceId`)
- Test: this file imports `cloudflare:workers` — it has NO bun-testable unit tests of its own (per this repo's established split); its behavior is covered by the engine tests in Task 12 and by keeping its OWN logic as thin as possible, calling only into already-tested `run-leg.ts`/`run-leg-alarm.ts` functions.

**Interfaces:**
- Consumes: `startLegContainer` (Task 5), `RunLegAlarmState` (Task 4), `prepareAndStartContainer`'s existing error contract.
- Produces: `GateLegRequest` gains `mode?: "sync-legacy" | "async-poll"` (absent = `"sync-legacy"`, the old behavior, zero change for every existing caller) and `instanceId?: string` (used only by the async branch's superseded-run check, Task 9).

- [ ] **Step 1: Add the new fields to `GateLegRequest`**

In `apps/fleet/src/gate/leg-env.ts`:

```ts
export interface GateLegRequest {
  // ...every existing field, unchanged...
  /** #1398: which protocol this leg's /run-leg call uses. Absent means
   *  "sync-legacy" -- every existing caller (today's workflow.ts) is
   *  unaffected until a later task starts setting this explicitly. */
  mode?: "sync-legacy" | "async-poll";
  /** #1398: the GATE_WORKFLOW instance this attempt belongs to -- used ONLY
   *  by the async path's superseded-run check (a later task), never to
   *  address an event (there is no event, spec Non-goals). */
  instanceId?: string;
}
```

- [ ] **Step 2: Branch `do.ts`'s `/run-leg` handler**

In `apps/fleet/src/gate/do.ts`, the existing handler keeps its two synchronous early-outs (git token, secrets) UNCHANGED, then branches:

```ts
export class GateRunnerDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run-leg" && req.method === "POST") {
      const body = (await req.json()) as GateLegRequest;
      let gitToken: string | undefined;
      try {
        gitToken = await legGitToken(body, (repo) => mintPrivateCloneToken(this.env, repo));
      } catch (err) {
        const message = err instanceof Error && err.message === PAT_ONLY_REFUSAL
          ? PAT_ONLY_REFUSAL
          : "private clone token unavailable";
        const failed: LegResult = { state: "error", description: message };
        return Response.json(failed);
      }
      const secretValues = await resolveGrantedSecrets(
        body.secretNames ?? [], this.env as unknown as Record<string, string | undefined>, mintAiToken(body, this.env),
      );
      const unresolved = firstUnresolvedSecret(body.secretNames ?? [], secretValues);
      if (unresolved !== null) {
        const failed: LegResult = { state: "error", description: `DID-NOT-RUN: secret "${unresolved}" unresolved` };
        return Response.json(failed);
      }
      const outbound = workerExports.GateOutbound({ props: gateOutboundProps(body, gitToken, secretValues) });
      if (body.mode === "async-poll") {
        return this.startAsyncLeg(body, outbound, secretValues);
      }
      // #1398: unchanged -- the OLD synchronous path, exactly as today.
      const outcome = await runLegWithSecrets(body.secretNames ?? [], secretValues, () =>
        runLegInContainer(body, {
          container: this.ctx.container, outbound, readResult: legResultReader(this.env.STUDIO_ARCHIVE), secretValues,
        }));
      return legResponse(outcome);
    }
    return new Response("not found", { status: 404 });
  }

  /** #1398: the async path's own /run-leg half -- starts the container,
   *  persists this attempt's state (and secretValues, for the eventual
   *  terminal redaction, a later task) to ctx.storage, schedules the first
   *  alarm, answers 202. Resolution failures (git token, secret) are already
   *  handled above this call -- by the time this runs, a container IS about
   *  to start.
   *
   *  #1398 plan review r1 BLOCKER 3: IDEMPOTENT. If `alarmState` already
   *  exists for this DO (a retried/duplicate /run-leg POST -- e.g. the
   *  original request succeeded server-side but its RESPONSE was lost,
   *  causing Workflows to treat the dispatch step as failed and retry it),
   *  this answers 202 again WITHOUT starting a second container. Every
   *  /run-leg POST targets a freshly-named DO per attempt (gateRunnerName),
   *  so an already-populated alarmState can ONLY mean "I already handled
   *  this exact attempt" -- never a different attempt's leftover state. */
  private async startAsyncLeg(
    body: GateLegRequest, outbound: ReturnType<typeof workerExports.GateOutbound>, secretValues: Record<string, string>,
  ): Promise<Response> {
    const existing = await this.ctx.storage.get<RunLegAlarmState>("alarmState");
    if (existing !== undefined) return new Response(null, { status: 202 });
    const started = await startLegContainer(body, {
      container: this.ctx.container, outbound, secretValues, inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
    });
    if (started.kind === "infra") {
      return new Response(JSON.stringify({ error: started.description }), { status: 503 });
    }
    const state: RunLegAlarmState = {
      phase: "waiting-for-ready", resultKey: body.resultKey, leg: body.leg, timeoutMin: body.timeoutMin,
      readyStartedAt: Date.now(), instanceId: body.instanceId ?? "", statusCheckCount: 0, consecutiveFailures: 0,
    };
    await this.ctx.storage.put("alarmState", state);
    await this.ctx.storage.put("secretValues", secretValues); // Task 9 reads+deletes this at the terminal tick
    await this.ctx.storage.setAlarm(Date.now() + ALARM_TICK_MS);
    return new Response(null, { status: 202 });
  }
  // /run-leg is synchronous by design for the sync-legacy path; the async
  // path's reply is just an accept -- the real leg result arrives in R2.
}
```

Add the needed imports at the top of `do.ts`: `startLegContainer` and `ALARM_TICK_MS` from `./run-leg`/`./run-leg-alarm` respectively, `type RunLegAlarmState` from `./run-leg-alarm`. Define `const INACTIVITY_TIMEOUT_MS = 2 * ALARM_TICK_MS;` (comfortably past one tick interval, per spec "Container lifetime").

**Add one more fix while this file is open (plan review r1 BLOCKER 3, second half): this task does NOT touch `workflow.ts`'s own dispatch closure (that is Task 11's own file) — flag it here so Task 11's own author does not skip it: a non-2xx, non-202 `/run-leg` response must THROW inside the dispatch step's own callback, never be spread into a state-less `LegRunResult` (a 503 body is `{error: "..."}`, which has no `state` field at all). Task 11's own code block already reflects this fix; this note exists so the two tasks are read together, not independently.**

- [ ] **Step 3: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit`
Expected: clean. (No bun-test project check needed for `do.ts` itself — it is excluded from the bun-typed project per that tsconfig's own `exclude` list; the MAIN `tsc --noEmit` is what type-checks it.)

- [ ] **Step 4: Manual smoke check (no automated test for this file directly)**

Run: `cd apps/fleet && grep -n "mode" src/gate/leg-env.ts src/gate/do.ts`
Confirm every new field/branch reads exactly as written above — `do.ts` has no unit tests of its own (its only coverage is the engine tests, Task 12, and the fact that every function it CALLS is already independently tested).

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/do.ts apps/fleet/src/gate/leg-env.ts
git commit -m "feat(gate): wire GateRunnerDO's /run-leg to the async path, behind body.mode

#1398: GateLegRequest gains an optional mode ('sync-legacy' default,
'async-poll' new) and instanceId. The two existing synchronous refusals
(git token, unresolved secret) are UNCHANGED and still answer before any
container starts, for either mode. When mode is 'async-poll', /run-leg now
starts the container via startLegContainer (never waits for readiness),
persists this attempt's RunLegAlarmState + secretValues to ctx.storage,
schedules the first alarm, and answers 202 -- it never holds the request
open. Absent mode keeps every existing caller on the exact old path.

Refs #1398, #1396."
```

