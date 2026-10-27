# Async /run-leg + DO-alarm polling — Implementation Plan (Part 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Split into 4 files** (GitHub omits the diff for a very large single file, which fails this repo's own leak-precheck closed, "no diff to scan"): this file (Part 1, Tasks 1-2), [Part 2](2026-10-27-async-run-leg-plan-1398-part2.md) (Tasks 3-6), [Part 3](2026-10-27-async-run-leg-plan-1398-part3.md) (Tasks 7-8), [Part 4](2026-10-27-async-run-leg-plan-1398-part4.md) (Tasks 9-13 + Self-Review). Read all four before starting; task numbering is continuous across them.

# Async /run-leg + DO-alarm polling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/run-leg`'s single, ~20-35-minute-long open DO call (the shape Cloudflare Workflows kills mid-flight past its own ~20-min per-invocation ceiling, #1393) with an async dispatch + DO-alarm poll + Workflow-side `step.sleep`/`step.do` poll loop, with zero production behavior change until an operator opts a repo in via a new flag.

**Architecture:** `/run-leg` starts the container and returns immediately (202), or a synchronous terminal `LegResult` for a pre-container-start refusal. A `GateRunnerDO` alarm polls the container on its own schedule (independent of any Workflow invocation), writing a terminal infra outcome to the leg's existing result key only when no container report ever arrives (write-once, so a genuine container report always wins). The Workflow side replaces its one long `step.do` with an explicit try-loop: a short dispatch step, then a `step.sleep(60s)` + short `step.do` R2-read loop. Both the old synchronous path and the new async path coexist, selected per-instance by a replay-safe `step.do('leg-mode', ...)` pin, itself driven by a new fleet-wide repo-allowlist flag (`GATE_ASYNC_LEGS`, mirroring `GATE_RUNNER_REPOS`'s existing shape) that defaults every repo to the OLD path.

**Tech Stack:** Cloudflare Workers, Durable Objects (alarms, `ctx.storage`), Cloudflare Workflows (`step.do`, `step.sleep`), R2 (conditional/write-once PUT), TypeScript, `bun:test` (pure logic) + `@cloudflare/vitest-pool-workers` (replay/alarm engine semantics).

**Spec:** `docs/superpowers/specs/2026-10-26-async-run-leg-design.md` (merged, PR #1397, refs #1396) — every task below cites the exact section it implements. Read both documents; this plan argues from that spec and does not repeat its reasoning, only its conclusions.

## Global Constraints

- **The governing invariant** (spec, "The governing invariant"): no `step.do` callback is long; every wall-clock value used for later deadline math is minted inside a `step.do` and returned, never a bare `Date.now()` between steps. This means `attemptId` is minted inside the dispatch step, the per-try elapsed-time check is its own `budget-<leg>-try<n>` step, and `touch()` fires from inside a step callback — never a bare `now()`/side effect in the surrounding try-loop. (Plan review r1 BLOCKER 1: an earlier draft of Task 7 violated this in three places; fixed below.)
- **R2 is the single source of truth** (spec, "New architecture"): no `step.waitForEvent`/`instance.sendEvent` anywhere in this implementation. A container's own R2 write is trusted as-is; ANY outcome the DO itself concludes (an infra guess, OR a result it observed/decided on its own, including the leg's own deadline red) is written via `claimOrReadBack`, R2_PREFIX-marked — never left unwritten just because it happens to classify as a "result" rather than "infra" (plan review r1 BLOCKER 2).
- **Reuse the existing result-key scheme** (spec, "Reusing the existing result-key scheme"): no new R2 key shape. Every try (including the `retry-<leg>` step's own internal infra-retries) gets a unique key via the EXISTING `infraRetryResultKey`/`retryResultKey` helpers, composed.
- **Tasks 1-2 change the LIVE synchronous path, not inert code** (plan review r1 item 6, correcting this plan's own earlier claim): `legStarted`'s replay-safe placement and the unique-key-per-try fix both land inside `runLegStep`/`outbound-handler.ts`/`log.ts`/`leg-env.ts` — functions EVERY existing gate run already calls today. Both are backward-compatible bug fixes (no key shape any existing run produces changes meaning; the new `.retry-tryN` shape is additive), but they are live-path changes, reviewed with that weight, not "dead code."
- **Zero NEW behavior reachable until opted in**: every task from Task 3 through Task 9 ships dead/inert code paths (new functions nothing calls yet, or calls gated behind a flag that defaults every repo to the old path). Tasks 10-11 are the only ones that wire the new path to anything live, and it still defaults OFF.
- **No container/image change**: `container/gate-server.ts`'s `/run`/`/result` protocol is unchanged (spec Non-goals). Do not touch it unless a task below says so (none do).
- **Step-count budget, corrected (plan review r1 item 8)**: an earlier draft of this plan undercounted by omitting the `leg-started`, `budget-<leg>-try<n>`, and give-up steps this revision's own BLOCKER-1/2 fixes add. Per leg, worst case: 1 `leg-started` step (once, shared across the whole leg) + up to 6 tries (3 in `start-<leg>`, 3 in `retry-<leg>`) × (1 dispatch + up to 35 poll steps + 1 budget step + up to 1 give-up step) ≈ `1 + 6 × 38 = 229` steps. A run with 30 parallel legs is then `~6,870` steps worst case — still comfortably inside the 10,000-step paid-plan budget, but with less headroom than this plan's own earlier (incorrect) estimate. **Before Task 11 ships**, query this fleet's actual largest historical PR by leg count (`fleet gate log`/the D1 run index) and confirm `229 × <that count>` stays well under budget — do not rely on the round "30 legs" estimate alone.
- **`touch()` cadence** (spec "Leftovers" item 2, pinned here): call `touch()` from inside EVERY poll step's own `step.do` callback, not every Nth. At a 60s poll interval the gap between touches is always far under `GATE_STALL_MS` (37 min); simplicity beats micro-optimizing an already-cheap, never-throwing call.
- **Heavy-gate discipline**: `npx tsc --noEmit` (both projects) and the targeted `bun test`/`vitest` files named in each task are the per-task gate. The FULL `bun test test/bun/` and the vitest-pool-workers suite are each a heavy gate — run them once per PR (not per task), never alongside each other.

## Rollout and rollback (plan review r1 item 6)

- **Deploy**: Worker-only, through the maestro's own `apps/fleet/scripts/deploy.sh`, from a clean worktree of `origin/main` — no image/container rebuild at any point in this plan (the container/gate-server.ts protocol is unchanged, per this plan's own Global Constraints and the spec's Non-goals). No studio in this fleet ever holds deploy credentials; every deploy in this rollout is the maestro's own action, never a studio's.
- **Canary before any real repo opt-in**: after Tasks 1-11 are merged and deployed, confirm the new path works AT ALL before adding a real gated repo to `GATE_ASYNC_LEGS` — e.g. a manually-triggered `fleet gate run` against a low-traffic/test repo with the flag opted in for that one repo, watched to a real green verdict, before opting in any repo whose gate blocks real PRs.
- **Rollback, in order, if a canary or an early real run misbehaves**:
  1. Flip `GATE_ASYNC_LEGS` back to excluding the affected repo (or empty). New Workflow instances for that repo immediately pin `"sync-legacy"` again (the `leg-mode` step re-evaluates the live flag for every NEW instance — only an ALREADY-PINNED in-flight instance is unaffected).
  2. **Drain**: wait for every in-flight `"async-poll"`-pinned instance to finish — bounded by `totalLegWallMs`'s own worst case across every leg in that run, never indefinite. An in-flight async instance keeps running its own pinned path to completion; it is never force-migrated.
  3. Only once no live instance can still be on the async path is a CODE rollback (reverting the merged PRs) safe to consider — reverting code while an async-pinned instance is still mid-run risks that instance hitting code paths a revert removed.
- **Follow-up, explicitly out of THIS plan's scope**: once every gated repo has migrated and run clean on the async path for a real operator-chosen soak period, a LATER, separate plan/PR deletes the old synchronous path (`runLegStep`'s non-`leg-started` internals stay, since Task 1 already fixed its one latent bug; the `sync-legacy` branch in `do.ts`/`workflow.ts` is what gets deleted). Not scheduled or scoped here.

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
it("the retry step's OWN internal infra-retries get unique keys too, never sharing .retry.json (plan review r1 item 5: this test must actually REACH the retry phase)", async () => {
  const step = fakeGenericStep();
  const seenKeys: string[] = [];
  let startAttempts = 0;
  const spyDispatch = async (planned: PlannedLeg, attemptId: string, signal: AbortSignal) => {
    seenKeys.push(planned.resultKey);
    startAttempts++;
    if (startAttempts === 1) {
      // start-<leg>'s own first (and only) try: a RED test, not infra -- this
      // is what makes isRetryable true and advances to the retry-<leg> phase
      // at all. Everything AFTER this is the retry phase's own internal
      // infra-retry loop, which is what this test actually needs to exercise.
      return reply({ state: "failure", description: "3 failed" });
    }
    // Every retry-<leg> internal try answers infra, so it exhausts its OWN
    // 3-try budget and we can observe every key it used.
    return reply({ state: "error", description: "gate container exited mid-leg" }, 503);
  };
  await runLegStep(step, spyDispatch, PLANNED);
  const retryKeys = seenKeys.filter((k) => k.includes(".retry"));
  expect(retryKeys).toEqual([
    "gate/o/r/runs/1/i/shard-lint.retry.json",
    "gate/o/r/runs/1/i/shard-lint.retry-try2.json",
    "gate/o/r/runs/1/i/shard-lint.retry-try3.json",
  ]);
  expect(new Set(retryKeys).size).toBe(retryKeys.length); // no duplicate keys
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

(Add `retryResultKey`, `infraRetryResultKey` to this test file's existing import line from `../../src/gate/leg-run` if not already imported. `PLANNED.resultKey` is `"gate/o/r/runs/1/i/shard-lint.json"`, per the file's own existing `PLANNED` fixture — the expected keys above use that exact leg name.)

The SECOND test above passes already today (it only exercises the existing, unchanged helper functions composed by hand) — it exists to PIN the exact composed shape the retry step's OWN internal `targetFor` must now produce, which the NEXT step wires in for real.

In `apps/fleet/test/bun/gate-outbound-handler.test.ts` (confirmed exact filename — `grep -rl RUN_RESULT_RE apps/fleet/test` during this task's own write-up), add to the existing `describe("PUT of a retry or head result key (write-once, leg's own key only)", ...)` block, following that block's own `fakeBucket`/`req`/`handleGateOutbound` pattern exactly:

```ts
it("a retry step's own 2nd/3rd internal try (shard-<leg>.retry-try2.json) PUTs write-once (201) (#1398)", async () => {
  const key = "gate/acme/example/runs/715/run-a/shard-typecheck.retry-try2.json";
  const { bucket, store } = fakeBucket();
  const res = await handleGateOutbound(req("PUT", `/${key}`, { body: "{}" }), bucket, { resultKey: key, repo: "acme/example" });
  expect(res.status).toBe(201);
  expect(store.has(key)).toBe(true);
});

it("a DOUBLE .retry (shard-<leg>.retry.retry-try2.json) is still refused, same as the existing .retry.retry.json case", async () => {
  const bad = "gate/acme/example/runs/715/run-a/shard-typecheck.retry.retry-try2.json";
  const { bucket, calls } = fakeBucket();
  const res = await handleGateOutbound(req("PUT", `/${bad}`, { body: "{}" }), bucket, { resultKey: bad, repo: "acme/example" });
  expect(res.status).toBe(403);
  expect(calls).toEqual([]);
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

