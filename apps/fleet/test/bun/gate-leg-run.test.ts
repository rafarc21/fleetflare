// runLegStep is the one-leg decision GateWorkflow makes: one start-<leg> step
// whose return value is the GateRunnerDO's LegResult. Imported from
// leg-run.ts, not workflow.ts: workflow.ts imports cloudflare:workers, which
// bun test cannot load.
import { describe, it, expect, spyOn } from "bun:test";
import { claimOrReadBack, combineCauses, gateRunnerName, infraRetryResultKey, LEG_STEP_CONFIG, legResultReader, MAX_COMBINED_CAUSE_CHARS, recoverCandidateKeys, retryResultKey, runLegStep, runLegStepPolling, isLegInfraDescription, R2_PREFIX, type DispatchOutcome, type LegStepConfig, type LegStepContext } from "../../src/gate/leg-run";
import { isInfraLegFailure } from "../../src/gate/infra-rerun";
import type { PlannedLeg } from "../../src/gate/fanout";
import type { LegResult } from "../../src/gate/verdict";

const PLANNED: PlannedLeg = {
  leg: "lint", commit: "abc", installCmd: "bun install", legCmd: "bun run lint",
  resultKey: "gate/o/r/runs/1/i/shard-lint.json", baselineKeys: [],
};

// Mirrors Workflows' retry rule: a step that throws is re-run until its retry
// limit is spent, then the error propagates to the caller. ctx.attempt is
// 1-based, matching Workflows' durable per-attempt counter (#1321).
// Generic (#1398): LegStepRunner.do is generic (the real WorkflowStep.do is
// too), so a fake pinned to one return type (LegResult) is no longer
// structurally assignable to it -- every call site in this file still gets
// LegResult back in practice, this just lets tsc see that it COULD be any T.
function fakeStep() {
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
    // #1398: runLegStepPolling needs sleep() too (its poll loop); runLegStep
    // never calls it (it uses deps.sleep). A no-op keeps the auto-step-retry
    // test assignable to PollingLegStepRunner without polluting `calls`.
    sleep: async () => {},
  };
}

// #1398: an alias -- kept as a separate name at the one call site (the
// legStarted-mint test) that deliberately exercises a non-LegResult return
// type, so that test's own intent (proving the generic widening) reads
// clearly without implying every OTHER fakeStep() call in this file also
// returns something other than LegResult.
const fakeGenericStep = fakeStep;

// #1398 review r1: models a REAL Workflows REPLAY (after an engine crash or
// deploy), not a step RETRY. A step name that has already completed returns
// its cached result WITHOUT invoking the callback again -- distinct from
// fakeStep/fakeGenericStep above, whose retry loop re-invokes the callback
// every call (that models Workflows' own automatic step-retry, a different
// mechanism). Lets a test seed a step as "already done" from a prior run,
// then call runLegStep again as the replay, to prove deadline math reads the
// CACHED mint time, never a second live clock read.
function fakeReplayingStep() {
  const cache = new Map<string, unknown>();
  return {
    cache,
    do: async <T>(name: string, _config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T> => {
      if (cache.has(name)) return cache.get(name) as T;
      const result = await fn(undefined);
      cache.set(name, result);
      return result;
    },
  };
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("runLegStep", () => {
  it("mints legStarted in its own step, first, and uses THAT value for total-deadline math, never a fresh Date.now() (governing invariant, #1398)", async () => {
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

  it("a replay after a crash reuses the leg-started step's CACHED mint time for deadline math, never a fresh now() read between steps (review r1, #1398)", async () => {
    const step = fakeReplayingStep();
    // The first run: the leg-started step mints and caches 0, then the engine
    // crashes before start-lint ever completes (modeled by never calling
    // runLegStep at all that first time -- only the one step Workflows itself
    // would already have durably recorded gets seeded).
    await step.do("leg-started-lint", LEG_STEP_CONFIG, async () => 0);

    // The replay: a fresh now() of 5000ms and a 1000ms total deadline. If
    // legStarted truly comes from the step's CACHED return (0), elapsed
    // (5000) already exceeds totalDeadlineMs -- zero dispatches, immediate
    // error. A mutant that reads now() fresh OUTSIDE the step and assigns
    // legStarted from THAT instead of step.do's return value would see
    // elapsed as 0 (5000 - 5000) and dispatch anyway -- this is exactly what
    // review r1 reported surviving the suite as written.
    let dispatches = 0;
    const dispatch = async () => { dispatches++; return reply({ state: "success" }); };
    const result = await runLegStep(step, dispatch, PLANNED, { now: () => 5000, totalDeadlineMs: 1000 });

    expect(dispatches).toBe(0);
    expect(result.state).toBe("error");
  });

  it("a leg deadline (200, state error) is final: no infra retry and no flaky retry", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "error", description: "lint exceeded 25 min without a result" });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "error", description: "lint exceeded 25 min without a result" });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint"]);
  });

  it("success: returns the DO payload as the leg result", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "success" });
    expect(await runLegStep(step, dispatch, PLANNED)).toEqual({ ms: expect.any(Number), leg: "lint", state: "success" });
  });

  it("failure: a red leg retries once as retry-<leg>, and a second failure is the final result", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ state: "failure", description: "3 errors" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "failure", description: "3 errors", redFirst: true });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("failure then success on retry: success with 'flaky: passed on retry'", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return sent === 1 ? reply({ state: "failure", description: "timing" }) : reply({ state: "success" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "success", description: "flaky: passed on retry; first: timing" });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("error: a leg-reported error is data, carried through", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "error", description: "container OOM" });
    expect(await runLegStep(step, dispatch, PLANNED)).toEqual({
      ms: expect.any(Number),
      leg: "lint", state: "error", description: "container OOM",
    });
  });

  it("non-2xx: retried twice (#1231); the 503 error body surfaces as '<leg>: <error>' for every attempt, combined", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ error: "gate container did not start within 180 s" }, 503); };
    const result = await runLegStep(step, dispatch, PLANNED);
    const cause = "lint: gate container did not start within 180 s after 0 min";
    expect(result.leg).toBe("lint");
    expect(result.state).toBe("error");
    expect(result.description).toBe(combineCauses([cause, cause, cause]));
    expect(sent).toBe(3);
  });

  it("the infra cause is cut at 200 chars per attempt, then the wall time is appended, then all 3 attempts are combined (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ error: "x".repeat(300) }, 503);
    const result = await runLegStep(step, dispatch, PLANNED);
    const cause = `lint: ${"x".repeat(200 - "lint: ".length)} after 0 min`;
    expect(result.state).toBe("error");
    expect(result.description).toBe(combineCauses([cause, cause, cause]));
  });

  it("every attempt's cause survives combineCauses, not just the first (#1231): a flat slice would erase attempts 2 and 3 entirely", async () => {
    const step = fakeStep();
    // Each attempt's error body is distinguished right after "lint: " so the
    // marker stays inside the 200-char per-attempt cap, unlike a trailing marker.
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ error: `${sent}${"x".repeat(193)}` }, 503); };
    const result = await runLegStep(step, dispatch, PLANNED);
    const causeFor = (n: number) => `lint: ${n}${"x".repeat(193)} after 0 min`;
    expect(result.state).toBe("error");
    expect(result.description).toBe(combineCauses([causeFor(1), causeFor(2), causeFor(3)]));
    // The old flat-slice code kept only the first ~140 chars of the joined
    // causes, so attempts 2 and 3 were wholly absent from the description —
    // not merely shortened. Each attempt's marker must now survive.
    expect(result.description).toContain("lint: 1");
    expect(result.description).toContain("lint: 2");
    expect(result.description).toContain("lint: 3");
  });

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

  it("a first success or error never retries — one start step only", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "error", description: "container OOM" });
    await runLegStep(step, dispatch, PLANNED);
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint"]);
  });

  it("start step config: two retries from a 15s exponential base delay, 30-minute attempt timeout (#1231)", async () => {
    const step = fakeStep();
    await runLegStep(step, async () => reply({ state: "success" }), PLANNED);
    expect(step.calls[0].config).toEqual({
      retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
      timeout: "30 minutes",
    });
  });

  it("caps a long description at 2,000 chars (step result limit)", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "failure", description: "x".repeat(5000) });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.description?.length).toBe(2000);
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint"]);
  });

  it("unknown state from the DO becomes error, never success", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "passed" });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.state).toBe("error");
    expect(result.description).toContain("unknown state");
  });
});

// #1231: retries.limit raised from 1 to 2, so a start-<leg> step now gets up
// to 2 infra retries (3 total attempts) before giving up.
describe("runLegStep: two infra retries, not one (#1231)", () => {
  it("two infra failures then success: the third attempt's result is the leg's success", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      if (sent <= 2) return reply({ error: "gate container did not start within 180 s" }, 503);
      return reply({ state: "success" });
    };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toMatchObject({ leg: "lint", state: "success" });
    expect(sent).toBe(3);
  });

  it("three infra failures: final error combines all attempt causes, capped at 140 chars", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ error: `attempt ${sent} boom` }, 503); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.state).toBe("error");
    expect(result.description!.length).toBeLessThanOrEqual(MAX_COMBINED_CAUSE_CHARS);
    expect(result.description).toContain("attempt 1 boom");
    expect(result.description).toContain("attempt 2 boom");
    expect(result.description).toContain("attempt 3 boom");
    expect(sent).toBe(3);
  });
});

describe("combineCauses: every failed attempt's cause, joined, capped at 140 chars (#1231)", () => {
  it("causes that fit comfortably are joined verbatim with '; ', no truncation marker", () => {
    expect(combineCauses(["a: boom", "b: boom", "c: boom"])).toBe("a: boom; b: boom; c: boom");
  });

  it("causes that together exceed 140 chars are cut within the budget, each ending with an ellipsis (#1231: a fair share per cause, not a flat slice)", () => {
    const result = combineCauses(["x".repeat(60), "y".repeat(60), "z".repeat(60)]);
    expect(result.length).toBeLessThanOrEqual(MAX_COMBINED_CAUSE_CHARS);
    // Each cause is shortened on its own, so each truncated cause's own ellipsis
    // shows up, not just one at the very end of the joined string.
    expect(result.split("; ").every((part) => part.endsWith("…"))).toBe(true);
  });

  it("3 long causes: a flat slice would erase causes 2 and 3 entirely; each cause gets a fair share instead (#1231)", () => {
    const causes = [`AAAA${"x".repeat(100)}`, `BBBB${"y".repeat(100)}`, `CCCC${"z".repeat(100)}`];
    const result = combineCauses(causes);
    expect(result.length).toBeLessThanOrEqual(MAX_COMBINED_CAUSE_CHARS);
    // Every cause's leading marker must survive as a nonempty fragment — none
    // of the three is wholly erased by the others' length.
    expect(result).toContain("AAAA");
    expect(result).toContain("BBBB");
    expect(result).toContain("CCCC");
  });
});

describe("runLegStep: time and test summary per leg (#1049)", () => {
  it("ms is the sum of both attempts' wall time when a red leg retries (Date.now read inside each step)", async () => {
    const clock = [1_000, 1_500, 2_000, 2_300];
    const now = spyOn(Date, "now").mockImplementation(() => (clock.length > 1 ? clock.shift()! : clock[0]));
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return sent === 1 ? reply({ state: "failure", description: "timing" }) : reply({ state: "success" }); };
    try {
      const result = await runLegStep(step, dispatch, PLANNED);
      expect(result).toMatchObject({ state: "success", ms: 800, description: "flaky: passed on retry; first: timing" });
    } finally {
      now.mockRestore();
    }
  });

  it("the test summary the DO reports flows through to the leg result", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "failure", description: "lint exited 1", summary: "Tests  1 failed | 1640 passed (1641)" });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toMatchObject({ state: "failure", summary: "Tests  1 failed | 1640 passed (1641)" });
  });

  it("a flaky pass carries the retry's summary", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      return sent === 1 ? reply({ state: "failure", description: "timing" }) : reply({ state: "success", summary: "5 pass" });
    };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toMatchObject({ state: "success", description: "flaky: passed on retry; first: timing", summary: "5 pass" });
  });
});

describe("runLegStep: flaky evidence and HTTP fallback (#1057)", () => {
  it("the retry's resultKey is the first key with '.retry'; the first attempt keeps the plain key", async () => {
    const step = fakeStep();
    const keys: string[] = [];
    let sent = 0;
    const dispatch = async (p: PlannedLeg) => {
      keys.push(p.resultKey);
      sent++;
      return sent === 1 ? reply({ state: "failure", description: "timing" }) : reply({ state: "success" });
    };
    await runLegStep(step, dispatch, PLANNED);
    expect(keys).toEqual([
      "gate/o/r/runs/1/i/shard-lint.json",
      "gate/o/r/runs/1/i/shard-lint.retry.json",
    ]);
  });

  it("the flaky description cuts the first attempt's description at 150 chars", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      return sent === 1 ? reply({ state: "failure", description: "y".repeat(400) }) : reply({ state: "success" });
    };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.description).toBe(`flaky: passed on retry; first: ${"y".repeat(150)}`);
  });

  it("non-2xx with a non-JSON body: the cause is '<leg>: HTTP <status>', combined across all 3 attempts (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => new Response("<html>bad gateway</html>", { status: 502 });
    const result = await runLegStep(step, dispatch, PLANNED);
    const cause = "lint: HTTP 502 after 0 min";
    expect(result).toMatchObject({ leg: "lint", state: "error", description: combineCauses([cause, cause, cause]) });
  });
});

// Each attempt dispatches under its own DO name, so a retry never lands on the
// DO (and container) a previous attempt is still tearing down (#1068).
describe("gateRunnerName: one runner DO per leg attempt (#1068)", () => {
  it("names the DO by run instance, leg and attempt", () => {
    expect(gateRunnerName("run-1", "lint", "a1")).toBe("run-1/lint/a1");
  });

  it("two attempts of the same leg in the same run never share a name", () => {
    expect(gateRunnerName("run-1", "lint", "a1")).not.toBe(gateRunnerName("run-1", "lint", "a2"));
  });

  it("the same attempt id on two legs or two runs never share a name", () => {
    expect(gateRunnerName("run-1", "lint", "a1")).not.toBe(gateRunnerName("run-1", "test", "a1"));
    expect(gateRunnerName("run-1", "lint", "a1")).not.toBe(gateRunnerName("run-2", "lint", "a1"));
  });
});

describe("runLegStep: every attempt dispatches under a fresh attempt id (#1068)", () => {
  it("a start-step infra retry gets a new attempt id on every attempt (#1231): the id is made inside the step callback", async () => {
    const step = fakeStep();
    const ids: string[] = [];
    const dispatch = async (_p: PlannedLeg, attemptId: string) => {
      ids.push(attemptId);
      return reply({ error: "container not listening" }, 503);
    };
    await runLegStep(step, dispatch, PLANNED);
    expect(ids).toHaveLength(3);
    expect(ids[0]).not.toBe("");
    expect(new Set(ids).size).toBe(3);
  });

  it("a flaky red leg's retry-<leg> step gets its own attempt id", async () => {
    const step = fakeStep();
    const ids: string[] = [];
    const dispatch = async (_p: PlannedLeg, attemptId: string) => {
      ids.push(attemptId);
      return reply({ state: "failure", description: "timing" });
    };
    await runLegStep(step, dispatch, PLANNED);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("start infra retry, then red, then the flaky retry: three dispatches, three distinct ids", async () => {
    const step = fakeStep();
    const ids: string[] = [];
    const replies = [reply({ error: "not listening" }, 503), reply({ state: "failure", description: "timing" }), reply({ state: "success" })];
    const dispatch = async (_p: PlannedLeg, attemptId: string) => {
      ids.push(attemptId);
      return replies.shift()!;
    };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.state).toBe("success");
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});

// Thrown attempts still count: the wall time from the callback start is put
// into the thrown message. Date.now is pinned so the minutes are exact.
describe("runLegStep: a thrown attempt reports its wall time (#1068)", () => {
  it("an infra attempt that spends 4 min then throws says 'after 4 min', combined across all 3 attempts (#1231)", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const step = fakeStep();
      const dispatch = async () => { now += 4 * 60_000; return reply({ error: "gate server unreachable: The container is not listening" }, 503); };
      const result = await runLegStep(step, dispatch, PLANNED);
      const cause = "lint: gate server unreachable: The container is not listening after 4 min";
      expect(result).toEqual({
        leg: "lint", state: "error",
        description: combineCauses([cause, cause, cause]),
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("a dispatch that rejects (no reply at all) still reports its wall time, combined across all 3 attempts (#1231)", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const step = fakeStep();
      const dispatch = async () => { now += 2 * 60_000; throw new Error("socket reset"); };
      const result = await runLegStep(step, dispatch, PLANNED);
      const cause = "socket reset after 2 min";
      expect(result).toEqual({ leg: "lint", state: "error", description: combineCauses([cause, cause, cause]) });
    } finally {
      clock.mockRestore();
    }
  });

  it("a successful attempt's description is not given a time suffix", async () => {
    const step = fakeStep();
    const result = await runLegStep(step, async () => reply({ state: "error", description: "container OOM" }), PLANNED);
    expect(result.description).toBe("container OOM");
  });
});

// #1094: a transport loss (or a container that exited mid-leg) leaves the leg's
// verdict with only the transport error. The leg's own R2 result, written by
// the container before it stopped, says why: the description carries it.
describe("runLegStep: an infra failure carries the leg's R2 result (#1094)", () => {
  const LOST = "Network connection lost.";
  const EXITED = { state: "failure" as const, description: "lint exited 143" };

  it("transport lost, R2 holds a known result: that result is the leg's, its state from R2 (#1122)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => EXITED });
    // A SIGTERM'd container's "exited 143" read back after a transport loss is
    // infra, never a red test (#1321): no flaky retry, so the run auto-reruns
    // instead of reading it back red.
    expect(result).toMatchObject({
      leg: "lint", state: "error", description: "result read from R2 after transport loss: lint exited 143",
    });
    expect(sent).toBe(1);
  });

  it("a LIVE 200 'exited 137' stays a real failure: the test proc died, not the container (#1321 review)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ state: "failure", description: "lint exited 137" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    // An OOM kill (137) or `timeout -s KILL` in the leg cmd is the code under
    // test, so it earns the flaky retry and stays a red-first failure.
    expect(result).toMatchObject({
      leg: "lint", state: "failure", description: "lint exited 137", redFirst: true,
    });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("no R2 result for the leg: the description is the transport error, combined across all 3 attempts (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => undefined });
    const cause = `${LOST} after 0 min`;
    expect(result.description).toBe(combineCauses([cause, cause, cause]));
  });

  it("an R2 read that throws never masks the transport error, combined across all 3 attempts (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => { throw new Error("r2 down"); } });
    const cause = `${LOST} after 0 min`;
    expect(result).toEqual({ leg: "lint", state: "error", description: combineCauses([cause, cause, cause]) });
  });

  it("no deps given: the transport error alone, combined across all 3 attempts (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const cause = `${LOST} after 0 min`;
    expect((await runLegStep(step, dispatch, PLANNED)).description).toBe(combineCauses([cause, cause, cause]));
  });

  it("transport lost, R2 holds success: the leg passes on the first try, no retry (#1122)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => ({ state: "success" }) });
    expect(result).toMatchObject({
      leg: "lint", state: "success", description: "result read from R2 after transport loss: success",
    });
    expect(sent).toBe(1);
  });

  it("a container that exited mid-leg (503) with a known R2 SIGTERM failure: infra, no retry (#1321)", async () => {
    const step = fakeStep();
    const keys: string[] = [];
    const dispatch = async () => reply({ error: "gate container exited mid-leg" }, 503);
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async (key) => { keys.push(key); return EXITED; },
    });
    expect(result).toMatchObject({
      leg: "lint", state: "error", description: "result read from R2 after transport loss: lint exited 143",
    });
    expect(keys).toEqual([PLANNED.resultKey]);
  });

  it("R2 failure then a passing retry: flaky, the first cause is the R2 result (#1122)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      if (sent === 1) throw new Error(LOST);
      return reply({ state: "success" });
    };
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async () => ({ state: "failure", description: "lint 3 errors" }),
    });
    expect(result).toMatchObject({
      leg: "lint", state: "success",
      description: "flaky: passed on retry; first: result read from R2 after transport loss: lint 3 errors",
    });
  });

  it("R2 absent under a transport loss: the transport error is the cause, and the start step's own infra retries run (#1231: now 3 attempts)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; throw new Error(LOST); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => undefined });
    expect(result).toMatchObject({ leg: "lint", state: "error" });
    expect(sent).toBe(3);
  });

  it("a retry that loses its transport reads the retry's own key", async () => {
    const step = fakeStep();
    const keys: string[] = [];
    let sent = 0;
    const dispatch = async () => {
      sent++;
      if (sent === 1) return reply({ state: "failure", description: "timing" });
      throw new Error(LOST);
    };
    await runLegStep(step, dispatch, PLANNED, { readResult: async (key) => { keys.push(key); return undefined; } });
    // The retry step's OWN three per-attempt reads target its own keys first —
    // .retry, then .retry-try2, then .retry-try3. The base key is only swept
    // later, by the #1395 recovery step, never read as the retry's own attempt.
    expect(keys.slice(0, 3)).toEqual([
      "gate/o/r/runs/1/i/shard-lint.retry.json",
      "gate/o/r/runs/1/i/shard-lint.retry-try2.json",
      "gate/o/r/runs/1/i/shard-lint.retry-try3.json",
    ]);
    expect(keys.slice(0, 3)).not.toContain("gate/o/r/runs/1/i/shard-lint.json");
  });

  it("the R2 description is capped at the 2000-char description ceiling, and R2 stderr never reaches the description", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const big = { state: "failure" as const, description: `lint ${"x".repeat(5000)}`, stderr: "SECRET-STDERR-TAIL" };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => big });
    expect(result.description).toBe(`result read from R2 after transport loss: lint ${"x".repeat(5000)}`.slice(0, 2000));
    expect(result.description).not.toContain("SECRET-STDERR-TAIL");
  });

  it("R2 stderr is never quoted into the description, even when the description is short", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    const short = { state: "failure" as const, description: "lint 3 errors", stderr: "SECRET-STDERR-TAIL" };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => short });
    expect(result.description).toBe("result read from R2 after transport loss: lint 3 errors");
  });

  it("the start step's infra retries read their own result key, not try 1's or each other's (#1231: tries 2 and 3 each get their own key)", async () => {
    const step = fakeStep();
    const readKeys: string[] = [];
    const dispatch = async () => { throw new Error(LOST); };
    await runLegStep(step, dispatch, PLANNED, { readResult: async (key) => { readKeys.push(key); return undefined; } });
    // The three per-attempt reads are the start step's own keys, in order; the
    // #1395 recovery sweep (which follows) reads the whole-leg candidates.
    expect(readKeys.slice(0, 3)).toEqual([
      PLANNED.resultKey,
      "gate/o/r/runs/1/i/shard-lint-try2.json",
      "gate/o/r/runs/1/i/shard-lint-try3.json",
    ]);
  });

  it("try 3 reads back its own stored result, never try 2's late-arriving one, under a shared-key collision (#1231)", async () => {
    const step = fakeStep();
    const dispatch = async () => { throw new Error(LOST); };
    // Models the race the plan calls out: try 2's read finds nothing yet (its
    // container's late write hasn't landed), but by the time something reads
    // the try2 key again, it has — a stale value a collision would hand to
    // try 3. try 3's OWN key always holds its own, distinct result.
    let try2Reads = 0;
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async (key) => {
        if (key === "gate/o/r/runs/1/i/shard-lint-try2.json") {
          try2Reads++;
          return try2Reads === 1 ? undefined : { state: "error", description: "try 2's stale result" };
        }
        if (key === "gate/o/r/runs/1/i/shard-lint-try3.json") {
          return { state: "error", description: "try 3's own result" };
        }
        return undefined;
      },
    });
    expect(result.state).toBe("error");
    expect(result.description).toBe("result read from R2 after transport loss: try 3's own result");
  });
});

// #1321: the per-try result key comes from the step's durable attempt counter
// (ctx.attempt), never a closure counter an engine restart would reset. A
// restart therefore keeps tries 2 and 3 on their own distinct keys.
describe("runLegStep: per-try keys from ctx.attempt survive an engine restart (#1321)", () => {
  it("a step whose callback resumes at attempt 2 still writes try 2's key, never the base key", async () => {
    // A fake engine that models the restart: the first attempt ran (and its
    // result was lost with the old engine), then the step re-enters at attempt 2.
    const step = {
      do: async <T>(_name: string, config: LegStepConfig, fn: (ctx: { attempt: number; step: { name: string; count: number } }) => Promise<T>) => {
        let attempt = 2; // restart: durable attemptedCount is already 2
        for (; ; attempt++) {
          try {
            return await fn({ attempt, step: { name: _name, count: 1 } });
          } catch (err) {
            if (attempt >= 1 + config.retries.limit) throw err;
          }
        }
      },
    };
    const readKeys: string[] = [];
    const dispatch = async () => { throw new Error("Network connection lost."); };
    await runLegStep(step, dispatch, PLANNED, { readResult: async (key) => { readKeys.push(key); return undefined; } });
    // Attempts 2 and 3 (retries.limit=2) must read -try2/-try3, never the base
    // key, so a late try-1 write cannot be read back as try 2's own result.
    expect(readKeys.slice(0, 2)).toEqual([
      "gate/o/r/runs/1/i/shard-lint-try2.json",
      "gate/o/r/runs/1/i/shard-lint-try3.json",
    ]);
  });

  it("the retry-<leg> step waits a jittered delay before its first dispatch only (#1321)", async () => {
    const step = fakeStep();
    const sleeps: number[] = [];
    let sent = 0;
    const dispatch = async () => {
      sent++;
      return sent === 1 ? reply({ state: "failure", description: "timing" }) : reply({ state: "success" });
    };
    await runLegStep(step, dispatch, PLANNED, {
      retryJitterMs: 4_000, random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); },
    });
    // One jitter wait on the retry step's first attempt, none on the start step.
    expect(sleeps).toEqual([2_000]);
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint"]);
  });

  it("no jitter when the cap is 0 (default): the retry dispatches without a wait (#1321)", async () => {
    const step = fakeStep();
    const sleeps: number[] = [];
    let sent = 0;
    const dispatch = async () => {
      sent++;
      return sent === 1 ? reply({ state: "failure", description: "timing" }) : reply({ state: "success" });
    };
    await runLegStep(step, dispatch, PLANNED, { sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps).toEqual([]);
  });

  it("the retry step jitters on its first attempt even when that attempt throws (#1321 review)", async () => {
    // A step engine that always throws the retry step's callback: the jitter
    // must still fire on attempt 1 before the infra retries re-run the step.
    const step = {
      do: async <T>(name: string, config: LegStepConfig, fn: (ctx?: { attempt: number; step: { name: string; count: number } }) => Promise<T>): Promise<T> => {
        if (name === "start-lint") return await fn({ attempt: 1, step: { name, count: 1 } });
        // retry-lint: throw on every attempt, exercising the jitter + infra retries.
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
    const sleeps: number[] = [];
    const dispatch = async () => reply({ state: "failure", description: "timing" });
    await runLegStep(step, dispatch, PLANNED, {
      retryJitterMs: 4_000, random: () => 0.25, sleep: async (ms) => { sleeps.push(ms); },
    });
    // The start step returned a failure, so the retry step ran and its first
    // attempt waited 0.25*4000 = 1000 ms before dispatching.
    expect(sleeps).toEqual([1_000]);
  });

  it("a step context that omits ctx falls back to try 1, never a TypeError (#1321 review)", async () => {
    const step = {
      do: async <T>(name: string, config: LegStepConfig, fn: (ctx?: { attempt: number; step: { name: string; count: number } }) => Promise<T>): Promise<T> => {
        // The runtime passed no context: fn() with no argument.
        return await fn();
      },
    };
    const readKeys: string[] = [];
    const dispatch = async () => { throw new Error("Network connection lost."); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async (key) => { readKeys.push(key); return undefined; } });
    // ctx absent -> tryNo 1 -> the base key is read FIRST, and the transport error is the cause.
    expect(readKeys[0]).toBe(PLANNED.resultKey);
    expect(result.state).toBe("error");
  });
});

describe("legResultReader: reads a leg's R2 result from a bucket", () => {
  it("absent key: undefined", async () => {
    const read = legResultReader({ get: async () => null });
    expect(await read("gate/o/r/runs/1/i/shard-lint.json")).toBeUndefined();
  });

  it("present key: its JSON, when it carries a state", async () => {
    const body = { state: "failure" as const, description: "lint exited 143" };
    const read = legResultReader({ get: async () => ({ json: async () => body }) });
    expect(await read("k")).toEqual(body);
  });

  it("a body without a known state is treated as absent", async () => {
    const read = legResultReader({ get: async () => ({ json: async () => ({ nope: 1 }) }) });
    expect(await read("k")).toBeUndefined();
  });

  it("a body whose state is not one of the leg states is treated as absent", async () => {
    const read = legResultReader({ get: async () => ({ json: async () => ({ state: "bogus" }) }) });
    expect(await read("k")).toBeUndefined();
  });
});

// #1092: an "install failed" error is an infra-class flake (a tarball fetch
// that died), so it gets the same one retry as a red leg, on a fresh container.
// #1104: a "clone failed" error (a git smart-HTTP stream garbled through the
// outbound proxy) is an infra-class flake too: one retry on a fresh container.
describe("runLegStep: clone failure retries once (#1104)", () => {
  const CLONE = "clone failed: fatal: remote-curl: bad line length character";

  it("clone failed, then success on a fresh container: success, first cause noted", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return sent === 1 ? reply({ state: "error", description: CLONE }) : reply({ state: "success" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "success", description: `flaky: passed on retry; first: ${CLONE}` });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("clone failed twice: the second clone failure is final, and its description notes the first cause", async () => {
    const step = fakeStep();
    let sent = 0;
    const second = "clone failed: fatal: unable to access 'http:/'";
    const dispatch = async () => { sent++; return reply({ state: "error", description: sent === 1 ? CLONE : second }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({
      ms: expect.any(Number), leg: "lint", state: "error",
      description: `${second}; first: ${CLONE}`,
    });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("the clone retry runs under retry-<leg> with the .retry.json evidence key", async () => {
    const step = fakeStep();
    const keys: string[] = [];
    let sent = 0;
    const dispatch = async (p: PlannedLeg) => {
      keys.push(p.resultKey);
      sent++;
      return sent === 1 ? reply({ state: "error", description: CLONE }) : reply({ state: "success" });
    };
    await runLegStep(step, dispatch, PLANNED);
    expect(keys).toEqual([
      "gate/o/r/runs/1/i/shard-lint.json",
      "gate/o/r/runs/1/i/shard-lint.retry.json",
    ]);
  });

  it("a clone failure recovered from R2 is retried and a true pass is tagged flaky (#1178)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      if (sent === 1) throw new Error("Network connection lost.");
      return reply({ state: "success" });
    };
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async () => ({ state: "error", description: CLONE }),
    });
    // The R2 prefix must not hide the clone-failed match: the retry earns a flaky success.
    expect(result).toEqual({
      ms: expect.any(Number), leg: "lint", state: "success",
      description: `flaky: passed on retry; first: result read from R2 after transport loss: ${CLONE}`,
    });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("an R2-recovered error with an unrelated cause stays final: no retry (#1178)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; throw new Error("Network connection lost."); };
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async () => ({ state: "error", description: "disk quota exceeded" }),
    });
    expect(result).toEqual({
      ms: expect.any(Number), leg: "lint", state: "error",
      description: "result read from R2 after transport loss: disk quota exceeded",
    });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint"]);
    expect(sent).toBe(1);
  });
});

describe("runLegStep: install failure retries once (#1092)", () => {
  const INSTALL = 'install failed: error: Fail extracting tarball for "wrangler"';

  it("install failed, then success on a fresh container: success, first cause noted", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return sent === 1 ? reply({ state: "error", description: INSTALL }) : reply({ state: "success" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "success", description: `flaky: passed on retry; first: ${INSTALL}` });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("an install-failed result read from R2 is retried once (#1126)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; throw new Error("Network connection lost."); };
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async () => ({ state: "error", description: INSTALL }),
    });
    // The R2 prefix must not hide the install-failed match: one fresh-container retry.
    expect(sent).toBe(2);
    expect(result.description).toContain("result read from R2 after transport loss");
  });

  it("install failed twice: the retry's error is final, and its description notes the first cause", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ state: "error", description: sent === 1 ? INSTALL : "install failed: 404 for registry" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({
      ms: expect.any(Number), leg: "lint", state: "error",
      description: `install failed: 404 for registry; first: ${INSTALL}`,
    });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint"]);
    expect(sent).toBe(2);
  });

  it("the install retry runs under retry-<leg> with the .retry.json evidence key", async () => {
    const step = fakeStep();
    const keys: string[] = [];
    let sent = 0;
    const dispatch = async (p: PlannedLeg) => {
      keys.push(p.resultKey);
      sent++;
      return sent === 1 ? reply({ state: "error", description: INSTALL }) : reply({ state: "success" });
    };
    await runLegStep(step, dispatch, PLANNED);
    expect(keys).toEqual([
      "gate/o/r/runs/1/i/shard-lint.json",
      "gate/o/r/runs/1/i/shard-lint.retry.json",
    ]);
  });

  it("an install retry that dies as infra still ends as error with the first cause noted, all 3 retry-step attempts combined (#1231)", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      return sent === 1 ? reply({ state: "error", description: INSTALL }) : reply({ error: "gate container did not start within 180 s" }, 503);
    };
    const result = await runLegStep(step, dispatch, PLANNED);
    const cause = "lint: gate container did not start within 180 s after 0 min";
    expect(result.state).toBe("error");
    expect(result.description).toBe(`${combineCauses([cause, cause, cause])}; first: ${INSTALL}`);
    // The retry phase's infra retries are spent, so the #1395 recover-retry-<leg>
    // step runs (finding nothing here) before the error is returned.
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint", "recover-retry-lint"]);
  });

  it.each([
    ["fetch failed: fatal: couldn't find remote ref"],
    ["checkout failed: error: pathspec"],
    ["gate-server: boom"],
  ])("other error kinds stay final, no retry: %s", async (description) => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "error", description });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toMatchObject({ state: "error", description });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint"]);
  });
});

// #1387: a leg deadline is a real red verdict, never infra. The DO answers
// 200 with state "error", so the step returns it once and never infra-retries
// or flaky-retries it. Real infra (503) is still retried.
describe("runLegStep: a deadline is final, infra still retries (#1387)", () => {
  it("a 200 deadline result is red once, no infra retry, no flaky retry", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ state: "error", description: "lint exceeded 25 min without a result" }); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toEqual({ ms: expect.any(Number), leg: "lint", state: "error", description: "lint exceeded 25 min without a result" });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint"]);
    expect(sent).toBe(1);
  });

  it("the deadline result is never infra-class: no auto-rerun", async () => {
    const step = fakeStep();
    const dispatch = async () => reply({ state: "error", description: "lint exceeded 25 min without a result" });
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result).toMatchObject({ leg: "lint", state: "error" });
    expect(isInfraLegFailure({ leg: "lint", state: "error", description: result.description })).toBe(false);
  });

  it("real infra (503) is still retried twice, then errors", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => { sent++; return reply({ error: "gate container did not start within 180 s" }, 503); };
    const result = await runLegStep(step, dispatch, PLANNED);
    expect(result.state).toBe("error");
    expect(sent).toBe(3);
  });
});

// #1387: the WHOLE leg (all attempts) is capped at timeout + grace. A leg that
// keeps failing infra past the cap ends as infra (still earns its auto-rerun),
// never left to cycle fresh containers forever.
describe("runLegStep: total wall-time cap (#1387)", () => {
  it("stamps progress only on a step's first attempt: three infra attempts touch once", async () => {
    const step = fakeStep();
    let sent = 0;
    let touches = 0;
    const dispatch = async () => { sent++; return reply({ error: "gate container did not start within 180 s" }, 503); };
    const result = await runLegStep(step, dispatch, PLANNED, { touch: async () => { touches++; } });
    expect(result.state).toBe("error");
    expect(sent).toBe(3);
    // The mutant "touch on every attempt" stamps 3 times; the watchdog must see
    // the retry loop, not a run that keeps "progressing".
    expect(touches).toBe(1);
  });

  it("a flaky retry is a NEW step, so it stamps its own first attempt too", async () => {
    const step = fakeStep();
    let sent = 0;
    let touches = 0;
    const dispatch = async () => { sent++; return sent === 1 ? reply({ state: "failure", description: "timing" }) : reply({ state: "success" }); };
    const result = await runLegStep(step, dispatch, PLANNED, { touch: async () => { touches++; } });
    expect(result).toMatchObject({ leg: "lint", state: "success" });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "retry-lint"]);
    expect(touches).toBe(2);
  });

  it("a leg whose infra retries cycle past the cap ends infra, not red: its earned causes ride, so the auto-rerun still fires", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const step = fakeStep();
      const dispatch = async () => {
        now += 500; // each attempt costs wall time
        return reply({ error: "gate container did not start within 180 s" }, 503);
      };
      // Total cap 1 ms: the first attempt already starts past it.
      const result = await runLegStep(step, dispatch, PLANNED, { totalDeadlineMs: 1 });
      expect(result).toMatchObject({ leg: "lint", state: "error" });
      expect(result.description).toBe(combineCauses(["lint: gate container did not start within 180 s after 0 min"]));
      expect(isInfraLegFailure({ leg: "lint", state: "error", description: result.description })).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("an in-budget infra retry that then succeeds is the leg's success", async () => {
    const step = fakeStep();
    let sent = 0;
    const dispatch = async () => {
      sent++;
      return sent <= 2 ? reply({ error: "gate container did not start within 180 s" }, 503) : reply({ state: "success" });
    };
    const result = await runLegStep(step, dispatch, PLANNED, { totalDeadlineMs: 1_000_000 });
    expect(result).toMatchObject({ leg: "lint", state: "success" });
    expect(sent).toBe(3);
  });
});

// #1398 Task 2: one unique key per try, including the retry step's OWN
// internal infra-retries. The retry-<leg> step runs after a red (or
// install/clone-failed) first attempt, and its own infra-retry loop (three
// tries) must never reuse one .retry.json key -- the collision shape #1393
// measures, one step further into the code than the start step's
// already-fixed infraRetryResultKey usage.
describe("runLegStep: the retry step's own infra-retries get unique keys (#1398)", () => {
  it("the retry step's OWN internal infra-retries get unique keys too, never sharing .retry.json", async () => {
    const step = fakeGenericStep();
    const seenKeys: string[] = [];
    let startAttempts = 0;
    const spyDispatch = async (planned: PlannedLeg) => {
      seenKeys.push(planned.resultKey);
      startAttempts++;
      if (startAttempts === 1) {
        // start-<leg>'s own first (and only) try: a RED test, not infra --
        // this is what makes isRetryable true and advances to the retry-<leg>
        // phase at all. Everything AFTER this is the retry phase's own
        // internal infra-retry loop, which is what this test exercises.
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
});

// #1395: a Workflows invocation cut at ~20 min dies as WorkflowInternalError,
// and every in-flight step replays from zero. But the container may already
// have written its result to R2. Before failing a start/retry step whose infra
// retries are spent, run a recover-start-<leg> / recover-retry-<leg> step that
// reads the leg's stored results newest-first and returns a terminal result if
// one exists. Each phase reads only its OWN keys (start: base + -tryN; retry:
// .retry*), so a stale value from an earlier instance never reads back as this
// run's result, and the split step names can never collide across legs.
const CUT = "Attempt failed due to internal workflows error";
const BASE_KEY = "gate/o/r/runs/1/i/shard-lint.json";
const TRY2_KEY = "gate/o/r/runs/1/i/shard-lint-try2.json";
const TRY3_KEY = "gate/o/r/runs/1/i/shard-lint-try3.json";
const RETRY_KEY = "gate/o/r/runs/1/i/shard-lint.retry.json";
const RETRY_TRY2_KEY = "gate/o/r/runs/1/i/shard-lint.retry-try2.json";
const RETRY_TRY3_KEY = "gate/o/r/runs/1/i/shard-lint.retry-try3.json";

// A fake step engine that models the invocation cut: the step's callback rejects
// with a WorkflowInternalError on every attempt, so its 3 tries are spent and
// the step throws -- exactly the shape the outer .catch must recover.
function cutStep() {
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

// A readResult that misses `target` for its first `misses` reads, then returns
// `value` -- models a container whose R2 write lands late, after the step's own
// per-attempt read already gave up on that key. Every other key is absent.
function lateRead(target: string, value: { state: "success" | "failure" | "error"; description?: string }, misses = 1) {
  const readKeys: string[] = [];
  let reads = 0;
  return {
    readKeys,
    readResult: async (key: string) => {
      readKeys.push(key);
      if (key === target) {
        reads++;
        return reads > misses ? value : undefined;
      }
      return undefined;
    },
  };
}

describe("runLegStep: a Workflows invocation cut recovers the leg's stored result (#1395)", () => {
  it("stored success recovers to success, not error, when the start step dies as WorkflowInternalError 3x", async () => {
    const step = cutStep();
    // The start phase's own candidate is -try3: a container that finished its
    // THIRD infra attempt before the cut wrote there. The recover-start sweep
    // reads -try3, -try2, base and finds it.
    const { readKeys, readResult } = lateRead(TRY3_KEY, { state: "success" }, 1);
    const dispatch = async () => { throw new Error(CUT); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult });
    expect(result).toMatchObject({
      leg: "lint", state: "success",
      description: "result read from R2 after transport loss: success",
    });
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "recover-start-lint"]);
    // The start phase reads ONLY base + -tryN keys, never a .retry* key.
    expect(readKeys.filter((k) => k.includes(".retry"))).toEqual([]);
  });

  it("stored failure recovered in the start phase stays retryable: a flaky pass on retry", async () => {
    const step = cutStep();
    // The start phase's own candidate -try3 holds the red result a container
    // wrote before the cut. The recover-start sweep returns it as a red first
    // try (data, not infra), so the leg still earns its one flaky retry.
    const { readResult } = lateRead(TRY3_KEY, { state: "failure", description: "lint 3 errors" }, 1);
    let sent = 0;
    const dispatch = async () => {
      sent++;
      // The start step's three infra attempts all die as WorkflowInternalError;
      // the retry step's fresh container passes.
      if (sent <= 3) throw new Error(CUT);
      return reply({ state: "success" });
    };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult });
    expect(result).toMatchObject({
      leg: "lint", state: "success",
      description: "flaky: passed on retry; first: result read from R2 after transport loss: lint 3 errors",
    });
    // The recovered red first try is still data: the flaky retry step ran.
    expect(step.calls.map((c) => c.name)).toEqual([
      "leg-started-lint", "start-lint", "recover-start-lint", "retry-lint",
    ]);
  });

  it("a stale .retry result from an earlier instance is never read by the start phase (review r1 item 2)", async () => {
    const step = cutStep();
    // An earlier instance with the same run id left a green .retry.json. The
    // start phase must NOT read it: this run has not seen a red first attempt.
    const { readKeys, readResult } = lateRead(RETRY_KEY, { state: "success" }, 0);
    const dispatch = async () => { throw new Error(CUT); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult });
    expect(result.state).toBe("error");
    expect(result.description).toContain("internal workflows err");
    // The start phase never touched a .retry* key, so the stale green never
    // turned this cut leg green.
    expect(readKeys.filter((k) => k.includes(".retry"))).toEqual([]);
  });

  it("the retry phase recovers a .retry result its own attempts missed (late write)", async () => {
    const step = cutStep();
    // A live red first attempt makes the leg retryable; the retry phase then dies
    // as WorkflowInternalError. Its attempt 1 reads .retry and misses (the late
    // write had not landed), then recover-retry re-reads .retry and finds it.
    let sent = 0;
    const dispatch = async () => {
      sent++;
      if (sent === 1) return reply({ state: "failure", description: "timing" });
      throw new Error(CUT);
    };
    const { readResult } = lateRead(RETRY_KEY, { state: "success" }, 1);
    const result = await runLegStep(step, dispatch, PLANNED, { readResult });
    // The recovered success passes the retry: a flaky pass, first cause noted.
    expect(result).toMatchObject({
      leg: "lint", state: "success",
      description: "flaky: passed on retry; first: timing",
    });
    expect(step.calls.map((c) => c.name)).toEqual([
      "leg-started-lint", "start-lint", "retry-lint", "recover-retry-lint",
    ]);
  });

  it("no stored result: the error is unchanged, and the recover-start step is the only extra step", async () => {
    const step = cutStep();
    const dispatch = async () => { throw new Error(CUT); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult: async () => undefined });
    expect(result.state).toBe("error");
    // The thrown message is the three attempts' causes combined (#1231), each
    // cut with an ellipsis when the budget is tight; the marker stays present.
    expect(result.description).toContain("internal workflows err");
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "recover-start-lint"]);
  });

  it("a stored SIGTERM result recovers to infra (error), never a red test (#1321)", async () => {
    const step = cutStep();
    const { readResult } = lateRead(TRY2_KEY, { state: "failure", description: "lint exited 143" }, 1);
    const dispatch = async () => { throw new Error(CUT); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult });
    expect(result).toMatchObject({
      leg: "lint", state: "error",
      description: "result read from R2 after transport loss: lint exited 143",
    });
    // No flaky retry: the platform kill is infra, so no retry step.
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "recover-start-lint"]);
  });

  it("a newer kill result is skipped for an older real result (review r1 item 3)", async () => {
    const step = cutStep();
    // Per-attempt reads all miss. The recovery sweep then reads -try3 (a SIGTERM
    // kill) then -try2 (a real, non-retryable error): it must skip the kill and
    // return the real error, never a needless infra rerun on the kill.
    const seen: Record<string, number> = {};
    const readResult = async (key: string) => {
      seen[key] = (seen[key] ?? 0) + 1;
      // Second read of -try3 (the recovery sweep's pass) is the kill; second read
      // of -try2 is the real error. Every per-attempt read (first pass) misses.
      if (key === TRY3_KEY && seen[key] === 2) return { state: "failure" as const, description: "lint exited 143" };
      if (key === TRY2_KEY && seen[key] === 2) return { state: "error" as const, description: "disk quota exceeded" };
      return undefined;
    };
    const dispatch = async () => { throw new Error(CUT); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult });
    // The real error is the recovered result -- the kill was skipped, never read
    // back as infra and never returned in place of the real answer.
    expect(result).toMatchObject({
      leg: "lint", state: "error",
      description: "result read from R2 after transport loss: disk quota exceeded",
    });
    expect(result.description).not.toContain("exited 143");
    // A non-retryable error: no retry phase, so only the start recovery ran.
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-lint", "start-lint", "recover-start-lint"]);
  });

  it("leg retry-foo's start recovery is recover-start-retry-foo, never leg foo's recover-retry-foo (review r1 item 1)", async () => {
    // The split step names mean leg "retry-foo"'s START-phase recovery step is
    // recover-start-retry-foo -- distinct from leg "foo"'s RETRY-phase
    // recover-retry-foo, so a leg named retry-foo can never reuse another leg's
    // cached recovery step result (leg names allow [a-z0-9-]).
    const planned = { ...PLANNED, leg: "retry-foo", resultKey: "gate/o/r/runs/1/i/shard-retry-foo.json" };
    const step = cutStep();
    const dispatch = async () => { throw new Error(CUT); };
    const result = await runLegStep(step, dispatch, planned, { readResult: async () => undefined });
    expect(result.state).toBe("error");
    expect(step.calls.map((c) => c.name)).toEqual(["leg-started-retry-foo", "start-retry-foo", "recover-start-retry-foo"]);
  });

  it("a stored result whose read throws still leaves the error unchanged", async () => {
    const step = cutStep();
    const dispatch = async () => { throw new Error(CUT); };
    const result = await runLegStep(step, dispatch, PLANNED, {
      readResult: async () => { throw new Error("r2 down"); },
    });
    expect(result.state).toBe("error");
    expect(result.description).toContain("internal workflows err");
  });

  it("the returned leg result is structuredClone-safe: plain data, no functions or class instances", async () => {
    const step = cutStep();
    const { readResult } = lateRead(TRY2_KEY, { state: "success" }, 1);
    const dispatch = async () => { throw new Error(CUT); };
    const result = await runLegStep(step, dispatch, PLANNED, { readResult });
    expect(result.state).toBe("success");
    // A step result Workflows will replay must survive structuredClone: no
    // functions, no class instances, no symbols -- only JSON-shaped data.
    expect(() => structuredClone(result)).not.toThrow();
    expect(structuredClone(result)).toEqual(result);
  });
});

describe("recoverCandidateKeys: each phase reads only its own keys, newest first (#1395)", () => {
  it("start phase: -tryN newest first, then the base key -- never .retry*", () => {
    expect(recoverCandidateKeys(BASE_KEY, "start")).toEqual([
      TRY3_KEY,
      TRY2_KEY,
      BASE_KEY,
    ]);
  });

  it("retry phase: .retry-tryN newest first, then .retry -- never base/-tryN", () => {
    expect(recoverCandidateKeys(BASE_KEY, "retry")).toEqual([
      RETRY_TRY3_KEY,
      RETRY_TRY2_KEY,
      RETRY_KEY,
    ]);
  });
});

describe("claimOrReadBack (#1398)", () => {
  it("the write wins when nothing is there yet", async () => {
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

  it("a conflict defers to whatever is already there, never the caller's own value", async () => {
    const store = new Map<string, string>([["k", JSON.stringify({ state: "success" })]]);
    const bucket = {
      put: async () => null, // already written -- simulates a container's own report winning the race
      get: async (key: string) => ({ json: async () => JSON.parse(store.get(key)!) }),
    };
    const result = await claimOrReadBack(bucket, "k", { state: "error", description: "guessed infra" });
    expect(result).toEqual({ state: "success" }); // NEVER the guessed infra value
  });
});

// #1398: runLegStepPolling's own fake step needs BOTH do() and sleep() --
// sleep is a no-op in tests (no real waiting), do() runs its callback once
// per call (no Workflows-style automatic retry -- this new design's OWN
// try-loop drives retries explicitly, never an implicit step-retry).
function fakePollingStep() {
  const calls: string[] = [];
  // #1398 r2 item A: a removed try cap (or a deadline moved out of the poll
  // step) turns runLegStepPolling's own loop into an unbounded one. Cap the
  // fake's total call count so such a mutation FAILS a test (this guard
  // throws) instead of hanging it forever.
  const guard = () => {
    if (calls.length > 1000) throw new Error(`fakePollingStep loop guard tripped at ${calls.length} calls`);
  };
  return {
    calls,
    do: async <T>(name: string, _config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T> => {
      guard();
      calls.push(name);
      return fn({ attempt: 1, step: { name, count: 1 } });
    },
    sleep: async (name: string) => { guard(); calls.push(`sleep:${name}`); },
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

  it("attemptId is minted in its OWN step before the dispatch step: a replayed step (same name) never calls dispatch a second time (governing invariant, BLOCKER 1)", async () => {
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
      do: async <T>(name: string, _config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T> => {
        if (cache.has(name)) return cache.get(name) as T;
        const result = await fn(undefined);
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

  it("attemptId stays the SAME across a Workflows-level AUTOMATIC step-retry of the dispatch step, not just a deploy replay (plan review r2 item 3)", async () => {
    // fakeGenericStep (Task 1) genuinely RE-INVOKES a throwing step.do
    // callback up to LEG_STEP_CONFIG's own retry limit -- this is Workflows'
    // OWN automatic step-retry, a DIFFERENT mechanism from the cache-based
    // replayingStep above (which models a deploy replay of an
    // ALREADY-SUCCEEDED step). The attemptId-minting step only ever runs
    // ONCE (it never throws), so the dispatch step's own retries all read
    // the SAME already-resolved value as a plain variable.
    const step = fakeGenericStep();
    const bucket = fakeBucket();
    const seenAttemptIds: string[] = [];
    let dispatchAttempts = 0;
    const dispatch = async (planned: PlannedLeg, attemptId: string): Promise<DispatchOutcome> => {
      dispatchAttempts++;
      seenAttemptIds.push(attemptId);
      if (dispatchAttempts === 1) throw new Error("transient network error"); // forces LEG_STEP_CONFIG's own retry
      bucket.store.set(planned.resultKey, JSON.stringify({ state: "success" }));
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0 });
    expect(result.state).toBe("success");
    expect(dispatchAttempts).toBe(2); // one throw, one success -- Workflows' OWN step-retry, never this loop's try-loop
    expect(new Set(seenAttemptIds).size).toBe(1); // the SAME attemptId on both the failing and the succeeding call
  });

  it("touch() fires on every dispatch AND every poll tick, not just the first try's dispatch (plan review r2 item 2)", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    let touchCalls = 0;
    const touch = async () => { touchCalls++; };
    let tries = 0;
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      tries++;
      bucket.store.set(planned.resultKey, JSON.stringify(
        tries < 3 ? { state: "error", description: "gate container exited mid-leg" } : { state: "success" },
      ));
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, touch, totalDeadlineMs: 1_000_000 });
    expect(result.state).toBe("success");
    // 3 tries, each: one touch on dispatch + one touch on the poll tick that
    // finds its result (infra on tries 1-2, success on try 3) = 2 touches
    // per try x 3 tries = 6, never just 1 (the old tryNo===1-gated behavior).
    expect(touchCalls).toBe(6);
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

  it("a poll read that throws (R2 down) is an infra result, never a rejection out of runLegStepPolling (review r1 item 1)", async () => {
    const step = fakePollingStep();
    const bucket = {
      put: async () => { throw new Error("r2 write down"); },
      get: async () => { throw new Error("r2 down"); },
    };
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> =>
      ({ kind: "accepted", resultKey: planned.resultKey, startedAt: 0 });
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, stepDeadlineMs: 1_000, totalDeadlineMs: 10_000 });
    expect(result.state).toBe("error");
    expect(result.description).toContain("gate result read failed");
  });

  it("a give-up write that throws (R2 down) is an infra result, never a rejection out of runLegStepPolling (review r1 item 1)", async () => {
    const step = fakePollingStep();
    const bucket = {
      put: async () => { throw new Error("r2 write down"); },
      get: async () => null, // nothing in R2 yet, so the budget step trips and give-up writes
    };
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> =>
      ({ kind: "accepted", resultKey: planned.resultKey, startedAt: 0 });
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, stepDeadlineMs: 0, totalDeadlineMs: 10_000 });
    expect(result.state).toBe("error");
    expect(result.description).toContain("gate result write failed");
  });

  it("a fast-infra leg is capped at 3 tries per phase, never re-dispatches forever (review r1 item 2)", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    let tries = 0;
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      tries++;
      bucket.store.set(planned.resultKey, JSON.stringify({ state: "error", description: "gate capacity: no container instance available" }));
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, totalDeadlineMs: 1_000_000 });
    expect(result.state).toBe("error");
    // 'gate capacity' is NOT retryable (not a red test / install / clone), so
    // only the start phase runs -- and it is capped at 3 tries.
    expect(tries).toBe(3);
  });

  it("'clone failed ... HTTP 500' is NOT infra-looped (isRetryable's one retry owns it); 'Network connection lost' IS (review r1 item 5)", () => {
    expect(isLegInfraDescription("clone failed: RPC failed; HTTP 500 curl 22")).toBe(false);
    expect(isLegInfraDescription("Network connection lost")).toBe(true);
    expect(isLegInfraDescription("Execution timed out")).toBe(true);
    expect(isLegInfraDescription("lint: HTTP 503")).toBe(true);
  });

  it("the retry phase's first dispatch honors retryJitterMs inside its dispatch callback (review r1 item 4)", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    const sleeps: number[] = [];
    // First attempt fails as a red test so the retry phase actually runs.
    let first = true;
    const dispatchRedFirst = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      if (first) {
        first = false;
        bucket.store.set(planned.resultKey, JSON.stringify({ state: "failure", description: "1 failed" }));
        return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
      }
      bucket.store.set(planned.resultKey, JSON.stringify({ state: "success" }));
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    const result = await runLegStepPolling(step, dispatchRedFirst, PLANNED, {
      bucket, now: () => 0, retryJitterMs: 4_000, random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); }, totalDeadlineMs: 1_000_000,
    });
    expect(result.state).toBe("success");
    // deps.sleep is ONLY called for the retry-phase jitter (the poll loop uses
    // step.sleep, never deps.sleep) -- so a non-empty sleeps proves the
    // retryJitterMs was honored, not silently ignored.
    expect(sleeps).toContain(2_000); // floor(0.5 * 4000) = 2000, the jitter honored on the retry dispatch
  });

  it("(A) replay mid-dispatch: the attemptId step is recorded, the dispatch step is not -- the replayed run dispatches the SAME id, exactly once (a bare crypto.randomUUID() outside its step fails)", async () => {
    const bucket = fakeBucket();
    let dispatchCalls = 0;
    const seenAttemptIds: string[] = [];
    const dispatch = async (planned: PlannedLeg, attemptId: string): Promise<DispatchOutcome> => {
      dispatchCalls++;
      seenAttemptIds.push(attemptId);
      // Park a terminal result so the poll finds it on the first tick and the
      // run never re-enters the try loop.
      bucket.store.set(planned.resultKey, JSON.stringify({ state: "success" }));
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    // Cache the attemptId step as already-done from a prior run (the engine
    // died after minting the id, before dispatch completed), but NOT the
    // dispatch step. The replayed run re-executes runLegStepPolling's whole
    // body, reads the CACHED id, and must pass it to the still-uncached
    // dispatch step.
    const cache = new Map<string, unknown>();
    const replayingStep = {
      do: async <T>(name: string, _config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T> => {
        if (cache.has(name)) return cache.get(name) as T;
        const result = await fn(undefined);
        cache.set(name, result);
        return result;
      },
      sleep: async () => {},
    };
    const seededAttemptId = "11111111-1111-4111-8111-111111111111";
    await replayingStep.do("dispatch-start-lint-try1-attempt-id", LEG_STEP_CONFIG, async () => seededAttemptId);
    await runLegStepPolling(replayingStep, dispatch, PLANNED, { bucket, now: () => 0 });
    expect(dispatchCalls).toBe(1);
    // A mutant that mints attemptId with a bare crypto.randomUUID() OUTSIDE its
    // own step re-mints a FRESH id on this replay -- dispatched id !== the
    // recorded one, so this equality fails.
    expect(seenAttemptIds).toEqual([seededAttemptId]);
  });

  it("(A) the past-deadline check rides INSIDE the poll step: moving it out to a per-tick budget step adds a step and fails this step-count assertion", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    let now = 0;
    // readResult advances the clock past the per-try attempt deadline on the
    // FIRST poll tick, so exactly one poll runs per try before the give-up.
    const readResult = async () => { now += 100_000; return undefined; };
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      // Never write a result: the leg polls, trips its attempt deadline, gives
      // up, and the give-up's infra description loops it to the next try.
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    await runLegStepPolling(step, dispatch, PLANNED, {
      bucket, now: () => now, readResult, stepDeadlineMs: 100, totalDeadlineMs: 1_000_000,
    });
    // The deadline decision is INSIDE the poll step: per tick there is exactly
    // one `-poll-` step and NO separate `-budget-` step. A mutant that moves
    // pastDeadline into its own per-tick budget step would emit a `-budget-`
    // step name here and fail.
    expect(step.calls.filter((c) => c.includes("-poll-"))).toHaveLength(3); // one per try, 3 tries
    expect(step.calls.filter((c) => /-budget-\d+/.test(c))).toHaveLength(0);
  });

  it("(A) Math.min(perTry, total-remaining) caps a late try: a long per-try deadline cannot outrun the total budget (removing Math.min fails the poll-count)", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    let now = 0;
    let dispatches = 0;
    // Each poll tick advances 5000 ms: past the TIGHT total budget (100) but
    // far short of the huge per-try deadline (10_000).
    const readResult = async () => { now += 5_000; return undefined; };
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      dispatches++;
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    const result = await runLegStepPolling(step, dispatch, PLANNED, {
      bucket, now: () => now, readResult, stepDeadlineMs: 10_000, totalDeadlineMs: 100,
    });
    expect(result.state).toBe("error");
    // Real code: try 1's per-try deadline is Math.min(10_000, 100 - 0) = 100,
    // so the FIRST poll tick (now 5000) already sees pastDeadline and gives up;
    // try 2's total-budget step (elapsed 5000 >= 100) then ends the run. One
    // dispatch, one poll. A mutant using the bare per-try deadline (10_000)
    // would let try 1 poll a SECOND tick (now 10_000) before its deadline
    // trips -- this count catches that.
    expect(dispatches).toBe(1);
    expect(step.calls.filter((c) => c.includes("-poll-"))).toHaveLength(1);
  });

  it("(A) a throwing dispatch returns an error result, never a rejection out of runLegStepPolling", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    const dispatch = async (): Promise<DispatchOutcome> => {
      throw new Error("Network connection lost");
    };
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, totalDeadlineMs: 1_000_000 });
    // The try/catch in dispatchAndPollOnce converts the throw into an infra
    // error result (which then loops, is infra, and ends as combined causes).
    // A removed try/catch would let the throw escape and this test would
    // reject instead of resolving.
    expect(result.state).toBe("error");
    expect(result.description).toContain("Network connection lost");
  });

  it("(A) a give-up that loses the R2 race returns the container's real result, never its own guess", async () => {
    const step = fakePollingStep();
    const containerResult = { state: "success", summary: "42 passed" };
    let puts = 0;
    let containerWrote = false;
    const bucket = {
      // The give-up's write-once PUT loses the race (returns null): the
      // container's own result already landed at the key. Model that landing by
      // making the container's result visible only AFTER this put is attempted
      // (the poll tick's own read, earlier in the same tick, still saw nothing).
      put: async () => { puts++; containerWrote = true; return null; },
      get: async () => (containerWrote ? { json: async () => containerResult } : null),
    };
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> =>
      ({ kind: "accepted", resultKey: planned.resultKey, startedAt: 0 });
    // stepDeadlineMs 0 -> the first poll tick trips the deadline -> the give-up
    // write LOSES, then claimOrReadBack reads back the container's own result.
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, stepDeadlineMs: 0, totalDeadlineMs: 1_000_000 });
    expect(puts).toBe(1); // the give-up genuinely attempted its write-once PUT
    expect(result.state).toBe("success"); // the container's own result, not the guess
    expect(result.summary).toBe("42 passed");
  });

  it("(B) a raw R2 body's extra fields never ride into the poll step result: only state, capped description, and summary survive", async () => {
    const step = fakePollingStep();
    const stdout = "x".repeat(32_097);
    const bucket = fakeBucket({
      [PLANNED.resultKey]: {
        state: "success", // success: no retry phase, so the poll's own result is the final one
        description: "x".repeat(3000),
        summary: "42 passed",
        stdout,
        stderr: "y".repeat(32_097),
        commit: "abc",
        limits: { cpu: 1 },
      },
    });
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> =>
      ({ kind: "accepted", resultKey: planned.resultKey, startedAt: 0 });
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, stepDeadlineMs: 0, totalDeadlineMs: 1_000 });
    expect(result.state).toBe("success");
    expect(result.description?.length).toBeLessThanOrEqual(2000);
    expect(result.summary).toBe("42 passed");
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
    expect(result).not.toHaveProperty("commit");
    expect(result).not.toHaveProperty("limits");
  });

  it("(B) a non-string description in the R2 body does not throw the poll callback", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket({
      [PLANNED.resultKey]: { state: "success", description: 42 },
    });
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> =>
      ({ kind: "accepted", resultKey: planned.resultKey, startedAt: 0 });
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, stepDeadlineMs: 0, totalDeadlineMs: 1_000 });
    // A mutant that calls .slice() on the raw description would throw here and
    // the poll callback would return read-failed instead of the real result.
    expect(result.state).toBe("success");
    expect(result.description).toBeUndefined();
  });

  it("(C) the total-budget step name carries its phase, so start and retry never collide", async () => {
    const step = fakePollingStep();
    const bucket = fakeBucket();
    // First try: a red test (so the retry phase runs); retry: success.
    let first = true;
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> => {
      if (first) {
        first = false;
        bucket.store.set(planned.resultKey, JSON.stringify({ state: "failure", description: "1 failed" }));
      } else {
        bucket.store.set(planned.resultKey, JSON.stringify({ state: "success" }));
      }
      return { kind: "accepted", resultKey: planned.resultKey, startedAt: 0 };
    };
    await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, totalDeadlineMs: 1_000_000 });
    const budgets = step.calls.filter((c) => c.includes("total-budget-"));
    expect(budgets).toContain("total-budget-start-lint-try1");
    expect(budgets).toContain("total-budget-retry-lint-try1");
  });

  // #1423: review r2 flagged two untested paths. A hung poll read must be
  // bounded by withStepDeadline (a stuck get would otherwise hold the step
  // open forever); a removed withStepDeadline on that read hangs this test.
  it("a hung poll read is bounded by withStepDeadline, never a hanging read (review r2: withStepDeadline removable)", async () => {
    // Fire the 30s read deadline immediately: withStepDeadline's setTimeout is
    // the ONLY timer in this path, so advancing it synchronously lets the hung
    // get lose the race deterministically, never a real 30s wait. A mutant that
    // removes withStepDeadline from the poll read awaits the hung get forever
    // and hangs the test instead of resolving.
    const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const step = fakePollingStep();
    // A get that NEVER resolves: under withStepDeadline the deadline fires and
    // the poll returns read-failed; without it, this Promise races nothing.
    const bucket = {
      put: async () => null,
      get: async () => new Promise<never>(() => {}),
    };
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> =>
      ({ kind: "accepted", resultKey: planned.resultKey, startedAt: 0 });
    const result = await runLegStepPolling(step, dispatch, PLANNED, {
      bucket, now: () => 0, stepDeadlineMs: 1_000, totalDeadlineMs: 10_000,
    });
    setSpy.mockRestore();
    clearSpy.mockRestore();
    expect(result.state).toBe("error");
    // The read-failed tick is infra, so the loop retries it to the cap; the
    // combined causes carry withStepDeadline's timeout message (truncated per
    // cause), never the give-up's own "no progress" guess.
    expect(result.description).toContain("gate result read failed: result read timed");
    expect(result.description).not.toContain("no progress past its deadline");
  });

  // #1423: the poll path's MAX_DESCRIPTION_CHARS cap (2000) is exercised here,
  // the async counterpart of runLegStep's own cap (line 233). The raw R2 body's
  // description is re-read by the poll step and rebuilt capped, so 32K of
  // stdout never rides into the step result.
  it("the poll read caps a container-authored description at MAX_DESCRIPTION_CHARS (2000), the async counterpart of the sync cap", async () => {
    const step = fakePollingStep();
    // A success, so the first poll's found result is the FINAL result — the cap
    // is read straight off the returned description, no retry phase in between.
    const bucket = fakeBucket({
      [PLANNED.resultKey]: { state: "success", description: "x".repeat(5000), summary: "42 passed" },
    });
    const dispatch = async (planned: PlannedLeg): Promise<DispatchOutcome> =>
      ({ kind: "accepted", resultKey: planned.resultKey, startedAt: 0 });
    const result = await runLegStepPolling(step, dispatch, PLANNED, { bucket, now: () => 0, stepDeadlineMs: 0, totalDeadlineMs: 1_000 });
    expect(result.state).toBe("success");
    expect(result.description?.length).toBe(2000);
    expect(result.description).toBe("x".repeat(2000));
    expect(result.summary).toBe("42 passed");
  });

  it("(D) 'DO alarm failed N times in a row, giving up' IS infra (emitted by run-leg-alarm.ts alarmTick); 'gate result (read|write) failed' IS, and no live description collides with the latter", () => {
    // #1425: run-leg-alarm.ts:285 now EMITS this as the alarm's own give-up --
    // dropping the pattern would make an alarm give-up read as a real red.
    expect(isLegInfraDescription("DO alarm failed 5 times in a row, giving up")).toBe(true);
    expect(isLegInfraDescription("gate result read failed: boom")).toBe(true);
    expect(isLegInfraDescription("gate result write failed: boom")).toBe(true);
    // The kept pattern 'gate result (read|write) failed' must not collide with
    // any live-path infra description: none of them contains that phrase, so
    // keeping the pattern changes no live classification.
    const live = [
      "gate capacity: no container instance available",
      "gate image not bound (images.gate)",
      "gate container binding missing",
      "gate container did not start within 180 s",
      "gate container failed: boom",
      "gate server unreachable after 90 s: boom",
      "gate server HTTP 503",
      "gate container exited mid-leg",
      "lint exceeded 25 min without a result",
    ];
    const kept = /\bgate result (read|write) failed\b/;
    for (const d of live) expect(kept.test(d)).toBe(false);
  });
});
