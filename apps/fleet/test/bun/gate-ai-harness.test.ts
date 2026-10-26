// apps/fleet/test/bun/gate-ai-harness.test.ts
// AI-leg harness guards (board #1345): N/N repeats, red-chip detectors,
// missing-secret DID-NOT-RUN, floor-mode stand-in. Each guard's unit here is
// the RED/GREEN source for its mutation report. Pure injected runner + env —
// no real model, no secret, no network.
import { describe, expect, test } from "bun:test";
import {
  defaultRedChipDetectors,
  detectChips,
  evaluateAsserts,
  floorStandIn,
  ModelUnavailable,
  runAICase,
  type AICase,
  type ModelRunner,
  type RunModel,
} from "../../container/gate/browser/ai/harness";

/** A stub runner that returns a fixed model response; a per-call queue lets a
 *  test vary one attempt from the next. */
function stubRunner(...responses: RunModel[]): ModelRunner {
  let i = 0;
  return { run: async () => responses[Math.min(i++, responses.length - 1)] };
}

function throwingRunner(err: Error): ModelRunner {
  return { run: async () => { throw err; } };
}

const realEnv = { realModelSecret: "present" };

function goodCase(over: Partial<AICase> = {}): AICase {
  return {
    name: "weather",
    input: { city: "Paris" },
    asserts: [{ path: "toolCalls", check: (m) => (m.toolCalls ?? []).length > 0, reason: "one tool call" }],
    ...over,
  };
}

const modelWithCall: RunModel = { text: "Getting weather now.", toolCalls: [{ name: "get_weather", input: { city: "Paris" } }] };

describe("floorStandIn", () => {
  test("unblocked route uses the real model, never the stand-in", () => {
    expect(floorStandIn({ realModelSecret: "x", standInModel: "s" })).toEqual({ useStandIn: false, reason: null });
  });
  test("blocked route with a stand-in switches to it", () => {
    expect(floorStandIn({ standInModel: "s", realRouteBlocked: true })).toEqual({ useStandIn: true, reason: null });
  });
  test("blocked route with no stand-in is unavailable", () => {
    expect(floorStandIn({ realRouteBlocked: true }).reason).toBe("real route blocked and no stand-in model configured");
  });
});

describe("detectChips", () => {
  const detectors = defaultRedChipDetectors();
  test("hits the example chips", () => {
    expect(detectChips("I couldn't do that.", detectors)).toContain("couldnt");
    expect(detectChips("Não consegui completar.", detectors)).toContain("nao-consegui");
    expect(detectChips("Something went wrong here.", detectors)).toContain("something-went-wrong");
  });
  test("clean text has no chips", () => {
    expect(detectChips("Here is the weather for Paris.", detectors)).toEqual([]);
  });
});

describe("evaluateAsserts", () => {
  test("reports the failed assert path", () => {
    const asserts = [{ path: "toolCalls", check: (m: RunModel) => (m.toolCalls ?? []).length > 0, reason: "one tool call" }];
    expect(evaluateAsserts({ text: "", toolCalls: [] }, asserts)).toEqual(["toolCalls"]);
  });
});

describe("runAICase guards", () => {
  test("2/3 pass -> red (N/N requires every attempt)", async () => {
    const res = await runAICase(goodCase({ repeat: 3 }), stubRunner(modelWithCall, { text: "" }, modelWithCall), realEnv);
    expect(res.status).toBe("red");
    if (res.status === "red") {
      expect(res.attempts).toHaveLength(1);
      expect(res.attempts[0].attempt).toBe(2);
    }
  });

  test("3/3 pass -> green", async () => {
    const res = await runAICase(goodCase({ repeat: 3 }), stubRunner(modelWithCall), realEnv);
    expect(res).toEqual({ status: "green", attempts: 3 });
  });

  test("chip hit -> red even when structure passes", async () => {
    const res = await runAICase(
      goodCase({ repeat: 1 }),
      stubRunner({ text: "Something went wrong", toolCalls: [{ name: "get_weather" }] }),
      realEnv,
    );
    expect(res.status).toBe("red");
    if (res.status === "red") expect(res.description).toContain("something-went-wrong");
  });

  test("chip is checked before asserts: chip hit but assert also fails -> red, not double-counted", async () => {
    const res = await runAICase(
      goodCase({ repeat: 1 }),
      stubRunner({ text: "I couldn't do that.", toolCalls: [] }),
      realEnv,
    );
    expect(res.status).toBe("red");
    if (res.status === "red") {
      expect(res.attempts[0].chipsHit).toEqual(["couldnt"]);
      expect(res.attempts[0].failedAsserts).toEqual(["toolCalls"]);
    }
  });

  test("missing real-model secret -> DID-NOT-RUN, never green", async () => {
    const res = await runAICase(goodCase(), stubRunner(modelWithCall), {});
    expect(res).toEqual({ status: "did-not-run", description: "AI DID-NOT-RUN: no real-model secret in the leg environment" });
  });

  test("empty-string secret -> DID-NOT-RUN", async () => {
    const res = await runAICase(goodCase(), stubRunner(modelWithCall), { realModelSecret: "" });
    expect(res.status).toBe("did-not-run");
  });

  test("blocked route with no stand-in -> DID-NOT-RUN", async () => {
    const res = await runAICase(goodCase(), stubRunner(modelWithCall), { realModelSecret: "x", realRouteBlocked: true });
    expect(res.status).toBe("did-not-run");
    if (res.status === "did-not-run") expect(res.description).toContain("AI DID-NOT-RUN");
  });

  test("blocked route with stand-in -> floor switch picks stand-in input", async () => {
    let seen: unknown;
    const runner: ModelRunner = { run: async (input) => { seen = input; return modelWithCall; } };
    const res = await runAICase(
      goodCase({ standInInput: { city: "Lisbon" } }),
      runner,
      { realModelSecret: "x", standInModel: "stand-in", realRouteBlocked: true },
    );
    expect(res.status).toBe("green");
    expect(seen).toEqual({ city: "Lisbon" });
  });

  test("ModelUnavailable mid-run -> DID-NOT-RUN, not a throw", async () => {
    const res = await runAICase(goodCase(), throwingRunner(new ModelUnavailable("route blocked")), realEnv);
    expect(res).toEqual({ status: "did-not-run", description: "AI DID-NOT-RUN: route blocked" });
  });

  test("repeat clamps to at least 1", async () => {
    const res = await runAICase(goodCase({ repeat: 0 }), stubRunner(modelWithCall), realEnv);
    expect(res).toEqual({ status: "green", attempts: 1 });
  });
});