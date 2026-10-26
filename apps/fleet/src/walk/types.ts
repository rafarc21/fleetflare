// #1348: shared types for the post-deploy staging walk runner. See
// docs/superpowers/specs/2026-10-26-post-deploy-walk-runner-design.md.
//
// schemaVersion "stub-v0": the consumer maestro's real walk-gate schema has
// not arrived yet. This shape is a placeholder — supersede it at the
// evidence.ts boundary when the real schema lands, never extend it in place.

export type WalkState = "success" | "failure" | "error" | "did-not-run";

/** One thing the sweep checks — a page, a flow step. The real shape is the
 *  consumer maestro's to define; `id` and `url` are the minimum this runner
 *  needs to label evidence. */
export interface WalkItem {
  id: string;
  url: string;
}

/** What a WalkEngine run of one item returns. Never includes storageState:
 *  a description that happens to echo it is scrubbed at the evidence.ts
 *  boundary (redact.ts), not trusted to stay clean here. */
export interface WalkAttempt {
  state: "success" | "failure" | "error";
  description?: string;
}

export interface WalkItemEvidence {
  schemaVersion: "stub-v0";
  sweepId: string;
  itemId: string;
  url: string;
  state: WalkState;
  description?: string;
  startedAt: string;
  finishedAt: string;
}

export interface WalkSweepItemRef {
  itemId: string;
  state: WalkState;
  key: string;
}

export interface WalkSweepEvidence {
  schemaVersion: "stub-v0";
  sweepId: string;
  state: WalkState;
  startedAt: string;
  finishedAt: string;
  items: WalkSweepItemRef[];
}
