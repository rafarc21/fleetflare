// Issue #263 (deep-modules sweep F3): the ONE gate both wake entry points
// (assign-wake.ts's `wakeOnAssign`, comment-wake.ts's `wakeOnComment`) share.
// Callers supply only a digest and their own refusal wording. Pure over
// `AssignWakeDeps` — no Env, no binding.

import type { AssignWakeDeps, AssignWakeReport } from "./assign-wake";
import type { WakeOutcome } from "../studio/wake";
import { sameRepoSlug } from "../github/wake-events";

/** Caller-worded refusals: the gate picks which applies, the caller words it. */
export interface WakeRefusals {
  unregistered: string;
  stopped: string;
  repoMismatch: (repoSlug: string) => string;
}

/**
 * Wake `studioId` with `digest`, or say why not.
 *
 * TOTAL on every path: every failure is a `reason`, never an exception —
 * both callers have already committed to a success response.
 *
 * Repo check (issues #278, #284 round 2): `repoSlug: null` (a studio
 * provisioned before that field existed) FAILS OPEN. A canonical-name lookup
 * failure (`sameRepoSlug` → `"unknown"`, issue #295 bug 2) refuses exactly
 * like `"different"` — this is the wake-gate, which fails closed always. Only
 * the write-gate (assign-wake.ts's `checkAssignRepo`) fails open on it.
 */
export async function wakeStudioFor(
  deps: AssignWakeDeps, studioId: string, gate: { repo: string; digest: string; refuse: WakeRefusals },
): Promise<AssignWakeReport> {
  let studio: { state: string; repoSlug: string | null } | null;
  try {
    studio = await deps.studioState(studioId);
  } catch (err) {
    return { woke: false, reason: errorText(err) };
  }
  if (studio === null) return { woke: false, reason: gate.refuse.unregistered };
  if (studio.state === "stopped") return { woke: false, reason: gate.refuse.stopped };
  if (studio.repoSlug !== null) {
    const match = await sameRepoSlug(studio.repoSlug, gate.repo, deps.resolveCanonicalRepo);
    if (match !== "same") {
      const suffix = match === "unknown" ? " (canonical-name lookup failed — refusing the wake to be safe)" : "";
      return { woke: false, reason: `${gate.refuse.repoMismatch(studio.repoSlug)}${suffix}` };
    }
  }

  let outcome: WakeOutcome;
  try {
    outcome = await deps.wake(studioId, gate.digest);
  } catch (err) {
    return { woke: false, reason: errorText(err) };
  }
  if (!outcome.ok) return { woke: false, reason: outcome.error ?? "wake failed for an unstated reason" };
  return { woke: true, digest: gate.digest };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
