// #1343: browser-leg semantics. A browser leg (config `browser: true`) is a
// REAL verdict only when spec evidence (screens, console JSON) exists under
// its evidence dir. Zero specs executed, or a skipped leg, is RED
// "DID-NOT-RUN", never green. Pure on purpose: no I/O, no env, so bun test
// can load it — the caller (workflow.ts) supplies the evidence set it read.
import type { LegResult } from "./verdict";
import type { PlannedLeg } from "./fanout";

/** The state-marker every DID-NOT-RUN description carries, so a caller can
 *  recognise the failure without string-matching a full sentence. */
export const DID_NOT_RUN = "DID-NOT-RUN";

/** The one description a browser leg with no spec evidence reports. */
export function didNotRunDescription(leg: string): string {
  return `${DID_NOT_RUN}: ${leg} (no spec evidence)`;
}

/** #1343 MED4: whether a manifest.json proves specs actually executed. A stray
 *  screenshot is not proof; the reporter must declare `executed > 0`. A
 *  missing/unparseable manifest, or one with executed 0, is false. */
export function manifestProvesExecution(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  const executed = Number((parsed as { executed?: unknown }).executed ?? 0);
  return Number.isFinite(executed) && executed > 0;
}

/** #1343 r2: the browser legs THIS run must check for evidence. A CARRIED green
 *  browser leg (already enforced by a prior run) is exempt — re-checking it
 *  under THIS run's evidence prefix would flip green->red DID-NOT-RUN on every
 *  infra/--failed-only rerun. Only a carried leg in `success` state is exempt:
 *  the carry never holds anything but green legs (greenLegsOf), but this
 *  checks state anyway so a malformed carry can never skip a real check. Pure
 *  so the exemption is bun-tested: a mutant that drops the carried check fails
 *  the test. */
export function browserLegsToCheck(
  legs: PlannedLeg[], carriedByLeg: ReadonlyMap<string, LegResult>,
): string[] {
  return legs
    .filter((l) => l.browser === true && carriedByLeg.get(l.leg)?.state !== "success")
    .map((l) => l.leg);
}

/** A browser leg that reported success but uploaded no spec evidence ran zero
 *  specs: downgrade to failure DID-NOT-RUN. Any other state, or evidence
 *  present, passes through unchanged. */
export function enforceBrowserLeg(leg: string, result: LegResult, hasEvidence: boolean): LegResult {
  if (result.state === "success" && !hasEvidence) {
    return { leg, state: "failure", description: didNotRunDescription(leg) };
  }
  return result;
}

/** Fan-in enforcement over every expected leg. A browser leg with no result at
 *  all (a skipped leg) is filled as DID-NOT-RUN failure, never left to read as
 *  a silent pass; a browser leg reporting success without evidence is
 *  downgraded the same way. Plain legs pass through untouched — their missing
 *  report stays aggregateVerdict's own pending/error, not this rule's. */
export function enforceBrowserLegs(
  expected: string[], results: LegResult[], browser: ReadonlySet<string>, evidence: ReadonlySet<string>,
): LegResult[] {
  const byLeg = new Map(results.map((r) => [r.leg, r]));
  const out: LegResult[] = [];
  for (const leg of expected) {
    if (!browser.has(leg)) {
      const r = byLeg.get(leg);
      if (r !== undefined) out.push(r);
      continue;
    }
    const r = byLeg.get(leg);
    out.push(r === undefined
      ? { leg, state: "failure" as const, description: didNotRunDescription(leg) }
      : enforceBrowserLeg(leg, r, evidence.has(leg)));
  }
  return out;
}

/** The gate/verdict target_url for one run's browser evidence. Points at the
 *  Worker's own evidence overview (Access-gated, so the operator's browser can
 *  open it), never a presigned or otherwise credential-bearing URL. */
export function verdictEvidenceUrl(workerPublicUrl: string, repo: string, pr: number, runId: string): string {
  return `${workerPublicUrl.replace(/\/+$/, "")}/studio/gate/evidence?repo=${encodeURIComponent(repo)}&pr=${pr}&run=${encodeURIComponent(runId)}`;
}