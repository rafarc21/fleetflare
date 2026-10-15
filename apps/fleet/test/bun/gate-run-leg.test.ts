import { describe, expect, test } from "bun:test";
import { runLegInContainer, type GateContainer, type OutboundBinding } from "../../src/gate/run-leg";
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
  /** Each port fetch consumes one entry: a Response, or an Error to throw. */
  portOutcomes: Array<Response | Error> = [];
  startThrows: Error | undefined;
  private startedAt: number | undefined = undefined;
  clock: { now: number } = { now: 0 };

  get running(): boolean {
    return this.startedAt !== undefined && this.clock.now - this.startedAt >= this.runningAfterMs;
  }

  start(options: { image: string; enableInternet: boolean; instance: string; env: Record<string, string> }): void {
    this.calls.push("start");
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
      fetch: async () => {
        this.calls.push("port-fetch");
        this.fetchCalls += 1;
        const next = this.portOutcomes.shift();
        if (next === undefined) throw new Error("connection refused");
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }

  async destroy(): Promise<void> {
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

describe("runLegInContainer: container start", () => {
  test("starts the image bound as images.gate, on the standard-4 instance, with internet and the leg env", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [okResponse("success")];
    const result = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(result).toEqual({ state: "success" });
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
    const result = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(result.state).toBe("error");
    expect(result.description).toContain("gate");
    expect(c.starts).toHaveLength(0);
    expect(c.destroyCount).toBe(1);
  });

  test("returns an error without touching anything when there is no container at all", async () => {
    const c = new FakeContainer();
    const result = await runLegInContainer(LEG, { container: undefined, outbound: OUTBOUND, ...fakeClock(c) });

    expect(result.state).toBe("error");
    expect(c.calls).toEqual([]);
  });

  test("a throwing start returns an error leg and still destroys the container", async () => {
    const c = new FakeContainer();
    c.startThrows = new Error("image pull failed");
    const result = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(result.state).toBe("error");
    expect(result.description).toContain("image pull failed");
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
    const result = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(result).toEqual({ state: "success" });
    expect(c.clock.now).toBeGreaterThanOrEqual(1000);
  });

  test("errors and destroys when the container never reports running within 180 s", async () => {
    const c = new FakeContainer();
    c.runningAfterMs = Number.POSITIVE_INFINITY;
    const result = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(result.state).toBe("error");
    expect(c.fetchCalls).toBe(0);
    expect(c.clock.now).toBeGreaterThanOrEqual(180_000);
    expect(c.destroyCount).toBe(1);
  });

  test("a port refusal retries every 500 ms and succeeds once the server is up", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), okResponse("failure")];
    const result = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(c.fetchCalls).toBe(3);
    expect(result).toEqual({ state: "failure" });
    expect(c.destroyCount).toBe(1);
  });

  test("a port refusal that outlasts the 60 s budget returns an error leg and destroys", async () => {
    const c = new FakeContainer();
    c.portOutcomes = Array.from({ length: 500 }, () => new Error("ECONNREFUSED"));
    const result = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(result.state).toBe("error");
    expect(result.description).toContain("ECONNREFUSED");
    // 60 s of 500 ms retries: one attempt at t=0 through t=60000 inclusive.
    expect(c.fetchCalls).toBe(121);
    expect(c.destroyCount).toBe(1);
  });

  test("a non-OK response from the server becomes an error leg", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [new Response("boom", { status: 500 })];
    const result = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(result.state).toBe("error");
    expect(result.description).toContain("500");
    expect(c.destroyCount).toBe(1);
  });
});

describe("runLegInContainer: 25 min leg deadline", () => {
  test("a leg past the deadline is an error leg, and the container is destroyed", async () => {
    const c = new FakeContainer();
    // The deadline signal is already aborted; the port never answers.
    const requestedMs: number[] = [];
    const result = await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c),
      timeoutSignal: (ms) => { requestedMs.push(ms); return AbortSignal.abort(); },
    });

    expect(result).toEqual({ state: "error", description: "leg exceeded 25 min" });
    expect(requestedMs).toEqual([1_500_000]);
    expect(c.destroyCount).toBe(1);
  });

  test("a deadline during a port retry is not reported as an unreachable server", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [new Error("ECONNRESET")];
    const result = await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c),
      timeoutSignal: () => AbortSignal.abort(),
    });

    expect(result.description).toBe("leg exceeded 25 min");
    expect(c.destroyCount).toBe(1);
  });

  test("a leg that finishes inside the deadline is untouched by it", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [okResponse("failure")];
    const result = await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c),
      timeoutSignal: () => new AbortController().signal,
    });

    expect(result).toEqual({ state: "failure" });
    expect(c.destroyCount).toBe(1);
  });
});
