// #1348: shared types for the post-deploy staging walk runner. See
// docs/superpowers/specs/2026-10-26-post-deploy-walk-runner-design.md.
//
// Field names below are the consumer maestro's walk-evidence schema v1
// (issue #1348 comment 6412380632), copied verbatim — do not rename. This
// replaces the earlier stub-v0 placeholder.

/** This runner's own control-flow verdict — never written into a v1
 *  evidence file field (v1 defines no such value); it is what runSweep
 *  returns/logs, and what the task's result envelope reports as
 *  RED "did-not-run" or "error" when the walk could not produce real
 *  evidence. */
export type WalkRunState = "success" | "failure" | "error" | "did-not-run";

/** One checklist item to walk. `role`/`idx`/`id` name its evidence file
 *  (`item-<role>-<idx>-<id>.json`); `url` is where it starts. */
export interface WalkItem {
  id: string;
  role: string;
  idx: number;
  url: string;
}

export interface WalkStep {
  n: number;
  screenshot: string;
  observed: string;
}

export interface ConsoleEvent {
  type: string;
  text: string;
  source: string;
  at: string;
}

export interface DebugLog {
  type: string;
  text: string;
}

export interface ExceptionEvent {
  text: string;
  url: string;
}

export interface RequestFault {
  method: string;
  path: string;
  status: number;
  errorText: string;
  type: string;
  canceled?: true;
}

export interface ConsoleCapture {
  consoleErrors: ConsoleEvent[];
  consoleWarnings: ConsoleEvent[];
  debugLogs: DebugLog[];
  exceptions: ExceptionEvent[];
  badRequests: RequestFault[];
  canceledRequests: RequestFault[];
}

export interface AiTurn {
  prompt: string;
  reply: string;
  chips: string[];
}

/** What a WalkEngine run of one checklist item returns. "error" is not a
 *  v1 result value: an engine throw is this runner's own infra outcome
 *  (runner.ts), never a `WalkAttempt` the engine itself returns. */
export interface WalkAttempt {
  result: "pass" | "fail";
  steps: WalkStep[];
  console: ConsoleCapture;
  ai: { turns: AiTurn[] };
  accounts: string[];
  failReason?: string;
}

/** `item-<role>-<idx>-<id>.json`, v1 shape. Written only for an item that
 *  actually got a real pass/fail verdict — a did-not-run or engine-throw
 *  outcome writes no item file at all (runner.ts). */
export interface WalkItemEvidence {
  fingerprint: string;
  verifier: string;
  at: string;
  result: "pass" | "fail";
  steps: WalkStep[];
  console: ConsoleCapture;
  ai: { turns: AiTurn[] };
  accounts: string[];
  failReason?: string;
}

export interface RouteEvidence {
  url: string;
  finalUrl: string;
  navError: string | null;
  consoleErrors: ConsoleEvent[];
  consoleWarnings: ConsoleEvent[];
  debugLogs: DebugLog[];
  exceptions: ExceptionEvent[];
  badRequests: RequestFault[];
  canceledRequests: RequestFault[];
  screenshot: string;
}

export interface SweepSignature {
  sig: string;
  count: number;
  routes: string[];
}

/** `sweep.json`. Nominal v1 shape when the route console sweep actually
 *  ran; otherwise this runner's own minimal did-not-run/error record — v1
 *  defines no state for "the walk never produced evidence", and there is
 *  no route data to report in that case. */
export type WalkSweepEvidence =
  | { fingerprint: string; at: string; routes: RouteEvidence[]; signatures: SweepSignature[] }
  | { fingerprint: string; at: string; state: "did-not-run" | "error"; reason: string };
