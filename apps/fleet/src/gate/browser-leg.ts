// #1343: browser-leg semantics. A browser leg (config `browser: true`) is a
// REAL verdict only when spec evidence (screens, console JSON) exists under
// its evidence dir. Zero specs executed, or a skipped leg, is RED
// "DID-NOT-RUN", never green. Pure on purpose: no I/O, no env, so bun test
// can load it — the caller (workflow.ts) supplies the manifest read.
import type { LegResult } from "./verdict";
import type { PlannedLeg } from "./fanout";

/** The state-marker every DID-NOT-RUN description carries, so a caller can
 *  recognise the failure without string-matching a full sentence. */
export const DID_NOT_RUN = "DID-NOT-RUN";

/** The one description a browser leg with no spec evidence reports. */
export function didNotRunDescription(leg: string): string {
  return `${DID_NOT_RUN}: ${leg} (no spec evidence)`;
}

/** The classification of one browser leg's manifest.json (#1381). `executed`
 *  alone must never green a leg — the defect's manifest declared a SCHEDULED
 *  count (317) while only 221 ran — so the verdict reads the outcome
 *  breakdown instead. */
export type ManifestRead =
  /** No manifest file at all. */
  | { kind: "absent" }
  /** Parsed, but the required counts are missing (the old `{executed}` schema). */
  | { kind: "unverified" }
  /** Counts present but a value is not a non-negative integer. */
  | { kind: "malformed" }
  /** Counts present but `executed` is less than the outcomes it reports. */
  | { kind: "inconsistent" }
  /** Counts present, but no test reached a pass/fail/flaky outcome. */
  | { kind: "did-not-run" }
  /** Counts present, some ran, but some did not run. */
  | { kind: "incomplete"; didNotRun: number }
  /** Counts present, some ran to an outcome, none did-not-run. */
  | { kind: "proven" };

const MANIFEST_COUNT_KEYS = ["executed", "passed", "failed", "flaky", "skipped", "didNotRun"] as const;
type ManifestCountKey = (typeof MANIFEST_COUNT_KEYS)[number];

/** The manifest counts the fleet reads (#1381): executed, passed, failed,
 *  flaky, skipped, didNotRun. All six are required and each must be a
 *  non-negative integer — a count that is `null`/a boolean/a numeric string/a
 *  fraction/negative/NaN is "malformed", never coerced (`Number(v)` would turn
 *  `null` into 0 and `'5'` into 5 and green a `didNotRun:null`). An old
 *  `{executed}` alone is "unverified", never a green. */
export function classifyManifest(parsed: unknown): ManifestRead {
  if (typeof parsed !== "object" || parsed === null) return { kind: "unverified" };
  const c = parsed as Record<string, unknown>;
  const counts = new Map<ManifestCountKey, number>();
  let missing = false;
  let malformed = false;
  for (const key of MANIFEST_COUNT_KEYS) {
    const v = c[key];
    if (v === undefined) { missing = true; continue; }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) { malformed = true; continue; }
    counts.set(key, v);
  }
  if (malformed) return { kind: "malformed" };
  if (missing) return { kind: "unverified" };
  const executed = counts.get("executed") as number;
  const passed = counts.get("passed") as number;
  const failed = counts.get("failed") as number;
  const flaky = counts.get("flaky") as number;
  const didNotRun = counts.get("didNotRun") as number;
  const outcomes = passed + failed + flaky;
  if (executed < outcomes) return { kind: "inconsistent" };
  if (outcomes === 0) return { kind: "did-not-run" };
  if (didNotRun > 0) return { kind: "incomplete", didNotRun };
  return { kind: "proven" };
}

/** The workflow's manifest-read glue, pure so it is bun-tested: an absent
 *  manifest is `absent` (a success downgrades to DID-NOT-RUN), a present one
 *  is classified from its parsed JSON (a parse failure passes `null` and reads
 *  "unverified"). */
export function manifestReadFrom(parsed: unknown, present: boolean): ManifestRead {
  return present ? classifyManifest(parsed) : { kind: "absent" };
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

/** RED description when a manifest is present but lacks the required counts
 *  (#1381 back-compat): the fleet cannot tell scheduled from executed, so the
 *  leg is unverified, never green. */
export function manifestLacksCountsDescription(leg: string): string {
  return `${DID_NOT_RUN}: ${leg} (manifest lacks counts)`;
}

/** RED description when a manifest count is not a non-negative integer (#1381
 *  r1): `Number(v)` would coerce null->0 / '5'->5, so the value must already
 *  be a number. */
export function manifestCountsMalformedDescription(leg: string): string {
  return `${DID_NOT_RUN}: ${leg} (manifest counts malformed)`;
}

/** RED description when `executed` is less than the outcomes it reports (#1381
 *  r1): the reported pass/fail/flaky cannot exceed the count that ran. */
export function manifestCountsInconsistentDescription(leg: string): string {
  return `${DID_NOT_RUN}: ${leg} (manifest counts inconsistent)`;
}

/** RED description when a manifest declares zero outcomes (#1381): `executed`
 *  was a scheduled count, nothing actually ran to a pass/fail/flaky result. */
export function zeroOutcomesDescription(leg: string): string {
  return `${DID_NOT_RUN}: ${leg} (no test reached an outcome)`;
}

/** RED description when a manifest declares some tests did not run (#1381). */
export function didNotRunCountDescription(leg: string, didNotRun: number): string {
  return `${DID_NOT_RUN}: ${leg} (${didNotRun} did not run)`;
}

/** A browser leg that reported success but whose manifest does not PROVE specs
 *  ran is downgraded to failure DID-NOT-RUN (#1381). Failure/error legs are
 *  already red and pass through unchanged — their own description is the
 *  headline, and a red leg is never the false-green this rule closes. */
export function enforceBrowserLeg(leg: string, result: LegResult, manifest: ManifestRead): LegResult {
  if (result.state !== "success") return result;
  switch (manifest.kind) {
    case "proven": return result;
    case "absent": return { leg, state: "failure", description: didNotRunDescription(leg) };
    case "unverified": return { leg, state: "failure", description: manifestLacksCountsDescription(leg) };
    case "malformed": return { leg, state: "failure", description: manifestCountsMalformedDescription(leg) };
    case "inconsistent": return { leg, state: "failure", description: manifestCountsInconsistentDescription(leg) };
    case "did-not-run": return { leg, state: "failure", description: zeroOutcomesDescription(leg) };
    case "incomplete": return { leg, state: "failure", description: didNotRunCountDescription(leg, manifest.didNotRun) };
  }
}

/** Fan-in enforcement over every expected leg. A browser leg with no result at
 *  all (a skipped leg) is filled as DID-NOT-RUN failure, never left to read as
 *  a silent pass; a browser leg reporting success without a PROVEN manifest is
 *  downgraded the same way. Plain legs pass through untouched — their missing
 *  report stays aggregateVerdict's own pending/error, not this rule's. */
export function enforceBrowserLegs(
  expected: string[], results: LegResult[], browser: ReadonlySet<string>, manifests: ReadonlyMap<string, ManifestRead>,
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
      : enforceBrowserLeg(leg, r, manifests.get(leg) ?? { kind: "absent" }));
  }
  return out;
}

/** The gate/verdict target_url for one run's browser evidence. Points at the
 *  Worker's own evidence overview (Access-gated, so the operator's browser can
 *  open it), never a presigned or otherwise credential-bearing URL. */
export function verdictEvidenceUrl(workerPublicUrl: string, repo: string, pr: number, runId: string): string {
  return `${workerPublicUrl.replace(/\/+$/, "")}/studio/gate/evidence?repo=${encodeURIComponent(repo)}&pr=${pr}&run=${encodeURIComponent(runId)}`;
}