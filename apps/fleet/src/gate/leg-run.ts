// #715: the one-leg step GateWorkflow runs. Pure: no Workflow/DO bindings, so
// bun test can load it. workflow.ts passes in the real step and dispatcher.
//
// The GateRunnerDO answers /run-leg synchronously with the leg's LegResult.
// That return value is the step result. A red test is data (state "failure"),
// never a throw. Any non-2xx is infra: the step throws, Workflows retries it
// once, and a second failure becomes this leg's "error".
import type { GateLegRequest } from "./leg-env";
import { normalizeLegResult, type LegRunMeta, type PlannedLeg } from "./fanout";
import { legTimeoutMin } from "./config";
import type { LegResult } from "./verdict";

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

/** The one step config a leg uses. Literal types, so the object is assignable
 *  to Workflows' WorkflowStepConfig without importing cloudflare:workers here
 *  (the check tsconfigs for test/ cannot resolve that module). */
export interface LegStepConfig {
  retries: { limit: number; delay: "15 seconds"; backoff: "constant" };
  timeout: "30 minutes";
}

/** The slice of Workflows' WorkflowStep this module uses. */
export interface LegStepRunner {
  do(name: string, config: LegStepConfig, fn: () => Promise<LegRunResult>): Promise<LegRunResult>;
}

export const LEG_STEP_CONFIG: LegStepConfig = {
  retries: { limit: 1, delay: "15 seconds", backoff: "constant" },
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
}

/** Slack past the leg's own timeout before its step gives up on a dispatch that
 *  never answered: covers the DO's readiness wait (180 s) and port-retry budget (240 s). */
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

/** Ends a step whose work has no progress past its deadline (#1119): the work is
 *  abandoned and the step rejects, so no orphan step holds the run open. */
export function withStepDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** A leg's result as the container wrote it to R2: state and description, no leg name. */
export type StoredLegResult = { state: LegResult["state"]; description?: string };

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
  // result key (see infraRetryResultKey).
  const deadlineMs = deps.stepDeadlineMs ?? legStepDeadlineMs(planned.timeoutMin);
  const attempt = (name: string, targetFor: (tryNo: number) => PlannedLeg): Promise<LegRunResult> => {
    let tryNo = 0;
    return step.do(name, LEG_STEP_CONFIG, async () => {
      const target = targetFor(++tryNo);
      // Made inside the callback: a Workflows step retry re-runs it, so every
      // try gets its own runner DO. A replayed step returns its recorded result.
      const attemptId = crypto.randomUUID();
      // Timed inside the callback: a Workflow replay returns the recorded ms
      // instead of timing the replay.
      const started = Date.now();
      // The dispatch call carries its own signal, so a hung DO call is aborted
      // at the deadline, not just abandoned by the race below (#1135).
      const signal = AbortSignal.timeout(deadlineMs);
      try {
        const res = await withStepDeadline(
          dispatch(target, attemptId, signal), deadlineMs, `${planned.leg}: no progress past its deadline`,
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
          ms: Date.now() - started,
        };
      } catch (err) {
        // The container may have written its own result before the transport
        // died. A known state there IS the leg's result (#1122), state included.
        const stored = await storedLegResult(deps.readResult, target.resultKey);
        if (stored !== undefined) return { leg: planned.leg, ms: Date.now() - started, ...stored };
        // A thrown attempt still counts: its wall time rides in the message, so
        // a failed leg's description shows real time (ms skips thrown attempts).
        // Our own deadline's abort reads as the deadline message, whatever the
        // runtime's abort wording is (#1135).
        const message = signal.aborted
          ? `${planned.leg}: no progress past its deadline`
          : err instanceof Error ? err.message : String(err);
        const minutes = Math.round((Date.now() - started) / 60_000);
        throw new Error(`${message.slice(0, MAX_INFRA_CAUSE_CHARS)} after ${minutes} min`);
      }
    });
  };

  const first = await attempt(`start-${planned.leg}`, (tryNo) => tryNo === 1
    ? planned
    : { ...planned, resultKey: infraRetryResultKey(planned.resultKey) },
  ).catch((err: unknown): LegRunResult => {
    // Retries spent (infra). The thrown message already carries the cause.
    const message = err instanceof Error ? err.message : String(err);
    return { leg: planned.leg, state: "error", description: message.slice(0, MAX_DESCRIPTION_CHARS) };
  });

  // A red test is data, but it may be a flake: run it once more on a fresh
  // container. An "install failed" (#1092) or "clone failed" (#1104) error is a flake too.
  // Other errors stay final.
  if (!isRetryable(first)) return first;

  // The retry writes its own log: the first attempt's shard-<leg>.json stays as evidence.
  const retryTarget: PlannedLeg = { ...planned, resultKey: retryResultKey(planned.resultKey) };
  const retry = await attempt(`retry-${planned.leg}`, () => retryTarget).catch((err: unknown): LegRunResult => {
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
  return description.startsWith("install failed") || description.startsWith("clone failed:");
}

/** The minimal R2 bucket shape the reader needs: the real R2Bucket satisfies it. */
export interface ResultBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
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
      description: `result read from R2 after transport loss: ${text}`.slice(0, MAX_DESCRIPTION_CHARS),
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

/** The start step's infra-retry key: its own, so a try 1 that wrote its result
 *  before its transport died is never read back as try 2's. Dashes, not dots:
 *  the container may only PUT `shard-<leg>[-…].json` (outbound-handler.ts). */
export function infraRetryResultKey(resultKey: string): string {
  return resultKey.replace(/\.json$/, "-try2.json");
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
  pr: { baseRef: string; pr: string; private: boolean; image?: string; bundleKey?: string; mergeBase?: string },
): GateLegRequest {
  return {
    owner, repo, commit: planned.commit, leg: planned.leg,
    installCmd: planned.installCmd, legCmd: planned.legCmd,
    resultKey: planned.resultKey, baselineKeys: planned.baselineKeys,
    private: pr.private, baseRef: pr.baseRef, pr: pr.pr,
    ...(planned.timeoutMin === undefined ? {} : { timeoutMin: planned.timeoutMin }),
    ...(pr.image === undefined ? {} : { image: pr.image }),
    ...(pr.bundleKey === undefined ? {} : { bundleKey: pr.bundleKey }),
    ...(pr.mergeBase === undefined ? {} : { mergeBase: pr.mergeBase }),
  };
}

/** The bundle step's config: one attempt. A retry would only repeat a clone the
 *  legs can do themselves, and a hung bundle leg must not stall the run. */
const BUNDLE_STEP_CONFIG: LegStepConfig = {
  retries: { limit: 0, delay: "15 seconds", backoff: "constant" },
  timeout: "30 minutes",
};

/** The slice of Workflows' WorkflowStep the bundle step uses. */
export interface BundleStepRunner {
  do(name: string, config: LegStepConfig, fn: () => Promise<void>): Promise<void>;
}

/** #1080: the bundle step is behind a flag, off by default. Until the gate image
 *  that understands the bundle leg is live, an old image would run it as a
 *  normal clone-and-checkout leg. Only the exact value "1" turns it on. */
export function bundleStepEnabled(raw: string | undefined): boolean {
  return raw === "1";
}

/** #1080: the one bundle step before the legs. True only when the bundle leg
 *  answered 200 with state success (the DO answers 200 for a leg error too). False
 *  on any failure, and it never throws: a run whose bundle did not build clones in
 *  each leg, as before. */
export async function runBundleStep(
  step: BundleStepRunner,
  dispatch: (planned: PlannedLeg) => Promise<Response>,
  planned: PlannedLeg,
): Promise<boolean> {
  return step.do("build-bundle", BUNDLE_STEP_CONFIG, async () => {
    const res = await dispatch(planned);
    if (!res.ok) throw new Error(`bundle leg: HTTP ${res.status}`);
    const body = await res.json() as { state?: unknown };
    if (body.state !== "success") throw new Error(`bundle leg: state ${String(body.state)}`);
  }).then(() => true, () => false);
}
