import { describe, expect, test } from "bun:test";
import { runLegInContainer, legResponse, LEG_RUN_TIMEOUT_MS, type GateContainer, type OutboundBinding } from "../../src/gate/run-leg";
import { buildLegEnvVars, type GateLegRequest } from "../../src/gate/leg-env";

// #715: GateRunnerDO drives the native ctx.container API. These tests run the
// pure runLegInContainer with a fake container that records every call. A
// fake clock makes the 180 s readiness bound and the 60 s port-retry budget
// cost nothing to exercise.

const LEG: GateLegRequest = {
  owner: "acme",
  repo: "widgets",
  commit: "base..head",
  leg: "leg-a",
  installCmd: "bun install",
  legCmd: "bun test",
  resultKey: "results/leg-a.json",
  baselineKeys: ["baseline/main.tar"],
  baseRef: "main",
  pr: "3",
};

// The binding is opaque to runLegInContainer; it only forwards it.
const OUTBOUND: OutboundBinding = {};

type Step = { kind: "start"; image: string; enableInternet: boolean; instance: string; env: Record<string, string> };

class FakeContainer implements GateContainer {
  calls: string[] = [];
  starts: Step[] = [];
  interceptedBinding: unknown = undefined;
  destroyCount = 0;
  fetchCalls = 0;
  images: Record<string, string> | undefined = { gate: "gate-image:v1" };
  /** Ticks of the fake clock before `running` flips true. Infinity = never. */
  runningAfterMs = 0;
  /** POST /run outcomes, consumed in order: a Response, or an Error to throw. */
  portOutcomes: Array<Response | Error> = [];
  /** GET /result outcomes, consumed in order. Once empty, resultFallback answers. */
  resultOutcomes: Array<Response | Error> = [];
  resultFallback: Response | Error = running();
  /** GET /result calls made, for the poll count. */
  polls = 0;
  startThrows: Error | undefined;
  staleRunning = false;
  private startedAt: number | undefined = undefined;
  clock: { now: number } = { now: 0 };

  get running(): boolean {
    return this.staleRunning || (this.startedAt !== undefined && this.clock.now - this.startedAt >= this.runningAfterMs);
  }

  start(options: { image: string; enableInternet: boolean; instance: string; env: Record<string, string> }): void {
    this.calls.push("start");
    if (this.staleRunning) throw new Error("already running");
    if (this.startThrows) throw this.startThrows;
    this.starts.push({ kind: "start", ...options });
    this.startedAt = this.clock.now;
  }

  async interceptAllOutboundHttp(binding: OutboundBinding): Promise<void> {
    this.calls.push("intercept");
    this.interceptedBinding = binding;
  }

  getTcpPort(_port: number): { fetch(input: string, init?: RequestInit): Promise<Response> } {
    return {
      fetch: async (input: string) => {
        this.fetchCalls += 1;
        if (input.endsWith("/result")) {
          this.polls += 1;
          this.calls.push("poll");
          const next = this.resultOutcomes.shift() ?? this.resultFallback;
          if (next instanceof Error) throw next;
          return next;
        }
        this.calls.push("port-fetch");
        const next = this.portOutcomes.shift();
        if (next === undefined) throw new Error("connection refused");
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }

  async destroy(): Promise<void> {
    this.staleRunning = false;
    this.calls.push("destroy");
    this.destroyCount += 1;
  }
}

/** A fake clock: sleep advances time, so no real waiting happens. */
function fakeClock(container: FakeContainer) {
  return {
    now: () => container.clock.now,
    sleep: async (ms: number) => {
      container.clock.now += ms;
    },
  };
}

function okResponse(state: string): Response {
  return Response.json({ state });
}

/** The 202 a server answers while its leg is still running. */
function running(): Response {
  return Response.json({ state: "running" }, { status: 202 });
}

describe("runLegInContainer: container start", () => {
  test("starts the image bound as images.gate, on the standard-4 instance, with internet and the leg env", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [okResponse("success")];
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "result", result: { state: "success" } });
    expect(c.starts).toHaveLength(1);
    const [start] = c.starts;
    expect(start?.image).toBe("gate-image:v1");
    expect(start?.instance).toBe("standard-4");
    expect(start?.enableInternet).toBe(true);
    expect(start?.env).toEqual(buildLegEnvVars(LEG));
    expect(start?.env.GATE_LEG).toBe("leg-a");
    expect(start?.env.GATE_RESULT_KEY).toBe("results/leg-a.json");
  });

  test("returns an error and never starts when no image is bound to images.gate", async () => {
    const c = new FakeContainer();
    c.images = undefined;
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome.kind).toBe("infra");
    if (outcome.kind === "infra") expect(outcome.description).toContain("gate");
    expect(c.starts).toHaveLength(0);
    expect(c.destroyCount).toBe(1);
  });

  test("returns an error without touching anything when there is no container at all", async () => {
    const c = new FakeContainer();
    const outcome = await runLegInContainer(LEG, { container: undefined, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome.kind).toBe("infra");
    expect(c.calls).toEqual([]);
  });

  test("a throwing start returns an error leg and still destroys the container", async () => {
    const c = new FakeContainer();
    c.startThrows = new Error("image pull failed");
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome.kind).toBe("infra");
    if (outcome.kind === "infra") expect(outcome.description).toContain("image pull failed");
    expect(c.destroyCount).toBe(1);
  });
});

describe("runLegInContainer: outbound interceptor", () => {
  test("registers the outbound binding before start", async () => {
    const c = new FakeContainer();
    await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(c.calls.indexOf("intercept")).toBeGreaterThanOrEqual(0);
    expect(c.calls.indexOf("intercept")).toBeLessThan(c.calls.indexOf("start"));
    expect(c.interceptedBinding).toBe(OUTBOUND);
  });
});

describe("runLegInContainer: readiness and port", () => {
  test("waits for running, then posts /run and returns the leg result", async () => {
    const c = new FakeContainer();
    c.runningAfterMs = 1000;
    c.portOutcomes = [okResponse("success")];
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "result", result: { state: "success" } });
    expect(c.clock.now).toBeGreaterThanOrEqual(1000);
  });

  test("errors and destroys when the container never reports running within 180 s", async () => {
    const c = new FakeContainer();
    c.runningAfterMs = Number.POSITIVE_INFINITY;
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome.kind).toBe("infra");
    expect(c.fetchCalls).toBe(0);
    expect(c.clock.now).toBeGreaterThanOrEqual(180_000);
    expect(c.destroyCount).toBe(1);
  });

  test("a port refusal retries every 500 ms and succeeds once the server is up", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), okResponse("failure")];
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(c.fetchCalls).toBe(3);
    expect(outcome).toEqual({ kind: "result", result: { state: "failure" } });
    expect(c.destroyCount).toBe(1);
  });

  test("a port refusal that outlasts the 60 s budget returns an error leg and destroys", async () => {
    const c = new FakeContainer();
    c.portOutcomes = Array.from({ length: 500 }, () => new Error("ECONNREFUSED"));
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome.kind).toBe("infra");
    if (outcome.kind === "infra") expect(outcome.description).toContain("ECONNREFUSED");
    // 60 s of 500 ms retries: one attempt at t=0 through t=60000 inclusive.
    expect(c.fetchCalls).toBe(121);
    expect(c.destroyCount).toBe(1);
  });

  test("a non-OK response from the server becomes an error leg", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [new Response("boom", { status: 500 })];
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome.kind).toBe("infra");
    if (outcome.kind === "infra") expect(outcome.description).toContain("500");
    expect(c.destroyCount).toBe(1);
  });
});

describe("runLegInContainer: polled result", () => {
  test("posts /run once, polls /result until the leg answers 200, then returns its body", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultOutcomes = [running(), running(), okResponse("success")];
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "result", result: { state: "success" } });
    expect(c.polls).toBe(3);
    expect(c.destroyCount).toBe(1);
  });

  test("polls every 5 s: the first poll comes 5 s after the start", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultOutcomes = [okResponse("failure")];
    await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(c.polls).toBe(1);
    expect(c.clock.now).toBe(5_000);
  });

  test("a poll that throws is retried, never fatal on its own", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultOutcomes = [new Error("ECONNRESET"), new Response("boom", { status: 500 }), okResponse("failure")];
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(c.polls).toBe(3);
    expect(outcome).toEqual({ kind: "result", result: { state: "failure" } });
    expect(c.destroyCount).toBe(1);
  });

  test("a leg that never answers 200 is an error at 25 min, and the container is destroyed", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultFallback = running();
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "infra", description: "leg exceeded 25 min" });
    expect(c.clock.now).toBeGreaterThanOrEqual(LEG_RUN_TIMEOUT_MS);
    expect(c.destroyCount).toBe(1);
  });

  test("a /result that fails on every poll still stops at the 25 min deadline", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultFallback = new Error("ECONNREFUSED");
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "infra", description: "leg exceeded 25 min" });
    expect(c.clock.now).toBeGreaterThanOrEqual(LEG_RUN_TIMEOUT_MS);
    expect(c.destroyCount).toBe(1);
  });
});

describe("runLegInContainer: stale container", () => {
  test("a container already running (deploy reset the DO mid-leg) is destroyed before start", async () => {
    const c = new FakeContainer();
    c.staleRunning = true;
    c.portOutcomes = [okResponse("success")];
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(c.calls.indexOf("destroy")).toBeGreaterThanOrEqual(0);
    expect(c.calls.indexOf("destroy")).toBeLessThan(c.calls.indexOf("start"));
    expect(outcome).toEqual({ kind: "result", result: { state: "success" } });
  });
});

describe("legResponse: /run-leg status mapping", () => {
  test("an infra failure answers 503 with an error body, never a 200 leg result", async () => {
    const res = legResponse({ kind: "infra", description: "gate container did not start within 180 s" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "gate container did not start within 180 s" });
  });

  test("a real leg result (success/failure/error body) answers 200 with that body", async () => {
    const res = legResponse({ kind: "result", result: { state: "failure", description: "3 errors" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "failure", description: "3 errors" });
  });
});