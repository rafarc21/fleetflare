import { describe, expect, test } from "bun:test";
import {
  runLegInContainer, runLegWithSecrets, legResponse, prepareAndStartContainer, startLegContainer, NO_INSTANCE_DESCRIPTION, type GateContainer, type OutboundBinding,
  type LegOutcome,
} from "../../src/gate/run-leg";
import { buildLegEnvVars, type GateLegRequest } from "../../src/gate/leg-env";

// #715: GateRunnerDO drives the native ctx.container API. These tests run the
// pure runLegInContainer with a fake container that records every call. A
// fake clock makes the 180 s readiness bound and the 240 s port-retry budget
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
  setInactivityTimeoutThrows: Error | undefined = undefined;
  staleRunning = false;
  /** Clock time at which the container stops running (it exited mid-leg). */
  exitAtMs = Number.POSITIVE_INFINITY;
  /** #1398: the last inactivity timeout set, if any. */
  inactivityTimeoutMs: number | undefined = undefined;
  private startedAt: number | undefined = undefined;
  clock: { now: number } = { now: 0 };

  get running(): boolean {
    if (this.clock.now >= this.exitAtMs) return false;
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

  async setInactivityTimeout(ms: number | bigint): Promise<void> {
    this.calls.push("setInactivityTimeout");
    if (this.setInactivityTimeoutThrows) throw this.setInactivityTimeoutThrows;
    this.inactivityTimeoutMs = Number(ms);
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

// #1398 Task 3: the async dispatch path starts a container WITHOUT waiting
// for readiness in the same call. The shared start sequence (image lookup,
// survivor destroy, intercept, start) is factored out so both the old
// synchronous path and the new async path share one implementation.
describe("prepareAndStartContainer (#1398)", () => {
  test("starts the container and sets an inactivity timeout, without waiting for readiness", async () => {
    const c = new FakeContainer();
    c.runningAfterMs = 5_000; // would need a wait in the OLD synchronous path
    const result = await prepareAndStartContainer(LEG, { container: c, outbound: OUTBOUND, inactivityTimeoutMs: 60_000 });
    expect(result).toEqual({ kind: "ok" });
    expect(c.starts).toHaveLength(1);
    expect(c.inactivityTimeoutMs).toBe(60_000);
    expect(c.calls).toContain("intercept");
    // No "poll"/"port-fetch" calls at all -- this function never talks to the
    // server, only the container's own start/intercept lifecycle.
    expect(c.fetchCalls).toBe(0);
  });

  test("destroys a stale-running survivor before starting fresh (same as runLegInContainer today)", async () => {
    const c = new FakeContainer();
    c.staleRunning = true;
    await prepareAndStartContainer(LEG, { container: c, outbound: OUTBOUND });
    expect(c.destroyCount).toBe(1);
    expect(c.starts).toHaveLength(1);
  });

  test("answers infra when the image is not bound (same mapping as runLegInContainer today)", async () => {
    const c = new FakeContainer();
    c.images = undefined;
    const result = await prepareAndStartContainer(LEG, { container: c, outbound: OUTBOUND });
    expect(result).toEqual({ kind: "infra", description: "gate image not bound (images.gate)" });
  });

  test("a rejecting setInactivityTimeout is an infra result, never a throw (#1398 review r1)", async () => {
    const c = new FakeContainer();
    c.setInactivityTimeoutThrows = new Error("inactivity timeout rejected");
    const result = await prepareAndStartContainer(LEG, { container: c, outbound: OUTBOUND, inactivityTimeoutMs: 60_000 });
    expect(result).toEqual({ kind: "infra", description: "gate container failed: inactivity timeout rejected" });
  });
});

describe("startLegContainer (#1398)", () => {
  test("starts the container and returns immediately, never waiting for readiness or polling", async () => {
    const c = new FakeContainer();
    c.runningAfterMs = Number.POSITIVE_INFINITY; // never becomes ready -- would hang the OLD path forever
    const result = await startLegContainer(LEG, { container: c, outbound: OUTBOUND, inactivityTimeoutMs: 60_000 });
    expect(result).toEqual({ kind: "started" });
    expect(c.inactivityTimeoutMs).toBe(60_000); // the async path sets it too -- a mutant dropping it from deps would still pass otherwise
    expect(c.fetchCalls).toBe(0); // never talked to the server
    expect(c.destroyCount).toBe(0); // never torn down -- the DO's alarm owns that later
  });

  test("surfaces an infra description when the image is not bound, same as the sync path", async () => {
    const c = new FakeContainer();
    c.images = undefined;
    const result = await startLegContainer(LEG, { container: c, outbound: OUTBOUND });
    expect(result).toEqual({ kind: "infra", description: "gate image not bound (images.gate)" });
  });
});

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

// #1346 correctness review r1 item 1: reverting the `deps.secretValues` plumb-
// through in run-leg.ts (buildLegEnvVars(req, deps.secretValues) back to
// buildLegEnvVars(req)) passed every test that existed before this one --
// nothing exercised runLegInContainer's OWN wiring of secretValues into the
// real container start() call, only buildLegEnvVars as a pure function in
// isolation (gate-secrets-leg-env.test.ts). This closes that gap.
describe("runLegInContainer: gate-scoped secrets reach the container's env (#1346)", () => {
  test("deps.secretValues becomes GATE_SECRET_* on the real start() call", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [okResponse("success")];
    await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c), secretValues: { "staging-login": "sup3r-s3cret" },
    });

    expect(c.starts).toHaveLength(1);
    expect(c.starts[0]?.env.GATE_SECRET_STAGING_LOGIN).toBe("sup3r-s3cret");
  });

  test("no deps.secretValues means no GATE_SECRET_* env vars at all", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [okResponse("success")];
    await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    const env = c.starts[0]?.env ?? {};
    expect(Object.keys(env).some((k) => k.startsWith("GATE_SECRET_"))).toBe(false);
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

  test("a port refusal that outlasts the 90 s budget is an infra outcome and destroys (live: cold image pulls took over 60 s)", async () => {
    const c = new FakeContainer();
    c.portOutcomes = Array.from({ length: 1000 }, () => new Error("ECONNREFUSED"));
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome.kind).toBe("infra");
    if (outcome.kind === "infra") expect(outcome.description).toContain("gate server unreachable after 90 s");
    // 90 s of 500 ms retries: one attempt at t=0 through t=90000 inclusive.
    expect(c.fetchCalls).toBe(181);
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

  test("a leg that never answers 200 is a red result at 25 min (#1387: never infra, never retried), and the container is destroyed", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultFallback = running();
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "result", result: { state: "error", description: "leg-a exceeded 25 min without a result" } });
    expect(c.clock.now).toBeGreaterThanOrEqual(25 * 60_000);
    expect(c.clock.now).toBeLessThan(25 * 60_000 + 5_000);
    expect(c.destroyCount).toBe(1);
  });

  test("a /result that fails on every poll still ends at the 25 min deadline as a red result", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultFallback = new Error("ECONNREFUSED");
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "result", result: { state: "error", description: "leg-a exceeded 25 min without a result" } });
    expect(c.clock.now).toBeGreaterThanOrEqual(25 * 60_000);
    expect(c.destroyCount).toBe(1);
  });
});

describe("runLegInContainer: per-leg deadline", () => {
  test("a leg's timeoutMin replaces the 25 min default: the deadline is its own N min", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultFallback = running();
    const outcome = await runLegInContainer({ ...LEG, timeoutMin: 3 }, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "result", result: { state: "error", description: "leg-a exceeded 3 min without a result" } });
    expect(c.clock.now).toBeGreaterThanOrEqual(3 * 60_000);
    expect(c.clock.now).toBeLessThan(4 * 60_000);
    expect(c.destroyCount).toBe(1);
  });

  test("a timeoutMin above MAX_LEG_TIMEOUT_MIN (25) is clamped to 25 min", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultFallback = running();
    const outcome = await runLegInContainer({ ...LEG, timeoutMin: 99 }, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "result", result: { state: "error", description: "leg-a exceeded 25 min without a result" } });
    expect(c.clock.now).toBeGreaterThanOrEqual(25 * 60_000);
  });

  test("a timeoutMin below 1 is clamped to 1 min", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultFallback = running();
    const outcome = await runLegInContainer({ ...LEG, timeoutMin: 0 }, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "result", result: { state: "error", description: "leg-a exceeded 1 min without a result" } });
    expect(c.clock.now).toBeLessThan(2 * 60_000);
  });

  test("a leg that answers inside its own deadline is returned as its real result", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultOutcomes = [running(), okResponse("success")];
    const outcome = await runLegInContainer({ ...LEG, timeoutMin: 3 }, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "result", result: { state: "success" } });
  });
});

describe("runLegInContainer: dead container mid-leg", () => {
  test("a container that stops running during polling is an infra failure at once, and is destroyed", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultFallback = running();
    c.exitAtMs = 12_000;
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "infra", description: "gate container exited mid-leg" });
    // Dies at 12 s: the next check after it is the 15 s poll. No polling until the 25 min deadline.
    expect(c.clock.now).toBeLessThan(60_000);
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

describe("runLegInContainer: no-instance fail-fast (#1278 ask 1)", () => {
  test("a start() that refuses for lack of an instance fails fast, never retries the host", async () => {
    const c = new FakeContainer();
    c.startThrows = new Error("There is no container instance that can be provided");
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "infra", description: NO_INSTANCE_DESCRIPTION });
    expect(c.destroyCount).toBe(1);
    expect(c.clock.now).toBe(0);
  });

  test("a port fetch that fails for lack of an instance fails fast: no 90 s budget spent", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [new Error("There is no container instance that can be provided")];
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "infra", description: NO_INSTANCE_DESCRIPTION });
    expect(c.fetchCalls).toBe(1);
    expect(c.clock.now).toBe(0);
    expect(c.destroyCount).toBe(1);
  });

  test("a poll that fails for lack of an instance fails fast mid-leg", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultOutcomes = [new Error("no container instance can be provided")];
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "infra", description: NO_INSTANCE_DESCRIPTION });
    expect(c.polls).toBe(1);
    expect(c.destroyCount).toBe(1);
  });

  test("an unrelated error is not misread as no-instance: the port-retry budget still applies", async () => {
    const c = new FakeContainer();
    c.portOutcomes = Array.from({ length: 1000 }, () => new Error("ECONNREFUSED"));
    const outcome = await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome.kind).toBe("infra");
    if (outcome.kind === "infra") expect(outcome.description).toContain("gate server unreachable after 90 s");
    expect(c.fetchCalls).toBe(181);
  });
});

describe("legResponse: /run-leg status mapping", () => {
  test("a leg deadline is a real red result: it answers 200, so the step never infra-retries it (#1387)", async () => {
    const res = legResponse({ kind: "result", result: { state: "error", description: "lint exceeded 25 min without a result" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "error", description: "lint exceeded 25 min without a result" });
  });

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
// #1066: the leg's image key is an allowlisted lookup into images. Unbound or
// hostile keys are infra, never a start and never a silent fallback to gate.
describe("runLegInContainer: per-repo image key", () => {
  const DESKTOP_IMAGES = { gate: "gate-image:v1", desktop: "desktop-image:v1" };
  const E2E_IMAGES = { gate: "gate-image:v1", e2e: "e2e-image:v1" };

  test("a desktop key starts the image bound as images.desktop", async () => {
    const c = new FakeContainer();
    c.images = { ...DESKTOP_IMAGES };
    c.portOutcomes = [okResponse("success")];
    const outcome = await runLegInContainer({ ...LEG, image: "desktop" }, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "result", result: { state: "success" } });
    expect(c.starts[0]?.image).toBe("desktop-image:v1");
  });

  test("no key starts the default gate image, unchanged", async () => {
    const c = new FakeContainer();
    c.images = { ...DESKTOP_IMAGES };
    c.portOutcomes = [okResponse("success")];
    await runLegInContainer(LEG, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(c.starts[0]?.image).toBe("gate-image:v1");
  });

  test("an e2e key starts the image bound as images.e2e (#1342)", async () => {
    const c = new FakeContainer();
    c.images = { ...E2E_IMAGES };
    c.portOutcomes = [okResponse("success")];
    const outcome = await runLegInContainer({ ...LEG, image: "e2e" }, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "result", result: { state: "success" } });
    expect(c.starts[0]?.image).toBe("e2e-image:v1");
  });

  test("an allowlisted e2e key with no binding is infra, names the key, never starts (#1342)", async () => {
    const c = new FakeContainer();
    c.images = { gate: "gate-image:v1" };
    const outcome = await runLegInContainer({ ...LEG, image: "e2e" }, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "infra", description: "gate image not bound (images.e2e)" });
    expect(c.starts).toHaveLength(0);
    expect(c.destroyCount).toBe(1);
  });

  test("an allowlisted key with no binding is infra, names the key, never starts", async () => {
    const c = new FakeContainer();
    c.images = { gate: "gate-image:v1" };
    const outcome = await runLegInContainer({ ...LEG, image: "desktop" }, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome).toEqual({ kind: "infra", description: "gate image not bound (images.desktop)" });
    expect(c.starts).toHaveLength(0);
    expect(c.destroyCount).toBe(1);
  });

  test("__proto__ as a key is infra and never starts, even though it is a property of every object", async () => {
    const c = new FakeContainer();
    c.images = { ...DESKTOP_IMAGES };
    const outcome = await runLegInContainer({ ...LEG, image: "__proto__" }, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome.kind).toBe("infra");
    expect(c.starts).toHaveLength(0);
  });

  test("toString as a key is infra and never starts, never falls back to gate", async () => {
    const c = new FakeContainer();
    c.images = { ...DESKTOP_IMAGES };
    const outcome = await runLegInContainer({ ...LEG, image: "toString" }, { container: c, outbound: OUTBOUND, ...fakeClock(c) });

    expect(outcome.kind).toBe("infra");
    expect(c.starts).toHaveLength(0);
  });
});

// #1122: a transport loss after the container wrote its own R2 result. The
// leg's result is that R2 result, read before the port-retry budget is spent.
// An absent or unknown R2 result keeps the retry path (readResult answers undefined).
describe("runLegInContainer: R2 result after transport loss (#1122)", () => {
  const LOST = new Error("Network connection lost.");

  test("POST loses its transport and R2 holds a known state: that result, no retry, no budget spent", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [LOST];
    const reads: string[] = [];
    const outcome = await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c),
      readResult: async (key) => { reads.push(key); return { state: "success" }; },
    });

    expect(outcome).toEqual({
      kind: "result", result: { state: "success", description: "result read from R2 after transport loss: success" },
    });
    expect(c.fetchCalls).toBe(1);
    expect(c.clock.now).toBe(0);
    expect(reads).toEqual([LEG.resultKey]);
  });

  test("POST loses its transport and R2 holds a failure: the leg is that failure, with the R2 description", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [LOST];
    const outcome = await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c),
      readResult: async () => ({ state: "failure", description: "lint 3 errors" }),
    });

    expect(outcome).toEqual({
      kind: "result", result: { state: "failure", description: "result read from R2 after transport loss: lint 3 errors" },
    });
  });

  test("POST loses its transport and R2 is absent: the port is retried as before", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [LOST, okResponse("failure")];
    const outcome = await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c),
      readResult: async () => undefined,
    });

    expect(outcome).toEqual({ kind: "result", result: { state: "failure" } });
    expect(c.fetchCalls).toBe(2);
  });

  test("a port refusal that outlasts the budget reads R2 once, on the first failure", async () => {
    const c = new FakeContainer();
    c.portOutcomes = Array.from({ length: 1000 }, () => new Error("ECONNREFUSED"));
    let reads = 0;
    const outcome = await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c),
      readResult: async () => { reads += 1; return undefined; },
    });

    expect(outcome.kind).toBe("infra");
    expect(c.fetchCalls).toBe(181);
    expect(reads).toBe(1);
  });

  test("a poll that loses its transport reads R2: a known state ends the leg while the container still runs", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultOutcomes = [LOST];
    const outcome = await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c),
      readResult: async () => ({ state: "failure", description: "lint 3 errors" }),
    });

    expect(outcome).toEqual({
      kind: "result", result: { state: "failure", description: "result read from R2 after transport loss: lint 3 errors" },
    });
    expect(c.polls).toBe(1);
    expect(c.clock.now).toBe(5_000);
  });

  test("a poll that loses its transport and R2 is absent keeps polling until the leg answers", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultOutcomes = [LOST, okResponse("success")];
    const outcome = await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c),
      readResult: async () => undefined,
    });

    expect(outcome).toEqual({ kind: "result", result: { state: "success" } });
    expect(c.polls).toBe(2);
  });

  test("a container that stopped mid-leg reads R2 first: its known result wins over 'exited mid-leg'", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [running()];
    c.resultFallback = running();
    c.exitAtMs = 12_000;
    const outcome = await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c),
      readResult: async () => ({ state: "success" }),
    });

    expect(outcome).toEqual({
      kind: "result", result: { state: "success", description: "result read from R2 after transport loss: success" },
    });
    expect(c.destroyCount).toBe(1);
  });

  test("an R2 read that throws never masks the transport error: the POST is retried", async () => {
    const c = new FakeContainer();
    c.portOutcomes = [LOST, okResponse("failure")];
    const outcome = await runLegInContainer(LEG, {
      container: c, outbound: OUTBOUND, ...fakeClock(c),
      readResult: async () => { throw new Error("r2 down"); },
    });

    expect(outcome).toEqual({ kind: "result", result: { state: "failure" } });
  });
});

// #1346 security review r2: do.ts can never be loaded under bun test
// (cloudflare:workers), so BOTH "an unresolved granted secret never runs"
// and "redact the leg's own result" moved here, into one pure function a
// test can call directly with a fake `run`, with no container at all.
describe("runLegWithSecrets", () => {
  test("every granted name resolved: run() is called, and its result is redacted", async () => {
    let ran = false;
    const run = async (): Promise<LegOutcome> => {
      ran = true;
      return { kind: "result", result: { state: "failure", description: "login as sup3r-s3cret failed" } };
    };
    const outcome = await runLegWithSecrets(["staging-login"], { "staging-login": "sup3r-s3cret" }, run);

    expect(ran).toBe(true);
    expect(outcome).toEqual({ kind: "result", result: { state: "failure", description: "login as «redacted» failed" } });
  });

  test("an unresolved granted name: run() is NEVER called, and the leg goes RED", async () => {
    let ran = false;
    const run = async (): Promise<LegOutcome> => {
      ran = true;
      return { kind: "result", result: { state: "success" } };
    };
    const outcome = await runLegWithSecrets(["staging-login"], {}, run);

    expect(ran).toBe(false);
    expect(outcome).toEqual({ kind: "result", result: { state: "error", description: 'DID-NOT-RUN: secret "staging-login" unresolved' } });
  });

  test("no granted names at all: run() is called, nothing is redacted", async () => {
    const run = async (): Promise<LegOutcome> => ({ kind: "result", result: { state: "success", description: "all good" } });
    const outcome = await runLegWithSecrets([], {}, run);

    expect(outcome).toEqual({ kind: "result", result: { state: "success", description: "all good" } });
  });

  test("an infra outcome from run() passes through untouched, never redacted", async () => {
    const run = async (): Promise<LegOutcome> => ({ kind: "infra", description: "gate container did not start within 180 s" });
    const outcome = await runLegWithSecrets(["staging-login"], { "staging-login": "sup3r-s3cret" }, run);

    expect(outcome).toEqual({ kind: "infra", description: "gate container did not start within 180 s" });
  });

  test("redacts summary too, and never touches state even when the value equals it", async () => {
    const run = async (): Promise<LegOutcome> => ({ kind: "result", result: { state: "success", summary: "1 fail (success)" } });
    const outcome = await runLegWithSecrets(["staging-login"], { "staging-login": "success" }, run);

    expect(outcome).toEqual({ kind: "result", result: { state: "success", summary: "1 fail («redacted»)" } });
  });
});
