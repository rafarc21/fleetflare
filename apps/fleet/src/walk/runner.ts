// #1348: post-deploy staging walk runner — dependency-injected control
// flow, same shape as gate/run-leg.ts's RunLegDeps/GateContainer split. See
// docs/superpowers/specs/2026-10-26-post-deploy-walk-runner-design.md.
//
// auth/engine/sink are all STUB seams: T5 (#1346) wires the real auth
// provider, T6 (#1347) wires the real engine, and a follow-up PR wires the
// real R2 sink. This module never reads a secret store or starts a browser
// itself.
import { aggregateSweepState, itemEvidenceKey, makeAbnormalSweepEvidence, makeItemEvidence, sweepEvidenceKey } from "./evidence";
import { redactValues } from "./redact";
import { hasUsableAuth, secretValues } from "./storage-state";
import type { RouteEvidence, SweepSignature, WalkAttempt, WalkItem, WalkRunState, WalkSweepEvidence } from "./types";

export interface WalkAuthProvider {
  /** undefined, "", or a Playwright storage state with no cookies and no
   *  origin localStorage entries all mean "no usable auth" (storage-state.ts
   *  hasUsableAuth — #1348 review r1 item 2). A provider throws only for its
   *  own transport failure, never to signal "no credential". */
  getStorageState(): Promise<string | undefined>;
}

export interface WalkEngine {
  /** The route console sweep behind sweep.json's nominal shape. */
  sweepRoutes(): Promise<{ routes: RouteEvidence[]; signatures: SweepSignature[] }>;
  /** May throw; runSweep treats a throw as this item's error — no item file
   *  is written for it (v1 defines no "error" result value). */
  runItem(item: WalkItem, storageState: string): Promise<WalkAttempt>;
}

export interface WalkEvidenceSink {
  putEvidence(key: string, body: string): Promise<void>;
}

/** Structured fields only — never the raw storage state or any captured
 *  text. Default caller (Worker wiring, out of this issue) decides where
 *  this goes; tests inject a collector instead of touching the console. */
export type WalkLog = (record: Record<string, unknown>) => void;

export interface WalkDeps {
  auth: WalkAuthProvider;
  engine: WalkEngine;
  sink: WalkEvidenceSink;
  /** v1's item evidence "verifier" field — this run's agent label. */
  verifier: string;
  log: WalkLog;
  now?: () => string;
}

export interface WalkRunResult {
  fingerprint: string;
  state: WalkRunState;
}

const NO_AUTH_REASON = "no usable test-account storage state";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The one seam every evidence write passes through: the JSON body is
 *  scrubbed against every known secret value (and its JSON-escaped/
 *  URL-encoded/base64 forms — redact.ts) before it reaches the sink, no
 *  matter which field it surfaced in. */
async function writeEvidence(sink: WalkEvidenceSink, key: string, body: unknown, secrets: string[]): Promise<void> {
  const json = JSON.stringify(body);
  await sink.putEvidence(key, secrets.length === 0 ? json : (redactValues(json, secrets) ?? json));
}

async function writeAbnormalSweep(
  deps: WalkDeps, fingerprint: string, now: () => string, state: "did-not-run" | "error", reason: string, secrets: string[],
): Promise<WalkRunResult> {
  const sweep = makeAbnormalSweepEvidence(fingerprint, now(), state, reason);
  await writeEvidence(deps.sink, sweepEvidenceKey(fingerprint), sweep, secrets);
  deps.log({ event: "walk_sweep", fingerprint, state });
  return { fingerprint, state };
}

export async function runSweep(fingerprint: string, items: WalkItem[], deps: WalkDeps): Promise<WalkRunResult> {
  const now = deps.now ?? (() => new Date().toISOString());

  let storageState: string | undefined;
  try {
    storageState = await deps.auth.getStorageState();
  } catch (err) {
    // No secret was ever obtained, so there is nothing to redact against —
    // the error message is written as-is.
    return writeAbnormalSweep(deps, fingerprint, now, "error", errorText(err), []);
  }

  if (!hasUsableAuth(storageState)) {
    return writeAbnormalSweep(deps, fingerprint, now, "did-not-run", NO_AUTH_REASON, []);
  }
  const secrets = secretValues(storageState);

  const itemStates: WalkRunState[] = [];
  for (const item of items) {
    try {
      const attempt = await deps.engine.runItem(item, storageState);
      const ev = makeItemEvidence(fingerprint, deps.verifier, now(), attempt);
      await writeEvidence(deps.sink, itemEvidenceKey(fingerprint, item), ev, secrets);
      itemStates.push(attempt.result === "pass" ? "success" : "failure");
      deps.log({ event: "walk_item", fingerprint, role: item.role, idx: item.idx, id: item.id, result: attempt.result });
    } catch {
      itemStates.push("error");
      deps.log({ event: "walk_item", fingerprint, role: item.role, idx: item.idx, id: item.id, result: "error" });
    }
  }

  let sweep: WalkSweepEvidence;
  let routesState: WalkRunState;
  try {
    const { routes, signatures } = await deps.engine.sweepRoutes();
    sweep = { fingerprint, at: now(), routes, signatures };
    routesState = "success";
  } catch (err) {
    sweep = makeAbnormalSweepEvidence(fingerprint, now(), "error", errorText(err));
    routesState = "error";
  }
  await writeEvidence(deps.sink, sweepEvidenceKey(fingerprint), sweep, secrets);

  const state = aggregateSweepState([...itemStates, routesState]);
  deps.log({ event: "walk_sweep", fingerprint, state });
  return { fingerprint, state };
}
