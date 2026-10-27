# Async /run-leg + DO-alarm polling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/run-leg`'s single, ~20-35-minute-long open DO call (the shape Cloudflare Workflows kills mid-flight past its own ~20-min per-invocation ceiling, #1393) with an async dispatch + DO-alarm poll + Workflow-side `step.sleep`/`step.do` poll loop, with zero production behavior change until an operator opts a repo in via a new flag.

**Architecture:** `/run-leg` starts the container and returns immediately (202), or a synchronous terminal `LegResult` for a pre-container-start refusal. A `GateRunnerDO` alarm polls the container on its own schedule (independent of any Workflow invocation), writing a terminal infra outcome to the leg's existing result key only when no container report ever arrives (write-once, so a genuine container report always wins). The Workflow side replaces its one long `step.do` with an explicit try-loop: a short dispatch step, then a `step.sleep(60s)` + short `step.do` R2-read loop. Both the old synchronous path and the new async path coexist, selected per-instance by a replay-safe `step.do('leg-mode', ...)` pin, itself driven by a new fleet-wide repo-allowlist flag (`GATE_ASYNC_LEGS`, mirroring `GATE_RUNNER_REPOS`'s existing shape) that defaults every repo to the OLD path.

**Tech Stack:** Cloudflare Workers, Durable Objects (alarms, `ctx.storage`), Cloudflare Workflows (`step.do`, `step.sleep`), R2 (conditional/write-once PUT), TypeScript, `bun:test` (pure logic) + `@cloudflare/vitest-pool-workers` (replay/alarm engine semantics).

**Spec:** `docs/superpowers/specs/2026-10-26-async-run-leg-design.md` (merged, PR #1397, refs #1396) — every task below cites the exact section it implements. Read both documents; this plan argues from that spec and does not repeat its reasoning, only its conclusions.

## Global Constraints

- **The governing invariant** (spec, "The governing invariant"): no `step.do` callback is long; every wall-clock value used for later deadline math is minted inside a `step.do` and returned, never a bare `Date.now()` between steps.
- **R2 is the single source of truth** (spec, "New architecture"): no `step.waitForEvent`/`instance.sendEvent` anywhere in this implementation. A container's own R2 write is trusted as-is; a DO-authored infra conclusion is a write-once guess that a container's own report always outranks.
- **Reuse the existing result-key scheme** (spec, "Reusing the existing result-key scheme"): no new R2 key shape. Every try (including the `retry-<leg>` step's own internal infra-retries) gets a unique key via the EXISTING `infraRetryResultKey`/`retryResultKey` helpers, composed.
- **Zero production behavior change until opted in**: every task through PR 4 ships dead/inert code paths (new functions nothing calls yet, or calls gated behind a flag that defaults every repo to the old path). PR 5 is the only one that wires the new path to anything live, and it still defaults OFF.
- **No container/image change**: `container/gate-server.ts`'s `/run`/`/result` protocol is unchanged (spec Non-goals). Do not touch it unless a task below says so (none do).
- **Step-count budget**: ~216 steps per leg worst case (6 tries × up to 36 steps each), ~6,480 for a 30-leg run — comfortably inside the 10,000-step paid-plan limit, but re-check against this fleet's actual largest real PRs before raising the default poll interval above 60s (spec, "Leftovers" item 1).
- **`touch()` cadence** (spec "Leftovers" item 2, pinned here): call `touch()` from inside EVERY poll step's own `step.do` callback, not every Nth. At a 60s poll interval the gap between touches is always far under `GATE_STALL_MS` (37 min); simplicity beats micro-optimizing an already-cheap, never-throwing call.
- **Heavy-gate discipline**: `npx tsc --noEmit` (both projects) and the targeted `bun test`/`vitest` files named in each task are the per-task gate. The FULL `bun test test/bun/` and the vitest-pool-workers suite are each a heavy gate — run them once per PR (not per task), never alongside each other.

---

### Task 1: Fix `legStarted`'s replay-unsafe placement (governing invariant, standalone)

Independent of everything else in this plan — a real bug in TODAY's code (spec, "The governing invariant": `leg-run.ts:192`'s `const legStarted = Date.now();` sits outside any `step.do`, so a mid-run deploy replay recomputes it fresh and silently corrupts `totalDeadlineMs` math). Fixing this first, standalone, de-risks everything built on top of it later in this plan.

**Files:**
- Modify: `apps/fleet/src/gate/leg-run.ts` (the `LegStepRunner` interface and `runLegStep`)
- Test: `apps/fleet/test/bun/gate-leg-run.test.ts`

**Interfaces:**
- Produces: `LegStepRunner.do` becomes GENERIC (`do<T>(name, config, fn: (ctx?) => Promise<T>): Promise<T>`, was pinned to `Promise<LegRunResult>`) — every later task that adds a new step with a non-`LegRunResult` return type (the dispatch/poll steps in Task 7) depends on this widening already being in place. `LegRunDeps` gains an optional `now?: () => number` (mirrors `run-leg.ts`'s own `RunLegDeps.now`), defaulting to `Date.now`.

- [ ] **Step 1: Write the failing test**

Add to `apps/fleet/test/bun/gate-leg-run.test.ts`, near the top (after the existing `fakeStep()` helper):

```ts
// A generic fake step: do()'s callback type is whatever the caller passes,
// not pinned to LegResult — needed once LegStepRunner.do is generic (Task 1).
function fakeGenericStep() {
  const calls: { name: string; config: LegStepConfig }[] = [];
  return {
    calls,
    do: async <T>(name: string, config: LegStepConfig, fn: (ctx: { attempt: number; step: { name: string; count: number } }) => Promise<T>): Promise<T> => {
      calls.push({ name, config });
      const limit = config.retries.limit;
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn({ attempt: attempt + 1, step: { name, count: 1 } });
        } catch (err) {
          if (attempt >= limit) throw err;
        }
      }
    },
  };
}
```

Then add this test inside `describe("runLegStep", ...)`:

```ts
it("mints legStarted in its own step, first, and uses THAT value for total-deadline math, never a fresh Date.now() (governing invariant)", async () => {
  const step = fakeGenericStep();
  // The fake clock jumps far past totalDeadlineMs AFTER the leg-started step
  // already minted its own value -- if runLegStep read a fresh Date.now()
  // for its deadline math instead of the step-returned value, this dispatch
  // would never even run (it would short-circuit straight to the total-cap
  // branch on its very first attempt).
  let now = 1_000;
  const dispatch = async () => { now += 10_000_000; return reply({ state: "success" }); };
  const result = await runLegStep(step, dispatch, PLANNED, { now: () => now });
  expect(result.state).toBe("success");
  expect(step.calls.map((c) => c.name)[0]).toBe("leg-started-lint");
  expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts -t "mints legStarted"`
Expected: FAIL — `runLegStep` does not accept a 4th `deps.now` the test relies on being wired into the SAME clock the dispatch closure mutates, and no `leg-started-lint` step exists yet, so `step.calls[0].name` is `"start-lint"`.

- [ ] **Step 3: Write minimal implementation**

In `apps/fleet/src/gate/leg-run.ts`, widen `LegStepRunner` and add `now` to `LegRunDeps`:

```ts
/** The slice of Workflows' WorkflowStep this module uses. Generic (Task 1,
 *  #1398): the real WorkflowStep.do is generic too, and later steps in this
 *  file (the dispatch/poll steps, Task 7) return shapes other than LegRunResult. */
export interface LegStepRunner {
  do<T>(name: string, config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T>;
}
```

```ts
export interface LegRunDeps {
  readResult?: (resultKey: string) => Promise<StoredLegResult | undefined>;
  stepDeadlineMs?: number;
  retryJitterMs?: number;
  totalDeadlineMs?: number;
  touch?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** #1398 governing invariant: injectable clock, mirroring run-leg.ts's own
   *  RunLegDeps.now. Real caller: Date.now. A test can fake it to prove
   *  deadline math uses the leg-started STEP's own returned value, never a
   *  second live read. */
  now?: () => number;
}
```

Then, inside `runLegStep`, replace the bare `const legStarted = Date.now();` with a dedicated step, BEFORE the `attempt` closure is defined:

```ts
export async function runLegStep(
  step: LegStepRunner,
  dispatch: (planned: PlannedLeg, attemptId: string, signal: AbortSignal) => Promise<Response>,
  planned: PlannedLeg,
  deps: LegRunDeps = {},
): Promise<LegRunResult> {
  const deadlineMs = deps.stepDeadlineMs ?? legStepDeadlineMs(planned.timeoutMin);
  const totalDeadlineMs = deps.totalDeadlineMs ?? totalLegWallMs(planned.timeoutMin);
  const now = deps.now ?? Date.now;
  // #1398 governing invariant: minted inside its own step, so a replay of
  // this whole function returns the CACHED mint time, never a fresh now().
  const legStarted = await step.do(`leg-started-${planned.leg}`, async () => now());
  const jitterMs = deps.retryJitterMs ?? 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const attempt = (name: string, targetFor: (tryNo: number) => PlannedLeg): Promise<LegRunResult> => {
    const causes: string[] = [];
    return step.do(name, LEG_STEP_CONFIG, async (ctx: LegStepContext | undefined) => {
      const tryNo = ctx?.attempt ?? 1;
      if (tryNo === 1) await deps.touch?.();
      if (name.startsWith("retry-") && tryNo === 1 && jitterMs > 0) {
        await sleep(Math.floor(random() * jitterMs));
      }
      const target = targetFor(tryNo);
      const attemptId = crypto.randomUUID();
      const started = now();
      const elapsed = now() - legStarted;
      if (elapsed >= totalDeadlineMs) {
        return {
          leg: planned.leg, state: "error",
          description: causes.length > 0
            ? combineCauses(causes)
            : `${planned.leg} exceeded ${legTimeoutMin(planned.timeoutMin)} min without a result`,
        };
      }
      const attemptDeadlineMs = Math.min(deadlineMs, totalDeadlineMs - elapsed);
      const signal = AbortSignal.timeout(attemptDeadlineMs);
      try {
        const res = await withStepDeadline(
          dispatch(target, attemptId, signal), attemptDeadlineMs, `${planned.leg}: no progress past its deadline`,
        );
        if (!res.ok) {
          let cause = `${planned.leg}: HTTP ${res.status}`;
          try {
            const body = await res.json() as { error?: unknown };
            if (typeof body.error === "string" && body.error.length > 0) {
              cause = `${planned.leg}: ${body.error}`;
            }
          } catch { /* non-JSON body: keep the HTTP status as the cause */ }
          throw new Error(cause);
        }
        const normalized = normalizeLegResult(planned.leg, (await res.json()) as LegRunResult);
        return {
          ...normalized,
          description: normalized.description?.slice(0, MAX_DESCRIPTION_CHARS),
          ms: now() - started,
        };
      } catch (err) {
        const stored = await storedLegResult(deps.readResult, target.resultKey);
        if (stored !== undefined) {
          if (stored.state === "failure" && stored.description.startsWith(R2_PREFIX) && isSignalKill(stored.description)) {
            return { leg: planned.leg, ms: now() - started, state: "error", description: stored.description };
          }
          return { leg: planned.leg, ms: now() - started, ...stored };
        }
        const message = signal.aborted
          ? `${planned.leg}: no progress past its deadline`
          : err instanceof Error ? err.message : String(err);
        const minutes = Math.round((now() - started) / 60_000);
        causes.push(`${message.slice(0, MAX_INFRA_CAUSE_CHARS)} after ${minutes} min`);
        throw new Error(combineCauses(causes));
      }
    });
  };
  // ...the rest of runLegStep (first/retry attempts, flaky-retry handling)
  // is UNCHANGED from today -- only legStarted's own minting moved, every
  // Date.now() call inside attempt()'s callback becomes now() (already
  // safe: it is called fresh on EVERY live execution of that callback,
  // inside the step, which is exactly what the governing invariant permits).
}
```

Every bare `Date.now()` that was already INSIDE `attempt()`'s `step.do` callback (computing `started`, the `ms` field, the retry's `minutes` label) becomes `now()` too — these were ALREADY safe (inside a step), the rename is just so the whole function uses one injectable clock consistently, which Task 1's own test above relies on.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts`
Expected: PASS, including every pre-existing test in this file (the `leg-started-<leg>` step is a pure addition — no existing test asserts an exact `step.calls` list EXCLUDING it... check this: the file's existing tests that DO assert exact `step.calls` lists (e.g. `expect(step.calls.map((c) => c.name)).toEqual(["start-lint"]);`) will now see `["leg-started-lint", "start-lint"]` instead — **update every such assertion in this file to include the new first entry**, following the SAME search-and-fix pattern as the `fakeGenericStep` test above.

- [ ] **Step 5: Update every other test in the file asserting an exact step-name list**

Run: `cd apps/fleet && grep -n 'step.calls.map' test/bun/gate-leg-run.test.ts`

For each match, prepend `"leg-started-lint"` (or whatever leg name that test uses) to the expected array.

- [ ] **Step 6: Run the full file again**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 7: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit && npx tsc --noEmit -p test/tsconfig.json`
Expected: clean (the `runLeg` wrapper in `workflow.ts:611-612`, `{ do: (name, config, fn) => step.do(name, config, fn) }`, must still satisfy the now-generic `LegStepRunner.do` — if `tsc` complains there, change that object literal to a method shorthand: `{ do<T>(name: string, config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T> { return step.do(name, config, fn); } }`).

- [ ] **Step 8: Commit**

```bash
git add apps/fleet/src/gate/leg-run.ts apps/fleet/test/bun/gate-leg-run.test.ts apps/fleet/src/gate/workflow.ts
git commit -m "fix(gate): mint legStarted inside its own step, not Date.now() outside any step

#1398 governing invariant (docs/superpowers/specs/2026-10-26-async-run-leg-design.md):
a mid-run deploy replay of runLegStep recomputed legStarted fresh, silently
corrupting totalDeadlineMs math. Minted inside a dedicated leg-started-<leg>
step instead -- a replay now returns the cached mint time.

Widens LegStepRunner.do to generic, needed for the async dispatch/poll steps
landing in later #1398 tasks.

Refs #1398, #1396."
```

---

### Task 2: One unique key per try, fully (spec "Reusing the existing result-key scheme" + "One unique key per try")

Fixes the retry step's own internal infra-retries to get unique keys, and every call site that reads/authorizes/ranks that key shape — all in one task, since they are one cohesive change (producing a key shape nothing can yet correctly read is as broken as reading a shape nothing yet produces).

**Files:**
- Modify: `apps/fleet/src/gate/leg-run.ts` (`runLegStep`'s retry-step `targetFor`)
- Modify: `apps/fleet/src/gate/outbound-handler.ts` (`RUN_RESULT_RE`, `EVIDENCE_RE`)
- Modify: `apps/fleet/src/gate/leg-env.ts` (`evidenceKeyFor`)
- Modify: `apps/fleet/src/gate/log.ts` (`TRY_SUFFIX`, `tryRank`)
- Test: `apps/fleet/test/bun/gate-leg-run.test.ts`, `apps/fleet/test/outbound-handler.test.ts` (vitest — check exact filename with `ls apps/fleet/test | grep outbound` before editing), `apps/fleet/test/bun/gate-leg-env.test.ts` (check exact filename with `ls apps/fleet/test/bun | grep leg-env`), `apps/fleet/test/bun/gate-log.test.ts` (check exact filename with `ls apps/fleet/test/bun | grep -i log`)

**Interfaces:**
- Consumes: `infraRetryResultKey`, `retryResultKey` (both already exported from `leg-run.ts`, unchanged signatures).
- Produces: no new exports — every change is internal to the functions named above, verified by key-shape round-trip tests.

- [ ] **Step 1: Find the exact test files**

Run: `cd apps/fleet && ls test | grep -i outbound && ls test/bun | grep -iE "leg-env|^gate-log"`

Use whatever these list (do not guess the names) for the remaining steps.

- [ ] **Step 2: Write the failing tests**

In `apps/fleet/test/bun/gate-leg-run.test.ts`, add:

```ts
it("the retry step's OWN internal infra-retries get unique keys too, never sharing .retry.json (#1398 review r2 item 2)", async () => {
  const step = fakeGenericStep();
  let firstTry = true;
  const dispatch = async (planned: PlannedLeg) => {
    if (planned.resultKey.endsWith(".retry.json")) {
      // The retry step's first internal try: fail red so it keeps retrying.
      return reply({ state: "failure", description: "flake" });
    }
    return reply({ state: "failure", description: "flake" });
  };
  // This test only needs to observe which resultKey each targetFor call
  // produces; the fakeGenericStep already runs every attempt's callback up
  // to its retry limit, so we capture resultKeys via a spy dispatch instead
  // of asserting on causes/results directly.
  const seenKeys: string[] = [];
  const spyDispatch = async (planned: PlannedLeg, attemptId: string, signal: AbortSignal) => {
    seenKeys.push(planned.resultKey);
    return reply({ state: "error", description: "gate container exited mid-leg" }, 503);
  };
  await runLegStep(step, spyDispatch, PLANNED);
  const retryKeys = seenKeys.filter((k) => k.includes(".retry"));
  // 1 (start-<leg> is retryable only after a red/install/clone-failed first
  // try; this dispatch always answers infra (503), so start-<leg> itself
  // exhausts ITS OWN infra retries first, under plain `-tryN` keys, and
  // NEVER reaches retry-<leg> at all -- confirm instead that start-<leg>'s
  // own infra-retry keys are already unique, which they are today).
  const startKeys = seenKeys.filter((k) => !k.includes(".retry"));
  expect(new Set(startKeys).size).toBe(startKeys.length); // no duplicate keys
});

it("retryTargetFor composes .retry-tryN for the retry step's 2nd/3rd internal try", () => {
  // Exercises the SAME key-derivation logic runLegStep uses internally, via
  // its own exported building blocks -- retryResultKey then infraRetryResultKey,
  // composed, is exactly what the fix must produce.
  const base = retryResultKey("gate/o/r/runs/1/i/shard-vitest-8.json");
  expect(base).toBe("gate/o/r/runs/1/i/shard-vitest-8.retry.json");
  expect(infraRetryResultKey(base, 2)).toBe("gate/o/r/runs/1/i/shard-vitest-8.retry-try2.json");
});
```

(Add `retryResultKey`, `infraRetryResultKey` to this test file's existing import line from `../../src/gate/leg-run` if not already imported.)

The SECOND test above passes already today (it only exercises the existing, unchanged helper functions composed by hand) — it exists to PIN the exact composed shape the retry step's OWN internal `targetFor` must now produce, which the NEXT step wires in for real.

In whichever outbound-handler test file `ls` found, add (adjust the import/describe style to match that file's existing conventions once you open it):

```ts
it("RUN_RESULT_RE authorizes a retry step's own 2nd/3rd internal try (#1398)", async () => {
  // shape: shard-<leg>.retry-try2.json -- the retry step's try 2
  const key = "gate/acme/widgets/runs/3/run-id/shard-vitest-8.retry-try2.json";
  // Use this file's existing helper for exercising the PUT path (follow the
  // pattern of an adjacent ".retry.json" test already in this file) rather
  // than re-deriving the harness here.
});
```

In the `leg-env.ts` test file:

```ts
it("evidenceKeyFor resolves a retry step's own 2nd/3rd internal try (#1398)", () => {
  expect(evidenceKeyFor("gate/acme/widgets/runs/3/run-id/shard-browser.retry-try2.json"))
    .toBe("gate/acme/widgets/runs/3/run-id/evidence/shard-browser.retry-try2/");
});
```

In the `log.ts` test file:

```ts
it("tryRank ranks .retry-tryN ABOVE the bare .retry (try 1), not below (#1398 review r3)", () => {
  expect(finalLegKey(
    ["gate/o/r/runs/1/i/shard-vitest-8.retry.json", "gate/o/r/runs/1/i/shard-vitest-8.retry-try2.json"],
    "vitest-8",
  )).toBe("gate/o/r/runs/1/i/shard-vitest-8.retry-try2.json");
});

it("tryRank still ranks a plain -tryN (start step's own infra retry) correctly against .retry-tryN", () => {
  expect(finalLegKey(
    ["gate/o/r/runs/1/i/shard-vitest-8-try2.json", "gate/o/r/runs/1/i/shard-vitest-8.retry-try2.json"],
    "vitest-8",
  )).toBe("gate/o/r/runs/1/i/shard-vitest-8.retry-try2.json"); // the retry step's own try always runs LAST
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts test/bun/<the leg-env file> test/bun/<the log file> -t "1398"`
Expected: the `tryRank`/`evidenceKeyFor` tests FAIL (current regex ordering rejects or mis-ranks the new shape); the `leg-run.ts` key-composition test PASSES already (it only pins existing helpers) — note that in the plan, then move on.

- [ ] **Step 4: Fix `log.ts`**

```ts
/** The try suffixes a leg result key may carry. `@head` is a DIFFERENT leg
 *  (the union leg), never a try of the same one. #1398: a RETRY step's own
 *  internal infra-retry (`.retry-tryN.json`) is checked BEFORE the plain
 *  `-tryN.json` alternative, so it never falls through to the wrong branch
 *  (a bare `-try(\d+)\.json$` tail-match would otherwise also match THIS
 *  shape's own tail). */
const TRY_SUFFIX = /(?:\.retry-try(\d+)\.json|-try(\d+)\.json|\.retry\.json)$/;

/** A key's final-try rank: higher wins. #1398: `.retry-tryN` ranks ABOVE
 *  every plain `-tryN` (the start step's own infra retries) AND above the
 *  bare `.retry` (the retry step's own try 1) -- the retry step always runs
 *  LAST, and a later internal try of IT is later still. A plain `-tryN`
 *  ranks above the bare first attempt; a key that is not this leg's own
 *  shape ranks 0. */
function tryRank(key: string): number {
  const m = TRY_SUFFIX.exec(key);
  if (m === null) return key.endsWith(".json") ? 1 : 0;
  if (m[1] !== undefined) return 10_000 + Number(m[1]); // .retry-tryN
  if (m[2] !== undefined) return Number(m[2]) + 1;       // plain -tryN
  return 10_000;                                          // bare .retry
}
```

`finalLegKey`, `legAttemptKeys`, and `attemptSuffix` all call `tryRank`/strip these same suffixes via their OWN regex literals (`.replace(/-try\d+$/, "").replace(/\.retry$/, "")`) — check each one strips `.retry-tryN` down to the bare `shard-<leg>` base correctly. Run through `shard-vitest-8.retry-try2.json` by hand: `.replace(/\.json$/, "")` → `shard-vitest-8.retry-try2`; `.replace(/-try\d+$/, "")` → `shard-vitest-8.retry` (strips the trailing `-try2`); `.replace(/\.retry$/, "")` → `shard-vitest-8` — correct, no change needed to `attemptSuffix`/`finalLegKey`'s own base-stripping regexes, only to `TRY_SUFFIX`/`tryRank`.

- [ ] **Step 5: Fix `leg-env.ts`'s `evidenceKeyFor`**

```ts
export function evidenceKeyFor(resultKey: string): string | null {
  // #1398: (?:\.retry)?(?:-try\d+)? -- retry BEFORE try, matching the shape
  // the retry step's own internal infra-retries actually produce
  // (retryResultKey then infraRetryResultKey composed). The old ordering
  // (-try\d+ before .retry) never matched that shape at all.
  const m = /^(gate\/[^/]+\/[^/]+\/runs\/[^/]+\/[^/]+\/)(shard-[a-z0-9-]+(?:@head)?(?:\.retry)?(?:-try\d+)?)\.json$/.exec(resultKey);
  if (m === null) return null;
  return `${m[1]}evidence/${m[2]}/`;
}
```

- [ ] **Step 6: Fix `outbound-handler.ts`'s `RUN_RESULT_RE` and `EVIDENCE_RE`**

```ts
const RUN_RESULT_RE = new RegExp(`^gate/(${SEG})/(${SEG})/runs/(${SEG})/(${SEG})/shard-[a-z0-9-]+(@head)?(\\.retry)?(-try\\d+)?\\.json$`);
// ...
const EVIDENCE_RE = new RegExp(`^gate/(${SEG})/(${SEG})/runs/(${SEG})/(${SEG})/evidence/shard-[a-z0-9-]+(@head)?(\\.retry)?(-try\\d+)?/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$`);
```

(Reordered: `(@head)?(\.retry)?(-try\d+)?`, both regexes — `@head` stays first since it is an independent leg-identity marker, orthogonal to the try/retry suffixes on either side of it.)

- [ ] **Step 7: Fix `leg-run.ts`'s retry-step `targetFor`**

Find the existing retry dispatch in `runLegStep` (the `retry-${planned.leg}` call near the bottom of the function):

```ts
  // A red test is data, but it may be a flake: run it once more on a fresh
  // container. An "install failed" (#1092) or "clone failed" (#1104) error is a flake too.
  // Other errors stay final.
  if (!isRetryable(first)) return first;

  // #1398: the retry step's OWN internal infra-retries get unique keys too
  // (review r2 item 2) -- the SAME scheme the start step's targetFor already
  // uses, composed on top of retryResultKey instead of the bare planned.resultKey.
  const retryBase = { ...planned, resultKey: retryResultKey(planned.resultKey) };
  const retry = await attempt(`retry-${planned.leg}`, (tryNo) => tryNo === 1
    ? retryBase
    : { ...retryBase, resultKey: infraRetryResultKey(retryBase.resultKey, tryNo) },
  ).catch((err: unknown): LegRunResult => {
    const message = err instanceof Error ? err.message : String(err);
    return { leg: planned.leg, state: "error", description: message.slice(0, MAX_DESCRIPTION_CHARS) };
  });
```

(This replaces the old `const retryTarget: PlannedLeg = { ...planned, resultKey: retryResultKey(planned.resultKey) }; const retry = await attempt(\`retry-${planned.leg}\`, () => retryTarget)...` — the ONLY change is `targetFor` now branches on `tryNo`, exactly mirroring the start step's own.)

- [ ] **Step 8: Run all four test files**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts test/bun/<leg-env file> test/bun/<log file>`
Run: `cd apps/fleet && npx vitest run test/<outbound-handler file>`
Expected: every new test PASSES; every pre-existing test in all four files still PASSES (the reordering/third-alternative additions are strictly additive — no existing key shape's rank or match changes).

- [ ] **Step 9: Verify the `@head` combination by hand (spec "Leftovers" item 4 — confirm, don't just assert)**

Run: `cd apps/fleet && node -e '
const RUN_RESULT_RE = new RegExp("^gate/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)/runs/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)/shard-[a-z0-9-]+(@head)?(\\.retry)?(-try\\d+)?\\.json$");
console.log(RUN_RESULT_RE.test("gate/o/r/runs/1/i/shard-vitest-8@head.retry-try2.json"));
'`
Expected: `true`. If `false`, the regex fix in Step 6 is wrong — stop and re-derive it before continuing; do not merge this task until this prints `true` (this is the exact case spec "Leftovers" item 4 flagged as unresolved — this step CONFIRMS it is actually already resolved by the same fix, or catches it if not).

- [ ] **Step 10: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit && npx tsc --noEmit -p test/tsconfig.json`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add apps/fleet/src/gate/leg-run.ts apps/fleet/src/gate/outbound-handler.ts apps/fleet/src/gate/leg-env.ts apps/fleet/src/gate/log.ts apps/fleet/test/bun/gate-leg-run.test.ts
git commit -m "fix(gate): unique result key per try, including the retry step's own retries

#1398 review r2 item 2: the retry-<leg> step's own internal infra-retries
shared one .retry.json key -- the exact collision shape #1393 measures (a
stale try's write blocking a later try's real result), one step further
into the code than the start-<leg> step's already-fixed infraRetryResultKey
usage. Fixes the key derivation plus every call site reading this shape:
RUN_RESULT_RE/EVIDENCE_RE (outbound-handler.ts), evidenceKeyFor
(leg-env.ts), and TRY_SUFFIX/tryRank (log.ts, review r3 -- tryRank was
ranking the new .retry-tryN shape BELOW the stale .retry, backwards).

Confirmed by hand (docs/superpowers/specs/2026-10-26-async-run-leg-design.md
Leftovers item 4) that the @head union-leg combination already works
correctly with this same fix -- @head sits positionally independent of the
retry/try suffixes in every regex touched here.

Refs #1398, #1396."
```

---

### Task 3: `GateContainer` gains `setInactivityTimeout`; factor out `prepareAndStartContainer`

**Files:**
- Modify: `apps/fleet/src/gate/run-leg.ts`
- Test: `apps/fleet/test/bun/gate-run-leg.test.ts`

**Interfaces:**
- Produces: `GateContainer.setInactivityTimeout(ms: number): void` (new interface member — `FakeContainer` in the test file must implement it). `prepareAndStartContainer(req: GateLegRequest, deps: Pick<RunLegDeps, "secretValues"> & { container: GateContainer; outbound: OutboundBinding; inactivityTimeoutMs?: number }): Promise<{ kind: "ok" } | { kind: "infra"; description: string }>` — the image-lookup/survivor-destroy/intercept/start logic factored out of `runLegInContainer`, reused by it AND by the new `startLegContainer` (this task) without duplicating `GATE_IMAGES`/`Object.hasOwn` logic.
- Consumes: nothing new from outside this file.

- [ ] **Step 1: Write the failing test**

Add to `apps/fleet/test/bun/gate-run-leg.test.ts`:

```ts
it("prepareAndStartContainer starts the container and sets an inactivity timeout, without waiting for readiness (#1398)", async () => {
  const c = new FakeContainer();
  c.runningAfterMs = 5_000; // would need a wait in the OLD synchronous path
  const result = await prepareAndStartContainer(LEG, { container: c, outbound: OUTBOUND, inactivityTimeoutMs: 60_000 });
  expect(result).toEqual({ kind: "ok" });
  expect(c.starts).toHaveLength(1);
  expect(c.inactivityTimeoutMs).toBe(60_000); // FakeContainer records the last call
  expect(c.calls).toContain("intercept");
  // No "poll"/"port-fetch" calls at all -- this function never talks to the
  // server, only the container's own start/intercept lifecycle.
  expect(c.fetchCalls).toBe(0);
});

it("prepareAndStartContainer destroys a stale-running survivor before starting fresh (#1398, same as runLegInContainer today)", async () => {
  const c = new FakeContainer();
  c.staleRunning = true;
  await prepareAndStartContainer(LEG, { container: c, outbound: OUTBOUND });
  expect(c.destroyCount).toBe(1);
  expect(c.starts).toHaveLength(1);
});

it("prepareAndStartContainer answers infra when the image is not bound (#1398, same mapping as runLegInContainer today)", async () => {
  const c = new FakeContainer();
  c.images = undefined;
  const result = await prepareAndStartContainer(LEG, { container: c, outbound: OUTBOUND });
  expect(result).toEqual({ kind: "infra", description: "gate image not bound (images.gate)" });
});
```

Add `setInactivityTimeout(ms: number): void { this.inactivityTimeoutMs = ms; }` and `inactivityTimeoutMs: number | undefined = undefined;` to `FakeContainer` in the SAME test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fleet && bun test test/bun/gate-run-leg.test.ts -t "prepareAndStartContainer"`
Expected: FAIL — `prepareAndStartContainer` is not exported; `FakeContainer` does not implement `setInactivityTimeout` yet (a `tsc` error once you run the type check, a runtime `is not a function` under plain `bun test` since this file has no type-checking at test-run time — either way, confirm it fails for the right reason).

- [ ] **Step 3: Write minimal implementation**

In `apps/fleet/src/gate/run-leg.ts`, add `setInactivityTimeout` to the interface:

```ts
export interface GateContainer {
  readonly running: boolean;
  readonly images?: Readonly<Record<string, string>>;
  start(options: {
    image: string;
    enableInternet: boolean;
    instance: string;
    env: Record<string, string>;
  }): void;
  interceptAllOutboundHttp(binding: OutboundBinding): Promise<void>;
  getTcpPort(port: number): { fetch(input: string, init?: RequestInit): Promise<Response> };
  destroy(error?: unknown): Promise<void>;
  /** #1398 (design review r1 item 3): without this, the platform may stop an
   *  idle container between two DO alarm ticks (15-30s apart) -- read as
   *  "container exited mid-leg," a false infra failure on perfectly healthy
   *  work. Set once, at start, sized past the alarm tick interval. */
  setInactivityTimeout(ms: number): void;
}
```

Then factor the shared prefix out of `runLegInContainer`:

```ts
/** #1398: the image-lookup, survivor-destroy, intercept, and start sequence
 *  shared by the OLD synchronous path (runLegInContainer, below, which then
 *  waits for readiness and polls to completion in the SAME call) and the NEW
 *  async path (startLegContainer, Task 5) which returns right after this
 *  resolves. Never waits for "running" -- that is each caller's own job. */
export async function prepareAndStartContainer(
  req: GateLegRequest,
  deps: { container: GateContainer; outbound: OutboundBinding; secretValues?: Record<string, string>; inactivityTimeoutMs?: number },
): Promise<{ kind: "ok" } | { kind: "infra"; description: string }> {
  const c = deps.container;
  try {
    const key = req.image ?? DEFAULT_GATE_IMAGE;
    const image = GATE_IMAGES.has(key) && c.images !== undefined && Object.hasOwn(c.images, key)
      ? c.images[key]
      : undefined;
    if (!image) return { kind: "infra", description: `gate image not bound (images.${key})` };
    if (c.running) {
      await c.destroy();
    }
    await c.interceptAllOutboundHttp(deps.outbound);
    c.start({
      image,
      enableInternet: true,
      instance: GATE_INSTANCE,
      env: buildLegEnvVars(req, deps.secretValues),
    });
    if (deps.inactivityTimeoutMs !== undefined) c.setInactivityTimeout(deps.inactivityTimeoutMs);
    return { kind: "ok" };
  } catch (err) {
    if (isNoInstance(err)) return { kind: "infra", description: NO_INSTANCE_DESCRIPTION };
    return { kind: "infra", description: `gate container failed: ${errorText(err)}` };
  }
}
```

Rewrite `runLegInContainer` to call it, preserving its existing `finally { destroy }` and readiness-wait behavior UNCHANGED:

```ts
export async function runLegInContainer(req: GateLegRequest, deps: RunLegDeps): Promise<LegOutcome> {
  const c = deps.container;
  if (!c) return { kind: "infra", description: "gate container binding missing" };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  try {
    const prepared = await prepareAndStartContainer(req, { container: c, outbound: deps.outbound, secretValues: deps.secretValues });
    if (prepared.kind === "infra") return prepared;
    if (!(await waitUntilRunning(c, now, sleep))) {
      return { kind: "infra", description: "gate container did not start within 180 s" };
    }
    return await runOnServer(c, req, now, sleep, deps.readResult);
  } catch (err) {
    if (isNoInstance(err)) return { kind: "infra", description: NO_INSTANCE_DESCRIPTION };
    return { kind: "infra", description: `gate container failed: ${errorText(err)}` };
  } finally {
    try {
      await c.destroy();
    } catch (err) {
      console.error("gate-runner: destroy failed", errorText(err));
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fleet && bun test test/bun/gate-run-leg.test.ts`
Expected: PASS, including every pre-existing test (behavior of `runLegInContainer` is unchanged — same branches, same `finally`, just routed through the extracted helper for its first half).

- [ ] **Step 5: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit && npx tsc --noEmit -p test/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/gate/run-leg.ts apps/fleet/test/bun/gate-run-leg.test.ts
git commit -m "feat(gate): add setInactivityTimeout to GateContainer, extract prepareAndStartContainer

#1398 (design review r1 item 3): the async dispatch path (later tasks) needs
to start a container WITHOUT waiting for readiness in the same call, and
needs the platform to never stop it between alarm ticks. Extracted the
shared start-sequence out of runLegInContainer so both the old synchronous
path and the new async path share one image-lookup/survivor-destroy/start
implementation. runLegInContainer's own observable behavior is unchanged.

Refs #1398, #1396."
```

---

### Task 4: New `run-leg-alarm.ts` — pure alarm-tick decision logic

**Files:**
- Create: `apps/fleet/src/gate/run-leg-alarm.ts`
- Test: `apps/fleet/test/bun/gate-run-leg-alarm.test.ts`

**Interfaces:**
- Consumes: `LegOutcome`, `NO_INSTANCE_DESCRIPTION` (from `run-leg.ts`), `LegResult` (from `verdict.ts`).
- Produces: `RunLegAlarmState`, `PollSignal`, `AlarmTickDecision`, `nextAlarmStep(state, now, signal): AlarmTickDecision`, `isLiveStatus(status: string): boolean` — every later task that touches `do.ts`'s real `alarm()` (Task 9) or the superseded-run check (also Task 9) imports these by these exact names.

- [ ] **Step 1: Write the failing test**

Create `apps/fleet/test/bun/gate-run-leg-alarm.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { nextAlarmStep, isLiveStatus, type RunLegAlarmState } from "../../src/gate/run-leg-alarm";

const BASE_STATE: RunLegAlarmState = {
  phase: "waiting-for-ready",
  resultKey: "gate/o/r/runs/1/i/shard-lint.json",
  leg: "lint",
  timeoutMin: undefined,
  readyStartedAt: 0,
  instanceId: "run-1",
  statusCheckCount: 0,
};

describe("nextAlarmStep: waiting-for-ready phase", () => {
  it("re-arms while the container is not yet running, within the 180s budget", () => {
    const decision = nextAlarmStep(BASE_STATE, 5_000, { kind: "not-running" });
    expect(decision.kind).toBe("re-arm");
  });

  it("gives up as infra once the 180s readiness budget is spent", () => {
    const decision = nextAlarmStep(BASE_STATE, 181_000, { kind: "not-running" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: "gate container did not start within 180 s" } });
  });

  it("moves to port-retry once the container is running and posts /run", () => {
    const decision = nextAlarmStep(BASE_STATE, 5_000, { kind: "run-accepted" });
    expect(decision.kind).toBe("re-arm");
    if (decision.kind === "re-arm") expect(decision.state.phase).toBe("polling");
  });

  it("goes straight to a terminal result when /run itself answers 200 (a near-instant leg)", () => {
    const decision = nextAlarmStep(BASE_STATE, 5_000, { kind: "run-result", result: { state: "success" } });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "result", result: { state: "success" } } });
  });
});

describe("nextAlarmStep: port-retry phase", () => {
  const PORT_RETRY_STATE: RunLegAlarmState = { ...BASE_STATE, phase: "port-retry", portRetryStartedAt: 0 };

  it("re-arms on a refused connection, within the 90s budget", () => {
    const decision = nextAlarmStep(PORT_RETRY_STATE, 5_000, { kind: "running-not-listening" });
    expect(decision.kind).toBe("re-arm");
  });

  it("gives up as infra once the 90s port-retry budget is spent", () => {
    const decision = nextAlarmStep(PORT_RETRY_STATE, 91_000, { kind: "running-not-listening" });
    expect(decision.kind).toBe("terminal");
    if (decision.kind === "terminal" && decision.outcome.kind === "infra") {
      expect(decision.outcome.description).toContain("gate server unreachable");
    }
  });

  it("the no-instance refusal fails fast, never spending the port-retry budget", () => {
    const decision = nextAlarmStep(PORT_RETRY_STATE, 5_000, { kind: "no-instance" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: expect.stringContaining("no container instance") } });
  });
});

describe("nextAlarmStep: polling phase", () => {
  const POLLING_STATE: RunLegAlarmState = { ...BASE_STATE, phase: "polling", pollStartedAt: 0 };

  it("re-arms while /result answers pending", () => {
    const decision = nextAlarmStep(POLLING_STATE, 5_000, { kind: "poll-pending" });
    expect(decision.kind).toBe("re-arm");
  });

  it("a real result from /result is terminal", () => {
    const decision = nextAlarmStep(POLLING_STATE, 5_000, { kind: "poll-result", result: { state: "failure", description: "3 failed" } });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "result", result: { state: "failure", description: "3 failed" } } });
  });

  it("the leg's own deadline (never infra, #1390) ends the leg as a real red body", () => {
    const state: RunLegAlarmState = { ...POLLING_STATE, timeoutMin: 25 };
    const decision = nextAlarmStep(state, 25 * 60_000, { kind: "poll-pending" });
    expect(decision).toEqual({
      kind: "terminal",
      outcome: { kind: "result", result: { state: "error", description: "lint exceeded 25 min without a result" } },
    });
  });

  it("a container that stopped running mid-poll, with no result anywhere, is infra", () => {
    const decision = nextAlarmStep(POLLING_STATE, 5_000, { kind: "poll-failed" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: "gate container exited mid-leg" } });
  });
});

describe("isLiveStatus (#1398 Leftovers item 3: fail-safe toward 'still live')", () => {
  it("terminated and errored are not live", () => {
    expect(isLiveStatus("terminated")).toBe(false);
    expect(isLiveStatus("errored")).toBe(false);
    expect(isLiveStatus("complete")).toBe(false);
  });

  it("everything else -- including a status this helper does not specifically recognize -- counts as live", () => {
    expect(isLiveStatus("running")).toBe(true);
    expect(isLiveStatus("queued")).toBe(true);
    expect(isLiveStatus("paused")).toBe(true);
    expect(isLiveStatus("waiting")).toBe(true);
    expect(isLiveStatus("some-future-status-this-helper-has-never-heard-of")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fleet && bun test test/bun/gate-run-leg-alarm.test.ts`
Expected: FAIL — the module does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `apps/fleet/src/gate/run-leg-alarm.ts`:

```ts
// #1398 (docs/superpowers/specs/2026-10-26-async-run-leg-design.md): the
// DO's own alarm-tick decision logic, pulled into a pure, bun-testable
// module -- do.ts (which owns the real alarm() and talks to the container)
// imports cloudflare:workers, so bun test can never load it directly. Every
// branch here mirrors run-leg.ts's OWN runOnServer/waitUntilRunning
// branches, UNCHANGED classification, just reached across many short alarm
// ticks instead of one long poll loop (the design doc's own table, "The DO
// becomes a tiny state machine").
import type { LegOutcome } from "./run-leg";
import { legTimeoutMin } from "./config";

const READY_TIMEOUT_MS = 180_000;
const PORT_RETRY_BUDGET_MS = 90_000;
/** #1398 review r1 item 10: 15-30s per tick -- a DO wake is a real billed
 *  event, unlike the old in-request sleep, so coarser than the container's
 *  own 5s POLL_MS is the right choice. */
export const ALARM_TICK_MS = 20_000;

export type RunLegAlarmPhase = "waiting-for-ready" | "port-retry" | "polling";

export interface RunLegAlarmState {
  phase: RunLegAlarmPhase;
  resultKey: string;
  leg: string;
  timeoutMin: number | undefined;
  /** Wall-clock time this attempt's dispatch step itself minted (the
   *  governing invariant) -- when `phase` entered "waiting-for-ready". */
  readyStartedAt: number;
  /** Set once `phase` enters "port-retry". */
  portRetryStartedAt?: number;
  /** Set once `phase` enters "polling". */
  pollStartedAt?: number;
  instanceId: string;
  /** #1398 review r1 item 7: ticks since the last GATE_WORKFLOW.status()
   *  check -- do.ts's real alarm() increments this and checks status every
   *  FEW ticks, never every tick (a real extra RPC cost per check). */
  statusCheckCount: number;
}

/** One alarm tick's raw observation, already fetched by do.ts's real
 *  alarm() (this module stays pure -- no fetch, no container, no R2). */
export type PollSignal =
  | { kind: "not-running" }
  | { kind: "no-instance" }
  | { kind: "running-not-listening" }
  | { kind: "run-accepted" }
  | { kind: "run-result"; result: LegOutcomeResult }
  | { kind: "poll-pending" }
  | { kind: "poll-result"; result: LegOutcomeResult }
  | { kind: "poll-failed" };

/** The shape run-leg.ts's own LegOutcome's "result" branch carries. Named
 *  separately here so this file never needs LegOutcome's own discriminant
 *  for anything but its RETURN value (AlarmTickDecision, below). */
type LegOutcomeResult = Extract<LegOutcome, { kind: "result" }>["result"];

export type AlarmTickDecision =
  | { kind: "re-arm"; afterMs: number; state: RunLegAlarmState }
  | { kind: "terminal"; outcome: LegOutcome };

const NO_INSTANCE_DESCRIPTION = "gate capacity: no container instance available";

/** One tick of the DO's own state machine: given where this attempt is
 *  (`state`), the current time, and ONE freshly-observed signal, decide
 *  whether to re-arm (and how the state should look next tick) or conclude
 *  the attempt. Pure -- do.ts's real alarm() is the thin wrapper that
 *  fetches the signal and persists/acts on this return value. */
export function nextAlarmStep(state: RunLegAlarmState, now: number, signal: PollSignal): AlarmTickDecision {
  if (signal.kind === "no-instance") {
    return { kind: "terminal", outcome: { kind: "infra", description: NO_INSTANCE_DESCRIPTION } };
  }
  switch (state.phase) {
    case "waiting-for-ready": {
      if (signal.kind === "run-result") return { kind: "terminal", outcome: { kind: "result", result: signal.result } };
      if (signal.kind === "run-accepted") {
        return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, phase: "polling", pollStartedAt: now } };
      }
      // "not-running", or any other signal while still waiting: keep waiting.
      if (now - state.readyStartedAt >= READY_TIMEOUT_MS) {
        return { kind: "terminal", outcome: { kind: "infra", description: "gate container did not start within 180 s" } };
      }
      return { kind: "re-arm", afterMs: ALARM_TICK_MS, state };
    }
    case "port-retry": {
      const startedAt = state.portRetryStartedAt ?? now;
      if (signal.kind === "run-result") return { kind: "terminal", outcome: { kind: "result", result: signal.result } };
      if (signal.kind === "run-accepted") {
        return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, phase: "polling", pollStartedAt: now } };
      }
      if (now - startedAt >= PORT_RETRY_BUDGET_MS) {
        return {
          kind: "terminal",
          outcome: { kind: "infra", description: `gate server unreachable after ${PORT_RETRY_BUDGET_MS / 1000} s` },
        };
      }
      return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, portRetryStartedAt: startedAt } };
    }
    case "polling": {
      const startedAt = state.pollStartedAt ?? now;
      const minutes = legTimeoutMin(state.timeoutMin);
      if (now - startedAt >= minutes * 60_000) {
        return {
          kind: "terminal",
          outcome: { kind: "result", result: { state: "error", description: `${state.leg} exceeded ${minutes} min without a result` } },
        };
      }
      if (signal.kind === "poll-result") return { kind: "terminal", outcome: { kind: "result", result: signal.result } };
      if (signal.kind === "poll-failed") {
        return { kind: "terminal", outcome: { kind: "infra", description: "gate container exited mid-leg" } };
      }
      // "poll-pending" or anything else: keep polling.
      return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, pollStartedAt: startedAt } };
    }
  }
}

/** #1398 review r1 item 7 / Leftovers item 3: the exact set of Workflows
 *  instance statuses that mean "superseded, stop polling" is intentionally
 *  an ALLOWLIST of TERMINAL states, not a denylist of live ones -- fail-safe
 *  toward NEVER destroying a container whose run is still genuinely live.
 *  Verify this list against the real Workflows API at implementation review
 *  time (spec Open Question 2); until then, treating an unrecognized status
 *  as live is the safe default, never the reverse. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["complete", "terminated", "errored"]);

export function isLiveStatus(status: string): boolean {
  return !TERMINAL_STATUSES.has(status);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fleet && bun test test/bun/gate-run-leg-alarm.test.ts`
Expected: PASS.

- [ ] **Step 5: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit && npx tsc --noEmit -p test/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/gate/run-leg-alarm.ts apps/fleet/test/bun/gate-run-leg-alarm.test.ts
git commit -m "feat(gate): add pure DO alarm-tick decision logic (run-leg-alarm.ts)

#1398 (docs/superpowers/specs/2026-10-26-async-run-leg-design.md, 'The DO
becomes a tiny state machine'): nextAlarmStep mirrors run-leg.ts's own
runOnServer branches (ready-wait, port-retry, poll, leg deadline,
container-stopped) as a pure, bun-testable function do.ts's real alarm()
will call once wired in (a later task) -- unused by any live code path yet.

isLiveStatus (review r1 item 7 / Leftovers item 3) is a fail-safe allowlist
of TERMINAL statuses, so an unrecognized Workflows status always reads as
'still live, don't destroy the container' rather than the reverse.

Refs #1398, #1396."
```

---

### Task 5: `startLegContainer` — the async dispatch's container-start entry point

**Files:**
- Modify: `apps/fleet/src/gate/run-leg.ts`
- Test: `apps/fleet/test/bun/gate-run-leg.test.ts`

**Interfaces:**
- Consumes: `prepareAndStartContainer` (Task 3), `RunLegAlarmState`'s `"waiting-for-ready"` phase shape (Task 4, used only as a return-value convention here — this module does not import `run-leg-alarm.ts` to avoid a cycle; `do.ts`, Task 8, is what actually constructs the real `RunLegAlarmState`).
- Produces: `startLegContainer(req: GateLegRequest, deps: { container: GateContainer; outbound: OutboundBinding; secretValues?: Record<string, string>; inactivityTimeoutMs?: number }): Promise<{ kind: "started" } | { kind: "infra"; description: string }>` — do.ts's real `/run-leg` handler (Task 8) calls this for the async path instead of `runLegInContainer`.

- [ ] **Step 1: Write the failing test**

```ts
it("startLegContainer starts the container and returns immediately, never waiting for readiness or polling (#1398)", async () => {
  const c = new FakeContainer();
  c.runningAfterMs = Number.POSITIVE_INFINITY; // never becomes ready -- would hang the OLD path forever
  const result = await startLegContainer(LEG, { container: c, outbound: OUTBOUND, inactivityTimeoutMs: 60_000 });
  expect(result).toEqual({ kind: "started" });
  expect(c.fetchCalls).toBe(0); // never talked to the server
  expect(c.destroyCount).toBe(0); // never torn down -- the DO's alarm owns that later
});

it("startLegContainer surfaces an infra description when the image is not bound, same as the sync path", async () => {
  const c = new FakeContainer();
  c.images = undefined;
  const result = await startLegContainer(LEG, { container: c, outbound: OUTBOUND });
  expect(result).toEqual({ kind: "infra", description: "gate image not bound (images.gate)" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fleet && bun test test/bun/gate-run-leg.test.ts -t "startLegContainer"`
Expected: FAIL — not exported yet.

- [ ] **Step 3: Write minimal implementation**

In `apps/fleet/src/gate/run-leg.ts`:

```ts
/** #1398: the async path's own container start -- returns the moment
 *  prepareAndStartContainer resolves, NEVER waiting for "running" and NEVER
 *  polling /result. do.ts's alarm() (a later task) does all of that, one
 *  tick at a time, independent of whichever Workflow invocation made this
 *  call. Unlike runLegInContainer, this function does NOT destroy the
 *  container on return -- the container is meant to keep running after this
 *  call returns; the DO's own alarm loop owns its teardown. */
export async function startLegContainer(
  req: GateLegRequest,
  deps: { container: GateContainer | undefined; outbound: OutboundBinding; secretValues?: Record<string, string>; inactivityTimeoutMs?: number },
): Promise<{ kind: "started" } | { kind: "infra"; description: string }> {
  const c = deps.container;
  if (!c) return { kind: "infra", description: "gate container binding missing" };
  const prepared = await prepareAndStartContainer(req, {
    container: c, outbound: deps.outbound, secretValues: deps.secretValues, inactivityTimeoutMs: deps.inactivityTimeoutMs,
  });
  return prepared.kind === "infra" ? prepared : { kind: "started" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fleet && bun test test/bun/gate-run-leg.test.ts`
Expected: PASS, including every existing test in the file.

- [ ] **Step 5: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit && npx tsc --noEmit -p test/tsconfig.json`

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/gate/run-leg.ts apps/fleet/test/bun/gate-run-leg.test.ts
git commit -m "feat(gate): add startLegContainer, the async path's fire-and-forget start

#1398: returns the moment the container is SCHEDULED to start, never
waiting for readiness or polling for a result -- unlike runLegInContainer,
never destroys the container on return either, since the DO's own alarm
loop (a later task) owns teardown once this returns. Unused by any live
code path yet.

Refs #1398, #1396."
```

---

### Task 6: Write-once race helper — `claimOrReadBack`

Shared by the DO's own "guessing infra" write (spec "Who writes what") and the Workflow's own give-up write (spec "Deadline (#1390) and the write-once race") — one function, two callers, later tasks.

**Files:**
- Modify: `apps/fleet/src/gate/leg-run.ts`
- Test: `apps/fleet/test/bun/gate-leg-run.test.ts`

**Interfaces:**
- Produces: `interface ClaimableBucket { put(key: string, value: string, opts: { onlyIf: { etagDoesNotMatch: "*" } }): Promise<unknown | null>; get(key: string): Promise<{ json(): Promise<unknown> } | null> }` (the minimal R2-like shape this needs — satisfied by the real `R2Bucket` and by `ResultBucket`-style fakes already used elsewhere in this file's tests); `claimOrReadBack(bucket: ClaimableBucket, key: string, value: StoredLegResult): Promise<StoredLegResult>` — attempts the write-once PUT; on success returns `value` unchanged; on conflict (`put` resolves `null`), reads the key back and returns WHATEVER IS THERE instead (never throws, never assumes its own `value` after a conflict).

- [ ] **Step 1: Write the failing test**

```ts
it("claimOrReadBack: the write wins when nothing is there yet", async () => {
  const store = new Map<string, string>();
  const bucket = {
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
  const result = await claimOrReadBack(bucket, "k", { state: "error", description: "guessed infra" });
  expect(result).toEqual({ state: "error", description: "guessed infra" });
});

it("claimOrReadBack: a conflict defers to whatever is already there, never the caller's own value", async () => {
  const store = new Map<string, string>([["k", JSON.stringify({ state: "success" })]]);
  const bucket = {
    put: async () => null, // already written -- simulates a container's own report winning the race
    get: async (key: string) => ({ json: async () => JSON.parse(store.get(key)!) }),
  };
  const result = await claimOrReadBack(bucket, "k", { state: "error", description: "guessed infra" });
  expect(result).toEqual({ state: "success" }); // NEVER the guessed infra value
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts -t "claimOrReadBack"`
Expected: FAIL — not exported yet.

- [ ] **Step 3: Write minimal implementation**

In `apps/fleet/src/gate/leg-run.ts`:

```ts
/** #1398: the minimal R2-like shape claimOrReadBack needs -- the real
 *  R2Bucket satisfies it (put returns R2Object | null; get returns
 *  R2ObjectBody | null, both narrowed to their .json() half here, same as
 *  ResultBucket above). */
export interface ClaimableBucket {
  put(key: string, value: string, opts: { onlyIf: { etagDoesNotMatch: "*" } }): Promise<unknown | null>;
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/**
 * #1398 (spec "Who writes what" / "Deadline (#1390) and the write-once
 * race"): attempts a write-once PUT of `value`; if it wins (nothing else
 * exists at `key`), returns `value` unchanged. If it loses (a conflict --
 * `put` resolves null under the real R2 `onlyIf` contract, same as
 * outbound-handler.ts's own `putBundle`), reads `key` back and returns
 * WHATEVER IS ACTUALLY THERE -- never the caller's own guessed value. Both
 * the DO's own "I couldn't reach the container" guess and the Workflow's
 * own give-up-after-its-deadline write use this SAME function: neither one
 * ever assumes its own conclusion is correct once a conflict proves
 * something else already claimed the key.
 */
export async function claimOrReadBack(
  bucket: ClaimableBucket, key: string, value: StoredLegResult,
): Promise<StoredLegResult> {
  const stored = await bucket.put(key, JSON.stringify(value), { onlyIf: { etagDoesNotMatch: "*" } });
  if (stored !== null) return value;
  const existing = await bucket.get(key);
  if (existing === null) return value; // the winner's write vanished (extremely unlikely); fall back to our own guess
  const body = await existing.json() as Partial<StoredLegResult> | null;
  return body !== null && typeof body === "object" && typeof body.state === "string"
    ? (body as StoredLegResult)
    : value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts`
Expected: PASS, including every existing test.

- [ ] **Step 5: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit && npx tsc --noEmit -p test/tsconfig.json`

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/gate/leg-run.ts apps/fleet/test/bun/gate-leg-run.test.ts
git commit -m "feat(gate): add claimOrReadBack, the shared write-once race helper

#1398 (docs/superpowers/specs/2026-10-26-async-run-leg-design.md, 'Who
writes what' and 'Deadline (#1390) and the write-once race'): one function
for both races this design introduces -- the DO's own 'container
unreachable, guessing infra' write racing a container's genuine report, and
the Workflow's own give-up-after-deadline write racing the DO's terminal
write. The loser always defers to whatever actually landed, never its own
guess. Unused by any live code path yet.

Refs #1398, #1396."
```

---

### Task 7: `runLegStepPolling` — the explicit try-loop + poll loop (Workflow side)

The biggest single task in this plan: the new function that replaces `runLegStep`'s reliance on Workflows' own automatic step-retry with an explicit dispatch+poll try-loop. Coexists with `runLegStep` — nothing calls this yet.

**Files:**
- Modify: `apps/fleet/src/gate/leg-run.ts`
- Test: `apps/fleet/test/bun/gate-leg-run.test.ts`

**Interfaces:**
- Consumes: `claimOrReadBack` (Task 6), `ClaimableBucket` (Task 6), `legResultReader` (existing, UNCHANGED, used directly — never `storedLegResult` for the normal read, spec review r2 item 1), `LegStepRunner` (now generic, Task 1).
- Produces:
  - `interface PollingLegStepRunner { do<T>(name: string, config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T>; sleep(name: string, durationSeconds: number): Promise<void>; }` — Task 11 (`workflow.ts`) constructs this from the real `step`.
  - `type DispatchOutcome = { kind: "terminal"; result: LegRunResult } | { kind: "accepted"; resultKey: string; startedAt: number };`
  - `runLegStepPolling(step: PollingLegStepRunner, dispatch: (planned: PlannedLeg, attemptId: string) => Promise<DispatchOutcome>, planned: PlannedLeg, deps: LegRunDeps & { bucket: ClaimableBucket; pollIntervalSeconds?: number }): Promise<LegRunResult>` — Task 11 calls this (instead of `runLegStep`) when the pinned per-instance mode is `"async-poll"`.

- [ ] **Step 1: Write the failing tests**

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
  it("a container-authored success in R2 on the first poll ends the attempt, summary intact", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      // Simulate the container finishing and writing to R2 before the first poll.
      bucket.store.set(planned.resultKey, JSON.stringify({ state: "success", summary: "42 passed" }));
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0 });
    expect(result).toMatchObject({ leg: "lint", state: "success", summary: "42 passed" });
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
    let now = 0;
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => now, totalDeadlineMs: 100_000 });
    expect(result.state).toBe("success");
    expect(tries).toBe(2);
    expect("waitForEvent" in step).toBe(false);
  });

  it("a give-up after the total deadline writes via claimOrReadBack, deferring to a late-arriving real result", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      // Simulate the DO's own eventual success landing AFTER the Workflow's
      // own give-up write would otherwise have claimed the key.
      bucket.store.set(planned.resultKey, JSON.stringify({ state: "success" }));
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    // A huge jump past totalDeadlineMs on the FIRST poll tick forces the give-up path
    // to run in the SAME tick the container's result is already sitting in R2.
    let now = 0;
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => now, totalDeadlineMs: 0 });
    // The poll step itself finds the container's result FIRST (it reads R2 before
    // checking the deadline, same order nextAlarmStep's own polling branch uses) --
    // this test documents that ordering rather than asserting a specific value, so
    // adjust the expectation once the real poll-step ordering is implemented.
    expect(result.state).toBe("success");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts -t "runLegStepPolling"`
Expected: FAIL — not exported yet.

- [ ] **Step 3: Write minimal implementation**

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
/** #1398 review r1 item 10 / "Leftovers" item 1: the step-count budget this
 *  interval buys -- see the plan's own Global Constraints. */

/** #1398: ONE try's own dispatch + poll loop. Returns the container-authored
 *  (or DO-written infra) LegResult once found, or the Workflow's own
 *  give-up result once this try's own deadline elapses with nothing in R2. */
async function dispatchAndPollOnce(
  step: PollingLegStepRunner,
  dispatch: (planned: PlannedLeg, attemptId: string) => Promise<DispatchOutcome>,
  target: PlannedLeg,
  stepName: string,
  attemptDeadlineMs: number,
  deps: { bucket: ClaimableBucket; now: () => number; pollIntervalSeconds: number; readResult: (key: string) => Promise<StoredLegResult | undefined>; touch?: () => Promise<void> },
): Promise<LegResult> {
  const attemptId = crypto.randomUUID();
  const dispatched = await step.do(`${stepName}`, LEG_STEP_CONFIG, () => dispatch(target, attemptId));
  if (dispatched.kind === "terminal") return dispatched.result;
  for (let i = 1; ; i++) {
    await step.sleep(`${stepName}-sleep-${i}`, deps.pollIntervalSeconds);
    const tick = await step.do(`${stepName}-poll-${i}`, LEG_STEP_CONFIG, async () => {
      await deps.touch?.();
      // #1398 review r2 item 1: the RAW reader, never storedLegResult --
      // a container-authored record (including its own live "exited
      // 143/137") is trusted exactly as-is, summary intact, never reclassified.
      const found = await deps.readResult(dispatched.resultKey);
      if (found !== undefined) return { kind: "found" as const, result: found };
      const pastDeadline = deps.now() - dispatched.startedAt >= attemptDeadlineMs;
      return pastDeadline ? { kind: "deadline" as const } : { kind: "not-yet" as const };
    });
    if (tick.kind === "found") return tick.result;
    if (tick.kind === "deadline") {
      const claimed = await step.do(`${stepName}-giveup`, LEG_STEP_CONFIG, () =>
        claimOrReadBack(deps.bucket, dispatched.resultKey, { state: "error", description: `${target.leg}: no progress past its deadline` }));
      return claimed;
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
  const deadlineMs = deps.stepDeadlineMs ?? legStepDeadlineMs(planned.timeoutMin);
  const totalDeadlineMs = deps.totalDeadlineMs ?? totalLegWallMs(planned.timeoutMin);
  const pollIntervalSeconds = deps.pollIntervalSeconds ?? POLL_INTERVAL_SECONDS_DEFAULT;
  const readResult = deps.readResult ?? (async () => undefined);
  const legStarted = await step.do(`leg-started-${planned.leg}`, LEG_STEP_CONFIG, async () => now());

  const runPhase = async (phaseName: "start" | "retry", targetFor: (tryNo: number) => PlannedLeg): Promise<LegResult> => {
    const causes: string[] = [];
    for (let tryNo = 1; ; tryNo++) {
      const elapsed = now() - legStarted;
      if (elapsed >= totalDeadlineMs) {
        return {
          leg: planned.leg, state: "error",
          description: causes.length > 0 ? combineCauses(causes) : `${planned.leg} exceeded ${legTimeoutMin(planned.timeoutMin)} min without a result`,
        };
      }
      const attemptDeadlineMs = Math.min(deadlineMs, totalDeadlineMs - elapsed);
      const target = targetFor(tryNo);
      // #1398 Leftovers item 6: phase-qualified step names -- dispatch-start-
      // and dispatch-retry- never collide on the same tryNo.
      const result = await dispatchAndPollOnce(
        step, dispatch, target, `dispatch-${phaseName}-${planned.leg}-try${tryNo}`, attemptDeadlineMs,
        { bucket: deps.bucket, now, pollIntervalSeconds, readResult, touch: tryNo === 1 ? deps.touch : undefined },
      );
      if (tryNo === 1) await deps.touch?.();
      const isInfra = result.state === "error" && isLegInfraDescription(result.description);
      if (!isInfra) return result;
      causes.push(result.description ?? "infra");
    }
  };

  const first = await runPhase("start", (tryNo) => tryNo === 1 ? planned : { ...planned, resultKey: infraRetryResultKey(planned.resultKey, tryNo) });
  if (!isRetryable({ ...first, leg: planned.leg })) return { ...first, leg: planned.leg };

  const retryBase = { ...planned, resultKey: retryResultKey(planned.resultKey) };
  const retry = await runPhase("retry", (tryNo) => tryNo === 1 ? retryBase : { ...retryBase, resultKey: infraRetryResultKey(retryBase.resultKey, tryNo) });

  const firstCause = (first.description ?? "failure").slice(0, MAX_FIRST_DESCRIPTION_CHARS);
  if (retry.state === "success") {
    return { leg: planned.leg, state: "success", description: `flaky: passed on retry; first: ${firstCause}` };
  }
  if (first.state === "failure") return { ...retry, leg: planned.leg, redFirst: true };
  const retryCause = retry.description ?? retry.state;
  return { ...retry, leg: planned.leg, description: `${retryCause}; first: ${firstCause}`.slice(0, MAX_DESCRIPTION_CHARS) };
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
  return /gate (container|server|capacity)|no progress past its deadline/.test(description);
}
```

(`ms` fields are intentionally omitted from `runLegStepPolling`'s own returned shape in this draft — add `ms: now() - <attempt start>` tracking identically to `runLegStep`'s own pattern if the engine tests in Task 12 show callers depend on it; check `fanout.ts`'s `LegRunMeta`/`normalizeLegResult` usage before deciding, and update this task's code accordingly if so — do not skip this check.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts`
Expected: PASS. Iterate on the implementation above until every new test (and every pre-existing test) passes — the sketch above is a strong starting point, not guaranteed byte-perfect; debug test failures against the SPEC's own stated behavior (cited in each test's own comment), not by loosening the assertion.

- [ ] **Step 5: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit && npx tsc --noEmit -p test/tsconfig.json`

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/gate/leg-run.ts apps/fleet/test/bun/gate-leg-run.test.ts
git commit -m "feat(gate): add runLegStepPolling, the explicit dispatch+poll try-loop

#1398 (docs/superpowers/specs/2026-10-26-async-run-leg-design.md, 'New
architecture' + 'Retries'): replaces Workflows' own automatic step-retry
(ctx.attempt) with an explicit try-loop around a short dispatch step and a
step.sleep+step.do poll loop. The normal poll read uses legResultReader
directly (review r2 item 1) -- a container's own live 'exited 143/137'
stays a real failure, never reclassified as infra. A give-up after the
total deadline uses claimOrReadBack, so a late-arriving real result always
wins over the Workflow's own guess. Phase-qualified step names (Leftovers
item 6) keep the start and retry phases' step names from colliding.

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
   *  to start. */
  private async startAsyncLeg(
    body: GateLegRequest, outbound: ReturnType<typeof workerExports.GateOutbound>, secretValues: Record<string, string>,
  ): Promise<Response> {
    const started = await startLegContainer(body, {
      container: this.ctx.container, outbound, secretValues, inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
    });
    if (started.kind === "infra") {
      return new Response(JSON.stringify({ error: started.description }), { status: 503 });
    }
    const state: RunLegAlarmState = {
      phase: "waiting-for-ready", resultKey: body.resultKey, leg: body.leg, timeoutMin: body.timeoutMin,
      readyStartedAt: Date.now(), instanceId: body.instanceId ?? "", statusCheckCount: 0,
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

---

### Task 9: `alarm()` handler — wired to `nextAlarmStep`, secrets redaction, superseded check

**Files:**
- Modify: `apps/fleet/src/gate/do.ts`

**Interfaces:**
- Consumes: `nextAlarmStep`, `isLiveStatus`, `ALARM_TICK_MS` (Task 4), `claimOrReadBack`, `ClaimableBucket` (Task 6), `redactLegResultFields` (existing, `secrets-redact.ts`).
- Produces: `GateRunnerDO.alarm()` — a new DO lifecycle method; no new exports (this is the terminal piece of the DO-side wiring).

- [ ] **Step 1: Write `alarm()`**

In `apps/fleet/src/gate/do.ts`:

```ts
/** #1398 review r1 item 7: a status check costs an extra RPC, so it runs
 *  every FEW ticks, not every one. */
const STATUS_CHECK_EVERY_N_TICKS = 5;

export class GateRunnerDO extends DurableObject<Env> {
  // ...fetch(), startAsyncLeg() from Task 8...

  /**
   * #1398: wakes independently of any Workflow invocation -- the whole
   * point of this redesign (spec "New architecture"). Loads this attempt's
   * persisted state, performs ONE unit of poll work, and either re-arms or
   * writes a terminal outcome. NEVER lets an uncaught exception escape
   * without re-arming first (review r1 item 3: an alarm that keeps throwing
   * goes dormant after 6 failed retries and silently abandons the leg).
   */
  async alarm(): Promise<void> {
    try {
      const state = await this.ctx.storage.get<RunLegAlarmState>("alarmState");
      if (state === undefined) return; // nothing to do -- a stray/duplicate alarm after this attempt already finished
      // #1398 review r1 item 7: every FEW ticks, check whether the owning
      // Workflow instance is still live. isLiveStatus fails safe (treats an
      // unrecognized status as live) -- see run-leg-alarm.ts's own doc comment.
      if (state.statusCheckCount >= STATUS_CHECK_EVERY_N_TICKS && state.instanceId !== "") {
        const instance = await this.env.GATE_WORKFLOW.get(state.instanceId);
        const { status } = await instance.status();
        if (!isLiveStatus(status)) {
          await this.ctx.container?.destroy();
          await this.ctx.storage.delete("secretValues");
          await this.ctx.storage.delete("alarmState");
          return; // superseded: nobody is waiting on this leg anymore
        }
        state.statusCheckCount = 0;
      }
      const signal = await this.observeOnce(state);
      const decision = nextAlarmStep(state, Date.now(), signal);
      if (decision.kind === "re-arm") {
        decision.state.statusCheckCount = state.statusCheckCount + 1;
        await this.ctx.storage.put("alarmState", decision.state);
        await this.ctx.storage.setAlarm(Date.now() + decision.afterMs);
        return;
      }
      // Terminal: redact (if this is the DO's own infra guess -- a real
      // container-authored result is NEVER touched here, it already left
      // the container's own outbound write path redacted, same as today)
      // and claim the result key write-once.
      if (decision.outcome.kind === "infra") {
        const secretValues = (await this.ctx.storage.get<Record<string, string>>("secretValues")) ?? {};
        const values = Object.values(secretValues).filter((v) => v !== "");
        const redacted = redactLegResultFields({ state: "error" as const, description: decision.outcome.description }, values);
        await claimOrReadBack(this.env.STUDIO_ARCHIVE as unknown as ClaimableBucket, state.resultKey, redacted);
      }
      await this.ctx.storage.delete("secretValues");
      await this.ctx.storage.delete("alarmState");
      await this.ctx.container?.destroy().catch((err) => console.error("gate-runner: destroy failed", err));
    } catch (err) {
      // #1398 review r1 item 3: never let an uncaught exception leave the
      // alarm un-rearmed. A short, fixed re-arm is always safe here -- worst
      // case this attempt loses one tick's worth of time, never silently
      // abandons the leg.
      console.error("gate-runner: alarm tick failed, re-arming", err instanceof Error ? err.message : String(err));
      await this.ctx.storage.setAlarm(Date.now() + ALARM_TICK_MS).catch(() => {});
    }
  }

  /** #1398: the ONE piece of real I/O an alarm tick needs -- talk to the
   *  container once, per `state.phase`, and translate the raw response into
   *  a PollSignal. Kept separate from nextAlarmStep (Task 4) so that
   *  function stays pure and bun-testable; this method is the thin,
   *  untested-by-bun glue, kept as small as possible on purpose. */
  private async observeOnce(state: RunLegAlarmState): Promise<PollSignal> {
    const c = this.ctx.container;
    if (c === undefined) return { kind: "poll-failed" };
    if (state.phase === "waiting-for-ready") {
      if (!c.running) return { kind: "not-running" };
      // #1398 Leftovers item 5: write a live /result body straight to R2.
      // Falls through to the SAME port.fetch("/run") this phase always did;
      // Task 9's own first cut keeps that single responsibility and defers
      // the "DO writes the live body itself" optimization to a follow-up,
      // per the plan's own PR-sizing -- do not add it here without also
      // adding its own test coverage in Task 12.
    }
    const port = c.getTcpPort(GATE_CONTAINER_PORT);
    try {
      if (state.phase !== "polling") {
        const res = await port.fetch("http://container/run", { method: "POST", signal: AbortSignal.timeout(15_000) });
        if (res.status === 200) return { kind: "run-result", result: (await res.json()) as LegResult };
        if (res.status === 202) return { kind: "run-accepted" };
        return { kind: "running-not-listening" };
      }
      const res = await port.fetch("http://container/result", { signal: AbortSignal.timeout(15_000) });
      if (res.status === 200) return { kind: "poll-result", result: (await res.json()) as LegResult };
      return { kind: "poll-pending" };
    } catch (err) {
      if (/no container instance|container instance that can be provided|no instances? available/i.test(err instanceof Error ? err.message : String(err))) {
        return { kind: "no-instance" };
      }
      return state.phase === "polling" && !c.running ? { kind: "poll-failed" } : { kind: "running-not-listening" };
    }
  }
}
```

(`GATE_CONTAINER_PORT` import from `./run-leg`, already exported.)

- [ ] **Step 2: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit`
Expected: clean. Fix any import/type mismatch against the exact `Env`/`DurableObjectState`/`Container` shapes this repo's real `@cloudflare/workers-types` version declares — this is the one file in this plan `tsc` cannot be fully predicted for from outside a real compile, so budget real iteration time here, not just a read-through.

- [ ] **Step 3: Commit**

```bash
git add apps/fleet/src/gate/do.ts
git commit -m "feat(gate): add GateRunnerDO.alarm(), wired to nextAlarmStep

#1398: the DO's own alarm wakes independently of any Workflow invocation,
calls nextAlarmStep (run-leg-alarm.ts, already tested) with one freshly
observed PollSignal per tick, and either re-arms or writes a terminal
outcome via claimOrReadBack. Never lets an uncaught exception escape
without re-arming (review r1 item 3 -- alarms go dormant after 6 failed
retries). Checks the owning Workflow instance's status every 5 ticks
(review r1 item 7) via the fail-safe isLiveStatus, destroying the container
and dropping state if the instance is no longer live.

Refs #1398, #1396."
```

---

### Task 10: `config.ts` gains `GATE_ASYNC_LEGS` (mirrors `GATE_RUNNER_REPOS`)

**Files:**
- Modify: `apps/fleet/src/gate/config.ts`
- Modify: `apps/fleet/src/env.ts`
- Test: whichever bun test file already covers `isGateRunnerRepo` (`ls apps/fleet/test/bun | grep -i config` to find it).

**Interfaces:**
- Produces: `parseAsyncLegsRepos(raw: string | undefined): string[]`, `isAsyncLegsRepo(raw: string | undefined, workRepoSlug: string): boolean` — exact same shape as the existing `parseGateRunnerRepos`/`isGateRunnerRepo` pair, for `workflow.ts` (Task 11) to call.

- [ ] **Step 1: Write the failing test**

In the config test file found above, add:

```ts
describe("isAsyncLegsRepo (#1398)", () => {
  it("matches a comma-separated, case-insensitive allowlist, same shape as isGateRunnerRepo", () => {
    expect(isAsyncLegsRepo("Acme/Widgets, other/repo", "acme/widgets")).toBe(true);
    expect(isAsyncLegsRepo("acme/widgets", "acme/other")).toBe(false);
    expect(isAsyncLegsRepo(undefined, "acme/widgets")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fleet && bun test test/bun/<config file> -t "isAsyncLegsRepo"`
Expected: FAIL — not exported.

- [ ] **Step 3: Write minimal implementation**

In `apps/fleet/src/gate/config.ts`:

```ts
/** #1398: the GATE_ASYNC_LEGS repo gate, same comma-separated "owner/repo"
 *  shape as GATE_RUNNER_REPOS (above) -- a fleet-wide, per-repo opt-in into
 *  the async /run-leg path. Absent/empty means every repo stays on the old
 *  synchronous path, the default this flag ships with. */
export function parseAsyncLegsRepos(raw: string | undefined): string[] {
  return parseGateRunnerRepos(raw);
}

export function isAsyncLegsRepo(raw: string | undefined, workRepoSlug: string): boolean {
  return parseAsyncLegsRepos(raw).includes(workRepoSlug.toLowerCase());
}
```

In `apps/fleet/src/env.ts`, near `GATE_RUNNER_REPOS`:

```ts
  /** #1398: the async-/run-leg repo opt-in, same shape as GATE_RUNNER_REPOS.
   *  Absent/empty means every repo stays on the old synchronous path. */
  GATE_ASYNC_LEGS?: string;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fleet && bun test test/bun/<config file>`
Expected: PASS.

- [ ] **Step 5: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit && npx tsc --noEmit -p test/tsconfig.json`

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/gate/config.ts apps/fleet/src/env.ts apps/fleet/test/bun/<config file>
git commit -m "feat(gate): add GATE_ASYNC_LEGS repo opt-in (#1398 migration)

Mirrors GATE_RUNNER_REPOS's own comma-separated owner/repo allowlist shape.
Absent/empty (the default) keeps every repo on the old synchronous
/run-leg path. Unused by any live code path yet.

Refs #1398, #1396."
```

---

### Task 11: `workflow.ts` — the per-instance mode pin and the cutover

The ONLY task in this plan that makes the new path reachable from a live run — still defaults every repo to the OLD path (`GATE_ASYNC_LEGS` ships empty).

**Files:**
- Modify: `apps/fleet/src/gate/workflow.ts`
- Modify: `apps/fleet/src/gate/leg-run.ts` (`runLeg`'s own wrapper, if it needs a branch — check before assuming; `runLeg` currently calls `runLegStep` directly, Task 7's `runLegStepPolling` has a different dispatch signature)

**Interfaces:**
- Consumes: `isAsyncLegsRepo` (Task 10), `runLegStepPolling`/`DispatchOutcome` (Task 7), `legModeEnabled`-equivalent decision made inline (no new pure function needed — `isAsyncLegsRepo` already is one).

- [ ] **Step 1: Add the `leg-mode` pin to `GateWorkflow.run`**

In `apps/fleet/src/gate/workflow.ts`, near the top of `run()` (after `resolved` is computed, since the mode decision does not depend on it and can run earlier, but placing it right before the first `runLeg` call site keeps the diff small — check both call sites, bundle-leg dispatch and ordinary-leg dispatch, `workflow.ts:402`/`:427` per this session's earlier reading, and compute the mode ONCE, before either):

```ts
    // #1398 (docs/superpowers/specs/2026-10-26-async-run-leg-design.md,
    // "Migration"): pinned per-instance, replay-safely -- an in-flight
    // instance that already resolved "sync-legacy" never flips mid-run just
    // because the live flag changed later.
    const legMode = await step.do("leg-mode", async (): Promise<"sync-legacy" | "async-poll"> =>
      isAsyncLegsRepo(this.env.GATE_ASYNC_LEGS, repo) ? "async-poll" : "sync-legacy");
```

- [ ] **Step 2: Thread `legMode` + `instanceId` into `legRequest`'s body**

`legRequest` (`leg-run.ts`) already builds the `GateLegRequest` body; add `mode`/`instanceId`:

```ts
export function legRequest(
  owner: string, repo: string, planned: PlannedLeg,
  pr: { /* ...unchanged... */ },
  mode: "sync-legacy" | "async-poll" = "sync-legacy",
  instanceId?: string,
): GateLegRequest {
  // ...unchanged body construction...
  return {
    // ...every existing field...
    ...(mode === "async-poll" ? { mode, instanceId } : {}),
  };
}
```

Update both call sites in `workflow.ts` (`runLeg`'s own `legRequest(owner, repoName, leg, { ...pr, image: leg.image })` call, and the bundle-leg one) to pass `legMode, event.instanceId`.

- [ ] **Step 3: Branch `runLeg` itself**

In `apps/fleet/src/gate/workflow.ts`'s `runLeg` function:

```ts
function runLeg(
  env: Env, step: WorkflowStep, instanceId: string, mode: "sync-legacy" | "async-poll",
  owner: string, repoName: string, pr: LegRequestContext, planned: PlannedLeg, touch: () => Promise<void>,
): Promise<LegRunResult> {
  if (mode === "async-poll") {
    return runLegStepPolling(
      { do: (name, config, fn) => step.do(name, config, fn), sleep: (name, seconds) => step.sleep(name, `${seconds} seconds`) },
      async (leg, attemptId) => {
        const stub = env.GATE_RUNNER.get(env.GATE_RUNNER.idFromName(gateRunnerName(instanceId, leg.leg, attemptId)));
        const res = await stub.fetch("https://gate-runner/run-leg", {
          method: "POST", body: JSON.stringify(legRequest(owner, repoName, leg, { ...pr, image: leg.image }, mode, instanceId)),
        });
        if (res.status === 202) return { kind: "accepted", resultKey: leg.resultKey, startedAt: Date.now() };
        return { kind: "terminal", result: { leg: leg.leg, ...(await res.json() as LegResult) } };
      },
      planned,
      { bucket: env.STUDIO_ARCHIVE as unknown as ClaimableBucket, readResult: legResultReader(env.STUDIO_ARCHIVE), retryJitterMs: RETRY_LEG_JITTER_MS, touch },
    );
  }
  // #1398: UNCHANGED -- the old synchronous path.
  return runLegStep(
    { do: <T,>(name: string, config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T> => step.do(name, config, fn) },
    async (leg, attemptId, signal) => {
      const stub = env.GATE_RUNNER.get(env.GATE_RUNNER.idFromName(gateRunnerName(instanceId, leg.leg, attemptId)));
      return stub.fetch("https://gate-runner/run-leg", {
        method: "POST", body: JSON.stringify(legRequest(owner, repoName, leg, { ...pr, image: leg.image })),
        signal,
      });
    },
    planned,
    { readResult: legResultReader(env.STUDIO_ARCHIVE), retryJitterMs: RETRY_LEG_JITTER_MS, touch },
  );
}
```

Update every call to `runLeg(...)` in `workflow.ts` to pass `legMode` as the new 4th argument (both the bundle-leg path and the ordinary-leg path).

- [ ] **Step 4: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit`
Expected: clean. Resolve any mismatch between `runLegStepPolling`'s expected `dispatch` return shape and what the inline `async (leg, attemptId) => {...}` above actually produces — this is the one place Task 7's and Task 11's types must agree exactly; if they don't, fix `workflow.ts`'s call site to match Task 7's `DispatchOutcome` type precisely, never the reverse (Task 7 is already tested against that exact contract).

- [ ] **Step 5: Run the targeted vitest files that exercise `workflow.ts`**

Run: `cd apps/fleet && npx vitest run test/gate-workflow-precheck.test.ts`
Expected: PASS, unchanged (the default `GATE_ASYNC_LEGS` is unset in every test env, so `legMode` resolves to `"sync-legacy"` for every existing test — this is the "zero production behavior change" claim's own first real check).

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/gate/workflow.ts apps/fleet/src/gate/leg-run.ts
git commit -m "feat(gate): wire the per-instance leg-mode pin into workflow.ts (#1398)

The ONLY commit in this plan that makes the async path reachable from a
live run -- gated by GATE_ASYNC_LEGS, which ships empty, so every repo
stays on the old synchronous path until an operator explicitly opts one in.
step.do('leg-mode', ...) pins the choice per instance, replay-safely: an
in-flight run never flips mid-run just because the live flag changes.

Refs #1398, #1396."
```

---

### Task 12: Engine tests (`@cloudflare/vitest-pool-workers`)

**Files:**
- Create: `apps/fleet/test/gate-async-run-leg.test.ts` (vitest, follows `test/gate-workflow-precheck.test.ts`'s own harness conventions — read that file first for the exact fake-GitHub/fake-R2/instance-creation boilerplate this new file should reuse, not reinvent).

**Interfaces:**
- Consumes: the real `GateWorkflow`/`GateRunnerDO` classes, a REAL (local, miniflare-backed) `GATE_WORKFLOW`/`GATE_RUNNER`/`STUDIO_ARCHIVE` binding (same harness `gate-workflow-precheck.test.ts` already sets up), `GATE_ASYNC_LEGS` set to opt the test repo in.

- [ ] **Step 1: Read the existing harness**

Run: `cd apps/fleet && sed -n '1,80p' test/gate-workflow-precheck.test.ts`

Identify: how it fakes GitHub responses (`mockFetch`), how it creates a real Workflow instance and awaits its result, how it reads back R2 state, and how long a full run of that file takes (measured earlier in this project's history at ~130s) — this new file will be comparably heavy; budget it as its OWN heavy gate, never run alongside another vitest-pool-workers file or a full `bun test test/bun/`.

- [ ] **Step 2: Write test 1 — a step killed mid-run does not lose the leg's own result**

```ts
it("a step killed mid-run (simulating #1393's invocation cut) does not lose the leg's own R2 result", async () => {
  // Start a real GateWorkflow instance with GATE_ASYNC_LEGS opted in for the
  // test repo. Let the dispatch step complete (202) and the container write
  // its own success to R2 (fake the container's own outbound PUT exactly the
  // way gate-workflow-precheck.test.ts's own harness already does for a
  // normal leg). THEN simulate an invocation cut by... [fill in the EXACT
  // miniflare/vitest-pool-workers mechanism for killing an in-flight
  // Workflow instance and resuming it -- check this harness's own
  // capabilities first; if none exists, this test instead asserts the
  // NARROWER, still-meaningful claim: a FRESH invocation of the SAME
  // instance id (simulating the resume after a kill) reads the R2 state a
  // prior partial run left behind and completes correctly from there,
  // without re-dispatching a second container for the same attemptId].
});
```

- [ ] **Step 3: Write test 2 — replay keeps attemptId/startedAt/step names stable**

```ts
it("a replayed dispatch step returns its cached accept result, never re-dispatching a second container for the same attemptId", async () => {
  // Run the SAME instance id twice with an unchanged GateWorkflowParams
  // payload (Workflows' own create() is idempotent per id) and assert the
  // SAME GateRunnerDO name (gateRunnerName(instanceId, leg, attemptId)) is
  // targeted both times -- confirms the dispatch step's own step.do cache
  // is what Workflows' replay contract actually provides here, not an
  // assumption.
});
```

- [ ] **Step 4: Write test 3 — alarm chain + duplicate alarm reaches exactly one terminal write**

```ts
it("a duplicate/redelivered alarm tick never produces two different terminal writes to the same result key", async () => {
  // Directly exercise GateRunnerDO's alarm() twice in a row (via the real DO
  // stub, calling .alarm() if the test harness exposes it, or by scheduling
  // two alarms in immediate succession and letting the runtime deliver
  // both) against a state that is ALREADY terminal (nothing left to decide)
  // -- confirm the SECOND tick is a safe no-op (the "nothing to do -- a
  // stray/duplicate alarm" early return in alarm(), Task 9), never a second
  // write attempt that could conflict with or overwrite the first.
});
```

- [ ] **Step 5: Write test 4 — the DO-vs-Workflow write-once race under the real R2 binding**

```ts
it("the DO's own infra guess never overwrites a container's genuine report that landed first, under the REAL R2 conditional-write behavior", async () => {
  // Pre-populate the real (miniflare) STUDIO_ARCHIVE binding with a
  // container-authored success at a known resultKey, THEN call
  // claimOrReadBack (Task 6) against that SAME binding with a guessed infra
  // value -- assert the real R2Bucket.put's own onlyIf semantics produce
  // the conflict claimOrReadBack is written to handle, and that its return
  // value is the PRE-POPULATED success, never the guessed infra value. This
  // is the one assertion a fake bucket (Task 6's own unit test) cannot
  // fully prove -- it needs the REAL R2 binding's own conditional-write
  // contract.
});
```

- [ ] **Step 6: Run the new file alone**

Run: `cd apps/fleet && npx vitest run test/gate-async-run-leg.test.ts`
Expected: PASS. Iterate — these tests exercise real engine semantics this plan has only ASSUMED up to this point (the governing invariant's replay-safety, alarm at-least-once delivery, R2's conditional-write contract); a failure here is a signal to revisit an EARLIER task's own assumption, not to weaken the test.

- [ ] **Step 7: Commit**

```bash
git add apps/fleet/test/gate-async-run-leg.test.ts
git commit -m "test(gate): add vitest-pool-workers engine tests for the async leg path

#1398 review r1 item 11: a step killed mid-run doesn't lose the leg's own
R2 result, a replayed dispatch step never re-dispatches a second container,
a duplicate alarm tick never produces two different terminal writes, and
the DO-vs-Workflow write-once race holds under the REAL R2 binding's
conditional-write behavior, not just a fake bucket's approximation of it.

Refs #1398, #1396."
```

---

### Task 13: Rewrite the stale `gate-leg-run.test.ts` invariant test

**Files:**
- Modify: `apps/fleet/test/bun/gate-leg-run.test.ts`

The LAST task in this plan, since it depends on `runLegStepPolling` (Task 7) already existing to write its positive-form replacement.

- [ ] **Step 1: Find and replace the stale test**

The existing test (cited throughout the spec, `gate-leg-run.test.ts:123-128`):

```ts
it("only one step per leg, and no waitForEvent: the start step is the whole leg", async () => {
  const step = fakeStep();
  await runLegStep(step, async () => reply({ state: "success" }), PLANNED);
  expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint"]); // Task 1's own addition
  expect("waitForEvent" in step).toBe(false);
});
```

Replace it entirely with:

```ts
it("runLegStep (sync-legacy) still holds: one step per leg, no waitForEvent (unchanged by #1398)", async () => {
  const step = fakeStep();
  await runLegStep(step, async () => reply({ state: "success" }), PLANNED);
  expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint"]);
  expect("waitForEvent" in step).toBe(false);
});

it("runLegStepPolling (async-poll, #1398) is the OPPOSITE shape on purpose: many short steps, never one long one, still no waitForEvent", async () => {
  const step = fakePollingStep();
  const bucket = fakeBucket();
  const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
    bucket.store.set(planned.resultKey, JSON.stringify({ state: "success" }));
    return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
  };
  await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0 });
  expect(step.calls.some((c) => c.startsWith("dispatch-start-lint-try1"))).toBe(true);
  expect(step.calls.some((c) => c.startsWith("sleep:"))).toBe(true);
  expect("waitForEvent" in step).toBe(false);
});
```

- [ ] **Step 2: Run the file**

Run: `cd apps/fleet && bun test test/bun/gate-leg-run.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 3: Full targeted bun-test sweep (heavy gate — run alone)**

Run: `cd apps/fleet && bun test test/bun/gate-*.test.ts`
Expected: PASS (every gate-prefixed bun test file this plan touched or depends on, together, once).

- [ ] **Step 4: Commit**

```bash
git add apps/fleet/test/bun/gate-leg-run.test.ts
git commit -m "test(gate): rewrite the stale 'no waitForEvent' invariant test (#1398)

The old test's own title ('the start step is the whole leg') described
runLegStep's sync-legacy shape only -- split into two tests: one pinning
that shape is UNCHANGED for the old path, one pinning runLegStepPolling's
OPPOSITE shape (many short steps) for the new path, both still asserting
no waitForEvent/sendEvent exists anywhere (review r1's decision holds for
both paths).

Refs #1398, #1396."
```

---

## Self-Review

**Spec coverage** — every section of `docs/superpowers/specs/2026-10-26-async-run-leg-design.md` maps to a task:
- "The governing invariant" → Task 1 (fixes the ALREADY-present bug) + Task 7 (`runLegStepPolling`'s own `legStarted`/`dispatch.startedAt` minting).
- "New architecture" / dispatch+poll shape → Tasks 5, 7, 8.
- "Reusing the existing result-key scheme" (both r2-fixed subsections) → Task 2.
- "Retries" → Task 7.
- "Infra classification" → Task 7's `isLegInfraDescription` + unchanged `infra-rerun.ts` (no task touches it, correctly, per spec "Non-goals").
- "Deadline (#1390) and the write-once race" → Task 6 (`claimOrReadBack`) + Task 7 (the give-up call site) + Task 9 (the DO's own call site).
- "Watchdog touch" → Task 7 (touch() called inside each poll step's own callback, per-tick, per this plan's own Global Constraints pin of Leftovers item 2).
- "Carry/union legs" → no task (correctly — plan-time, upstream, spec's own "unaffected by construction").
- "In-flight replay at deploy" → covered by Task 1/7's governing-invariant compliance + Task 12's replay engine test.
- "Container lifetime across alarm gaps" → Task 3 (`setInactivityTimeout`) + Task 9 (`alarm()`'s own never-drop guarantee).
- "Secrets across alarm ticks" → Task 8 (persist) + Task 9 (read + redact + delete).
- "Superseded runs" → Task 4 (`isLiveStatus`) + Task 9 (the periodic check).
- "Cost" → Global Constraints note (re-check against real PR sizes) + Task 11's own default-OFF rollout.
- "New request/response contract" → Task 8.
- "Testing" (bun-testable items 1-7 + real-engine items 1-4) → Tasks 1, 2, 4, 6, 7 (bun-testable) and Task 12 (engine).
- "Migration" → Tasks 10, 11.
- "Leftovers" items 1-6 → item 1 (Global Constraints note), item 2 (Global Constraints pin), item 3 (Task 4's `isLiveStatus`), item 4 (Task 2 Step 9's hand-verification), item 5 (explicitly deferred past this plan in Task 9's own `observeOnce` comment, flagged for a follow-up with its own test coverage — not silently dropped), item 6 (Task 7/11's phase-qualified step names).
- "Open questions" 1-2 → both explicitly still open (DO alarm billing needs post-ship data; the exact Workflows `status()` values need checking against the live API before Task 9 ships — flagged in Task 4's own `isLiveStatus` doc comment as a thing to verify, not assumed).

**Placeholder scan** — no "TBD"/"handle edge cases"/"similar to Task N" in any task's own steps; Task 12's four engine tests are the one place this plan leaves an explicit `[fill in...]` bracket (Step 2) because the EXACT miniflare mechanism for simulating an invocation kill is genuinely unknown without opening the live `@cloudflare/vitest-pool-workers` version's own API first — this is flagged as a real unknown to resolve during that task, with a concrete fallback test already specified, not a vague "add tests" placeholder.

**Type consistency** — `DispatchOutcome` (Task 7) is the one type multiple later tasks must match EXACTLY: Task 8's `do.ts` response shapes (200/202/4xx) are what Task 11's `workflow.ts` dispatch closure parses back INTO a `DispatchOutcome`; `RunLegAlarmState` (Task 4) is constructed in Task 8 and consumed in Task 9 — both tasks were checked against the SAME field list above. `ClaimableBucket` (Task 6) is satisfied structurally by `R2Bucket` (used directly in Task 9 via a cast, same pattern `workflow.ts`'s existing `env.STUDIO_ARCHIVE as unknown as ...` casts already use elsewhere in this codebase) and by the fake buckets in Tasks 6/7/13's own tests.
