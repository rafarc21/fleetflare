// #1348: pure evidence shaping — R2 keys, the stub-v0 item/sweep shape, and
// sweep-state aggregation. No I/O; see runner.ts for the dependency-injected
// control flow that calls these.
import { redact } from "./redact";
import type { WalkItemEvidence, WalkState, WalkSweepEvidence } from "./types";

export function itemEvidenceKey(sweepId: string, itemId: string): string {
  return `walk/${sweepId}/items/${itemId}.json`;
}

export function sweepEvidenceKey(sweepId: string): string {
  return `walk/${sweepId}/sweep.json`;
}

export interface MakeItemEvidenceInput {
  sweepId: string;
  itemId: string;
  url: string;
  state: WalkState;
  description?: string;
  startedAt: string;
  finishedAt: string;
  /** The live storage state, if one was used for this attempt. Scrubbed out
   *  of `description` before it is returned — never stored. */
  secret?: string;
}

export function makeItemEvidence(input: MakeItemEvidenceInput): WalkItemEvidence {
  const description = input.secret === undefined ? input.description : redact(input.description, input.secret);
  return {
    schemaVersion: "stub-v0",
    sweepId: input.sweepId,
    itemId: input.itemId,
    url: input.url,
    state: input.state,
    ...(description === undefined ? {} : { description }),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
}

/** Same precedence gate/verdict.ts already uses for legs (error > failure),
 *  extended with did-not-run ranked above success: a sweep that never ran is
 *  not a passing sweep. */
const STATE_RANK: Record<WalkState, number> = { error: 3, failure: 2, "did-not-run": 1, success: 0 };

export function aggregateSweepState(states: WalkState[]): WalkState {
  let worst: WalkState = "success";
  for (const s of states) {
    if (STATE_RANK[s] > STATE_RANK[worst]) worst = s;
  }
  return worst;
}

export function makeSweepEvidence(
  sweepId: string,
  items: WalkItemEvidence[],
  startedAt: string,
  finishedAt: string,
): WalkSweepEvidence {
  return {
    schemaVersion: "stub-v0",
    sweepId,
    state: aggregateSweepState(items.map((i) => i.state)),
    startedAt,
    finishedAt,
    items: items.map((i) => ({ itemId: i.itemId, state: i.state, key: itemEvidenceKey(sweepId, i.itemId) })),
  };
}
