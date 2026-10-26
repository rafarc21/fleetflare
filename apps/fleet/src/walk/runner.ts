// #1348: post-deploy staging walk runner — dependency-injected control
// flow, same shape as gate/run-leg.ts's RunLegDeps/GateContainer split. See
// docs/superpowers/specs/2026-10-26-post-deploy-walk-runner-design.md.
//
// auth/engine/sink are all STUB seams: T5 (#1346) wires the real auth
// provider, T6 (#1347) wires the real engine, and a follow-up PR wires the
// real R2 sink. This module never reads a secret store or starts a browser
// itself.
import { itemEvidenceKey, makeItemEvidence, makeSweepEvidence, sweepEvidenceKey } from "./evidence";
import type { WalkAttempt, WalkItem, WalkItemEvidence, WalkSweepEvidence } from "./types";

export interface WalkAuthProvider {
  /** undefined = no storage state available (not yet provisioned, expired,
   *  revoked). A provider throws only for its own transport failure — a
   *  missing credential is a value, never an exception. */
  getStorageState(): Promise<string | undefined>;
}

export interface WalkEngine {
  /** May throw; runSweep treats a throw as this item's "error", never lets
   *  it escape the sweep. */
  runItem(item: WalkItem, storageState: string): Promise<WalkAttempt>;
}

export interface WalkEvidenceSink {
  putEvidence(key: string, body: string): Promise<void>;
}

/** Structured fields only — never the raw storageState. Default caller
 *  (Worker wiring, out of this issue) decides where this goes; tests inject
 *  a collector instead of touching the real console. */
export type WalkLog = (record: Record<string, unknown>) => void;

export interface WalkDeps {
  auth: WalkAuthProvider;
  engine: WalkEngine;
  sink: WalkEvidenceSink;
  log: WalkLog;
  now?: () => string;
}

const MISSING_STORAGE_STATE_REASON = "no test-account storage state available";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function writeItem(sink: WalkEvidenceSink, ev: WalkItemEvidence): Promise<void> {
  await sink.putEvidence(itemEvidenceKey(ev.sweepId, ev.itemId), JSON.stringify(ev));
}

export async function runSweep(sweepId: string, items: WalkItem[], deps: WalkDeps): Promise<WalkSweepEvidence> {
  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const storageState = await deps.auth.getStorageState();

  const itemEvidence: WalkItemEvidence[] = [];
  if (storageState === undefined) {
    for (const item of items) {
      const ev = makeItemEvidence({
        sweepId, itemId: item.id, url: item.url, state: "did-not-run",
        description: MISSING_STORAGE_STATE_REASON, startedAt, finishedAt: now(),
      });
      await writeItem(deps.sink, ev);
      deps.log({ event: "walk_item", sweepId, itemId: item.id, state: ev.state });
      itemEvidence.push(ev);
    }
  } else {
    for (const item of items) {
      const itemStarted = now();
      let attempt: WalkAttempt;
      try {
        attempt = await deps.engine.runItem(item, storageState);
      } catch (err) {
        attempt = { state: "error", description: errorText(err) };
      }
      const ev = makeItemEvidence({
        sweepId, itemId: item.id, url: item.url, state: attempt.state,
        description: attempt.description, startedAt: itemStarted, finishedAt: now(),
        secret: storageState,
      });
      await writeItem(deps.sink, ev);
      deps.log({ event: "walk_item", sweepId, itemId: item.id, state: ev.state });
      itemEvidence.push(ev);
    }
  }

  const sweep = makeSweepEvidence(sweepId, itemEvidence, startedAt, now());
  await deps.sink.putEvidence(sweepEvidenceKey(sweepId), JSON.stringify(sweep));
  deps.log({ event: "walk_sweep", sweepId, state: sweep.state });
  return sweep;
}
