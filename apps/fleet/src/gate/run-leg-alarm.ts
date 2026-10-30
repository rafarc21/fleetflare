// #1398 (docs/superpowers/specs/2026-10-26-async-run-leg-design.md): the
// DO's own alarm-tick decision logic, pulled into a pure, bun-testable
// module -- do.ts (which owns the real alarm() and talks to the container)
// imports cloudflare:workers, so bun test can never load it directly. Every
// branch here mirrors run-leg.ts's OWN runOnServer/waitUntilRunning
// branches, UNCHANGED classification, just reached across many short alarm
// ticks instead of one long poll loop (the design doc's own table, "The DO
// becomes a tiny state machine").
import { NO_INSTANCE_DESCRIPTION, type LegOutcome } from "./run-leg";
import { claimOrReadBack, R2_PREFIX, type ClaimableBucket } from "./leg-run";
import { redactLegResultFields } from "./secrets-redact";
import { legTimeoutMin } from "./config";

const READY_TIMEOUT_MS = 180_000;
const PORT_RETRY_BUDGET_MS = 90_000;
/** #1398 review r1 item 7: a status check costs an extra RPC, so it runs
 *  every FEW ticks, not every one. */
const STATUS_CHECK_EVERY_N_TICKS = 5;
/** #1398 plan review r1 BLOCKER 4: stays comfortably under Cloudflare's own
 *  6-failed-retries alarm-dormancy cliff (spec "Container lifetime"). */
const MAX_CONSECUTIVE_FAILURES = 5;
/** #1398 review r1 item 10: 15-30s per tick -- a DO wake is a real billed
 *  event, unlike the old in-request sleep, so coarser than the container's
 *  own 5s POLL_MS is the right choice. */
export const ALARM_TICK_MS = 20_000;
/** #1398 plan review r1 BLOCKER 2: real slack on top of the DO's own worst
 *  case, covering alarm-tick scheduling jitter and at-least-once redelivery
 *  delay -- the Workflow's own give-up backstop (asyncAttemptDeadlineMs,
 *  below) must never fire while the DO could still legitimately be working. */
const ASYNC_GRACE_MS = 5 * 60_000;

export type RunLegAlarmPhase = "waiting-for-ready" | "port-retry" | "polling";

export interface RunLegAlarmState {
  phase: RunLegAlarmPhase;
  resultKey: string;
  leg: string;
  timeoutMin: number | undefined;
  /** Wall-clock time this attempt's dispatch step itself minted (the
   *  governing invariant) -- when `phase` entered "waiting-for-ready". */
  readyStartedAt: number;
  /** #1409 (a): the leg's OWN start — minted the moment /run is first
   *  attempted (the waiting-for-ready -> port-retry or -> polling
   *  transition). The polling deadline anchors HERE, not at pollStartedAt:
   *  a leg can spend up to 90 s in port-retry before /run is accepted, and
   *  that time counts against timeoutMin, exactly as runOnServer's
   *  `legStarted` does. */
  legStartedAt?: number;
  /** Set once `phase` enters "port-retry". */
  portRetryStartedAt?: number;
  /** Set once `phase` enters "polling". */
  pollStartedAt?: number;
  instanceId: string;
  /** #1398 review r1 item 7: ticks since the last GATE_WORKFLOW.status()
   *  check -- do.ts's real alarm() increments this and checks status every
   *  FEW ticks, never every tick (a real extra RPC cost per check). */
  statusCheckCount: number;
  /** #1398 (Task 9): how many consecutive alarm ticks failed to make
   *  progress -- do.ts's alarm() increments this and gives up as terminal
   *  infra once a cap is hit, so a persistently broken DO never re-arms
   *  forever. Optional: Task 4's own state literals need not set it. */
  consecutiveFailures?: number;
}

/** One alarm tick's raw observation, already fetched by do.ts's real
 *  alarm() (this module stays pure -- no fetch, no container, no R2). */
export type PollSignal =
  | { kind: "not-running" }
  | { kind: "no-instance" }
  | { kind: "running-not-listening" }
  | { kind: "run-accepted" }
  | { kind: "run-result"; result: LegOutcomeResult }
  | { kind: "run-rejected"; description: string }
  | { kind: "poll-pending" }
  | { kind: "poll-result"; result: LegOutcomeResult }
  | { kind: "poll-failed" };

/** The shape run-leg.ts's own LegOutcome's "result" branch carries. Named
 *  separately here so this file never needs LegOutcome's own discriminant
 *  for anything but its RETURN value (AlarmTickDecision, below). */
type LegOutcomeResult = Extract<LegOutcome, { kind: "result" }>["result"];

/** A tick's terminal conclusion: only "result" or "infra" -- nextAlarmStep
 *  never concludes with an "accepted" (that variant is the async START's own
 *  reply, never an alarm decision). */
export type TerminalOutcome = Extract<LegOutcome, { kind: "result" } | { kind: "infra" }>;

export type AlarmTickDecision =
  | { kind: "re-arm"; afterMs: number; state: RunLegAlarmState }
  | { kind: "terminal"; outcome: TerminalOutcome };

/** One tick of the DO's own state machine: given where this attempt is
 *  (`state`), the current time, and ONE freshly-observed signal, decide
 *  whether to re-arm (and how the state should look next tick) or conclude
 *  the attempt. Pure -- do.ts's real alarm() is the thin wrapper that
 *  fetches the signal and persists/acts on this return value.
 *
 *  Branch order matters (plan review r1 item 7): a `poll-result`/`run-result`
 *  signal is checked BEFORE any deadline check in every phase, so a leg that
 *  genuinely finishes in the SAME tick its own deadline elapses still gets
 *  its real result, never the synthetic deadline message. */
export function nextAlarmStep(state: RunLegAlarmState, now: number, signal: PollSignal): AlarmTickDecision {
  if (signal.kind === "no-instance") {
    return { kind: "terminal", outcome: { kind: "infra", description: NO_INSTANCE_DESCRIPTION } };
  }
  // #1398 review r1 item 5: /run answered a non-200/non-202 status. run-leg.ts's
  // own runOnServer maps that to an infra failure carrying the status text
  // (its `gate server HTTP <n>`), never a retryable "not listening yet" --
  // the alarm must classify it the same way, whatever phase the /run was
  // attempted from.
  if (signal.kind === "run-rejected") {
    return { kind: "terminal", outcome: { kind: "infra", description: signal.description } };
  }
  switch (state.phase) {
    case "waiting-for-ready": {
      if (signal.kind === "run-result") return { kind: "terminal", outcome: { kind: "result", result: signal.result } };
      if (signal.kind === "run-accepted") {
        return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, phase: "polling", pollStartedAt: now, legStartedAt: state.legStartedAt ?? now } };
      }
      // #1398 plan review r1 item 7: the container IS running and the DO DID
      // attempt /run -- a refusal here means "listening not yet bound," the
      // port-retry phase's own job, never a reason to keep calling this
      // "waiting for ready" (which only means "c.running is still false").
      if (signal.kind === "running-not-listening") {
        return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, phase: "port-retry", portRetryStartedAt: now, legStartedAt: state.legStartedAt ?? now } };
      }
      // "not-running": the container itself has not come up yet.
      if (now - state.readyStartedAt >= READY_TIMEOUT_MS) {
        return { kind: "terminal", outcome: { kind: "infra", description: "gate container did not start within 180 s" } };
      }
      return { kind: "re-arm", afterMs: ALARM_TICK_MS, state };
    }
    case "port-retry": {
      const startedAt = state.portRetryStartedAt ?? now;
      if (signal.kind === "run-result") return { kind: "terminal", outcome: { kind: "result", result: signal.result } };
      if (signal.kind === "run-accepted") {
        return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, phase: "polling", pollStartedAt: now, legStartedAt: state.legStartedAt ?? now } };
      }
      if (now - startedAt >= PORT_RETRY_BUDGET_MS) {
        return {
          kind: "terminal",
          outcome: { kind: "infra", description: `gate server unreachable after ${PORT_RETRY_BUDGET_MS / 1000} s` },
        };
      }
      return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, portRetryStartedAt: startedAt } };
    }
    case "polling": {
      // #1409 (b): a container that is not running any more during the poll
      // phase ends the leg NOW as infra — never a silent re-arm that keeps
      // burning ticks until the leg's own deadline. runOnServer's own poll
      // loop checks c.running FIRST and returns infra the moment it turns
      // false; the alarm mirrors that.
      if (signal.kind === "not-running") {
        return { kind: "terminal", outcome: { kind: "infra", description: "gate container exited mid-leg" } };
      }
      // #1409 (a): the leg's deadline anchors at legStartedAt (when /run was
      // first attempted), not pollStartedAt. Port-retry can spend up to 90 s
      // before /run is accepted; that time counts against timeoutMin, exactly
      // as runOnServer's legStarted does.
      const startedAt = state.legStartedAt ?? state.pollStartedAt ?? now;
      // #1398 plan review r1 item 7: checked FIRST -- a real result wins over
      // a same-tick deadline, never the reverse.
      if (signal.kind === "poll-result") return { kind: "terminal", outcome: { kind: "result", result: signal.result } };
      // #1398 review r1 item 4: checked BEFORE the deadline -- a container that
      // died in the SAME tick the deadline elapses is infra (retried on a fresh
      // container), never a red "exceeded" body, exactly as run-leg.ts's own
      // runOnServer reads c.running before its deadline check today.
      if (signal.kind === "poll-failed") {
        return { kind: "terminal", outcome: { kind: "infra", description: "gate container exited mid-leg" } };
      }
      const minutes = legTimeoutMin(state.timeoutMin);
      if (now - startedAt >= minutes * 60_000) {
        return {
          kind: "terminal",
          outcome: { kind: "result", result: { state: "error", description: `${state.leg} exceeded ${minutes} min without a result` } },
        };
      }
      // "poll-pending" or anything else: keep polling.
      return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, pollStartedAt: startedAt } };
    }
  }
}

/** #1398 review r1 item 7 / Leftovers item 3: the exact set of Workflows
 *  instance statuses that mean "superseded, stop polling" is intentionally
 *  an ALLOWLIST of TERMINAL states, not a denylist of live ones -- fail-safe
 *  toward NEVER destroying a container whose run is still genuinely live.
 *  Verify this list against the real Workflows API at implementation review
 *  time (spec Open Question 2); until then, treating an unrecognized status
 *  as live is the safe default, never the reverse. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["complete", "terminated", "errored"]);

export function isLiveStatus(status: string): boolean {
  return !TERMINAL_STATUSES.has(status);
}

/**
 * #1398 plan review r1 BLOCKER 2: the Workflow's OWN poll loop needs its own
 * give-up deadline, for the case the DO's alarm never gets to run its own
 * check at all (a true platform fault -- the alarm went dormant, spec
 * "Container lifetime"). That backstop must be STRICTLY LONGER than the
 * total time the DO could legitimately still be working within (its own
 * ready-wait + port-retry + polling budgets), plus real grace for alarm
 * scheduling jitter -- otherwise the Workflow's own "give up" write could
 * race (and sometimes lose to, sometimes wrongly precede) the DO's own
 * still-in-progress, legitimate work. One function, used by BOTH do.ts's
 * internal math (indirectly, via the same three constants) and
 * runLegStepPolling's own poll loop (Task 7), so they can never drift apart.
 */
export function asyncAttemptDeadlineMs(timeoutMin: number | undefined): number {
  return READY_TIMEOUT_MS + PORT_RETRY_BUDGET_MS + legTimeoutMin(timeoutMin) * 60_000 + ASYNC_GRACE_MS;
}

/** #1398: every piece of real I/O one alarm tick needs, injected -- do.ts's
 *  real alarm() is the ONLY caller built from real bindings; every test above
 *  builds this from plain fakes. */
export interface AlarmTickDeps {
  storage: {
    getState(): Promise<RunLegAlarmState | undefined>;
    getSecretValues(): Promise<Record<string, string> | undefined>;
    putState(state: RunLegAlarmState): Promise<void>;
    deleteSecretValues(): Promise<void>;
    deleteState(): Promise<void>;
    scheduleAlarm(atMs: number): Promise<void>;
  };
  container: { destroy(): Promise<void> } | undefined;
  bucket: ClaimableBucket;
  instanceStatus: (instanceId: string) => Promise<string>;
  /** do.ts's own real observeOnce -- the ONE piece of this whole flow that
   *  actually talks to the container over HTTP. Everything else here is
   *  pure orchestration. */
  observe: (state: RunLegAlarmState) => Promise<PollSignal>;
  now: () => number;
}

async function writeTerminalOutcome(deps: AlarmTickDeps, resultKey: string, outcome: TerminalOutcome): Promise<void> {
  const secretValues = (await deps.storage.getSecretValues()) ?? {};
  const values = Object.values(secretValues).filter((v) => v !== "");
  // #1398 plan review r1 BLOCKER 2: EVERY self-made outcome is written --
  // a "result" (a live-observed body, OR the leg's own deadline red) gets
  // the SAME redaction + claimOrReadBack treatment an "infra" guess does.
  // Only the "infra" branch's description gets the R2_PREFIX marker added
  // HERE -- a "result" outcome's own description (e.g. the deadline's
  // "<leg> exceeded N min...") is already exactly the wording #1390
  // established and is never prefixed.
  const toWrite = outcome.kind === "infra"
    ? { state: "error" as const, description: `${R2_PREFIX}${outcome.description}` }
    : outcome.result;
  const redacted = redactLegResultFields(toWrite, values);
  await claimOrReadBack(deps.bucket, resultKey, redacted);
}

/**
 * #1398 plan review r1 BLOCKER 4: one alarm tick's FULL orchestration,
 * fully injected, fully bun-testable -- do.ts's real alarm() does nothing but
 * build real deps and call this.
 */
export async function alarmTick(deps: AlarmTickDeps): Promise<"done" | "re-armed" | "superseded" | "gave-up-after-failures"> {
  const state = await deps.storage.getState();
  if (state === undefined) return "done"; // a stray/duplicate tick after this attempt already finished
  try {
    let current = state;
    if (current.statusCheckCount >= STATUS_CHECK_EVERY_N_TICKS && current.instanceId !== "") {
      const status = await deps.instanceStatus(current.instanceId);
      if (!isLiveStatus(status)) {
        await deps.container?.destroy();
        await deps.storage.deleteSecretValues();
        await deps.storage.deleteState();
        return "superseded";
      }
      current = { ...current, statusCheckCount: 0 };
    }
    const signal = await deps.observe(current);
    const decision = nextAlarmStep(current, deps.now(), signal);
    if (decision.kind === "re-arm") {
      const nextState: RunLegAlarmState = { ...decision.state, statusCheckCount: current.statusCheckCount + 1, consecutiveFailures: 0 };
      await deps.storage.putState(nextState);
      await deps.storage.scheduleAlarm(deps.now() + decision.afterMs);
      return "re-armed";
    }
    await writeTerminalOutcome(deps, current.resultKey, decision.outcome);
    // r1 item 4: destroy FIRST, guarded -- a throwing destroy must never fall
    // into the catch below and re-arm (which would rewrite the already-deleted
    // state and bill 4 extra ticks). The keys are deleted regardless, so a
    // dead/unreachable container can never resurrect this attempt.
    try {
      await deps.container?.destroy();
    } catch (err) {
      console.error("gate-runner: alarm tick destroy failed", errorText(err));
    }
    await deps.storage.deleteSecretValues();
    await deps.storage.deleteState();
    return "done";
  } catch (err) {
    // #1398 plan review r1 BLOCKER 4: never let an uncaught exception
    // propagate silently -- log (never secret values: only the error text),
    // then re-arm (tracking the failure count) unless the cap is reached, in
    // which case give up with a terminal infra result rather than re-arm (and
    // bill) forever.
    console.error("gate-runner: alarm tick failed", errorText(err));
    const failures = (state.consecutiveFailures ?? 0) + 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await writeTerminalOutcome(deps, state.resultKey, {
        kind: "infra", description: `DO alarm failed ${failures} times in a row, giving up`,
      }).catch(() => {});
      // r1 item 3: a failing secret delete MUST rethrow, so CF's own alarm
      // retry takes over -- swallowing it returns "gave-up" with the
      // secretValues still stored, stranded forever.
      await deps.storage.deleteSecretValues();
      await deps.storage.deleteState().catch(() => {});
      await deps.container?.destroy().catch(() => {});
      return "gave-up-after-failures";
    }
    // r1 item 3: a failing re-arm MUST rethrow -- swallowing it makes alarm()
    // return normally (CF never retries) and strands the attempt forever.
    await deps.storage.putState({ ...state, consecutiveFailures: failures });
    await deps.storage.scheduleAlarm(deps.now() + ALARM_TICK_MS);
    return "re-armed";
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
