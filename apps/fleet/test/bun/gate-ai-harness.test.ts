// apps/fleet/test/bun/gate-ai-harness.test.ts
// AI-leg harness guards (board #1345): N/N repeats, red-chip detectors,
// negative-control self-test, throw/timeout=red, missing-secret DID-NOT-RUN,
// floor-mode stand-in. Each guard's unit here is the RED/GREEN source for its
// mutation report. Pure injected runner + env — no real model, no secret.
import { describe, expect, test } from "bun:test";
import {
  defaultRedChipDetectors,
  detectChips,
  evaluateAsserts,
  floorStandIn,
  ModelUnavailable,
  normalizeRepeat,
  runAICase,
  type AICase,
  type ModelRunner,
  type RunContext,
  type RunModel,
} from "../../container/gate/browser/ai/harness";

/** A stub runner that returns a fixed model response; a per-call queue lets a
 *  test vary one run from the next. */
function stubRunner(...responses: RunModel[]): ModelRunner & { calls: Array<{ input: unknown; ctx: RunContext }> } {
  const calls: Array<{ input: unknown; ctx: RunContext }> = [];
  let i = 0;
  return {
    calls,
    run: async (input, ctx) => {
      calls.push({ input, ctx });
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
}

function throwingRunner(err: Error): ModelRunner {
  return { run: async () => { throw err; } };
}

const realEnv = { realModelId: "real-model", realModelSecret: "present" };

function goodCase(over: Partial<AICase> = {}): AICase {
  return {
    name: "weather",
    inputs: [{ city: "Paris" }, { city: "Lisbon" }, { city: "Berlin" }],
    asserts: [{ path: "toolCalls", check: (m) => (m.toolCalls ?? []).length > 0, reason: "one tool call" }],
    ...over,
  };
}

const modelWithCall: RunModel = { text: "Getting weather now.", toolCalls: [{ name: "get_weather", input: { city: "Paris" } }] };

describe("normalizeRepeat", () => {
  test("integer >= 1 passes", () => {
    expect(normalizeRepeat(3)).toBe(3);
    expect(normalizeRepeat(1)).toBe(1);
  });
  test("NaN, fractional, zero, negative, non-number all null", () => {
    expect(normalizeRepeat(NaN)).toBeNull();
    expect(normalizeRepeat(2.5)).toBeNull();
    expect(normalizeRepeat(0)).toBeNull();
    expect(normalizeRepeat(-1)).toBeNull();
    expect(normalizeRepeat("three")).toBeNull();
  });
});

describe("floorStandIn", () => {
  test("unblocked route uses the real model", () => {
    expect(floorStandIn({ realModelSecret: "x", standInModel: "s" })).toEqual({ floor: false, modelId: null, reason: null });
  });
  test("blocked route with a stand-in switches to it", () => {
    expect(floorStandIn({ standInModel: "s", realRouteBlocked: true })).toEqual({ floor: true, modelId: "s", reason: null });
  });
  test("blocked route with no stand-in is unavailable", () => {
    expect(floorStandIn({ realRouteBlocked: true }).reason).toBe("real route blocked and no stand-in model configured");
  });
});

describe("detectChips", () => {
  const detectors = defaultRedChipDetectors();
  test("hits the example chips", () => {
    expect(detectChips("I couldn't do that.", detectors)).toContain("couldnt");
    expect(detectChips("Something went wrong here.", detectors)).toContain("something-went-wrong");
  });
  test("couldn't without 'I' still matches", () => {
    expect(detectChips("couldn't save the file", detectors)).toContain("couldnt");
  });
  test("clean text has no chips", () => {
    expect(detectChips("Here is the weather for Paris.", detectors)).toEqual([]);
  });
  test("default detectors include the Portuguese nao-consegui chip", () => {
    const dets = defaultRedChipDetectors();
    expect(detectChips("Não consegui completar.", dets)).toContain("nao-consegui"); // english-check: allow
  });
});

describe("evaluateAsserts", () => {
  test("reports the failed assert path", () => {
    const asserts = [{ path: "toolCalls", check: (m: RunModel) => (m.toolCalls ?? []).length > 0, reason: "one tool call" }];
    expect(evaluateAsserts({ text: "", toolCalls: [] }, asserts)).toEqual(["toolCalls"]);
  });
});

describe("runAICase guards", () => {
  test("2/3 pass -> red (N/N requires every run)", async () => {
    const res = await runAICase(
      goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 1 }),
      stubRunner(modelWithCall, { text: "" }, modelWithCall),
      realEnv,
    );
    expect(res.status).toBe("red");
    expect(res.didNotRun).toBe(false);
    expect(res.passed).toBe(2);
    expect(res.totalRuns).toBe(3);
  });

  test("all runs pass -> green", async () => {
    const res = await runAICase(
      goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 2 }),
      stubRunner(modelWithCall),
      realEnv,
    );
    expect(res).toMatchObject({ status: "green", totalRuns: 6, attempts: 6, passed: 6, floor: false });
    expect(res.turns).toHaveLength(6);
  });

  test("chip hit -> red even when structure passes", async () => {
    const res = await runAICase(
      goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 1 }),
      stubRunner({ text: "Something went wrong", toolCalls: [{ name: "get_weather" }] }),
      realEnv,
    );
    expect(res.status).toBe("red");
    expect(res.description).toContain("something-went-wrong");
  });

  test("chip and assert both fail on one run -> both recorded", async () => {
    const res = await runAICase(
      goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 1 }),
      stubRunner({ text: "I couldn't do that.", toolCalls: [] }),
      realEnv,
    );
    expect(res.status).toBe("red");
    expect(res.failed?.[0].chipsHit).toEqual(["couldnt"]);
    expect(res.failed?.[0].failedAsserts).toEqual(["toolCalls"]);
  });

  test("custom/localized detectors are used when configured", async () => {
    const custom = [{ name: "boom", match: (t: string) => /boom/.test(t) }];
    const res = await runAICase(
      goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 1, redChips: custom }),
      stubRunner({ text: "boom", toolCalls: [{ name: "x" }] }),
      realEnv,
    );
    expect(res.status).toBe("red");
    expect(res.description).toContain("boom");
  });

  test("expectRedChip fires -> green (negative-control self-test)", async () => {
    const res = await runAICase(
      goodCase({
        inputs: [{ a: 1 }, { b: 2 }, { c: 3 }],
        repeat: 1,
        expectRedChip: "couldnt",
        asserts: [],
      }),
      stubRunner({ text: "I couldn't do that." }),
      realEnv,
    );
    expect(res.status).toBe("green");
  });

  test("expectRedChip does not fire -> red, missing expected chip", async () => {
    const res = await runAICase(
      goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 1, expectRedChip: "couldnt", asserts: [] }),
      stubRunner({ text: "All done." }),
      realEnv,
    );
    expect(res.status).toBe("red");
    expect(res.failed?.[0].missingRedChip).toBe("couldnt");
  });

  test("missing real-model secret -> DID-NOT-RUN red, not green", async () => {
    const res = await runAICase(goodCase(), stubRunner(modelWithCall), {});
    expect(res.status).toBe("red");
    expect(res.didNotRun).toBe(true);
    expect(res.description).toContain("AI DID-NOT-RUN");
  });

  test("blocked route with no stand-in -> DID-NOT-RUN", async () => {
    const res = await runAICase(goodCase(), stubRunner(modelWithCall), { realModelSecret: "x", realRouteBlocked: true });
    expect(res.status).toBe("red");
    expect(res.didNotRun).toBe(true);
  });

  test("floor works WITHOUT a real secret and passes stand-in model id", async () => {
    const runner = stubRunner(modelWithCall);
    const res = await runAICase(
      goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 1 }),
      runner,
      { standInModel: "stand-in-model", realRouteBlocked: true },
    );
    expect(res.status).toBe("green");
    expect(res.floor).toBe(true);
    expect(runner.calls.every((c) => c.ctx.floor && c.ctx.modelId === "stand-in-model")).toBe(true);
  });

  test("floor result is visibly distinct: floor:true vs real floor:false", async () => {
    const real = await runAICase(goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 1 }), stubRunner(modelWithCall), realEnv);
    const floor = await runAICase(
      goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 1 }),
      stubRunner(modelWithCall),
      { standInModel: "s", realRouteBlocked: true },
    );
    expect(real.floor).toBe(false);
    expect(floor.floor).toBe(true);
  });

  test("generic throw -> red run, not DID-NOT-RUN", async () => {
    const res = await runAICase(goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 1 }), throwingRunner(new Error("boom")), realEnv);
    expect(res.status).toBe("red");
    expect(res.didNotRun).toBe(false);
    expect(res.failed?.[0].thrown).toBe("boom");
  });

  test("ModelUnavailable -> DID-NOT-RUN", async () => {
    const res = await runAICase(goodCase(), throwingRunner(new ModelUnavailable("route blocked")), realEnv);
    expect(res.status).toBe("red");
    expect(res.didNotRun).toBe(true);
    expect(res.description).toContain("route blocked");
  });

  test("per-attempt timeout -> red with timedOut", async () => {
    const slow: ModelRunner = { run: async () => { await new Promise((r) => setTimeout(r, 50)); return modelWithCall; } };
    const res = await runAICase(goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 1, timeoutMs: 1 }), slow, realEnv);
    expect(res.status).toBe("red");
    expect(res.failed?.[0].timedOut).toBe(true);
  });

  test("NaN repeat -> config error red, never green", async () => {
    const res = await runAICase(goodCase({ repeat: NaN }), stubRunner(modelWithCall), realEnv);
    expect(res.status).toBe("red");
    expect(res.description).toContain("invalid repeat");
  });

  test("fewer than 3 distinct inputs -> config error red", async () => {
    const res = await runAICase(goodCase({ inputs: [{ a: 1 }, { a: 1 }] }), stubRunner(modelWithCall), realEnv);
    expect(res.status).toBe("red");
    expect(res.description).toContain("3 distinct");
  });

  test("turns evidence matches consumer schema: prompt, reply, chips[], floor", async () => {
    const res = await runAICase(
      goodCase({ inputs: [{ a: 1 }, { b: 2 }, { c: 3 }], repeat: 1 }),
      stubRunner(modelWithCall),
      realEnv,
    );
    expect(res.turns[0]).toEqual({ prompt: { a: 1 }, reply: "Getting weather now.", chips: [], floor: false });
  });
});