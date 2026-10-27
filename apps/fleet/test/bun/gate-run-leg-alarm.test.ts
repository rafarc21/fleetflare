import { describe, it, expect } from "bun:test";
import { nextAlarmStep, isLiveStatus, asyncAttemptDeadlineMs, ALARM_TICK_MS, alarmTick, type AlarmTickDeps, type RunLegAlarmState } from "../../src/gate/run-leg-alarm";
import { NO_INSTANCE_DESCRIPTION } from "../../src/gate/run-leg";
import { R2_PREFIX } from "../../src/gate/leg-run";

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
    if (decision.kind === "re-arm") expect(decision.afterMs).toBe(ALARM_TICK_MS);
  });

  it("gives up as infra once the 180s readiness budget is spent", () => {
    const decision = nextAlarmStep(BASE_STATE, 181_000, { kind: "not-running" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: "gate container did not start within 180 s" } });
  });

  it("the readiness deadline is inclusive at exactly 180s, and just under stays re-arm (review r1: >= vs > boundary)", () => {
    // readyStartedAt is 0; the tick lands at exactly 180_000.
    const atBoundary = nextAlarmStep(BASE_STATE, 180_000, { kind: "not-running" });
    expect(atBoundary).toEqual({ kind: "terminal", outcome: { kind: "infra", description: "gate container did not start within 180 s" } });
    const justUnder = nextAlarmStep(BASE_STATE, 179_999, { kind: "not-running" });
    expect(justUnder.kind).toBe("re-arm");
  });

  it("moves to PORT-RETRY (not polling) when the container is running but the port is refused (plan review r1 item 7: port-retry was unreachable)", () => {
    const decision = nextAlarmStep(BASE_STATE, 5_000, { kind: "running-not-listening" });
    expect(decision.kind).toBe("re-arm");
    if (decision.kind === "re-arm") {
      expect(decision.state.phase).toBe("port-retry");
      expect(decision.state.portRetryStartedAt).toBe(5_000);
      expect(decision.afterMs).toBe(ALARM_TICK_MS);
    }
  });

  it("moves to POLLING once /run is actually accepted (202)", () => {
    const decision = nextAlarmStep(BASE_STATE, 5_000, { kind: "run-accepted" });
    expect(decision.kind).toBe("re-arm");
    if (decision.kind === "re-arm") {
      expect(decision.state.phase).toBe("polling");
      expect(decision.state.pollStartedAt).toBe(5_000);
      expect(decision.afterMs).toBe(ALARM_TICK_MS);
    }
  });

  it("goes straight to a terminal result when /run itself answers 200 (a near-instant leg)", () => {
    const decision = nextAlarmStep(BASE_STATE, 5_000, { kind: "run-result", result: { state: "success" } });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "result", result: { state: "success" } } });
  });

  it("the no-instance refusal fails fast in the waiting phase too, never spending any budget", () => {
    const decision = nextAlarmStep(BASE_STATE, 5_000, { kind: "no-instance" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: NO_INSTANCE_DESCRIPTION } });
  });
});

describe("nextAlarmStep: port-retry phase", () => {
  const PORT_RETRY_STATE: RunLegAlarmState = { ...BASE_STATE, phase: "port-retry", portRetryStartedAt: 0 };

  it("re-arms on a refused connection, within the 90s budget", () => {
    const decision = nextAlarmStep(PORT_RETRY_STATE, 5_000, { kind: "running-not-listening" });
    expect(decision.kind).toBe("re-arm");
    if (decision.kind === "re-arm") {
      expect(decision.state.phase).toBe("port-retry"); // stays, never regresses
      expect(decision.afterMs).toBe(ALARM_TICK_MS);
    }
  });

  it("gives up as infra once the 90s port-retry budget is spent", () => {
    const decision = nextAlarmStep(PORT_RETRY_STATE, 91_000, { kind: "running-not-listening" });
    expect(decision).toEqual({
      kind: "terminal", outcome: { kind: "infra", description: "gate server unreachable after 90 s" },
    });
  });

  it("the port-retry deadline is inclusive at exactly 90s, and just under stays re-arm (review r1: >= vs > boundary)", () => {
    const atBoundary = nextAlarmStep(PORT_RETRY_STATE, 90_000, { kind: "running-not-listening" });
    expect(atBoundary).toEqual({ kind: "terminal", outcome: { kind: "infra", description: "gate server unreachable after 90 s" } });
    const justUnder = nextAlarmStep(PORT_RETRY_STATE, 89_999, { kind: "running-not-listening" });
    expect(justUnder.kind).toBe("re-arm");
  });

  it("reaching run-accepted from port-retry moves to polling (review r1: deleting this branch passes all tests today)", () => {
    const decision = nextAlarmStep(PORT_RETRY_STATE, 5_000, { kind: "run-accepted" });
    expect(decision.kind).toBe("re-arm");
    if (decision.kind === "re-arm") {
      expect(decision.state.phase).toBe("polling");
      expect(decision.state.pollStartedAt).toBe(5_000);
    }
  });

  it("reaching run-result from port-retry is a terminal result (review r1: deleting this branch passes all tests today)", () => {
    const decision = nextAlarmStep(PORT_RETRY_STATE, 5_000, { kind: "run-result", result: { state: "failure", description: "x" } });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "result", result: { state: "failure", description: "x" } } });
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

  it("poll-failed in the SAME tick the deadline elapses is infra, never a red 'exceeded' body (review r1 item 4: poll-failed checked BEFORE the deadline)", () => {
    const state: RunLegAlarmState = { ...POLLING_STATE, timeoutMin: 25 };
    const decision = nextAlarmStep(state, 25 * 60_000, { kind: "poll-failed" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: "gate container exited mid-leg" } });
  });

  it("the no-instance refusal fails fast in the polling phase too, never spending the leg's own deadline", () => {
    const decision = nextAlarmStep(POLLING_STATE, 5_000, { kind: "no-instance" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: NO_INSTANCE_DESCRIPTION } });
  });
});

describe("nextAlarmStep: run-rejected (review r1 item 5: /run non-200/202 is infra with the status text, never 'running-not-listening')", () => {
  it("a /run rejection is terminal infra carrying the status text, whatever the phase", () => {
    const decision = nextAlarmStep(BASE_STATE, 5_000, { kind: "run-rejected", description: "gate server HTTP 500" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: "gate server HTTP 500" } });
  });

  it("a /run rejection from the port-retry phase is also terminal infra, never a retry", () => {
    const PORT_RETRY_STATE: RunLegAlarmState = { ...BASE_STATE, phase: "port-retry", portRetryStartedAt: 0 };
    const decision = nextAlarmStep(PORT_RETRY_STATE, 5_000, { kind: "run-rejected", description: "gate server HTTP 403" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: "gate server HTTP 403" } });
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
    deleteSecretValuesThrows: undefined as Error | undefined,
    scheduleAlarmThrows: undefined as Error | undefined,
    destroyThrows: undefined as Error | undefined,
  };
  const deps: AlarmTickDeps = {
    storage: {
      getState: async () => fixture.state,
      getSecretValues: async () => fixture.secretValues,
      putState: async (s) => { fixture.state = s; },
      deleteSecretValues: async () => { if (fixture.deleteSecretValuesThrows) throw fixture.deleteSecretValuesThrows; fixture.secretValues = undefined; },
      deleteState: async () => { fixture.state = undefined as unknown as RunLegAlarmState; },
      scheduleAlarm: async (at) => { if (fixture.scheduleAlarmThrows) throw fixture.scheduleAlarmThrows; fixture.scheduledAtMs.push(at); },
    },
    container: { destroy: async () => { fixture.destroyCount++; if (fixture.destroyThrows) throw fixture.destroyThrows; } },
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

  it("the superseded path deletes secretValues (r1 item 1: deleting the call passes all 37)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ instanceStatus: async () => "terminated" });
    fixture.state = { ...fixture.state!, statusCheckCount: 5 };
    fixture.secretValues = { x: "y" };
    expect(await alarmTick(deps)).toBe("superseded");
    expect(fixture.secretValues).toBeUndefined();
  });

  it("the give-up path deletes secretValues (r1 item 1: deleting the call passes all 37)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => { throw new Error("stuck"); } });
    fixture.state = { ...fixture.state!, consecutiveFailures: 4 };
    fixture.secretValues = { x: "y" };
    expect(await alarmTick(deps)).toBe("gave-up-after-failures");
    expect(fixture.secretValues).toBeUndefined();
  });

  it("an empty instanceId '' is NEVER superseded, even with a terminal status (r1 item 2)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ instanceStatus: async () => "terminated" });
    fixture.state = { ...fixture.state!, instanceId: "", statusCheckCount: 5 };
    expect(await alarmTick(deps)).not.toBe("superseded");
    expect(fixture.destroyCount).toBe(0);
  });

  it("a scheduleAlarm throw on the re-arm path rethrows, so CF's own alarm retry takes over (r1 item 3)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => { throw new Error("stuck"); } });
    fixture.scheduleAlarmThrows = new Error("setAlarm rejected");
    await expect(alarmTick(deps)).rejects.toThrow("setAlarm rejected");
  });

  it("a deleteSecretValues throw on the give-up path rethrows, so CF's own alarm retry takes over (r1 item 3)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => { throw new Error("stuck"); } });
    fixture.state = { ...fixture.state!, consecutiveFailures: 4 };
    fixture.deleteSecretValuesThrows = new Error("storage delete rejected");
    await expect(alarmTick(deps)).rejects.toThrow("storage delete rejected");
  });

  it("a throwing container.destroy on the normal terminal path does NOT re-arm: keys still deleted (r1 item 4)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => ({ kind: "poll-failed" }) });
    fixture.destroyThrows = new Error("destroy rejected");
    fixture.secretValues = { x: "y" };
    expect(await alarmTick(deps)).toBe("done");
    expect(fixture.secretValues).toBeUndefined();
    expect(fixture.state).toBeUndefined();
    expect(fixture.scheduledAtMs.length).toBe(0); // no re-arm scheduled
  });
});
