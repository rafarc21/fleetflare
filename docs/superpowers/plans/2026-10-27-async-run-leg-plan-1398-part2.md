# Async /run-leg + DO-alarm polling — Implementation Plan (Part 2 of 4)

> **Continued from [Part 1](2026-10-27-async-run-leg-plan-1398-part1.md)** (Goal/Architecture/Tech Stack/Spec/Global Constraints/Rollout, Tasks 1-2). This file: Tasks 3-6. Next: [Part 3](2026-10-27-async-run-leg-plan-1398-part3.md) (Tasks 7-8), [Part 4](2026-10-27-async-run-leg-plan-1398-part4.md) (Tasks 9-13 + Self-Review). Task numbering is continuous across all four files — read Part 1 first for the Global Constraints every task below assumes.


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
- Consumes: `LegOutcome`, `NO_INSTANCE_DESCRIPTION` (from `run-leg.ts` — IMPORTED, never re-declared as a second literal, plan review r1 item 8), `LegResult` (from `verdict.ts`), `legTimeoutMin`, `legStepDeadlineMs`-adjacent constants (from `config.ts`).
- Produces: `RunLegAlarmState`, `PollSignal`, `AlarmTickDecision`, `nextAlarmStep(state, now, signal): AlarmTickDecision`, `isLiveStatus(status: string): boolean`, `asyncAttemptDeadlineMs(timeoutMin: number | undefined): number` (plan review r1 BLOCKER 2 — the Workflow's own give-up backstop, below, and Task 7's poll loop both import this, so the DO's own worst-case timing and the Workflow's backstop can never drift apart) — every later task that touches `do.ts`'s real `alarm()` (Task 9), the superseded-run check (also Task 9), or `runLegStepPolling`'s own give-up logic (Task 7) imports these by these exact names.

- [ ] **Step 1: Write the failing test**

Create `apps/fleet/test/bun/gate-run-leg-alarm.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { nextAlarmStep, isLiveStatus, asyncAttemptDeadlineMs, type RunLegAlarmState } from "../../src/gate/run-leg-alarm";
import { NO_INSTANCE_DESCRIPTION } from "../../src/gate/run-leg";

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

  it("moves to PORT-RETRY (not polling) when the container is running but the port is refused (plan review r1 item 7: port-retry was unreachable)", () => {
    const decision = nextAlarmStep(BASE_STATE, 5_000, { kind: "running-not-listening" });
    expect(decision.kind).toBe("re-arm");
    if (decision.kind === "re-arm") {
      expect(decision.state.phase).toBe("port-retry");
      expect(decision.state.portRetryStartedAt).toBe(5_000);
    }
  });

  it("moves to POLLING once /run is actually accepted (202)", () => {
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
    if (decision.kind === "re-arm") expect(decision.state.phase).toBe("port-retry"); // stays, never regresses
  });

  it("gives up as infra once the 90s port-retry budget is spent", () => {
    const decision = nextAlarmStep(PORT_RETRY_STATE, 91_000, { kind: "running-not-listening" });
    expect(decision).toEqual({
      kind: "terminal", outcome: { kind: "infra", description: "gate server unreachable after 90 s" },
    });
  });

  it("the no-instance refusal fails fast, never spending the port-retry budget", () => {
    const decision = nextAlarmStep(PORT_RETRY_STATE, 5_000, { kind: "no-instance" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: NO_INSTANCE_DESCRIPTION } });
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

  it("a poll-result that arrives in the SAME tick the deadline elapses WINS -- never dropped for the synthetic deadline message (plan review r1 item 7)", () => {
    const state: RunLegAlarmState = { ...POLLING_STATE, timeoutMin: 25 };
    const decision = nextAlarmStep(state, 25 * 60_000, { kind: "poll-result", result: { state: "success" } });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "result", result: { state: "success" } } });
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

describe("asyncAttemptDeadlineMs (plan review r1 BLOCKER 2: the Workflow's own backstop must be STRICTLY LONGER than the DO's own worst case)", () => {
  it("exceeds 180s ready-wait + 90s port-retry + the leg's own timeout, with real grace", () => {
    const doWorstCaseMs = 180_000 + 90_000 + 25 * 60_000;
    expect(asyncAttemptDeadlineMs(25)).toBeGreaterThan(doWorstCaseMs);
  });

  it("scales with a non-default timeoutMin the same way", () => {
    const doWorstCaseMs = 180_000 + 90_000 + 10 * 60_000;
    expect(asyncAttemptDeadlineMs(10)).toBeGreaterThan(doWorstCaseMs);
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
import { NO_INSTANCE_DESCRIPTION, type LegOutcome } from "./run-leg";
import { legTimeoutMin } from "./config";

const READY_TIMEOUT_MS = 180_000;
const PORT_RETRY_BUDGET_MS = 90_000;
/** #1398 review r1 item 10: 15-30s per tick -- a DO wake is a real billed
 *  event, unlike the old in-request sleep, so coarser than the container's
 *  own 5s POLL_MS is the right choice. */
export const ALARM_TICK_MS = 20_000;
/** #1398 plan review r1 BLOCKER 2: real slack on top of the DO's own worst
 *  case, covering alarm-tick scheduling jitter and at-least-once redelivery
 *  delay -- the Workflow's own give-up backstop (asyncAttemptDeadlineMs,
 *  below) must never fire while the DO could still legitimately be working. */
const ASYNC_GRACE_MS = 5 * 60_000;

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

/** One tick of the DO's own state machine: given where this attempt is
 *  (`state`), the current time, and ONE freshly-observed signal, decide
 *  whether to re-arm (and how the state should look next tick) or conclude
 *  the attempt. Pure -- do.ts's real alarm() is the thin wrapper that
 *  fetches the signal and persists/acts on this return value.
 *
 *  Branch order matters (plan review r1 item 7): a `poll-result`/`run-result`
 *  signal is checked BEFORE any deadline check in every phase, so a leg that
 *  genuinely finishes in the SAME tick its own deadline elapses still gets
 *  its real result, never the synthetic deadline message. */
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
      // #1398 plan review r1 item 7: the container IS running and the DO DID
      // attempt /run -- a refusal here means "listening not yet bound," the
      // port-retry phase's own job, never a reason to keep calling this
      // "waiting for ready" (which only means "c.running is still false").
      if (signal.kind === "running-not-listening") {
        return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, phase: "port-retry", portRetryStartedAt: now } };
      }
      // "not-running": the container itself has not come up yet.
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
      // #1398 plan review r1 item 7: checked FIRST -- a real result wins over
      // a same-tick deadline, never the reverse.
      if (signal.kind === "poll-result") return { kind: "terminal", outcome: { kind: "result", result: signal.result } };
      const minutes = legTimeoutMin(state.timeoutMin);
      if (now - startedAt >= minutes * 60_000) {
        return {
          kind: "terminal",
          outcome: { kind: "result", result: { state: "error", description: `${state.leg} exceeded ${minutes} min without a result` } },
        };
      }
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

/**
 * #1398 plan review r1 BLOCKER 2: the Workflow's OWN poll loop needs its own
 * give-up deadline, for the case the DO's alarm never gets to run its own
 * check at all (a true platform fault -- the alarm went dormant, spec
 * "Container lifetime"). That backstop must be STRICTLY LONGER than the
 * total time the DO could legitimately still be working within (its own
 * ready-wait + port-retry + polling budgets), plus real grace for alarm
 * scheduling jitter -- otherwise the Workflow's own "give up" write could
 * race (and sometimes lose to, sometimes wrongly precede) the DO's own
 * still-in-progress, legitimate work. One function, used by BOTH do.ts's
 * internal math (indirectly, via the same three constants) and
 * runLegStepPolling's own poll loop (Task 7), so they can never drift apart.
 */
export function asyncAttemptDeadlineMs(timeoutMin: number | undefined): number {
  return READY_TIMEOUT_MS + PORT_RETRY_BUDGET_MS + legTimeoutMin(timeoutMin) * 60_000 + ASYNC_GRACE_MS;
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

Plan review r1 fixes folded in: waiting-for-ready now actually transitions
to port-retry on a refused connection (it previously never left
waiting-for-ready at all -- port-retry was dead code); a poll-result is
checked before the deadline in every phase, so a leg that finishes in the
same tick its deadline elapses keeps its real result; NO_INSTANCE_DESCRIPTION
is imported from run-leg.ts, not re-declared.

asyncAttemptDeadlineMs (BLOCKER 2) gives the Workflow's own poll-loop
backstop a deadline strictly longer than the DO's own worst-case total time
(180s ready-wait + 90s port-retry + the leg's own timeout, plus real grace)
-- Task 7 imports this same function so the two can never drift apart.

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

