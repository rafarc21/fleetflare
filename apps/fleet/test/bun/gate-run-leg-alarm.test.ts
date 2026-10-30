import { describe, it, expect } from "bun:test";
import { nextAlarmStep, isLiveStatus, asyncAttemptDeadlineMs, ALARM_TICK_MS, alarmTick, abandonAttempt, observeOnce, type AlarmTickDeps, type GateRunnerPort, type RunLegAlarmState } from "../../src/gate/run-leg-alarm";
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
      expect(decision.state.legStartedAt).toBe(5_000); // the leg's own clock starts here
      expect(decision.afterMs).toBe(ALARM_TICK_MS);
    }
  });

  it("moves to POLLING once /run is actually accepted (202)", () => {
    const decision = nextAlarmStep(BASE_STATE, 5_000, { kind: "run-accepted" });
    expect(decision.kind).toBe("re-arm");
    if (decision.kind === "re-arm") {
      expect(decision.state.phase).toBe("polling");
      expect(decision.state.pollStartedAt).toBe(5_000);
      expect(decision.state.legStartedAt).toBe(5_000); // minted at the first /run attempt
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

  it("the leg's deadline anchors at legStartedAt, not pollStartedAt (review r1 item a: port-retry time counts against timeoutMin)", () => {
    // /run was first attempted at t=0 (legStartedAt=0), then spent 90 s in
    // port-retry before /run was accepted at t=90_000 (pollStartedAt).
    const state: RunLegAlarmState = { ...POLLING_STATE, timeoutMin: 25, legStartedAt: 0, pollStartedAt: 90_000 };
    // Only pollStartedAt's 90 s has elapsed, but the leg has been running 91 s.
    const decision = nextAlarmStep(state, 91_000, { kind: "poll-pending" });
    expect(decision.kind).toBe("re-arm"); // not yet: 91 s < 25 min
    // The full 25 min measured from legStartedAt (t=0) elapses at 25*60_000.
    const atDeadline = nextAlarmStep(state, 25 * 60_000, { kind: "poll-pending" });
    expect(atDeadline).toEqual({
      kind: "terminal",
      outcome: { kind: "result", result: { state: "error", description: "lint exceeded 25 min without a result" } },
    });
  });

  it("a not-running signal in the polling phase ends the leg as infra NOW, never a silent re-arm (review r1 item b)", () => {
    const decision = nextAlarmStep(POLLING_STATE, 5_000, { kind: "not-running" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: "gate container exited mid-leg" } });
  });

  it("not-running in polling wins over a same-tick deadline as infra, never a red 'exceeded' body (review r1 item b, item 4 ordering)", () => {
    const state: RunLegAlarmState = { ...POLLING_STATE, timeoutMin: 25, legStartedAt: 0 };
    const decision = nextAlarmStep(state, 25 * 60_000, { kind: "not-running" });
    expect(decision).toEqual({ kind: "terminal", outcome: { kind: "infra", description: "gate container exited mid-leg" } });
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
function fakeAlarmDeps(opts: { observe?: AlarmTickDeps["observe"]; instanceStatus?: AlarmTickDeps["instanceStatus"]; log?: AlarmTickDeps["log"] } = {}) {
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
    putStateThrows: undefined as Error | undefined,
    getSecretValuesThrows: undefined as Error | undefined,
    // #1436 item 3: how many of the NEXT bucket.put calls throw (simulating
    // an R2 outage) before one finally succeeds -- 0 means every put
    // succeeds normally (the write-once conflict check still applies).
    // putCallCount counts every attempt, success or throw, for retry-count
    // assertions.
    putFailTimes: 0,
    putCallCount: 0,
    logged: [] as string[],
  };
  const deps: AlarmTickDeps = {
    storage: {
      getState: async () => fixture.state,
      getSecretValues: async () => { if (fixture.getSecretValuesThrows) throw fixture.getSecretValuesThrows; return fixture.secretValues; },
      putState: async (s) => { if (fixture.putStateThrows) throw fixture.putStateThrows; fixture.state = s; },
      deleteSecretValues: async () => { if (fixture.deleteSecretValuesThrows) throw fixture.deleteSecretValuesThrows; fixture.secretValues = undefined; },
      deleteState: async () => { fixture.state = undefined as unknown as RunLegAlarmState; },
      scheduleAlarm: async (at) => { if (fixture.scheduleAlarmThrows) throw fixture.scheduleAlarmThrows; fixture.scheduledAtMs.push(at); },
    },
    container: { destroy: async () => { fixture.destroyCount++; if (fixture.destroyThrows) throw fixture.destroyThrows; } },
    bucket: {
      put: async (key, value) => {
        fixture.putCallCount++;
        if (fixture.putFailTimes > 0) { fixture.putFailTimes--; throw new Error("r2 put down"); }
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
    log: opts.log ?? (async (m: string) => { fixture.logged.push(m); }),
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

  // #1428 (a): a secretValues record stranded with no alarmState (e.g. after
  // CF stops retrying a throwing alarm() at ~6 tries) is cleared by the
  // stray-tick branch, so a granted secret never rests in DO storage forever.
  it("a stray tick with no state still clears a leftover secretValues record (r2 leftover a)", async () => {
    const { deps, fixture } = fakeAlarmDeps();
    fixture.state = undefined;
    fixture.secretValues = { "staging-login": "sup3r-s3cret" };
    expect(await alarmTick(deps)).toBe("done");
    expect(fixture.secretValues).toBeUndefined();
  });

  // #1428 (a): the give-up path arms the one-shot sweep alarm BEFORE its
  // deletes, so a later stray tick has the state-less branch above to run.
  it("the give-up path arms a far-future sweep alarm before deleting (r2 leftover a)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => { throw new Error("stuck"); } });
    fixture.state = { ...fixture.state!, consecutiveFailures: 4 };
    fixture.nowMs = 1_000_000;
    expect(await alarmTick(deps)).toBe("gave-up-after-failures");
    expect(fixture.scheduledAtMs).toContain(1_000_000 + 3_600_000); // 60 min out
  });

  // #1428 (b): a putState throw on the re-arm path must rethrow exactly like
  // scheduleAlarm's -- the plan's original draft swallowed it with .catch,
  // which returned normally and stranded the attempt (CF never retried).
  it("a putState throw on the re-arm path rethrows, so CF's own alarm retry takes over (r2 leftover b)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => { throw new Error("stuck"); } });
    fixture.putStateThrows = new Error("storage put rejected");
    await expect(alarmTick(deps)).rejects.toThrow("storage put rejected");
  });

  // #1428 (d): the thrown error text logged by the catch is redacted before
  // it reaches the logger -- a secret value echoed in an error message never
  // escapes unscrubbed into the log.
  it("the catch-log redacts a secret value carried in the error text (r2 leftover d)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => { throw new Error("auth failed with staging-login=sup3r-s3cret"); } });
    fixture.secretValues = { "staging-login": "sup3r-s3cret" };
    await alarmTick(deps);
    const logged = fixture.logged.join("\n");
    expect(logged).not.toContain("sup3r-s3cret");
    expect(logged).toContain("«redacted»");
  });

  // #1436 security review item 2: the failure counter must advance even when
  // the redact+log attempt ITSELF fails (a storage fault reading
  // getSecretValues, or a throwing logger) -- counting first, before the
  // best-effort redact+log, is what makes this true; counting AFTER would
  // let a storage fault silently stall the counter forever.
  it("the failure counter advances even when getSecretValues() throws inside the catch's own redact+log attempt (#1436 item 2)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => { throw new Error("stuck"); } });
    fixture.getSecretValuesThrows = new Error("storage read down");
    const result = await alarmTick(deps);
    expect(result).toBe("re-armed");
    expect(fixture.state?.consecutiveFailures).toBe(1);
    // The redact+log attempt itself failed (it needs getSecretValues'
    // result), so the fallback line is what actually reached the logger.
    expect(fixture.logged.join("\n")).toContain("error text withheld");
  });

  it("the failure counter advances even when getSecretValues() throws AND the cap is reached in the same tick (#1436 item 2)", async () => {
    const { deps, fixture } = fakeAlarmDeps({ observe: async () => { throw new Error("stuck"); } });
    fixture.state = { ...fixture.state!, consecutiveFailures: 4 };
    fixture.getSecretValuesThrows = new Error("storage read down");
    const result = await alarmTick(deps);
    expect(result).toBe("gave-up-after-failures");
    expect(fixture.logged.join("\n")).toContain("error text withheld");
  });

  // #1436 security review item 3: writeTerminalOutcome's own R2 PUT can throw
  // (an outage, not the write-once conflict claimOrReadBack already handles
  // by returning null) -- silently swallowing it loses the attempt's real
  // result, and the Workflow then waits its own ~35 min deadline for nothing.
  describe("writeTerminalOutcome retries a throwing R2 write up to 3x (#1436 item 3)", () => {
    it("succeeds on the 2nd attempt: normal teardown, exactly 2 put calls", async () => {
      const { deps, fixture } = fakeAlarmDeps({ observe: async () => ({ kind: "poll-failed" }) });
      fixture.putFailTimes = 1; // 1st throws, 2nd succeeds
      const result = await alarmTick(deps);
      expect(result).toBe("done");
      expect(fixture.putCallCount).toBe(2);
      const stored = JSON.parse(fixture.bucketStore.get(BASE_STATE.resultKey)!);
      expect(stored.description.startsWith(R2_PREFIX)).toBe(true);
      expect(fixture.destroyCount).toBe(1); // the write won -- normal teardown
      expect(fixture.state).toBeUndefined();
    });

    it("succeeds on the 3rd (last) attempt: still normal teardown, exactly 3 put calls", async () => {
      const { deps, fixture } = fakeAlarmDeps({ observe: async () => ({ kind: "poll-failed" }) });
      fixture.putFailTimes = 2;
      const result = await alarmTick(deps);
      expect(result).toBe("done");
      expect(fixture.putCallCount).toBe(3);
      expect(fixture.state).toBeUndefined();
    });

    it("fails all 3 tries: write-failed -- state and container are KEPT, consecutiveFailures counts it, re-arms (never torn down on a guess)", async () => {
      const { deps, fixture } = fakeAlarmDeps({ observe: async () => ({ kind: "poll-failed" }) });
      fixture.putFailTimes = 5; // more than the 3x cap -- never actually succeeds
      const result = await alarmTick(deps);
      expect(result).toBe("re-armed");
      expect(fixture.putCallCount).toBe(3); // exactly 3 tries, never a 4th
      expect(fixture.destroyCount).toBe(0); // container kept -- the real result is still unwritten
      expect(fixture.state).toBeDefined();
      expect(fixture.state?.consecutiveFailures).toBe(1);
      expect(fixture.scheduledAtMs.length).toBe(1);
      // Every failed attempt logs, redacted -- never a raw secret value.
      expect(fixture.logged.join("\n")).toContain("terminal write failed");
    });

    it("a write-failed tick's own logged attempts redact a granted secret value carried in the R2 error text", async () => {
      const { deps, fixture } = fakeAlarmDeps({
        observe: async () => ({ kind: "poll-result", result: { state: "failure", description: "contains secret-value-xyz" } }),
      });
      fixture.secretValues = { "my-secret": "secret-value-xyz" };
      fixture.putFailTimes = 5;
      await alarmTick(deps);
      const logged = fixture.logged.join("\n");
      expect(logged).toContain("terminal write failed");
      expect(logged).not.toContain("secret-value-xyz");
    });

    it("getSecretValues() itself throwing (the redaction corpus read, not the logging one) is a write-failed, never an uncaught throw out of alarmTick", async () => {
      const { deps, fixture } = fakeAlarmDeps({ observe: async () => ({ kind: "poll-failed" }) });
      fixture.getSecretValuesThrows = new Error("storage read down");
      const result = await alarmTick(deps);
      expect(result).toBe("re-armed");
      expect(fixture.destroyCount).toBe(0); // container kept -- the real result is still unwritten
      expect(fixture.state?.consecutiveFailures).toBe(1);
      expect(fixture.logged.join("\n")).toContain("could not read secrets for redaction");
    });

    it("repeated write-failed ticks accumulate consecutiveFailures toward the cap, eventually giving up", async () => {
      const { deps, fixture } = fakeAlarmDeps({ observe: async () => ({ kind: "poll-failed" }) });
      fixture.putFailTimes = 3;
      expect(await alarmTick(deps)).toBe("re-armed");
      expect(fixture.state?.consecutiveFailures).toBe(1);
      fixture.putFailTimes = 3;
      expect(await alarmTick(deps)).toBe("re-armed");
      expect(fixture.state?.consecutiveFailures).toBe(2);
    });
  });
});

describe("observeOnce (#1428 leftover e: do.ts's HTTP glue, now bun-tested)", () => {
  const PORT_PHASE = { phase: "waiting-for-ready" as const, resultKey: "k", leg: "lint", timeoutMin: undefined, readyStartedAt: 0, instanceId: "run-1", statusCheckCount: 0 };

  function portReturning(status: number, body: unknown): GateRunnerPort {
    return { fetch: async () => new Response(JSON.stringify(body), { status }) };
  }

  const alwaysRunning = () => true;
  const neverRunning = () => false;

  it("no port binding is poll-failed", async () => {
    expect(await observeOnce({ state: PORT_PHASE, running: alwaysRunning, getPort: () => undefined })).toEqual({ kind: "poll-failed" });
  });

  it("a not-yet-running container in waiting-for-ready is not-running, before any fetch AND before getPort is ever called (#1428 item 5)", async () => {
    let fetched = false;
    let portRequested = false;
    const getPort = () => { portRequested = true; return { fetch: async () => { fetched = true; return new Response(null, { status: 200 }); } }; };
    expect(await observeOnce({ state: PORT_PHASE, running: neverRunning, getPort })).toEqual({ kind: "not-running" });
    expect(fetched).toBe(false);
    // #1428 item 5: getTcpPort moved INSIDE the try, after the not-running
    // check -- a not-running container must never even ask for a port.
    expect(portRequested).toBe(false);
  });

  it("a /run 200 is a run-result carrying the body", async () => {
    const res = await observeOnce({ state: { ...PORT_PHASE, phase: "waiting-for-ready" }, running: alwaysRunning, getPort: () => portReturning(200, { state: "success" }) });
    expect(res).toEqual({ kind: "run-result", result: { state: "success" } });
  });

  it("a /run 202 is run-accepted", async () => {
    const res = await observeOnce({ state: { ...PORT_PHASE, phase: "waiting-for-ready" }, running: alwaysRunning, getPort: () => portReturning(202, {}) });
    expect(res).toEqual({ kind: "run-accepted" });
  });

  it("a /run other status is running-not-listening", async () => {
    const res = await observeOnce({ state: { ...PORT_PHASE, phase: "waiting-for-ready" }, running: alwaysRunning, getPort: () => portReturning(500, {}) });
    expect(res).toEqual({ kind: "running-not-listening" });
  });

  it("the polling phase hits /result: 200 is a poll-result, 202 is poll-pending", async () => {
    const polling = { ...PORT_PHASE, phase: "polling" as const, pollStartedAt: 0 };
    const ok = await observeOnce({ state: polling, running: alwaysRunning, getPort: () => portReturning(200, { state: "failure", description: "x" }) });
    expect(ok).toEqual({ kind: "poll-result", result: { state: "failure", description: "x" } });
    const pending = await observeOnce({ state: polling, running: alwaysRunning, getPort: () => portReturning(202, {}) });
    expect(pending).toEqual({ kind: "poll-pending" });
  });

  it("a no-instance fetch throw maps to no-instance in any phase", async () => {
    const port: GateRunnerPort = { fetch: async () => { throw new Error("no container instance available"); } };
    const res = await observeOnce({ state: PORT_PHASE, running: alwaysRunning, getPort: () => port });
    expect(res).toEqual({ kind: "no-instance" });
  });

  it("a non-no-instance throw during polling with a stopped container is poll-failed", async () => {
    const port: GateRunnerPort = { fetch: async () => { throw new Error("connection refused"); } };
    const res = await observeOnce({ state: { ...PORT_PHASE, phase: "polling", pollStartedAt: 0 }, running: neverRunning, getPort: () => port });
    expect(res).toEqual({ kind: "poll-failed" });
  });

  it("the same throw while still running reads as running-not-listening (retry, not infra)", async () => {
    const port: GateRunnerPort = { fetch: async () => { throw new Error("connection refused"); } };
    const res = await observeOnce({ state: { ...PORT_PHASE, phase: "polling", pollStartedAt: 0 }, running: alwaysRunning, getPort: () => port });
    expect(res).toEqual({ kind: "running-not-listening" });
  });

  // #1428 item 5: the ORIGINAL do.ts glue read `this.ctx.container.running`
  // ONCE, before the fetch, and reused that single stale snapshot in the
  // catch handler too. A container that dies DURING the fetch (a real race:
  // the fetch is awaited, running() is re-checked only after it settles)
  // must read as poll-failed -- the "stopped" classification -- never the
  // optimistic "still probably fine, retry" running-not-listening a STALE
  // pre-call `running` value would wrongly keep producing forever.
  it("running() is re-read FRESH in the catch, not reused from before the call -- a container that dies mid-fetch reads as poll-failed, never a stale running-not-listening (#1428 item 5)", async () => {
    let liveWhileFetching = true;
    const port: GateRunnerPort = {
      fetch: async () => {
        // The container dies WHILE this call is in flight -- a real race the
        // old single-snapshot design could never observe.
        liveWhileFetching = false;
        throw new Error("connection refused");
      },
    };
    const res = await observeOnce({
      state: { ...PORT_PHASE, phase: "polling", pollStartedAt: 0 },
      running: () => liveWhileFetching,
      getPort: () => port,
    });
    expect(res).toEqual({ kind: "poll-failed" });
  });

  it("conversely, a container that is STILL running when the catch runs stays running-not-listening, not poll-failed", async () => {
    const port: GateRunnerPort = { fetch: async () => { throw new Error("connection refused"); } };
    const res = await observeOnce({
      state: { ...PORT_PHASE, phase: "polling", pollStartedAt: 0 },
      running: () => true,
      getPort: () => port,
    });
    expect(res).toEqual({ kind: "running-not-listening" });
  });
});

/** A minimal, directly-inspectable fake for AbandonDeps. */
function fakeAbandonDeps(opts: { state?: RunLegAlarmState } = {}) {
  const fixture = {
    state: opts.state as RunLegAlarmState | undefined,
    secretValues: { x: "y" } as Record<string, string> | undefined,
    destroyCount: 0,
  };
  const deps = {
    storage: {
      getState: async () => fixture.state,
      deleteSecretValues: async () => { fixture.secretValues = undefined; },
      deleteState: async () => { fixture.state = undefined; },
    },
    container: { destroy: async () => { fixture.destroyCount++; } },
  };
  return { deps, fixture };
}

// #1428 item 1: the Workflow's own give-up write (leg-run.ts's
// dispatchAndPollOnce giveup step) calls this via an idempotent DO RPC
// (do.ts's /abandon route), so a truly dormant DO -- CF stopped retrying its
// throwing alarm(), the spec's own "Container lifetime" dormancy cliff -- is
// cleaned up promptly instead of waiting for the far slower one-shot secret
// sweep (item a, a 60 min backstop).
describe("abandonAttempt (#1428 item 1: Workflow-driven idempotent DO RPC)", () => {
  it("a matching resultKey destroys the container and deletes both secretValues and alarmState", async () => {
    const { deps, fixture } = fakeAbandonDeps({ state: { ...BASE_STATE, resultKey: "k1" } });
    const result = await abandonAttempt(deps, "k1");
    expect(result).toBe("abandoned");
    expect(fixture.destroyCount).toBe(1);
    expect(fixture.secretValues).toBeUndefined();
    expect(fixture.state).toBeUndefined();
  });

  it("no state at all (already cleaned up by its own tick, or a prior abandon call) is a safe no-op -- this IS the idempotency", async () => {
    const { deps, fixture } = fakeAbandonDeps({ state: undefined });
    const result = await abandonAttempt(deps, "k1");
    expect(result).toBe("no-op");
    expect(fixture.destroyCount).toBe(0);
  });

  it("calling it twice in a row (the real idempotent-RPC scenario) is 'abandoned' then 'no-op', never a second destroy", async () => {
    const { deps, fixture } = fakeAbandonDeps({ state: { ...BASE_STATE, resultKey: "k1" } });
    expect(await abandonAttempt(deps, "k1")).toBe("abandoned");
    expect(await abandonAttempt(deps, "k1")).toBe("no-op");
    expect(fixture.destroyCount).toBe(1); // never destroyed twice
  });

  // A stored state for a DIFFERENT resultKey can only mean this RPC reached
  // the wrong DO instance -- each attempt gets its own DEDICATED DO
  // (gateRunnerName), so this should never happen for a real attempt, but a
  // mismatch must never destroy work that is not this call's own: left
  // untouched, never guessed about.
  it("a resultKey that does NOT match the stored state's own is left untouched -- never destroys someone else's attempt", async () => {
    const { deps, fixture } = fakeAbandonDeps({ state: { ...BASE_STATE, resultKey: "k1" } });
    const result = await abandonAttempt(deps, "k2");
    expect(result).toBe("no-op");
    expect(fixture.destroyCount).toBe(0);
    expect(fixture.state).toBeDefined(); // untouched
    expect(fixture.secretValues).toBeDefined(); // untouched
  });

  it("no container binding is tolerated -- deletes still run", async () => {
    const { deps, fixture } = fakeAbandonDeps({ state: { ...BASE_STATE, resultKey: "k1" } });
    const result = await abandonAttempt({ ...deps, container: undefined }, "k1");
    expect(result).toBe("abandoned");
    expect(fixture.secretValues).toBeUndefined();
    expect(fixture.state).toBeUndefined();
  });
});
