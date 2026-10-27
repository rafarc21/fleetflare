// #715: the one-leg step GateWorkflow runs. Pure: no Workflow/DO bindings, so
// bun test can load it. workflow.ts passes in the real step and dispatcher.
//
// The GateRunnerDO answers /run-leg synchronously with the leg's LegResult.
// That return value is the step result. A red test is data (state "failure"),
// never a throw. Any non-2xx is infra: the step throws, Workflows retries it
// twice (#1231), and a third failure becomes this leg's "error".
import type { GateLegRequest } from "./leg-env";
import { normalizeLegResult, type LegRunMeta, type PlannedLeg } from "./fanout";
import { legTimeoutMin } from "./config";
import type { LegResult } from "./verdict";
import { asyncAttemptDeadlineMs } from "./run-leg-alarm";
import { grantedSecretNames, trustedForSecrets } from "./secrets-scope";
import { isInfraCause } from "./infra-rerun";
import type { GateSecretsAllowlist } from "./secrets-config";

/** A leg's result as the step returns it: the DO's LegResult plus wall time and summary. */
export type LegRunResult = LegResult & LegRunMeta & {
  /** Set when the leg's first attempt was a red test: its retry's infra error is not infra (#1119). */
  redFirst?: true;
};

/** Workflows caps a step result at 1 MiB; a leg description has no reason to
 *  be near that, so it is bounded well under it. */
const MAX_DESCRIPTION_CHARS = 2000;

/** The infra-cause message ceiling: a leg's final description carries the
 *  503 body's error, cut to this many chars so it stays a one-line cause. */
const MAX_INFRA_CAUSE_CHARS = 200;

/** The first attempt's red description, cut to this many chars when the leg
 *  passes on retry, so the flake's cause stays in the one-line status. */
const MAX_FIRST_DESCRIPTION_CHARS = 150;

/** The combined-causes budget for a leg whose every attempt failed (#1231):
 *  short enough to read as one line, generous enough for 2-3 short causes. */
export const MAX_COMBINED_CAUSE_CHARS = 140;

/** Every cause gets a fair share of the budget — a long cause is shortened,
 *  never erased outright by a later cause's length. The total never exceeds
 *  MAX_COMBINED_CAUSE_CHARS: each cause's share already accounts for the "; "
 *  separators between them. */
export function combineCauses(causes: string[]): string {
  if (causes.length === 0) return "";
  const sep = "; ";
  const budget = Math.max(0, MAX_COMBINED_CAUSE_CHARS - sep.length * (causes.length - 1));
  const perCause = Math.max(1, Math.floor(budget / causes.length));
  const trimmed = causes.map((c) => (c.length <= perCause ? c : `${c.slice(0, Math.max(0, perCause - 1))}…`));
  return trimmed.join(sep);
}

/** The one step config a leg uses. Literal types, so the object is assignable
 *  to Workflows' WorkflowStepConfig without importing cloudflare:workers here
 *  (the check tsconfigs for test/ cannot resolve that module). */
export interface LegStepConfig {
  retries: { limit: number; delay: "15 seconds"; backoff: "constant" | "exponential" };
  timeout: "30 minutes";
}

/** The slice of Workflows' WorkflowStepContext the step callback receives:
 *  attempt (1-based, durable across an engine restart) and step name/count. */
export interface LegStepContext {
  attempt: number;
  step: { name: string; count: number };
}

/** The slice of Workflows' WorkflowStep this module uses. Generic (#1398):
 *  the real WorkflowStep.do is generic too, and later steps in this file
 *  (the async/polling path's dispatch/poll steps) return shapes other than
 *  LegRunResult. */
export interface LegStepRunner {
  do<T>(name: string, config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T>;
}

export const LEG_STEP_CONFIG: LegStepConfig = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "30 minutes",
};

/** LEG_STEP_CONFIG.timeout in ms. Kept in step with the literal above. */
export const LEG_STEP_TIMEOUT_MS = 30 * 60_000;
/** Slack the attempt deadline keeps under the step timeout, so the deadline
 *  always ends a hung attempt first (#1135 item 3). */
const STEP_DEADLINE_MARGIN_MS = 2 * 60_000;
/** A stored R2 result read is bounded: a hung read must not hold the step open (#1135). */
const R2_READ_TIMEOUT_MS = 30_000;

/** The runner DO name for one attempt of one leg. Every attempt (the start
 *  step, its infra step-retry, and the retry-<leg> step) gets its own name, so
 *  an attempt never lands on a DO whose previous container may still be
 *  tearing down (#1068). Pure: the workflow passes its instance id and the
 *  attempt id made inside the step callback. */
export function gateRunnerName(instanceId: string, leg: string, attemptId: string): string {
  return `${instanceId}/${leg}/${attemptId}`;
}

/** The Workflow-side reads a leg's R2 result by its key (#1094). Optional: a
 *  caller without it keeps the transport error as the whole description. */
export interface LegRunDeps {
  readResult?: (resultKey: string) => Promise<StoredLegResult | undefined>;
  /** Overrides the step deadline (tests). Default: legStepDeadlineMs(planned.timeoutMin). */
  stepDeadlineMs?: number;
  /** Upper bound of the random wait before a retry-<leg> dispatch (#1321). 0
   *  disables the jitter (tests). Default: 0; the live caller passes a real cap. */
  retryJitterMs?: number;
  /** Overrides the total wall-time cap for the WHOLE leg (all attempts). Tests
   *  pass a small value to reach the cap without real waiting. Default:
   *  totalLegWallMs(planned.timeoutMin). */
  totalDeadlineMs?: number;
  /** #1387: stamps the run's progress on a step's FIRST attempt only. An infra
   *  retry of the same step re-runs the same work on a fresh container, so it
   *  must not stamp — the watchdog has to see a retry loop, not a run that
   *  keeps "progressing". Never throws (markRunProgress). */
  touch?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** #1398 governing invariant: injectable clock, mirroring run-leg.ts's own
   *  RunLegDeps.now. Real caller: Date.now. A test can fake it to prove
   *  deadline math uses the leg-started STEP's own returned value, never a
   *  second live read. */
  now?: () => number;
}

/** The live cap on the retry-step start jitter (#1321): each retry-<leg> step
 *  waits a random 0..cap before its clone, so N red legs do not clone in
 *  lockstep and burst the shared GitHub token with 429s. */
export const RETRY_LEG_JITTER_MS = 4_000;

/** Slack past the leg's own timeout before its step gives up on a dispatch that
 *  never answered: covers the DO's readiness wait (180 s) and port-retry budget (90 s). */
const LEG_STEP_GRACE_MS = 10 * 60_000;

/** The per-attempt deadline for one leg: its timeout plus grace, capped under the
 *  step timeout. #1135: the old deadline (35 min) sat past the 30 min step
 *  timeout, so a hung attempt was never ended by it. Now every attempt ends
 *  before Workflows' own timeout fires, and the run is bounded. */
export function legStepDeadlineMs(timeoutMin: number | undefined): number {
  return Math.min(
    legTimeoutMin(timeoutMin) * 60_000 + LEG_STEP_GRACE_MS,
    LEG_STEP_TIMEOUT_MS - STEP_DEADLINE_MARGIN_MS,
  );
}

/** #1387: the total wall time the WHOLE leg may spend across every attempt —
 *  the start step, its infra retries, and the retry-<leg> step. The leg's own
 *  timeout plus the step grace. Not clamped to the per-attempt step timeout:
 *  the total spans two steps (start + retry), so it may legitimately exceed one
 *  step's 30 min while still ending well short of the old 3x25 min retry loop. */
export function totalLegWallMs(timeoutMin: number | undefined): number {
  return legTimeoutMin(timeoutMin) * 60_000 + LEG_STEP_GRACE_MS;
}

/** Ends a step whose work has no progress past its deadline (#1119): the work is
 *  abandoned and the step rejects, so no orphan step holds the run open. */
export function withStepDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** A leg's result as the container wrote it to R2: state, description, and
 *  (#1398) summary -- widened so runLegStepPolling's own normal read
 *  (legResultReader, never storedLegResult) can surface it, matching what
 *  the container already writes and what runLegStep's own live-response
 *  path already preserves today. */
export type StoredLegResult = { state: LegResult["state"]; description?: string; summary?: string };

/** #1321: a leg killed by SIGTERM (143) or SIGKILL (137) writes "exited 143/137".
 *  A LIVE gate-server that returns this means the test proc itself died — an OOM
 *  kill (137) or `timeout -s KILL` in the leg cmd is a REAL failure. Only a
 *  result recovered from R2 after a transport loss (carrying R2_PREFIX) means the
 *  platform killed the container, so that alone is re-read as infra. */
const SIGNAL_KILL_RE = /\bexited 1(43|37)\b/;

/** Whether a description names a SIGTERM/SIGKILL leg exit (#1321). Callers gate
 *  the infra re-read on the R2 read-back prefix themselves. */
export function isSignalKill(description: string | undefined): boolean {
  return description !== undefined && SIGNAL_KILL_RE.test(description);
}

/** The description prefix a result read back from R2 carries (#1122). Kept in one
 *  place so isRetryable can strip it before matching the underlying cause. */
export const R2_PREFIX = "result read from R2 after transport loss: ";

/** Runs one leg: a start-<leg> step, and when that returns state "failure"
 *  (a red test, possibly flaky), an "install failed" error (#1092), or a
 *  "clone failed" error (#1104) a single retry-<leg> step with a fresh container. Never throws: every failure becomes
 *  this leg's LegResult, so the other legs still finish. */
export async function runLegStep(
  step: LegStepRunner,
  dispatch: (planned: PlannedLeg, attemptId: string, signal: AbortSignal) => Promise<Response>,
  planned: PlannedLeg,
  deps: LegRunDeps = {},
): Promise<LegRunResult> {
  // targetFor takes the try number: the start step's infra retry gets its own
  // result key (see infraRetryResultKey). The try number is ctx.attempt, the
  // durable per-attempt counter (1-based, survives an engine restart), never a
  // closure counter that an engine restart would reset (#1321).
  const deadlineMs = deps.stepDeadlineMs ?? legStepDeadlineMs(planned.timeoutMin);
  // #1387: the total wall time the WHOLE leg (start step + retry-<leg> step +
  // every infra attempt) may spend: the leg's own timeout plus the step grace.
  // A leg that keeps failing infra past this is ended, never left to cycle.
  const totalDeadlineMs = deps.totalDeadlineMs ?? totalLegWallMs(planned.timeoutMin);
  const now = deps.now ?? Date.now;
  // #1398 governing invariant: minted inside its own step, so a mid-run
  // deploy replay of this whole function returns the CACHED mint time,
  // never a fresh now() that would silently corrupt totalDeadlineMs math.
  const legStarted = await step.do(`leg-started-${planned.leg}`, LEG_STEP_CONFIG, async () => now());
  const jitterMs = deps.retryJitterMs ?? 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const attempt = (name: string, targetFor: (tryNo: number) => PlannedLeg): Promise<LegRunResult> => {
    // Persists across this step's own Workflows retries (same closure) — one
    // cause per failed attempt, so the final throw (if retries run out) carries
    // all of them, never just the last.
    const causes: string[] = [];
    return step.do(name, LEG_STEP_CONFIG, async (ctx: LegStepContext | undefined) => {
      // #1321: the try number is the durable per-attempt counter. A runtime that
      // omits the context falls back to 1 (the old single-key behavior) rather
      // than a fleet-wide TypeError on the first leg.
      const tryNo = ctx?.attempt ?? 1;
      // #1387: only a step's FIRST attempt stamps the run's progress. An infra
      // retry of the same step re-runs the same work on a fresh container, so
      // it must not stamp — the watchdog has to see a retry loop, not a run
      // that keeps "progressing".
      if (tryNo === 1) await deps.touch?.();
      // #1321: retry-<leg> steps all dispatch in one Promise.all, so every red
      // leg would clone at once and burst the shared token. A random wait on the
      // step's FIRST attempt (only) desyncs the clones.
      if (name.startsWith("retry-") && tryNo === 1 && jitterMs > 0) {
        await sleep(Math.floor(random() * jitterMs));
      }
      const target = targetFor(tryNo);
      // Made inside the callback: a Workflows step retry re-runs it, so every
      // try gets its own runner DO. A replayed step returns its recorded result.
      const attemptId = crypto.randomUUID();
      // Timed inside the callback (after any jitter): a Workflow replay returns
      // the recorded ms instead of timing the replay.
      const started = now();
      // #1387: the whole leg is capped, not just this attempt. An infra retry
      // that would start past the cap is ended with the causes already earned —
      // still an infra-class error, so the run takes its one auto-rerun, never a
      // false red on healthy code. Only a hung attempt that hits its OWN leg
      // deadline (inside runOnServer) is the final red.
      const elapsed = now() - legStarted;
      if (elapsed >= totalDeadlineMs) {
        return {
          leg: planned.leg, state: "error",
          description: causes.length > 0
            ? combineCauses(causes)
            : `${planned.leg} exceeded ${legTimeoutMin(planned.timeoutMin)} min without a result`,
        };
      }
      // This attempt's own deadline: the per-attempt deadline, capped so the
      // WHOLE leg never runs past totalDeadlineMs (#1387). Worst case =
      // timeoutMin + grace, never ~63 min of cycling fresh containers.
      const attemptDeadlineMs = Math.min(deadlineMs, totalDeadlineMs - elapsed);
      // The dispatch call carries its own signal, so a hung DO call is aborted
      // at the deadline, not just abandoned by the race below (#1135).
      const signal = AbortSignal.timeout(attemptDeadlineMs);
      try {
        const res = await withStepDeadline(
          dispatch(target, attemptId, signal), attemptDeadlineMs, `${planned.leg}: no progress past its deadline`,
        );
        if (!res.ok) {
          // A non-2xx (infra, 503) carries its cause in the body's `error`
          // field — surface it. No usable body: name the HTTP status.
          let cause = `${planned.leg}: HTTP ${res.status}`;
          try {
            const body = await res.json() as { error?: unknown };
            if (typeof body.error === "string" && body.error.length > 0) {
              cause = `${planned.leg}: ${body.error}`;
            }
          } catch { /* non-JSON body: keep the HTTP status as the cause */ }
          throw new Error(cause);
        }
        const normalized = normalizeLegResult(planned.leg, (await res.json()) as LegRunResult);
        return {
          ...normalized,
          description: normalized.description?.slice(0, MAX_DESCRIPTION_CHARS),
          ms: now() - started,
        };
      } catch (err) {
        // The container may have written its own result before the transport
        // died. A known state there IS the leg's result (#1122), state included.
        const stored = await storedLegResult(deps.readResult, target.resultKey);
        if (stored !== undefined) {
          // #1321: a SIGTERM/SIGKILL'd container writes "exited 143/137" as a
          // failure. Read back after a transport loss (R2_PREFIX present), the
          // platform kill is infra, never a red test. A live 200 with the same
          // text stays a real failure (OOM kill / `timeout -s KILL`), never
          // converted here.
          if (stored.state === "failure" && stored.description.startsWith(R2_PREFIX) && isSignalKill(stored.description)) {
            return { leg: planned.leg, ms: now() - started, state: "error", description: stored.description };
          }
          return { leg: planned.leg, ms: now() - started, ...stored };
        }
        // A thrown attempt still counts: its wall time rides in the message, so
        // a failed leg's description shows real time (ms skips thrown attempts).
        // Our own deadline's abort reads as the deadline message, whatever the
        // runtime's abort wording is (#1135).
        const message = signal.aborted
          ? `${planned.leg}: no progress past its deadline`
          : err instanceof Error ? err.message : String(err);
        const minutes = Math.round((now() - started) / 60_000);
        causes.push(`${message.slice(0, MAX_INFRA_CAUSE_CHARS)} after ${minutes} min`);
        throw new Error(combineCauses(causes));
      }
    });
  };

  const first = await attempt(`start-${planned.leg}`, (tryNo) => tryNo === 1
    ? planned
    : { ...planned, resultKey: infraRetryResultKey(planned.resultKey, tryNo) },
  ).catch(async (err: unknown): Promise<LegRunResult> => {
    // #1395: before failing the leg, read its stored results. A container that
    // wrote its result to R2 before the Workflows invocation was cut means the
    // leg already finished — return that result, never restart from zero.
    const recovered = await recoverLegResult(
      step, `recover-start-${planned.leg}`, deps.readResult, planned.leg, planned.resultKey, "start");
    if (recovered !== undefined) return recovered;
    // Retries spent (infra). The thrown message already carries the cause.
    const message = err instanceof Error ? err.message : String(err);
    return { leg: planned.leg, state: "error", description: message.slice(0, MAX_DESCRIPTION_CHARS) };
  });

  // A red test is data, but it may be a flake: run it once more on a fresh
  // container. An "install failed" (#1092) or "clone failed" (#1104) error is a flake too.
  // Other errors stay final.
  if (!isRetryable(first)) return first;

  // The retry writes its own log: the first attempt's shard-<leg>.json stays as evidence.
  // #1398: the retry step's OWN internal infra-retries get unique keys too
  // (review r2 item 2) -- the SAME scheme the start step's targetFor already
  // uses, composed on top of retryResultKey instead of the bare planned.resultKey.
  const retryBase = { ...planned, resultKey: retryResultKey(planned.resultKey) };
  const retry = await attempt(`retry-${planned.leg}`, (tryNo) => tryNo === 1
    ? retryBase
    : { ...retryBase, resultKey: infraRetryResultKey(retryBase.resultKey, tryNo) },
  ).catch(async (err: unknown): Promise<LegRunResult> => {
    // #1395: the retry phase recovers only its own `.retry*` keys, under a
    // distinct step name (a start-phase recovery step must never be replayed as
    // this phase's read).
    const recovered = await recoverLegResult(
      step, `recover-retry-${planned.leg}`, deps.readResult, planned.leg, planned.resultKey, "retry");
    if (recovered !== undefined) return recovered;
    const message = err instanceof Error ? err.message : String(err);
    return { leg: planned.leg, state: "error", description: message.slice(0, MAX_DESCRIPTION_CHARS) };
  });

  // Wall time covers both attempts.
  const ms = sumMs(first.ms, retry.ms);
  const firstCause = (first.description ?? "failure").slice(0, MAX_FIRST_DESCRIPTION_CHARS);
  if (retry.state === "success") {
    return {
      leg: planned.leg, state: "success", description: `flaky: passed on retry; first: ${firstCause}`, ms, summary: retry.summary,
    };
  }
  // A red first try stays a real failure for the infra rerun, even if its retry lost the connection (#1119).
  if (first.state === "failure") return { ...retry, ms, redFirst: true };
  // An install retry that did not pass: its final description notes the first cause (#1092).
  const retryCause = retry.description ?? retry.state;
  return {
    ...retry, ms, description: `${retryCause}; first: ${firstCause}`.slice(0, MAX_DESCRIPTION_CHARS),
  };
}

/** A first result that earns the one retry: a red test (state failure), an
 *  "install failed" error (#1092), a dropped tarball fetch that a fresh container clears,
 *  or a "clone failed" error (#1104), a git stream garbled through the outbound proxy. */
export function isRetryable(first: LegRunResult): boolean {
  if (first.state === "failure") return true;
  if (first.state !== "error") return false;
  const description = first.description ?? "";
  // Strip the R2 read-back prefix so a result recovered after transport loss
  // matches on its underlying cause (#1126).
  const stripped = description.startsWith(R2_PREFIX) ? description.slice(R2_PREFIX.length) : description;
  return stripped.startsWith("install failed") || stripped.startsWith("clone failed:");
}

/** #1398: the slice of Workflows' WorkflowStep the async/polling path needs
 *  -- do(), generic (Task 1), plus sleep(), which real Workflows exposes as
 *  step.sleep(name, duration) and which does NOT count toward the instance's
 *  step budget (spec "Cost"). */
export interface PollingLegStepRunner {
  do<T>(name: string, config: LegStepConfig, fn: (ctx?: LegStepContext) => Promise<T>): Promise<T>;
  sleep(name: string, durationSeconds: number): Promise<void>;
}

/** #1398: a dispatch call's own outcome -- a TERMINAL LegResult reached
 *  before any container ever started (DID-NOT-RUN, PAT-only refusal, spec
 *  "Secrets across alarm ticks"), or an ACCEPTED container start, carrying
 *  the governing-invariant-safe values (startedAt minted inside the
 *  dispatch step itself) later poll steps need. */
export type DispatchOutcome =
  | { kind: "terminal"; result: LegRunResult }
  | { kind: "accepted"; resultKey: string; startedAt: number };

const POLL_INTERVAL_SECONDS_DEFAULT = 60;

/** #1398 review r1 item 2: the explicit try-loop's own cap -- the SAME count
 *  runLegStep reaches through LEG_STEP_CONFIG.retries (limit 2 = 3 total
 *  attempts: 1 initial + 2 infra retries). Without this, a fast-infra leg
 *  ('gate capacity') re-dispatched forever, each try bounded only by its own
 *  per-try deadline, cycling ~35 min past the total budget. */
const MAX_TRIES_PER_PHASE = LEG_STEP_CONFIG.retries.limit + 1;

/** #1398: ONE try's own dispatch + poll loop. Returns the container-authored
 *  (or DO-written infra) LegResult once found, or the Workflow's own
 *  give-up result once this try's own deadline elapses with nothing in R2.
 *  Every governing-invariant-sensitive value (attemptId, each deadline
 *  check) is minted/computed strictly INSIDE its own step.do callback --
 *  this function's own surrounding `for` loop only ever reads already-
 *  resolved step results (plan review r1 BLOCKER 1). */
async function dispatchAndPollOnce(
  step: PollingLegStepRunner,
  dispatch: (planned: PlannedLeg, attemptId: string) => Promise<DispatchOutcome>,
  target: PlannedLeg,
  stepName: string,
  attemptDeadlineMs: number,
  deps: {
    bucket: ClaimableBucket;
    now: () => number;
    pollIntervalSeconds: number;
    readResult: (key: string) => Promise<StoredLegResult | undefined>;
    touch?: () => Promise<void>;
    sleep: (ms: number) => Promise<void>;
    random: () => number;
    /** #1398 review r1 item 4: the retry-phase dispatch-start jitter (#1321),
     *  already applied at the call site (0 for the start phase and for
     *  tryNo > 1); this just waits it out inside the dispatch callback. */
    jitterMs: number;
  },
): Promise<LegRunResult> {
  // #1398 plan review r2 item 3: minted in its OWN step, BEFORE the dispatch
  // step. A Workflows-level AUTOMATIC step-retry (the dispatch step's own
  // callback THROWING, LEG_STEP_CONFIG.retries kicking in) genuinely
  // RE-INVOKES that callback -- unlike a deploy-triggered REPLAY, which
  // never re-runs an already-succeeded step's callback at all. If attemptId
  // were minted INSIDE the dispatch step (as an earlier draft had it), each
  // automatic retry would mint a DIFFERENT id, so retry 2 would target a
  // BRAND-NEW, empty DO -- never the one retry 1 already started a container
  // on -- and Task 8's own idempotency guard (an already-populated
  // alarmState) could never fire, because there would never BE one. Minting
  // it here, in a step that (once it succeeds once, which a bare
  // crypto.randomUUID() call always does) is simply REPLAYED like any other
  // already-resolved step, means every retry of the dispatch step reads the
  // SAME id.
  const attemptId = await step.do(`${stepName}-attempt-id`, LEG_STEP_CONFIG, async () => crypto.randomUUID());
  let dispatched: DispatchOutcome;
  try {
    dispatched = await step.do(stepName, LEG_STEP_CONFIG, async () => {
      // #1398 plan review r2 item 2: touch() ALSO fires here (every NEW
      // dispatch, i.e. every try, not gated to tryNo===1 anymore -- see the
      // poll step below for why tryNo-gating alone was wrong).
      await deps.touch?.();
      // #1398 review r1 item 4: the retry-phase jitter desyncs red legs'
      // dispatches so they do not clone in lockstep and burst the shared
      // GitHub token with 429s (#1321). Waited INSIDE the dispatch callback
      // so a Workflows replay returns the recorded result, never re-waits.
      if (deps.jitterMs > 0) {
        await deps.sleep(Math.floor(deps.random() * deps.jitterMs));
      }
      return dispatch(target, attemptId);
    });
  } catch (err) {
    // #1398 plan review r1 BLOCKER 3 (the other half -- workflow.ts's own
    // dispatch closure THROWS on a non-2xx; this is where that throw must
    // land once the step's own LEG_STEP_CONFIG.retries are exhausted, never
    // an unhandled rejection out of runLegStepPolling entirely). Same shape
    // runLegStep's own catch block already returns for this case.
    const message = err instanceof Error ? err.message : String(err);
    return { leg: target.leg, state: "error", description: message.slice(0, MAX_INFRA_CAUSE_CHARS) };
  }
  if (dispatched.kind === "terminal") return dispatched.result;
  for (let i = 1; ; i++) {
    await step.sleep(`${stepName}-sleep-${i}`, deps.pollIntervalSeconds);
    // #1398 review r1 item 3: the past-deadline check rides INSIDE this same
    // poll step, not a separate budget step per tick -- a 25-min leg polling
    // every 60s already costs ~25 poll steps; a second budget step per tick
    // would double that toward the 10,000-step paid plan. Both the read and
    // the elapsed check now compute their wall-clock values strictly inside
    // this ONE callback (governing invariant), so folding them is safe.
    const tick = await step.do(`${stepName}-poll-${i}`, LEG_STEP_CONFIG, async () => {
      // #1398 plan review r2 item 2: touch() fires on EVERY poll tick, not
      // just the dispatch step -- a leg whose first two tries each spend
      // their own ~25-30 min polling before failing infra would otherwise go
      // ~50-60 min between progress stamps (only stamped at each NEW try's
      // dispatch), past GATE_STALL_MS (37 min) -- a FALSE stall on a run
      // that is, in fact, still actively polling every 60s the whole time.
      await deps.touch?.();
      // #1398 review r1 item 1: the raw R2 read can hang (a stuck get) or
      // throw (R2 down). withStepDeadline bounds the hang; a throw becomes a
      // read-failed signal below -- NEVER a rejection out of this callback,
      // so runLegStepPolling keeps runLegStep's never-throws contract.
      let found: StoredLegResult | undefined;
      let readError: string | undefined;
      try {
        found = await withStepDeadline(
          deps.readResult(dispatched.resultKey), R2_READ_TIMEOUT_MS, "result read timed out",
        );
      } catch (err) {
        readError = err instanceof Error ? err.message : String(err);
      }
      if (readError !== undefined) {
        return { kind: "read-failed" as const, description: `gate result read failed: ${readError.slice(0, MAX_INFRA_CAUSE_CHARS)}` };
      }
      // #1398 review r2 item 1: the RAW reader, never storedLegResult --
      // a container-authored record (including its own live "exited
      // 143/137") is trusted exactly as-is, summary intact, never reclassified.
      // #1398 plan review r2 "ms outside step" note: ms is computed HERE,
      // strictly inside this callback (deps.now() read live, dispatched.startedAt
      // read from an already-resolved step) -- never after this step.do call
      // resolves, so a replay never recomputes it from a fresh, wrong clock read.
      if (found !== undefined) {
        // #1398 review r1 item 6 nit: cap the container-authored description
        // to MAX_DESCRIPTION_CHARS -- a raw R2 body must never let 32K of
        // stdout ride into a 1 MiB step result (the container already caps
        // its own write, but the poll read is the Workflow's own read-back,
        // so it caps again rather than trust the container).
        const capped: StoredLegResult = found.description === undefined
          ? found
          : { ...found, description: found.description.slice(0, MAX_DESCRIPTION_CHARS) };
        return { kind: "found" as const, result: capped, ms: deps.now() - dispatched.startedAt };
      }
      return { kind: "not-yet" as const, pastDeadline: deps.now() - dispatched.startedAt >= attemptDeadlineMs };
    });
    if (tick.kind === "found") return { leg: target.leg, ...tick.result, ms: tick.ms };
    if (tick.kind === "read-failed") return { leg: target.leg, state: "error", description: tick.description };
    if (tick.pastDeadline) {
      // #1398 plan review r1 BLOCKER 2: R2_PREFIX-marked, same convention
      // every DO-authored write uses -- this is the Workflow's OWN guess,
      // and claimOrReadBack ensures a real, later-arriving result still wins.
      // ms computed inside this SAME callback, same reasoning as the poll tick above.
      // #1398 review r1 item 1: the write can hang or throw too (R2 down) --
      // bounded and caught, never a rejection out of runLegStepPolling.
      const claimed = await step.do(`${stepName}-giveup`, LEG_STEP_CONFIG, async () => {
        let result: StoredLegResult;
        try {
          result = await withStepDeadline(
            claimOrReadBack(deps.bucket, dispatched.resultKey, {
              state: "error", description: `${R2_PREFIX}${target.leg}: no progress past its deadline`,
            }),
            R2_READ_TIMEOUT_MS,
            "result write timed out",
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = { state: "error", description: `gate result write failed: ${message.slice(0, MAX_INFRA_CAUSE_CHARS)}` };
        }
        return { leg: target.leg, ...result, ms: deps.now() - dispatched.startedAt };
      });
      return claimed;
    }
  }
}

/**
 * #1398 (spec "New architecture" / "Retries"): the explicit try-loop that
 * replaces Workflows' own automatic step-retry (runLegStep's `ctx.attempt`
 * usage) with real application code -- dispatch is now a SHORT step that
 * only throws for a synchronous protocol failure; everything after the
 * container starts is a terminal R2 outcome this loop discovers by polling,
 * never a thrown exception. Coexists with runLegStep: nothing calls this
 * yet (a later task wires it in behind the per-instance mode pin).
 */
export async function runLegStepPolling(
  step: PollingLegStepRunner,
  dispatch: (planned: PlannedLeg, attemptId: string) => Promise<DispatchOutcome>,
  planned: PlannedLeg,
  deps: LegRunDeps & { bucket: ClaimableBucket; pollIntervalSeconds?: number },
): Promise<LegRunResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  // #1398 review r1 item 4: the retry-phase jitter cap (#1321), applied only
  // to the retry phase's FIRST try's dispatch -- same shape runLegStep's own
  // jitter already uses (name.startsWith("retry-") && tryNo === 1).
  const retryJitterMs = deps.retryJitterMs ?? 0;
  // #1398 plan review r1 BLOCKER 2: the per-attempt deadline this loop uses
  // is asyncAttemptDeadlineMs (run-leg-alarm.ts), NOT the sync path's own
  // legStepDeadlineMs -- it must stay strictly longer than the DO's own
  // worst-case total time, or the Workflow's give-up write could race a
  // still-legitimately-working DO under normal operation, not just a true fault.
  const attemptDeadlineMs = deps.stepDeadlineMs ?? asyncAttemptDeadlineMs(planned.timeoutMin);
  const totalDeadlineMs = deps.totalDeadlineMs ?? totalLegWallMs(planned.timeoutMin);
  const pollIntervalSeconds = deps.pollIntervalSeconds ?? POLL_INTERVAL_SECONDS_DEFAULT;
  // #1398 review r2 item 1: the normal read is the RAW reader (never
  // storedLegResult), so a container-authored record is trusted as-is; the
  // bucket IS the source (deps.readResult only overrides it for tests that
  // need a reader with side effects).
  const readResult = deps.readResult ?? legResultReader(deps.bucket);
  const legStarted = await step.do(`leg-started-${planned.leg}`, LEG_STEP_CONFIG, async () => now());

  const runPhase = async (phaseName: "start" | "retry", targetFor: (tryNo: number) => PlannedLeg): Promise<LegRunResult> => {
    const causes: string[] = [];
    for (let tryNo = 1; tryNo <= MAX_TRIES_PER_PHASE; tryNo++) {
      // #1398 plan review r1 BLOCKER 1: the TOTAL-deadline check is its own
      // step too -- tryNo itself is a safe, replay-stable loop counter (not
      // a wall-clock value), but the now()-vs-totalDeadlineMs comparison is not.
      // The step returns the ELAPSED time (not just a boolean) so the try's
      // own deadline cap below reads a step-returned value, never a second
      // bare now() in the surrounding loop (governing invariant).
      const elapsed = await step.do(`total-budget-${planned.leg}-try${tryNo}`, LEG_STEP_CONFIG, async () =>
        now() - legStarted);
      if (elapsed >= totalDeadlineMs) {
        return {
          leg: planned.leg, state: "error",
          description: causes.length > 0 ? combineCauses(causes) : `${planned.leg} exceeded ${legTimeoutMin(planned.timeoutMin)} min without a result`,
        };
      }
      const target = targetFor(tryNo);
      // #1398 Leftovers item 6: phase-qualified step names -- dispatch-start-
      // and dispatch-retry- never collide on the same tryNo.
      // #1398 plan review r2 item 2: touch is passed for EVERY tryNo now,
      // not gated to tryNo===1 -- dispatchAndPollOnce itself calls it on
      // every dispatch AND every poll tick, so progress is stamped
      // throughout a long multi-try leg, never just once at the very start.
      // #1398 review r1 item 2: this try's own attempt deadline is capped by
      // the REMAINING total budget (min(attemptDeadlineMs, total - elapsed)),
      // exactly runLegStep's own Math.min(deadlineMs, totalDeadlineMs - elapsed)
      // -- so a try that starts late can never hold the whole leg past its cap.
      const remainingTotalMs = totalDeadlineMs - elapsed;
      const tryDeadlineMs = Math.max(0, Math.min(attemptDeadlineMs, remainingTotalMs));
      const jitterMs = phaseName === "retry" && tryNo === 1 ? retryJitterMs : 0;
      const result = await dispatchAndPollOnce(
        step, dispatch, target, `dispatch-${phaseName}-${planned.leg}-try${tryNo}`, tryDeadlineMs,
        { bucket: deps.bucket, now, pollIntervalSeconds, readResult, touch: deps.touch, sleep, random, jitterMs },
      );
      const isInfra = result.state === "error" && isLegInfraDescription(result.description);
      if (!isInfra) return result;
      causes.push(result.description ?? "infra");
    }
    // All MAX_TRIES_PER_PHASE tries were infra and the total deadline never
    // tripped: end with the combined causes, never an unbounded loop.
    return {
      leg: planned.leg, state: "error",
      description: combineCauses(causes),
    };
  };

  const first = await runPhase("start", (tryNo) => tryNo === 1 ? planned : { ...planned, resultKey: infraRetryResultKey(planned.resultKey, tryNo) });
  if (!isRetryable({ ...first, leg: planned.leg })) return { ...first, leg: planned.leg };

  const retryBase = { ...planned, resultKey: retryResultKey(planned.resultKey) };
  const retry = await runPhase("retry", (tryNo) => tryNo === 1 ? retryBase : { ...retryBase, resultKey: infraRetryResultKey(retryBase.resultKey, tryNo) });

  const ms = sumMs(first.ms, retry.ms);
  const firstCause = (first.description ?? "failure").slice(0, MAX_FIRST_DESCRIPTION_CHARS);
  if (retry.state === "success") {
    return { leg: planned.leg, state: "success", description: `flaky: passed on retry; first: ${firstCause}`, ms, summary: retry.summary };
  }
  if (first.state === "failure") return { ...retry, leg: planned.leg, ms, redFirst: true };
  const retryCause = retry.description ?? retry.state;
  return { ...retry, leg: planned.leg, ms, description: `${retryCause}; first: ${firstCause}`.slice(0, MAX_DESCRIPTION_CHARS) };
}

/** #1398: the infra-cause check this loop's own try-decision needs --
 *  SEPARATE from isInfraLegFailure (infra-rerun.ts), which ALSO excludes a
 *  redFirst result; this loop decides "retry this ONE phase's attempt,"
 *  infra-rerun.ts later decides "auto-rerun the WHOLE run." Reuses the SAME
 *  INFRA_CAUSE taxonomy (isInfraCause) rather than a hand-rolled regex, so
 *  the two can never drift apart: 'clone failed ... HTTP 500' is NOT infra
 *  here (its one isRetryable retry handles it), while a caught dispatch
 *  error like 'Network connection lost' IS (review r1 item 5). Exported for
 *  the engine tests (Task 12) to exercise directly.
 */
export function isLegInfraDescription(description: string | undefined): boolean {
  if (description === undefined) return false;
  return isInfraCause(description);
}

/** The minimal R2 bucket shape the reader needs: the real R2Bucket satisfies it. */
export interface ResultBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/** #1398: the minimal R2-like shape claimOrReadBack needs -- the real
 *  R2Bucket satisfies it (put returns R2Object | null; get returns
 *  R2ObjectBody | null, both narrowed to their .json() half here, same as
 *  ResultBucket above). */
export interface ClaimableBucket {
  put(key: string, value: string, opts: { onlyIf: { etagDoesNotMatch: "*" } }): Promise<unknown | null>;
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/**
 * #1398 (spec "Who writes what" / "Deadline (#1390) and the write-once
 * race"): attempts a write-once PUT of `value`; if it wins (nothing else
 * exists at `key`), returns `value` unchanged. If it loses (a conflict --
 * `put` resolves null under the real R2 `onlyIf` contract, same as
 * outbound-handler.ts's own `putBundle`), reads `key` back and returns
 * WHATEVER IS ACTUALLY THERE -- never the caller's own guessed value. Both
 * the DO's own "I couldn't reach the container" guess and the Workflow's
 * own give-up-after-its-deadline write use this SAME function: neither one
 * ever assumes its own conclusion is correct once a conflict proves
 * something else already claimed the key.
 */
export async function claimOrReadBack(
  bucket: ClaimableBucket, key: string, value: StoredLegResult,
): Promise<StoredLegResult> {
  const stored = await bucket.put(key, JSON.stringify(value), { onlyIf: { etagDoesNotMatch: "*" } });
  if (stored !== null) return value;
  const existing = await bucket.get(key);
  if (existing === null) return value; // the winner's write vanished (extremely unlikely); fall back to our own guess
  const body = await existing.json() as Partial<StoredLegResult> | null;
  return body !== null && typeof body === "object" && typeof body.state === "string"
    ? (body as StoredLegResult)
    : value;
}

/** The states the container writes to R2. A body with any other state is not a leg result. */
const STORED_STATES: ReadonlySet<string> = new Set(["success", "failure", "error"]);

/** Reads a leg's R2 result by key. Absent, or a body with no known state, is
 *  undefined. Pure over the bucket it is given, so the test supplies a fake. */
export function legResultReader(bucket: ResultBucket): (resultKey: string) => Promise<StoredLegResult | undefined> {
  return async (resultKey) => {
    const obj = await bucket.get(resultKey);
    if (obj === null) return undefined;
    const body = (await obj.json()) as Partial<StoredLegResult> | null;
    return body !== null && typeof body === "object" && typeof body.state === "string" && STORED_STATES.has(body.state)
      ? body as StoredLegResult
      : undefined;
  };
}

/** The leg's R2 result after a transport loss (#1122): its state and a description
 *  that names where it came from. Only the state and description are read, never
 *  stderr. Undefined when there is no reader, no known state, or the read throws. */
export async function storedLegResult(
  read: LegRunDeps["readResult"], resultKey: string, timeoutMs = R2_READ_TIMEOUT_MS,
): Promise<StoredLegResult & { description: string } | undefined> {
  if (read === undefined) return undefined;
  try {
    const stored = await withStepDeadline(read(resultKey), timeoutMs, "result read timed out");
    if (stored === undefined) return undefined;
    const text = stored.description ?? stored.state;
    return {
      state: stored.state,
      description: `${R2_PREFIX}${text}`.slice(0, MAX_DESCRIPTION_CHARS),
    };
  } catch {
    return undefined;
  }
}

/** The retry's R2 key: the leg's own key with ".retry" before ".json", so the
 *  container still PUTs only under its leg's resultKey. */
export function retryResultKey(resultKey: string): string {
  return resultKey.replace(/\.json$/, ".retry.json");
}

/** The start step's infra-retry key for one try number: its own, so an
 *  earlier try that wrote its result before its transport died is never read
 *  back as a later try's (#1231: tries 2 and 3 must not share try 2's key).
 *  Dashes, not dots: the container may only PUT `shard-<leg>[-…].json`
 *  (outbound-handler.ts). */
export function infraRetryResultKey(resultKey: string, tryNo: number): string {
  return resultKey.replace(/\.json$/, `-try${tryNo}.json`);
}

/** The candidate result keys one recovery phase may read, newest first (#1395).
 *  `phase` splits the set by who could have written it THIS run, so a stale
 *  value from an earlier instance (same run id, R2 keys never expire) can never
 *  read back as this run's result:
 *   - "start": the first attempt's base key and its own `-tryN` infra retries
 *     (newest `-tryN` first, then base). A `.retry*` key cannot exist until a
 *     red first attempt has been seen, so the start phase never reads it.
 *   - "retry": the bare `.retry` and its own `.retry-tryN` internal infra
 *     retries (newest first), never the base/`-tryN` start-phase keys. */
export function recoverCandidateKeys(baseResultKey: string, phase: "start" | "retry"): string[] {
  const maxTryNo = LEG_STEP_CONFIG.retries.limit + 1;
  const keys: string[] = [];
  if (phase === "retry") {
    const retryBase = retryResultKey(baseResultKey);
    for (let tryNo = maxTryNo; tryNo >= 2; tryNo--) keys.push(infraRetryResultKey(retryBase, tryNo));
    keys.push(retryBase);
    return keys;
  }
  for (let tryNo = maxTryNo; tryNo >= 2; tryNo--) keys.push(infraRetryResultKey(baseResultKey, tryNo));
  keys.push(baseResultKey);
  return keys;
}

/** #1395: reads one leg's stored results newest-first, skipping kill results.
 *  A container that wrote its result to R2 before the Workflows invocation was
 *  cut is the leg's real result, so a leg whose step died as WorkflowInternalError
 *  never restarts from zero when that result exists. A SIGTERM/SIGKILL result
 *  (`exited 143/137`) is a platform kill, not the code under test: it is
 *  skipped in favour of an older real result; only when every candidate is a
 *  kill (or absent) is a kill returned, to be read back as infra. Undefined
 *  when no candidate key holds a known state. */
async function recoverStoredLegResult(
  read: LegRunDeps["readResult"], resultKey: string, phase: "start" | "retry",
): Promise<StoredLegResult & { description: string } | undefined> {
  let kill: (StoredLegResult & { description: string }) | undefined;
  for (const key of recoverCandidateKeys(resultKey, phase)) {
    const stored = await storedLegResult(read, key);
    if (stored === undefined) continue;
    if (stored.state === "failure" && isSignalKill(stored.description)) {
      kill ??= stored; // remember the newest kill, keep looking for a real result
      continue;
    }
    return stored;
  }
  return kill;
}

/** #1395: the recovery step a start/retry step runs once its infra retries are
 *  spent: read the leg's stored results and, if one exists, make it the leg's
 *  result instead of the infra error. A platform SIGTERM/SIGKILL (exited
 *  143/137) read back from R2 is infra, never a red test (#1321). `name` is a
 *  distinct step per phase (`recover-start-<leg>` / `recover-retry-<leg>`), so
 *  a leg named `retry-<x>` can never collide with another leg's recovery step
 *  (leg names allow `[a-z0-9-]`). */
async function recoverLegResult(
  step: LegStepRunner, name: string, read: LegRunDeps["readResult"], leg: string,
  resultKey: string, phase: "start" | "retry",
): Promise<LegRunResult | undefined> {
  const stored = await step.do(name, LEG_STEP_CONFIG, async () =>
    recoverStoredLegResult(read, resultKey, phase));
  if (stored === undefined) return undefined;
  if (stored.state === "failure" && isSignalKill(stored.description)) {
    return { leg, state: "error", description: stored.description };
  }
  return { leg, ...stored };
}

/** The sum of the attempts that were timed; undefined when none was. */
function sumMs(...parts: (number | undefined)[]): number | undefined {
  const timed = parts.filter((p): p is number => p !== undefined);
  return timed.length > 0 ? timed.reduce((a, b) => a + b, 0) : undefined;
}

/** The /run-leg request body for one planned leg of one PR. Pure, so the
 *  private flag and the PR's own owner/repo reach the DO by a tested path. */
export function legRequest(
  owner: string, repo: string, planned: PlannedLeg,
  pr: {
    baseRef: string; pr: string; private: boolean; image?: string; bundleKey?: string; mergeBase?: string;
    /** #1346 security review r1: already-computed trust (sameRepo AND a
     *  trusted collaborator AND a human AND the PR's base is the repo's
     *  actual default branch -- secrets-scope.ts's trustedForSecrets).
     *  Absent is treated as false -- fail closed. */
    trusted?: boolean;
    /** #1346: the OPS repo's gate-secrets.json, already parsed. Absent grants
     *  nothing, same as an allowlist with no entry for this repo. */
    secretsAllowlist?: GateSecretsAllowlist;
  },
): GateLegRequest {
  // #1346: the ONLY place a secret grant is decided for this leg. Every
  // guard (trust, repo, leg, registry) lives in grantedSecretNames itself.
  const secretNames = pr.secretsAllowlist === undefined
    ? []
    : grantedSecretNames(pr.secretsAllowlist, `${owner}/${repo}`, planned.leg, pr.trusted === true);
  return {
    owner, repo, commit: planned.commit, leg: planned.leg,
    installCmd: planned.installCmd, legCmd: planned.legCmd,
    resultKey: planned.resultKey, baselineKeys: planned.baselineKeys,
    private: pr.private, baseRef: pr.baseRef, pr: pr.pr,
    ...(planned.timeoutMin === undefined ? {} : { timeoutMin: planned.timeoutMin }),
    ...(pr.image === undefined ? {} : { image: pr.image }),
    ...(pr.bundleKey === undefined ? {} : { bundleKey: pr.bundleKey }),
    ...(pr.mergeBase === undefined ? {} : { mergeBase: pr.mergeBase }),
    ...(planned.browser === true ? { browser: true } : {}),
    ...(secretNames.length === 0 ? {} : { secretNames }),
  };
}

/** The inputs trustedForSecrets itself needs, read off the Workflow's own
 *  resolve-pr step result. Named separately from LegRequestContext so a
 *  caller (workflow.ts) can compute `trusted` once, outside any leg loop,
 *  from fields it already has. */
export interface TrustContextInput {
  baseRef: string;
  sameRepo: boolean;
  authorAssociation: string;
  authorIsBot: boolean;
  authorLogin: string;
  defaultBranch: string;
  /** #1380 security review r1 MED: fleet-wide OPS boolean opt-in. false = off. */
  trustOwnApp: boolean;
  /** #1380 security review r1 MED: this Worker's own App slug, from `GET
   *  /app` -- see secrets-scope.ts's SecretsTrustInput for the full contract. */
  ownAppSlug?: string;
}

/** legRequest's own `pr` parameter shape, minus the per-leg `image` override
 *  (runLeg, below, applies that itself from each PlannedLeg). */
export interface LegRequestContext {
  baseRef: string; pr: string; private: boolean; bundleKey?: string; mergeBase?: string;
  trusted: boolean; secretsAllowlist: GateSecretsAllowlist;
}

/**
 * #1346 correctness review r1 item 1: workflow.ts imports `cloudflare:workers`
 * at module scope, so bun test can never load it to exercise its own glue
 * code directly -- which is exactly how "drop the sameRepo/trusted
 * pass-through" could survive every existing test. Pulling the trust
 * computation AND the legRequest-context construction out here, into a file
 * bun test CAN load, closes that gap: workflow.ts's own two call sites now do
 * nothing but call this function and spread its result, leaving as little
 * logic in the untested glue as possible.
 */
export function legRequestContext(
  trust: TrustContextInput, priv: boolean, secretsAllowlist: GateSecretsAllowlist,
  extra: { pr: string; bundleKey?: string; mergeBase?: string },
): LegRequestContext {
  const trusted = trustedForSecrets(trust);
  return {
    baseRef: trust.baseRef, pr: extra.pr, private: priv, trusted, secretsAllowlist,
    ...(extra.bundleKey === undefined ? {} : { bundleKey: extra.bundleKey }),
    ...(extra.mergeBase === undefined ? {} : { mergeBase: extra.mergeBase }),
  };
}

/** The bundle step's config: two infra retries, like a leg step. A 503 (infra:
 *  unreachable, a cold host, container failed to start) is retried on a fresh
 *  attempt; a 200 with a non-success state is data and is never retried (the
 *  legs clone). A hung bundle leg is still bounded by its own 5-min timeout. */
const BUNDLE_STEP_CONFIG: LegStepConfig = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "30 minutes",
};

/** The bundle dispatch's per-attempt deadline (#1313 review). The bundle leg's
 *  own timeout is 5 min (BUNDLE_LEG_TIMEOUT_MIN); add the container start wait
 *  (180 s) plus a margin, so a hung DO call ends well under the 30-min step
 *  timeout. Three such attempts (2 retries) plus their 15 s backoff stay far
 *  under the 35-min watchdog stall, unlike three 30-min step timeouts. */
const BUNDLE_ATTEMPT_DEADLINE_MS = 9 * 60_000;

/** The slice of Workflows' WorkflowStep the bundle step uses. The step's return
 *  value is the built/not-built boolean, so a Workflow replay returns the
 *  recorded verdict instead of recomputing it. */
export interface BundleStepRunner {
  do(name: string, config: LegStepConfig, fn: () => Promise<boolean>): Promise<boolean>;
}

/** #1080: the bundle step needs two switches, both off by default. The fleet
 *  flag (GATE_BUNDLE="1") is the kill switch: until the gate image that understands
 *  the bundle leg is live, an old image would run it as a normal clone-and-checkout
 *  leg. The repo's own `bundle: true` opts that repo in. Either one off, every leg clones. */
export function bundleStepEnabled(fleetFlag: string | undefined, repoOptIn: boolean | undefined): boolean {
  return fleetFlag === "1" && repoOptIn === true;
}

/** #1080: the one bundle step before the legs. True only when the bundle leg
 *  answered 200 with state success (the DO answers 200 for a leg error too). A
 *  503 (infra) is retried by the step config (#1313); any other failure is
 *  final, and the step never throws: a run whose bundle did not build clones in
 *  each leg, as before. */
export async function runBundleStep(
  step: BundleStepRunner,
  dispatch: (planned: PlannedLeg, signal: AbortSignal) => Promise<Response>,
  planned: PlannedLeg,
  attemptDeadlineMs: number = BUNDLE_ATTEMPT_DEADLINE_MS,
): Promise<boolean> {
  return step.do("build-bundle", BUNDLE_STEP_CONFIG, async () => {
    // A hung DO call is aborted at the per-attempt deadline, so it cannot hold
    // the step (and the run) open past the watchdog's stall window (#1313).
    const signal = AbortSignal.timeout(attemptDeadlineMs);
    const res = await withStepDeadline(
      dispatch(planned, signal), attemptDeadlineMs, "bundle leg: no progress past its deadline",
    );
    // A non-2xx (infra, 503) throws, so the step's retries re-run it on a fresh
    // attempt (#1313). A 200 with a non-success state is data: return false, so
    // the legs clone and the step never retries a genuine leg error.
    if (!res.ok) throw new Error(`bundle leg: HTTP ${res.status}`);
    const body = await res.json() as { state?: unknown };
    return body.state === "success";
    // Retries exhausted on infra still never fail the run: false, the legs clone.
  }).catch(() => false);
}
