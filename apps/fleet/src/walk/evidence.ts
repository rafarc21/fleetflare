// #1348: pure evidence shaping against the v1 walk-evidence schema — R2 key
// segment validation, the item evidence builder, and this runner's own
// WalkRunState aggregation (not a v1 field; see types.ts). No I/O; see
// runner.ts for the dependency-injected control flow that calls these.
import type { WalkAttempt, WalkItem, WalkItemEvidence, WalkRunState, WalkSweepEvidence } from "./types";

/** Same charset test-creds.ts's NAME_RE/KEY_RE already use for a secret
 *  name/key: leading alnum, then alnum/`_`/`.`/`-`. An item's role/id are
 *  schema-supplied (the consumer maestro's checklist), never trusted
 *  verbatim into an R2 key path — #1348 review r1 item 5. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function assertSafeSegment(label: string, value: string): void {
  if (!SEGMENT_RE.test(value)) {
    throw new Error(`walk: ${label} "${value}" is not a safe R2 key segment`);
  }
}

export function sweepEvidenceKey(fingerprint: string): string {
  assertSafeSegment("fingerprint", fingerprint);
  return `walk/${fingerprint}/sweep.json`;
}

export function itemEvidenceKey(fingerprint: string, item: WalkItem): string {
  assertSafeSegment("fingerprint", fingerprint);
  assertSafeSegment("role", item.role);
  assertSafeSegment("id", item.id);
  if (!Number.isInteger(item.idx) || item.idx < 0) {
    throw new Error(`walk: idx ${item.idx} is not a non-negative integer`);
  }
  return `walk/${fingerprint}/item-${item.role}-${item.idx}-${item.id}.json`;
}

export function makeItemEvidence(
  fingerprint: string,
  verifier: string,
  at: string,
  attempt: WalkAttempt,
): WalkItemEvidence {
  return {
    fingerprint,
    verifier,
    at,
    result: attempt.result,
    steps: attempt.steps,
    console: attempt.console,
    ai: attempt.ai,
    accounts: attempt.accounts,
    ...(attempt.failReason === undefined ? {} : { failReason: attempt.failReason }),
  };
}

/** sweep.json's shape when the walk never produced real route evidence — no
 *  v1 field for that, so this is this runner's own minimal record. */
export function makeAbnormalSweepEvidence(
  fingerprint: string,
  at: string,
  state: "did-not-run" | "error",
  reason: string,
): WalkSweepEvidence {
  return { fingerprint, at, state, reason };
}

/** error > failure > did-not-run > success. #1348 review r1 item 1: an
 *  empty item list is did-not-run (nothing ran), never a vacuous success. */
const STATE_RANK: Record<WalkRunState, number> = { error: 3, failure: 2, "did-not-run": 1, success: 0 };

export function aggregateSweepState(states: WalkRunState[]): WalkRunState {
  if (states.length === 0) return "did-not-run";
  let worst: WalkRunState = "success";
  for (const s of states) {
    if (STATE_RANK[s] > STATE_RANK[worst]) worst = s;
  }
  return worst;
}
