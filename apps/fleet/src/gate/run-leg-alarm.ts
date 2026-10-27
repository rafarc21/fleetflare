// #1398 (docs/superpowers/specs/2026-10-26-async-run-leg-design.md): the
// DO's own alarm-tick decision logic, pulled into a pure, bun-testable
// module -- do.ts (which owns the real alarm() and talks to the container)
// imports cloudflare:workers, so bun test can never load it directly. Every
// branch here mirrors run-leg.ts's OWN runOnServer/waitUntilRunning
// branches, UNCHANGED classification, just reached across many short alarm
// ticks instead of one long poll loop (the design doc's own table, "The DO
// becomes a tiny state machine").
import { NO_INSTANCE_DESCRIPTION, type LegOutcome } from "./run-leg";
import { legTimeoutMin } from "./config";

const READY_TIMEOUT_MS = 180_000;
const PORT_RETRY_BUDGET_MS = 90_000;
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
  /** Set once `phase` enters "port-retry". */
  portRetryStartedAt?: number;
  /** Set once `phase` enters "polling". */
  pollStartedAt?: number;
  instanceId: string;
  /** #1398 review r1 item 7: ticks since the last GATE_WORKFLOW.status()
   *  check -- do.ts's real alarm() increments this and checks status every
   *  FEW ticks, never every tick (a real extra RPC cost per check). */
  statusCheckCount: number;
}

/** One alarm tick's raw observation, already fetched by do.ts's real
 *  alarm() (this module stays pure -- no fetch, no container, no R2). */
export type PollSignal =
  | { kind: "not-running" }
  | { kind: "no-instance" }
  | { kind: "running-not-listening" }
  | { kind: "run-accepted" }
  | { kind: "run-result"; result: LegOutcomeResult }
  | { kind: "poll-pending" }
  | { kind: "poll-result"; result: LegOutcomeResult }
  | { kind: "poll-failed" };

/** The shape run-leg.ts's own LegOutcome's "result" branch carries. Named
 *  separately here so this file never needs LegOutcome's own discriminant
 *  for anything but its RETURN value (AlarmTickDecision, below). */
type LegOutcomeResult = Extract<LegOutcome, { kind: "result" }>["result"];

export type AlarmTickDecision =
  | { kind: "re-arm"; afterMs: number; state: RunLegAlarmState }
  | { kind: "terminal"; outcome: LegOutcome };

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
  switch (state.phase) {
    case "waiting-for-ready": {
      if (signal.kind === "run-result") return { kind: "terminal", outcome: { kind: "result", result: signal.result } };
      if (signal.kind === "run-accepted") {
        return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, phase: "polling", pollStartedAt: now } };
      }
      // #1398 plan review r1 item 7: the container IS running and the DO DID
      // attempt /run -- a refusal here means "listening not yet bound," the
      // port-retry phase's own job, never a reason to keep calling this
      // "waiting for ready" (which only means "c.running is still false").
      if (signal.kind === "running-not-listening") {
        return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, phase: "port-retry", portRetryStartedAt: now } };
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
        return { kind: "re-arm", afterMs: ALARM_TICK_MS, state: { ...state, phase: "polling", pollStartedAt: now } };
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
      const startedAt = state.pollStartedAt ?? now;
      // #1398 plan review r1 item 7: checked FIRST -- a real result wins over
      // a same-tick deadline, never the reverse.
      if (signal.kind === "poll-result") return { kind: "terminal", outcome: { kind: "result", result: signal.result } };
      const minutes = legTimeoutMin(state.timeoutMin);
      if (now - startedAt >= minutes * 60_000) {
        return {
          kind: "terminal",
          outcome: { kind: "result", result: { state: "error", description: `${state.leg} exceeded ${minutes} min without a result` } },
        };
      }
      if (signal.kind === "poll-failed") {
        return { kind: "terminal", outcome: { kind: "infra", description: "gate container exited mid-leg" } };
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