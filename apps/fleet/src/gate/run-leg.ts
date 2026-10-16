// #715 gate runner: runs ONE leg in ONE gate container through the native
// ctx.container API. Split out of do.ts so it is unit-testable under bun
// test: do.ts imports cloudflare:workers, which the bun-typed test project
// cannot load. The container and the outbound binding are injected here.
//
// Why the native API: on the durable_object scheduling policy the image must
// be named at start (`start({ image })`). The @cloudflare/containers base
// class starts without one and fails with "Image or container snapshot must
// be set for the new runtime".

import type { GateLegRequest } from "./leg-env";
import { buildLegEnvVars } from "./leg-env";
import { DEFAULT_GATE_IMAGE, GATE_IMAGES, legTimeoutMin } from "./config";

export const GATE_CONTAINER_PORT = 8080;
export const GATE_INSTANCE = "standard-4";
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 250;
const PORT_RETRY_MS = 500;
/** Live: on a host that has not pulled the (Rust-sized) gate image yet, the
 *  server took over 60 s to listen after start(). Pulls are cached per host. */
const PORT_RETRY_BUDGET_MS = 240_000;
/** How often a running leg is polled for its result. */
const POLL_MS = 5_000;
/** Ceiling on one request to the container. A request past it is a failed
 *  attempt, retried; the leg itself is bounded by its own deadline. */
const REQUEST_TIMEOUT_MS = 15_000;

export type LegResult = { state: "success" | "failure" | "error"; description?: string };

/** A leg run ends in exactly one of two things: a real gate-server body
 *  (success/failure/error — data, 200) or an infra failure (container never
 *  started, server unreachable, timeout — 503 so the Workflow step retries). */
export type LegOutcome =
  | { kind: "result"; result: LegResult }
  | { kind: "infra"; description: string };

/** The /run-leg reply: infra failures answer 503 so leg-run.ts's non-2xx
 *  check retries them once; a real leg body is 200 and carried as data. */
export function legResponse(outcome: LegOutcome): Response {
  if (outcome.kind === "infra") {
    return new Response(JSON.stringify({ error: outcome.description }), { status: 503 });
  }
  return Response.json(outcome.result);
}

/** The Worker's outbound entrypoint binding (a workers-types `Fetcher` at
 *  runtime). Typed `object` so this module loads in the bun-typed test
 *  project, which has no workers globals. */
export type OutboundBinding = object;

/** The slice of Cloudflare's container API this module uses. workers-types
 *  4.20260702.1 declares `Container.start` without `image` or `instance`, and
 *  declares no `images` at all, so the shape is spelled out here. Reading the
 *  real `Container` into this type needs no cast: `images` is optional. */
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
}

export interface RunLegDeps {
  /** undefined when the DO has no container binding. */
  container: GateContainer | undefined;
  /** The Worker-side outbound entrypoint (outbound-entrypoint.ts), already
   *  scoped to this leg's resultKey. Registered before start. */
  outbound: OutboundBinding;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the gate container for one leg, posts /run, and always destroys the
 *  container afterwards. Every infra failure returns an infra outcome (503,
 *  retried once by the Workflow step); a real gate-server body returns as a
 *  result. Never a throw. */
export async function runLegInContainer(req: GateLegRequest, deps: RunLegDeps): Promise<LegOutcome> {
  const c = deps.container;
  if (!c) return { kind: "infra", description: "gate container binding missing" };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  try {
    // The image is looked up by key, never taken from repo text: the key must be
    // allowlisted AND an own property of the operator's images map, so an
    // inherited name (__proto__, toString) never resolves. Unbound is infra.
    const key = req.image ?? DEFAULT_GATE_IMAGE;
    const image = GATE_IMAGES.has(key) && c.images !== undefined && Object.hasOwn(c.images, key)
      ? c.images[key]
      : undefined;
    if (!image) return { kind: "infra", description: `gate image not bound (images.${key})` };
    // A Worker deploy can reset this DO while the container survives, leaving
    // `running` true here. start() would throw "already running" — destroy the
    // survivor first so this leg gets a fresh container.
    if (c.running) {
      await c.destroy();
    }
    await c.interceptAllOutboundHttp(deps.outbound);
    c.start({
      image,
      enableInternet: true,
      instance: GATE_INSTANCE,
      env: buildLegEnvVars(req),
    });
    if (!(await waitUntilRunning(c, now, sleep))) {
      return { kind: "infra", description: "gate container did not start within 180 s" };
    }
    return await runOnServer(c, req, now, sleep);
  } catch (err) {
    return { kind: "infra", description: `gate container failed: ${errorText(err)}` };
  } finally {
    // The container bills while it lives: release it after every leg.
    try {
      await c.destroy();
    } catch (err) {
      console.error("gate-runner: destroy failed", errorText(err));
    }
  }
}

async function waitUntilRunning(
  c: GateContainer,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const started = now();
  while (!c.running) {
    if (now() - started >= READY_TIMEOUT_MS) return false;
    await sleep(READY_POLL_MS);
  }
  return true;
}

/** Starts the leg in the container and polls it to its result. POST /run
 *  answers at once, so no request is held for the whole leg: the container
 *  runs the leg once, and a repeat POST never starts a second run.
 *
 *  Two ways a polled leg ends early, both infra (503, the step retries once on a
 *  fresh container): a container that stopped running, and a leg past its own
 *  deadline. Live 10-16: a typecheck leg hung to the deadline and its retry on a
 *  fresh container passed in 108 s, so a deadline is a host hang, not a verdict. */
async function runOnServer(
  c: GateContainer,
  req: GateLegRequest,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<LegOutcome> {
  const port = c.getTcpPort(GATE_CONTAINER_PORT);
  const legStarted = now();
  const minutes = legTimeoutMin(req.timeoutMin);

  // The server may bind a moment after `running` turns true. A refused
  // connection is retried every 500 ms for at most 60 s.
  const postStarted = now();
  for (;;) {
    let res: Response;
    try {
      res = await port.fetch("http://container/run", { method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (now() - postStarted >= PORT_RETRY_BUDGET_MS) {
        return { kind: "infra", description: `gate server unreachable: ${errorText(err)}` };
      }
      await sleep(PORT_RETRY_MS);
      continue;
    }
    if (res.status === 200) return { kind: "result", result: (await res.json()) as LegResult };
    if (res.status === 202) break;
    return { kind: "infra", description: `gate server HTTP ${res.status}` };
  }

  // 202 from /run: the leg is running. Poll until it answers 200.
  for (;;) {
    await sleep(POLL_MS);
    if (!c.running) return { kind: "infra", description: "gate container exited mid-leg" };
    if (now() - legStarted >= minutes * 60_000) {
      return { kind: "infra", description: `${req.leg} exceeded ${minutes} min without a result` };
    }
    try {
      const res = await port.fetch("http://container/result", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 200) return { kind: "result", result: (await res.json()) as LegResult };
      // 202: still running. Any other status is retried like a thrown poll.
    } catch {
      // A failed poll is retried; only the leg deadline ends the leg.
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
