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
import { storedLegResult, type StoredLegResult } from "./leg-run";
import { firstUnresolvedSecret } from "./secrets-registry";
import { redactLegResultFields } from "./secrets-redact";

export const GATE_CONTAINER_PORT = 8080;
export const GATE_INSTANCE = "standard-4";
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 250;
const PORT_RETRY_MS = 500;
/** #1313: the budget a cold host gets to bring the gate server up. Live: a host
 *  that has not pulled the (Rust-sized) gate image yet took over 60 s to listen
 *  after start(); 90 s still covers that while failing fast. The old 240 s
 *  turned every post-deploy first-try leg into a ~10-min "gate server
 *  unreachable" stall before its step retry landed on a now-warm host. */
const PORT_RETRY_BUDGET_MS = 90_000;
/** How often a running leg is polled for its result. */
const POLL_MS = 5_000;
/** Ceiling on one request to the container. A request past it is a failed
 *  attempt, retried; the leg itself is bounded by its own deadline. */
const REQUEST_TIMEOUT_MS = 15_000;

/** A host with no spare container instance refuses start() (or the port fetch)
 *  with this wording. It is account capacity, not a leg defect: fail fast and
 *  back off, never spend the port-retry budget thrashing a saturated host. */
const NO_INSTANCE_RE = /no container instance|container instance that can be provided|no instances? available/i;

/** The infra description a no-instance leg returns. Named so the step's
 *  exponential retry backs off the same saturated host, and infra-rerun.ts still
 *  classifies it as infra (its INFRA_CAUSE matches "no container instance"). */
export const NO_INSTANCE_DESCRIPTION = "gate capacity: no container instance available";

// #1346 correctness review r1: gate-server.ts's runGate actually returns
// { state, description, summary } (container/gate-server.ts's own RunOutcome,
// `return { state: body.state, description: body.description, summary: body.summary }`)
// -- summary was missing from this type even though it was already flowing
// through at runtime (res.json() as LegResult does not strip it, just hides
// it from the type checker). Declaring it here is what let do.ts's redaction
// (secrets-redact.ts's redactLegResultFields) see and scrub it.
export type LegResult = { state: "success" | "failure" | "error"; description?: string; summary?: string };

/** A leg run ends in exactly one of two things: a real gate-server body
 *  (success/failure/error — data, 200) or an infra failure (container never
 *  started, server unreachable, exited mid-leg — 503 so the Workflow step
 *  retries). A leg past its own deadline is a real red body, never infra (#1387). */
export type LegOutcome =
  | { kind: "result"; result: LegResult }
  | { kind: "infra"; description: string };

/** The /run-leg reply: infra failures answer 503 so leg-run.ts's non-2xx
 *  check retries them twice; a real leg body is 200 and carried as data. */
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
  /** #1398 (design review r1 item 3): without this, the platform may stop an
   *  idle container between two DO alarm ticks (15-30s apart) -- read as
   *  "container exited mid-leg," a false infra failure on perfectly healthy
   *  work. Set once, at start, sized past the alarm tick interval. Matches
   *  workers-types Container's own signature (number | bigint, Promise<void>). */
  setInactivityTimeout(durationMs: number | bigint): Promise<void>;
}

export interface RunLegDeps {
  /** undefined when the DO has no container binding. */
  container: GateContainer | undefined;
  /** The Worker-side outbound entrypoint (outbound-entrypoint.ts), already
   *  scoped to this leg's resultKey. Registered before start. */
  outbound: OutboundBinding;
  /** Reads the leg's own R2 result. A transport loss reads it before the port-retry
   *  budget is spent: a known state there is the leg's result (#1122). */
  readResult?: (resultKey: string) => Promise<StoredLegResult | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** #1346: this leg's granted secrets, name -> resolved value -- do.ts
   *  builds this from req.secretNames (never read off `req` itself, same
   *  split as gateOutboundProps' own gitToken parameter). Fed straight into
   *  buildLegEnvVars below, so the container's GATE_SECRET_* env vars are set
   *  before start(), never after. */
  secretValues?: Record<string, string>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
      env: buildLegEnvVars(req, deps.secretValues),
    });
    if (deps.inactivityTimeoutMs !== undefined) await c.setInactivityTimeout(deps.inactivityTimeoutMs);
    return { kind: "ok" };
  } catch (err) {
    // The account-at-capacity refusal surfaces here from start(): fail fast,
    // never retry the host in place.
    if (isNoInstance(err)) return { kind: "infra", description: NO_INSTANCE_DESCRIPTION };
    return { kind: "infra", description: `gate container failed: ${errorText(err)}` };
  }
}

/** Starts the gate container for one leg, posts /run, and always destroys the
 *  container afterwards. Every infra failure returns an infra outcome (503,
 *  retried twice by the Workflow step); a real gate-server body returns as a
 *  result. Never a throw. */
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
    // The account-at-capacity refusal surfaces here from start(): fail fast,
    // never retry the host in place.
    if (isNoInstance(err)) return { kind: "infra", description: NO_INSTANCE_DESCRIPTION };
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

/**
 * #1346 security review r2: do.ts (GateRunnerDO) imports cloudflare:workers,
 * so bun test can never load it -- which is exactly how a silent revert of
 * EITHER "an unresolved granted secret never runs" OR "redact the leg's own
 * result before it leaves this DO" could pass every existing test (both
 * lived as plain code in do.ts's fetch handler before this). Pulling both
 * into this one pure, injectable function -- `run` stands in for
 * `runLegInContainer`, so a test can fake it and assert on the LegOutcome
 * this function hands back, exactly as if do.ts had called it -- closes that
 * gap. do.ts's own fetch handler is now just: resolve secrets, call this,
 * call legResponse on the result.
 */
export async function runLegWithSecrets(
  secretNames: readonly string[],
  secretValues: Readonly<Record<string, string>>,
  run: () => Promise<LegOutcome>,
): Promise<LegOutcome> {
  // A granted name that failed to resolve (an unset Worker secret, a missing
  // signing key) is a broken deploy, never "run without it" -- the container
  // (and `run`) never starts at all.
  const unresolved = firstUnresolvedSecret(secretNames, secretValues);
  if (unresolved !== null) {
    return { kind: "result", result: { state: "error", description: `DID-NOT-RUN: secret "${unresolved}" unresolved` } };
  }
  const outcome = await run();
  // The container's direct /run and /result HTTP response is a path of its
  // own, separate from the R2-PUT outbound-handler.ts already redacts --
  // this is the one place THIS path gets the same treatment, on the leg's
  // actual result only (an infra description is Worker-generated text,
  // never leg output).
  const values = Object.values(secretValues);
  return outcome.kind === "result"
    ? { kind: "result", result: redactLegResultFields(outcome.result, values) }
    : outcome;
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
 *  A container that stops running ends the leg early as infra (503, the step
 *  retries twice on fresh containers). A leg past its own deadline ends as a
 *  REAL red body (200, state error): a deadline is the leg's verdict, never a
 *  host hang to retry (#1387). */
async function runOnServer(
  c: GateContainer,
  req: GateLegRequest,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  readResult: RunLegDeps["readResult"],
): Promise<LegOutcome> {
  const port = c.getTcpPort(GATE_CONTAINER_PORT);
  const legStarted = now();
  const minutes = legTimeoutMin(req.timeoutMin);

  // The server may bind a moment after `running` turns true. A refused
  // connection is retried every 500 ms for at most PORT_RETRY_BUDGET_MS. Its
  // first failure reads the leg's R2 result before any retry spends the budget (#1122).
  const postStarted = now();
  let checkedR2 = false;
  for (;;) {
    let res: Response;
    try {
      res = await port.fetch("http://container/run", { method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (!checkedR2) {
        checkedR2 = true;
        const stored = await storedLegResult(readResult, req.resultKey);
        if (stored !== undefined) return { kind: "result", result: stored };
      }
      // Account at capacity: fail fast, never spend the full budget on a host
      // that cannot provide an instance (live: 459 concurrent legs thrashed a
      // saturated host under peer load).
      if (isNoInstance(err)) return { kind: "infra", description: NO_INSTANCE_DESCRIPTION };
      if (now() - postStarted >= PORT_RETRY_BUDGET_MS) {
        // #1313: name the budget that was spent, so the fail-fast shape is
        // visible in the description a leg's combined causes report.
        return { kind: "infra", description: `gate server unreachable after ${PORT_RETRY_BUDGET_MS / 1000} s: ${errorText(err)}` };
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
    // A stopped container may have written its result first (#1122).
    if (!c.running) {
      const stored = await storedLegResult(readResult, req.resultKey);
      return stored !== undefined ? { kind: "result", result: stored } : { kind: "infra", description: "gate container exited mid-leg" };
    }
    if (now() - legStarted >= minutes * 60_000) {
      return { kind: "result", result: { state: "error", description: `${req.leg} exceeded ${minutes} min without a result` } };
    }
    try {
      const res = await port.fetch("http://container/result", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 200) return { kind: "result", result: (await res.json()) as LegResult };
      // 202: still running. Any other status is retried like a thrown poll.
    } catch (err) {
      // A transport loss reads R2 for the leg's own result (#1122). Otherwise the
      // poll is retried; only the leg deadline ends the leg.
      const stored = await storedLegResult(readResult, req.resultKey);
      if (stored !== undefined) return { kind: "result", result: stored };
      // The host lost capacity mid-leg: fail fast rather than poll a saturated host.
      if (isNoInstance(err)) return { kind: "infra", description: NO_INSTANCE_DESCRIPTION };
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether an error is the account-at-capacity refusal, not a leg or host
 *  defect. Retrying a saturated host only adds the failure's port-retry budget
 *  on top; fail fast and let the step's exponential backoff shed the load. */
function isNoInstance(err: unknown): boolean {
  return NO_INSTANCE_RE.test(errorText(err));
}
