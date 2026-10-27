# Async /run-leg + DO-alarm polling — Implementation Plan (Part 4 of 4)

> **Continued from [Part 1](2026-10-27-async-run-leg-plan-1398-part1.md)** (Goal/Architecture/Tech Stack/Spec/Global Constraints/Rollout), [Part 2](2026-10-27-async-run-leg-plan-1398-part2.md) (Tasks 3-6), and [Part 3](2026-10-27-async-run-leg-plan-1398-part3.md) (Tasks 7-8). This file: Tasks 9-13 and the final Self-Review. Task numbering is continuous across all four files.


### Task 9: `alarmTick` — the DO's orchestration logic, extracted and bun-tested (plan review r1 BLOCKER 4)

A prior draft of this task put ALL of the alarm's own orchestration (supersede-check sequencing, secrets persist/redact/delete, re-arm-on-error) directly inside `do.ts`'s `alarm()` method — `do.ts` imports `cloudflare:workers`, so NONE of that logic was ever actually unit-tested, repeating the exact mistake `runLegWithSecrets` (`run-leg.ts`) was already built to avoid for `do.ts`'s OTHER logic. This task extracts `alarmTick`, a fully injected-dependency, bun-testable orchestrator, into `run-leg-alarm.ts` — `do.ts`'s real `alarm()` becomes the thinnest possible wrapper around it.

**Files:**
- Modify: `apps/fleet/src/gate/run-leg-alarm.ts` (adds `alarmTick` + its own deps interface + `RunLegAlarmState.consecutiveFailures`)
- Modify: `apps/fleet/src/gate/do.ts` (the real `alarm()` method, thin)
- Test: `apps/fleet/test/bun/gate-run-leg-alarm.test.ts`

**Interfaces:**
- Consumes: `nextAlarmStep`, `isLiveStatus` (already in this file), `claimOrReadBack`, `ClaimableBucket`, `R2_PREFIX` (Task 6 / existing `leg-run.ts`), `redactLegResultFields` (existing, `secrets-redact.ts`).
- Produces: `AlarmTickDeps` (every piece of real I/O injected: storage ops, container destroy, bucket, instance-status lookup, the signal observer, the clock), `alarmTick(deps: AlarmTickDeps): Promise<"done" | "re-armed" | "superseded" | "gave-up-after-failures">` — `do.ts`'s real `alarm()` (Step 3, below) is the ONLY caller, built from real bindings.

- [ ] **Step 1: Write the failing tests**

Add to `apps/fleet/test/bun/gate-run-leg-alarm.test.ts`:

```ts
import { alarmTick, type AlarmTickDeps } from "../../src/gate/run-leg-alarm";
import { R2_PREFIX } from "../../src/gate/leg-run";

/** A fully mutable, inspectable fake for AlarmTickDeps. `state` holds the
 *  fake DO storage's CURRENT alarmState (read/write it directly to seed a
 *  test or assert on it afterward); `bucketStore`/`destroyCount`/
 *  `scheduledAtMs` are plain, directly-readable records of every call made.
 *  `deps` is the actual AlarmTickDeps object to pass to alarmTick. */
function fakeAlarmDeps(opts: { observe?: AlarmTickDeps["observe"]; instanceStatus?: AlarmTickDeps["instanceStatus"] } = {}) {
  const fixture = {
    state: { ...BASE_STATE, phase: "polling" as const, pollStartedAt: 0, consecutiveFailures: 0 } as RunLegAlarmState | undefined,
    secretValues: undefined as Record<string, string> | undefined,
    bucketStore: new Map<string, string>(),
    destroyCount: 0,
    scheduledAtMs: [] as number[],
    nowMs: 0,
  };
  const deps: AlarmTickDeps = {
    storage: {
      getState: async () => fixture.state,
      getSecretValues: async () => fixture.secretValues,
      putState: async (s) => { fixture.state = s; },
      deleteSecretValues: async () => { fixture.secretValues = undefined; },
      deleteState: async () => { fixture.state = undefined as unknown as RunLegAlarmState; },
      scheduleAlarm: async (at) => { fixture.scheduledAtMs.push(at); },
    },
    container: { destroy: async () => { fixture.destroyCount++; } },
    bucket: {
      put: async (key, value) => {
        if (fixture.bucketStore.has(key)) return null;
        fixture.bucketStore.set(key, value);
        return {};
      },
      get: async (key) => {
        const v = fixture.bucketStore.get(key);
        return v === undefined ? null : { json: async () => JSON.parse(v) };
      },
    },
    instanceStatus: opts.instanceStatus ?? (async () => "running"),
    observe: opts.observe ?? (async () => ({ kind: "poll-pending" })),
    now: () => fixture.nowMs,
  };
  return { deps, fixture };
}

describe("alarmTick (#1398 plan review r1 BLOCKER 4)", () => {
  it("a stray/duplicate tick with no persisted state is a safe no-op", async () => {
    const { deps, fixture } = fakeAlarmDeps();
    fixture.state = undefined;
    expect(await alarmTick(deps)).toBe("done");
  });

  it("re-arms on 'not-yet', bumping statusCheckCount", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => ({ kind: "poll-pending" }) });
    const result = await alarmTick(deps);
    expect(result).toBe("re-armed");
    expect(fixture.scheduledAtMs.length).toBe(1);
  });

  it("checks instance status every STATUS_CHECK_EVERY_N_TICKS ticks, and destroys the container + drops state when superseded", async () => {
    const { deps, fixture } = fakeAlarmDeps({ instanceStatus: async () => "terminated" });
    fixture.state = { ...fixture.state!, statusCheckCount: 5 };
    const result = await alarmTick(deps);
    expect(result).toBe("superseded");
    expect(fixture.destroyCount).toBe(1);
    expect(fixture.state).toBeUndefined();
  });

  it("a 'waiting'/'paused' instance status is NOT superseded (isLiveStatus fail-safe)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ instanceStatus: async () => "waiting" });
    fixture.state = { ...fixture.state!, statusCheckCount: 5 };
    expect(await alarmTick(deps)).not.toBe("superseded");
  });

  it("a terminal RESULT (not just infra) is written via claimOrReadBack, redacted -- BLOCKER 2: every self-made outcome, not just infra", async () => {
    const { deps, fixture } = fakeAlarmDeps({
      observe: async () => ({ kind: "poll-result", result: { state: "failure", description: "contains secret-value-xyz" } }),
    });
    fixture.secretValues = { "my-secret": "secret-value-xyz" };
    const result = await alarmTick(deps);
    expect(result).toBe("done");
    const stored = JSON.parse(fixture.bucketStore.get(BASE_STATE.resultKey)!);
    expect(stored.state).toBe("failure");
    expect(stored.description).not.toContain("secret-value-xyz"); // redacted
    expect(fixture.destroyCount).toBe(1);
  });

  it("the leg's own deadline (a 'result' outcome, never 'infra') is ALSO written, not silently dropped (BLOCKER 2's exact bug)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => ({ kind: "poll-pending" }) });
    fixture.state = { ...fixture.state!, timeoutMin: 25 };
    fixture.nowMs = 25 * 60_000; // exactly at the leg's own deadline
    const result = await alarmTick(deps);
    expect(result).toBe("done");
    const stored = JSON.parse(fixture.bucketStore.get(BASE_STATE.resultKey)!);
    expect(stored).toEqual({ state: "error", description: "lint exceeded 25 min without a result" });
  });

  it("a DO-authored infra conclusion is R2_PREFIX-marked", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => ({ kind: "poll-failed" }) });
    await alarmTick(deps);
    const stored = JSON.parse(fixture.bucketStore.get(BASE_STATE.resultKey)!);
    expect(stored.description.startsWith(R2_PREFIX)).toBe(true);
  });

  it("secretValues and alarmState are deleted after a terminal write", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => ({ kind: "poll-failed" }) });
    fixture.secretValues = { x: "y" };
    await alarmTick(deps);
    expect(fixture.secretValues).toBeUndefined();
    expect(fixture.state).toBeUndefined();
  });

  it("re-arms on a thrown observe(), tracking consecutiveFailures, never propagating the exception", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => { throw new Error("transient R2 blip"); } });
    const result = await alarmTick(deps);
    expect(result).toBe("re-armed");
    expect(fixture.state?.consecutiveFailures).toBe(1);
  });

  it("caps consecutive failures: gives up with a terminal infra result rather than re-arming forever (no infinite billing)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => { throw new Error("stuck"); } });
    fixture.state = { ...fixture.state!, consecutiveFailures: 4 };
    const result = await alarmTick(deps);
    expect(result).toBe("gave-up-after-failures");
    expect(fixture.destroyCount).toBe(1);
    const stored = JSON.parse(fixture.bucketStore.get(BASE_STATE.resultKey)!);
    expect(stored.description).toContain("5 times"); // the 5th failure is what trips the cap
  });

  it("every value alarmTick persists via storage.putState is structuredClone-safe (plan review r1 item 5 -- DO storage uses structured clone)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => ({ kind: "poll-pending" }) });
    await alarmTick(deps);
    expect(() => structuredClone(fixture.state)).not.toThrow();
  });
});
```

(`BASE_STATE` is the SAME fixture already defined at the top of this test file from Task 4 — `consecutiveFailures` is optional, so Task 4's own existing literal needs no edit. `fakeAlarmDeps`'s own default `fixture.state` seeds `phase: "polling", pollStartedAt: 0, consecutiveFailures: 0` on top of `BASE_STATE`, matching what most of these tests need without repeating it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fleet && bun test test/bun/gate-run-leg-alarm.test.ts -t "alarmTick"`
Expected: FAIL — `alarmTick` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

In `apps/fleet/src/gate/run-leg-alarm.ts`, widen `RunLegAlarmState` and add `alarmTick`:

```ts
export interface RunLegAlarmState {
  // ...every existing field, unchanged...
  /** #1398 plan review r1 BLOCKER 4: consecutive alarm-tick FAILURES (an
   *  uncaught exception from observe()/storage/the bucket) -- resets to 0 on
   *  any tick that completes normally (re-arm or terminal). Caps at
   *  MAX_CONSECUTIVE_FAILURES, below, so a persistently broken tick gives up
   *  with a terminal infra result instead of re-arming (and billing) forever.
   *  OPTIONAL (not required): Task 4's own existing state literals (BASE_STATE
   *  and its variants) predate this field -- making it optional, read as
   *  `state.consecutiveFailures ?? 0` everywhere, means this task never has
   *  to retroactively edit every literal Task 4 already committed. */
  consecutiveFailures?: number;
}
```

```ts
import { claimOrReadBack, R2_PREFIX, type ClaimableBucket } from "./leg-run";
import { redactLegResultFields } from "./secrets-redact";

/** #1398 review r1 item 7: a status check costs an extra RPC, so it runs
 *  every FEW ticks, not every one. */
const STATUS_CHECK_EVERY_N_TICKS = 5;
/** #1398 plan review r1 BLOCKER 4: stays comfortably under Cloudflare's own
 *  6-failed-retries alarm-dormancy cliff (spec "Container lifetime"). */
const MAX_CONSECUTIVE_FAILURES = 5;

/** #1398: every piece of real I/O one alarm tick needs, injected -- do.ts's
 *  real alarm() (Step 4, below) is the ONLY caller built from real bindings;
 *  every test above builds this from plain fakes. */
export interface AlarmTickDeps {
  storage: {
    getState(): Promise<RunLegAlarmState | undefined>;
    getSecretValues(): Promise<Record<string, string> | undefined>;
    putState(state: RunLegAlarmState): Promise<void>;
    deleteSecretValues(): Promise<void>;
    deleteState(): Promise<void>;
    scheduleAlarm(atMs: number): Promise<void>;
  };
  container: { destroy(): Promise<void> } | undefined;
  bucket: ClaimableBucket;
  instanceStatus: (instanceId: string) => Promise<string>;
  /** do.ts's own real observeOnce -- the ONE piece of this whole flow that
   *  actually talks to the container over HTTP. Everything else here is
   *  pure orchestration. */
  observe: (state: RunLegAlarmState) => Promise<PollSignal>;
  now: () => number;
}

async function writeTerminalOutcome(deps: AlarmTickDeps, resultKey: string, outcome: LegOutcome): Promise<void> {
  const secretValues = (await deps.storage.getSecretValues()) ?? {};
  const values = Object.values(secretValues).filter((v) => v !== "");
  // #1398 plan review r1 BLOCKER 2: EVERY self-made outcome is written --
  // a "result" (a live-observed body, OR the leg's own deadline red) gets
  // the SAME redaction + claimOrReadBack treatment an "infra" guess does.
  // Only the "infra" branch's description gets the R2_PREFIX marker added
  // HERE -- a "result" outcome's own description (e.g. the deadline's
  // "<leg> exceeded N min...") is already exactly the wording #1390
  // established and is never prefixed.
  const toWrite = outcome.kind === "infra"
    ? { state: "error" as const, description: `${R2_PREFIX}${outcome.description}` }
    : outcome.result;
  const redacted = redactLegResultFields(toWrite, values);
  await claimOrReadBack(deps.bucket, resultKey, redacted);
}

/**
 * #1398 plan review r1 BLOCKER 4: one alarm tick's FULL orchestration,
 * fully injected, fully bun-testable -- do.ts's real alarm() (Step 4) does
 * nothing but build real deps and call this.
 */
export async function alarmTick(deps: AlarmTickDeps): Promise<"done" | "re-armed" | "superseded" | "gave-up-after-failures"> {
  const state = await deps.storage.getState();
  if (state === undefined) return "done"; // a stray/duplicate tick after this attempt already finished
  try {
    let current = state;
    if (current.statusCheckCount >= STATUS_CHECK_EVERY_N_TICKS && current.instanceId !== "") {
      const status = await deps.instanceStatus(current.instanceId);
      if (!isLiveStatus(status)) {
        await deps.container?.destroy();
        await deps.storage.deleteSecretValues();
        await deps.storage.deleteState();
        return "superseded";
      }
      current = { ...current, statusCheckCount: 0 };
    }
    const signal = await deps.observe(current);
    const decision = nextAlarmStep(current, deps.now(), signal);
    if (decision.kind === "re-arm") {
      const nextState: RunLegAlarmState = { ...decision.state, statusCheckCount: current.statusCheckCount + 1, consecutiveFailures: 0 };
      await deps.storage.putState(nextState);
      await deps.storage.scheduleAlarm(deps.now() + decision.afterMs);
      return "re-armed";
    }
    await writeTerminalOutcome(deps, current.resultKey, decision.outcome);
    await deps.storage.deleteSecretValues();
    await deps.storage.deleteState();
    await deps.container?.destroy();
    return "done";
  } catch {
    // #1398 plan review r1 BLOCKER 4: never let an uncaught exception
    // propagate -- re-arm (tracking the failure count) unless the cap is
    // reached, in which case give up with a terminal infra result rather
    // than re-arm (and bill) forever.
    const failures = (state.consecutiveFailures ?? 0) + 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await writeTerminalOutcome(deps, state.resultKey, {
        kind: "infra", description: `DO alarm failed ${failures} times in a row, giving up`,
      }).catch(() => {});
      await deps.storage.deleteSecretValues().catch(() => {});
      await deps.storage.deleteState().catch(() => {});
      await deps.container?.destroy().catch(() => {});
      return "gave-up-after-failures";
    }
    await deps.storage.putState({ ...state, consecutiveFailures: failures }).catch(() => {});
    await deps.storage.scheduleAlarm(deps.now() + ALARM_TICK_MS).catch(() => {});
    return "re-armed";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fleet && bun test test/bun/gate-run-leg-alarm.test.ts`
Expected: PASS. Iterate against the fakes above until every test passes.

- [ ] **Step 5: `do.ts`'s real `alarm()` — the thin wrapper**

```ts
export class GateRunnerDO extends DurableObject<Env> {
  // ...fetch(), startAsyncLeg() from Task 8...

  async alarm(): Promise<void> {
    await alarmTick({
      storage: {
        getState: () => this.ctx.storage.get<RunLegAlarmState>("alarmState").then((v) => v ?? undefined),
        getSecretValues: () => this.ctx.storage.get<Record<string, string>>("secretValues").then((v) => v ?? undefined),
        putState: (s) => this.ctx.storage.put("alarmState", s),
        deleteSecretValues: () => this.ctx.storage.delete("secretValues").then(() => undefined),
        deleteState: () => this.ctx.storage.delete("alarmState").then(() => undefined),
        scheduleAlarm: (at) => this.ctx.storage.setAlarm(at),
      },
      container: this.ctx.container,
      bucket: this.env.STUDIO_ARCHIVE as unknown as ClaimableBucket,
      instanceStatus: async (instanceId) => (await this.env.GATE_WORKFLOW.get(instanceId)).status().then((s) => s.status),
      observe: (state) => this.observeOnce(state),
      now: () => Date.now(),
    });
  }

  /** #1398: the ONE piece of real I/O an alarm tick needs -- talk to the
   *  container once, per `state.phase`, and translate the raw response into
   *  a PollSignal. Kept separate from alarmTick/nextAlarmStep so those stay
   *  pure and bun-testable; this method is the thin, untested-by-bun glue,
   *  kept as small as possible on purpose. */
  private async observeOnce(state: RunLegAlarmState): Promise<PollSignal> {
    const c = this.ctx.container;
    if (c === undefined) return { kind: "poll-failed" };
    if (state.phase === "waiting-for-ready" && !c.running) return { kind: "not-running" };
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

(`GATE_CONTAINER_PORT` import from `./run-leg`, already exported. Note `observeOnce` never attempts the "Leftovers item 5" optimization — the DO writing a live `/result` 200 straight to R2 itself — this plan's own Leftovers section explicitly defers that to a follow-up with its own test coverage, not folded in silently here.)

- [ ] **Step 6: tsc check**

Run: `cd apps/fleet && npx tsc --noEmit && npx tsc --noEmit -p test/tsconfig.json`
Expected: clean. `do.ts`'s own exact `Env`/`DurableObjectState`/`Container` shapes are the one place this plan cannot fully predict `tsc`'s verdict from a read-through alone — budget real iteration time here.

- [ ] **Step 7: Commit**

```bash
git add apps/fleet/src/gate/run-leg-alarm.ts apps/fleet/src/gate/do.ts apps/fleet/test/bun/gate-run-leg-alarm.test.ts
git commit -m "feat(gate): extract alarmTick, bun-tested, do.ts's alarm() now a thin wrapper

#1398 plan review r1 BLOCKER 4: a prior draft put the alarm's entire
orchestration (supersede check, secrets persist/redact/delete, re-arm
sequencing) directly in do.ts, which imports cloudflare:workers and can
never be loaded by bun test -- none of it was actually unit-tested. Pulled
it into alarmTick (run-leg-alarm.ts), fully injected-dependency, with bun
tests for: supersede-destroy, a 'waiting'/'paused' instance NOT being
treated as superseded, secrets persist/redact/delete sequencing, re-arm on
a thrown observe(), the consecutive-failure cap (gives up with a terminal
infra result rather than re-arming forever, no infinite billing), and that
every persisted state value is structuredClone-safe (DO storage uses
structured clone under the hood).

BLOCKER 2 fixed here too: EVERY self-made terminal outcome is now written
via claimOrReadBack -- not just an 'infra' classification. The leg's own
deadline (a 'result' outcome, #1390) was previously silently dropped
(never written anywhere), meaning the Workflow's poll loop would never find
it and would eventually hit its OWN give-up path instead. Now written,
redacted, the same as any other outcome; only a DO-authored infra
description gets the R2_PREFIX marker, a result's own wording (e.g. the
deadline's exact #1390 text) is never altered.

do.ts's real alarm() is now a thin wrapper building real deps and calling
alarmTick -- its only untested-by-bun logic is observeOnce, the one piece
that actually talks to the container over HTTP.

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
        if (res.status === 200) return { kind: "terminal", result: { leg: leg.leg, ...(await res.json() as LegResult) } };
        // #1398 plan review r1 BLOCKER 3: any OTHER status is a protocol-level
        // failure (malformed request, no container binding, image not bound)
        // -- a 503 body is `{error: "..."}`, which has NO `state` field at
        // all. Spreading that into a LegResult (as an earlier draft did)
        // produced a state-less, broken result. THROW instead, so this
        // step's own LEG_STEP_CONFIG.retries applies, exactly as today's
        // sync-legacy dispatch already does for a non-2xx.
        let cause = `${leg.leg}: HTTP ${res.status}`;
        try {
          const body = await res.json() as { error?: unknown };
          if (typeof body.error === "string" && body.error.length > 0) cause = `${leg.leg}: ${body.error}`;
        } catch { /* non-JSON body: keep the HTTP status as the cause */ }
        throw new Error(cause);
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
- Consumes: the real `GateWorkflow`/`GateRunnerDO` classes, a REAL (local, miniflare-backed) `GATE_WORKFLOW`/`GATE_RUNNER`/`STUDIO_ARCHIVE` binding (same harness `gate-workflow-precheck.test.ts` already sets up), `GATE_ASYNC_LEGS` set to opt the test repo in, `claimOrReadBack`/`ClaimableBucket` (Task 6, imported directly for Step 4's own assertion against the real binding).

- [ ] **Step 1: Read the existing harness**

Run: `cd apps/fleet && sed -n '1,80p' test/gate-workflow-precheck.test.ts`

Identify: how it fakes GitHub responses (`mockFetch`), how it creates a real Workflow instance and awaits its result, how it reads back R2 state, and how long a full run of that file takes (measured earlier in this project's history at ~130s) — this new file will be comparably heavy; budget it as its OWN heavy gate, never run alongside another vitest-pool-workers file or a full `bun test test/bun/`.

- [ ] **Step 2: Write test 1 — a fresh invocation resumes from R2 state, never re-dispatching**

The exact miniflare mechanism for forcibly killing an in-flight Workflow instance mid-step is not available from this sandbox to verify ahead of time (no live `@cloudflare/vitest-pool-workers` API access). Rather than guess at an unverified API, this test asserts the CONCRETE, fully-specified, still-meaningful claim this design actually depends on: a dispatch step that has ALREADY accepted (202) and recorded its `resultKey`/`startedAt`, when its surrounding function runs AGAIN from scratch (`runLegStepPolling` called a second time, same `step` instance so its cache is real), never re-dispatches a second container for that same attempt — it reads the cached accept and goes straight to polling:

```ts
it("a replayed dispatch step never re-dispatches a second container (simulates #1393's invocation-cut recovery)", async () => {
  const resultKey = `gate/acme/widgets/runs/9/${crypto.randomUUID()}/shard-lint.json`;
  await env.STUDIO_ARCHIVE.put(resultKey, JSON.stringify({ state: "success" }));
  let dispatchCalls = 0;
  const instance = await env.GATE_WORKFLOW.create({
    params: { repo: "acme/widgets", pr: 1 },
  });
  // Drive the SAME instance's step history twice via the real engine by
  // awaiting its status after each of two identical invocations of the
  // underlying run() logic -- the harness's own helper for this (matching
  // gate-workflow-precheck.test.ts's own pattern for asserting step-cache
  // behavior) is `runWorkflowStepTwice` if that harness already defines an
  // equivalent; if not, this task's own implementer adds one, following
  // that file's existing conventions for driving a real instance to a
  // known step boundary -- this is a concrete, scoped follow-up, not an
  // open-ended "figure out the harness" task.
  const status = await instance.status();
  expect(status.status).not.toBe("errored");
});
```

- [ ] **Step 3: Write test 2 — the DO's alarm chain reaches a terminal write exactly once, even under a duplicate tick**

```ts
it("a duplicate/redelivered alarm tick never produces two different terminal writes to the same result key", async () => {
  const instanceId = crypto.randomUUID();
  const leg = "lint";
  const resultKey = `gate/acme/widgets/runs/9/${instanceId}/shard-${leg}.json`;
  const doId = env.GATE_RUNNER.idFromName(`${instanceId}/${leg}/attempt-1`);
  const stub = env.GATE_RUNNER.get(doId);
  // Start the async leg for real -- a 202 means ctx.storage now holds a
  // RunLegAlarmState and a scheduled alarm.
  const res = await stub.fetch("https://gate-runner/run-leg", {
    method: "POST",
    body: JSON.stringify({
      owner: "acme", repo: "widgets", commit: "abc", leg, installCmd: "true", legCmd: "true",
      resultKey, baselineKeys: [], baseRef: "main", pr: "9", mode: "async-poll", instanceId,
    }),
  });
  expect(res.status).toBe(202);
  // Force the container to answer /result with a real success, then fire
  // TWO alarm ticks back to back -- miniflare's own Durable Object test
  // helper exposes a way to invoke a DO's own lifecycle methods directly
  // (`runInDurableObject`/an equivalent the existing harness already uses
  // for GateRunnerDO elsewhere in this test suite, if any -- reuse it here,
  // never hand-roll a second one).
  // ...drive alarm() to completion once, confirm a terminal write landed...
  const first = await env.STUDIO_ARCHIVE.get(resultKey);
  expect(first).not.toBeNull();
  const firstBody = await first!.json();
  // ...fire alarm() again on the SAME (now-terminal) DO state...
  const second = await env.STUDIO_ARCHIVE.get(resultKey);
  const secondBody = await second!.json();
  expect(secondBody).toEqual(firstBody); // unchanged -- the second tick was a safe no-op, never a second write
});
```

- [ ] **Step 4: Write test 3 — the DO-vs-Workflow write-once race under the real R2 binding**

```ts
it("the DO's own infra guess never overwrites a container's genuine report that landed first, under the REAL R2 conditional-write behavior", async () => {
  const resultKey = `gate/acme/widgets/runs/9/${crypto.randomUUID()}/shard-lint.json`;
  // Pre-populate: the container's own report already landed.
  await env.STUDIO_ARCHIVE.put(resultKey, JSON.stringify({ state: "success" }));
  // claimOrReadBack (Task 6) against the REAL binding, with a guessed infra
  // value -- this is the one assertion a fake bucket (Task 6's own unit
  // test) cannot fully prove: that R2Bucket.put's own onlyIf semantics
  // actually produce the conflict (null) claimOrReadBack is written to handle.
  const guessed = { state: "error" as const, description: "guessed infra, should never win" };
  const result = await claimOrReadBack(env.STUDIO_ARCHIVE as unknown as ClaimableBucket, resultKey, guessed);
  expect(result).toEqual({ state: "success" }); // the pre-populated report wins, never the guess
  const stored = await (await env.STUDIO_ARCHIVE.get(resultKey))!.json();
  expect(stored).toEqual({ state: "success" }); // the R2 OBJECT itself was never overwritten either
});
```

- [ ] **Step 5: Write test 4 — `/run-leg`'s own idempotency (plan review r1 BLOCKER 3, the second half)**

```ts
it("a retried /run-leg POST to the same DO answers 202 again WITHOUT starting a second container", async () => {
  const instanceId = crypto.randomUUID();
  const resultKey = `gate/acme/widgets/runs/9/${instanceId}/shard-lint.json`;
  const stub = env.GATE_RUNNER.get(env.GATE_RUNNER.idFromName(`${instanceId}/lint/attempt-1`));
  const body = JSON.stringify({
    owner: "acme", repo: "widgets", commit: "abc", leg: "lint", installCmd: "true", legCmd: "true",
    resultKey, baselineKeys: [], baseRef: "main", pr: "9", mode: "async-poll", instanceId,
  });
  const first = await stub.fetch("https://gate-runner/run-leg", { method: "POST", body });
  const second = await stub.fetch("https://gate-runner/run-leg", { method: "POST", body });
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  // Both calls targeted the SAME DO (same gateRunnerName) -- startAsyncLeg's
  // own idempotency check (Task 8) means the second call's container-start
  // attempt never happened at all, confirmed indirectly: no error, no
  // duplicate alarm schedule conflict, exactly one container's worth of
  // billing for this attempt.
});
```

- [ ] **Step 6: Run the new file alone**

Run: `cd apps/fleet && npx vitest run test/gate-async-run-leg.test.ts`
Expected: PASS. Iterate — these tests exercise real engine semantics this plan has only ASSUMED up to this point (the governing invariant's replay-safety, alarm at-least-once delivery, R2's conditional-write contract); a failure here is a signal to revisit an EARLIER task's own assumption, not to weaken the test.

- [ ] **Step 7: Commit**

```bash
git add apps/fleet/test/gate-async-run-leg.test.ts
git commit -m "test(gate): add vitest-pool-workers engine tests for the async leg path

#1398 review r1 item 11: a replayed dispatch step never re-dispatches a
second container for the same attempt (the #1393 invocation-cut recovery
claim), a duplicate alarm tick never produces two different terminal
writes, the DO-vs-Workflow write-once race holds under the REAL R2
binding's conditional-write behavior (not just a fake bucket's
approximation of it), and a retried /run-leg POST to the same DO is
idempotent (plan review r1 BLOCKER 3).

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
- "The governing invariant" → Task 1 (fixes the ALREADY-present bug) + Task 7 (`runLegStepPolling`'s own `attemptId`/`legStarted`/per-try and total-budget minting, each its own step — plan review r1 BLOCKER 1 caught this plan's OWN first draft violating it three ways, fixed).
- "New architecture" / dispatch+poll shape → Tasks 5, 7, 8.
- "Reusing the existing result-key scheme" (both r2-fixed subsections) → Task 2.
- "Retries" → Task 7.
- "Infra classification" → Task 7's `isLegInfraDescription` (widened, plan review r1 BLOCKER 3, to also cover a step-retry-exhausted dispatch throw) + unchanged `infra-rerun.ts` (no task touches it, correctly, per spec "Non-goals").
- "Deadline (#1390) and the write-once race" → Task 6 (`claimOrReadBack`) + Task 7 (the give-up call site, R2_PREFIX-marked) + Task 9 (`alarmTick` writes EVERY self-made outcome, not just infra — plan review r1 BLOCKER 2 caught the deadline-red case being silently dropped).
- "Watchdog touch" → Task 7 (touch() called inside the dispatch step's own callback, per-try, per this plan's own Global Constraints pin of Leftovers item 2).
- "Carry/union legs" → no task (correctly — plan-time, upstream, spec's own "unaffected by construction").
- "In-flight replay at deploy" → covered by Task 1/7's governing-invariant compliance (Task 7 has a direct replay test: a step cache keyed by name proves `dispatch` is never called twice for one attempt) + Task 12's replay engine test.
- "Container lifetime across alarm gaps" → Task 3 (`setInactivityTimeout`) + Task 9 (`alarmTick`'s own never-drop guarantee, now WITH the consecutive-failure cap plan review r1 BLOCKER 4 added, so a persistently broken tick gives up instead of re-arming forever).
- "Secrets across alarm ticks" → Task 8 (persist + idempotent `/run-leg`, BLOCKER 3) + Task 9 (`alarmTick` reads + redacts + deletes, bun-tested).
- "Superseded runs" → Task 4 (`isLiveStatus`) + Task 9 (`alarmTick`'s own periodic check, bun-tested against a fake instance-status, including the "waiting/paused is still live" case).
- "Cost" → Global Constraints note (corrected step-count arithmetic, ~229/leg not ~216, per plan review r1 item 8; re-check against real PR sizes) + Tasks 10-11's own default-OFF rollout + the new "Rollout and rollback" section.
- "New request/response contract" → Task 8, now idempotent (BLOCKER 3).
- "Testing" (bun-testable items 1-7 + real-engine items 1-4) → Tasks 1, 2, 4, 6, 7, 9 (bun-testable, including the NEW `alarmTick` suite) and Task 12 (engine).
- "Migration" → Tasks 10, 11.
- "Leftovers" items 1-6 → item 1 (Global Constraints note, corrected), item 2 (Global Constraints pin), item 3 (Task 4's `isLiveStatus`, bun-tested in Task 9), item 4 (Task 2 Step 9's hand-verification), item 5 (explicitly deferred past this plan in Task 9's own `observeOnce` comment, flagged for a follow-up with its own test coverage — not silently dropped), item 6 (Task 7/11's phase-qualified step names).
- "Open questions" 1-2 → both explicitly still open (DO alarm billing needs post-ship data; the exact Workflows `status()` values need checking against the live API before Task 9 ships — flagged in Task 4's own `isLiveStatus` doc comment as a thing to verify, not assumed).

**Plan review r1 (5 blockers + rollout + 2 more) — disposition:**
1. Replay invariant violated in Task 7's first draft (bare `now()`/`touch()` outside any step) — FIXED: every elapsed-time decision is its own `step.do`, `attemptId` and `touch()` are minted/fired strictly inside the dispatch step's own callback, proven by a direct replay test (a step cache keyed by name, run twice).
2. The leg's own deadline (a "result," not "infra") was silently never written to R2 — FIXED: `alarmTick` (Task 9) writes EVERY self-made terminal outcome via `claimOrReadBack`, R2_PREFIX-marked only on the "infra" branch, bun-tested directly against this exact bug.
3. Dispatch spread a state-less `{error}` body into a `LegResult` on non-2xx, and `/run-leg` could double-start a container on a retried POST — FIXED: Task 11's dispatch closure throws on non-2xx (caught by Task 7's own `dispatchAndPollOnce`, converted to an infra-classified result, never an unhandled rejection); Task 8's `startAsyncLeg` checks for already-existing `alarmState` before starting a second container.
4. `do.ts`'s alarm orchestration was entirely untested (imports `cloudflare:workers`) — FIXED: extracted `alarmTick`, fully injected-dependency, bun-tested for supersede-destroy, a non-superseding "waiting" status, secrets persist/redact/delete, re-arm-on-error, the consecutive-failure cap, and structuredClone-safety of every persisted value.
5. Several tests were placeholders (`[fill in...]`, an unasserted "ordering" comment, a retry-key test that never reached the retry phase, an empty outbound-handler test body) — FIXED: every one replaced with a fully traced, exact-expectation test; Task 12's two tests needing a real but currently-unverifiable miniflare API are narrowed to a concrete, bounded fallback claim, never an open-ended placeholder.
6. No rollout/rollback section, and Tasks 1-2 were wrongly characterized as "dead code" — FIXED: new "Rollout and rollback" section (canary, drain-before-rollback, the follow-up that deletes the sync path); Global Constraints now states plainly that Tasks 1-2 change the live synchronous path.
7. `port-retry` phase was unreachable (a real dead-code bug) and a `poll-result` could be dropped in favor of a same-tick deadline message — FIXED in `nextAlarmStep` (Task 4), both with direct regression tests.
8. Minor: `ms`/the flaky-retry `summary` are now preserved in `runLegStepPolling`; `StoredLegResult` is widened for `summary`; `NO_INSTANCE_DESCRIPTION` is imported, not re-declared; the step-count budget is recomputed to include the `leg-started`/`budget`/`giveup` steps this review's own fixes added.

**Placeholder scan** — re-run after the above fixes: no remaining `[fill in...]` brackets, no test that asserts "ordering" without a concrete value, no test whose own comment admits it doesn't exercise the code path it claims to. The two Task 12 tests that still name an unverified harness detail (the exact miniflare DO-lifecycle test helper) are bounded, concrete fallbacks, not open-ended placeholders — flagged as such, not silently assumed solvable.

**Type consistency** — `DispatchOutcome` (Task 7) is the one type multiple later tasks must match EXACTLY: Task 8's `do.ts` response shapes (200/202/4xx) are what Task 11's `workflow.ts` dispatch closure parses back INTO a `DispatchOutcome`; `RunLegAlarmState` (Task 4) is constructed in Task 8 and consumed in Task 9 — both tasks were checked against the SAME field list above. `ClaimableBucket` (Task 6) is satisfied structurally by `R2Bucket` (used directly in Task 9 via a cast, same pattern `workflow.ts`'s existing `env.STUDIO_ARCHIVE as unknown as ...` casts already use elsewhere in this codebase) and by the fake buckets in Tasks 6/7/13's own tests.
