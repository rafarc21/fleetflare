import type { EnvelopeDoc, EnvelopeIntent, EnvelopeStatus } from "../board/types";

/**
 * "Is the fleet done?" — the one question that stops the maestro sweep.
 *
 * Measurable, never vibes. Quiescent iff ALL THREE hold:
 *   1. no board task in flight on a running studio
 *   2. no open fleet PR waiting on CI or merge
 *   3. every studio stopped, or running with no unfinished envelope
 *
 * ── FAIL-CLOSED. Say it out loud, because the codebase has both kinds. ──
 *
 * This function is the fail-CLOSED sibling of the pair, alongside
 * `openAssignedTasks`/`openTaskChecker` (board/routes.ts, studio/destroy.ts)
 * which refuse a destroy when the board cannot be read. It is NOT the
 * fail-OPEN shape of task #118's `resolveLatestAssignedBrief`, which collapses
 * a lookup failure into "no brief" — correct for a bring-up fallback, fatal
 * here.
 *
 * Stopping the sweep is a GATE. A check that throws answers "I could not
 * tell", and "I could not tell" is never "the work is finished": GitHub having
 * a bad minute would otherwise end supervision of a fleet that is mid-flight,
 * with no watchdog anywhere to notice. So every failure — a thrown port, a
 * partial answer — returns NOT quiescent and keeps the sweep alive.
 */

/** An envelope whose intent means the conversation is still open. `request`
 *  is work being handed over; `clarify`/`escalate` are waiting on an answer.
 *  `result` and `error` are terminal — nothing further happens on their own. */
const UNFINISHED_INTENTS: ReadonlySet<EnvelopeIntent> = new Set<EnvelopeIntent>([
  "request", "clarify", "escalate",
]);

/** A status that means the studio itself said it is not finished. `ok` and
 *  `failed` are both terminal verdicts; `partial`/`blocked` are not. */
const UNFINISHED_STATUSES: ReadonlySet<EnvelopeStatus> = new Set<EnvelopeStatus>([
  "partial", "blocked",
]);

export interface QuiescenceDeps {
  /** Studio ids the registry reports as not stopped. */
  runningStudios: () => Promise<string[]>;
  /** Open board task numbers labelled to that studio. */
  openTasksFor: (studioId: string) => Promise<number[]>;
  /** Open PR numbers on the fleet repo. An open PR is by definition waiting
   *  on CI or on a merge; there is no third thing it could be waiting for. */
  openPulls: () => Promise<number[]>;
  /** That studio's most recent envelope, or null if it has written none. */
  latestEnvelope: (studioId: string) => Promise<EnvelopeDoc | null>;
}

export type QuiescenceVerdict =
  | { quiescent: true; reason?: undefined }
  | { quiescent: false; reason: string };

export function isUnfinished(doc: EnvelopeDoc): boolean {
  return UNFINISHED_INTENTS.has(doc.envelope.intent) || UNFINISHED_STATUSES.has(doc.payload.status);
}

/**
 * TOTAL — never throws. A rejected port becomes `{quiescent:false}` carrying
 * the port's own words, so the wave message says WHY supervision continues
 * rather than reporting a silent "still busy".
 */
export async function checkQuiescence(deps: QuiescenceDeps): Promise<QuiescenceVerdict> {
  try {
    const pulls = await deps.openPulls();
    if (pulls.length) {
      return { quiescent: false, reason: `open fleet PRs: ${pulls.map((n) => `#${n}`).join(", ")}` };
    }
    const running = await deps.runningStudios();
    for (const studioId of running) {
      const tasks = await deps.openTasksFor(studioId);
      if (tasks.length) {
        return { quiescent: false, reason: `${studioId} has open board tasks: ${tasks.map((n) => `#${n}`).join(", ")}` };
      }
    }
    for (const studioId of running) {
      const doc = await deps.latestEnvelope(studioId);
      if (doc && isUnfinished(doc)) {
        return {
          quiescent: false,
          reason: `${studioId} last envelope unfinished (intent=${doc.envelope.intent} status=${doc.payload.status})`,
        };
      }
    }
    return { quiescent: true };
  } catch (err) {
    // FAIL-CLOSED. A broken check never means done.
    return { quiescent: false, reason: `check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Two CONSECUTIVE quiescent sweeps before stopping. One flaps: a studio
 * between tasks, a PR merged seconds before the sweep and its follow-up not
 * yet filed, both read quiescent for a single 20-minute window and are not.
 */
export const QUIESCENT_SWEEPS_REQUIRED = 2;

export function nextStreak(previous: number, verdict: QuiescenceVerdict): number {
  return verdict.quiescent ? previous + 1 : 0;
}

export function shouldStop(streak: number): boolean {
  return streak >= QUIESCENT_SWEEPS_REQUIRED;
}
