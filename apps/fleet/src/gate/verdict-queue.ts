// #1276 item 3: the queue of gate/verdict posts a rate limit kept from landing.
//
// A terminal verdict (or the watchdog's final error/failure) that GitHub
// refused for quota is NOT lost: it is queued here and re-posted by the
// every-minute cron once GitHub's own reset time passes. Without this, the
// ~73 measured status-post failures in one window left PRs with no verdict and
// the merge gate blocked on them.
//
// Shape mirrors drain.ts's gateDrainQueue: one JSON array over fleet_state,
// keyed by GATE_VERDICT_QUEUE_KEY, with append/remove as single D1 statements
// (json_insert / json_remove by path) so a concurrent append and a drain
// remove never lose an entry.

/** One verdict post that still has to land. `state` is terminal only — a
 *  pending post that failed is re-issued by the run's own post-pending step,
 *  never queued here. */
export interface QueuedVerdictPost {
  repo: string;
  sha: string;
  state: "success" | "failure" | "error";
  description: string;
  /** ms epoch: the post is retried only once now() >= this. Set to the GitHub
   *  reset time when it is known, else a fixed default wait. */
  resetAt: number;
}

export const GATE_VERDICT_QUEUE_KEY = "gate_verdict_posts";

/** When GitHub gives no reset hint, this is how long a queued post waits before
 *  its first retry (a minute, matching the cron's own cadence). */
export const VERDICT_POST_DEFAULT_RETRY_MS = 60_000;

/** The D1-backed queue, injected so tests can fake it and the env wiring stays
 *  the only place that touches the database. */
export interface VerdictQueue {
  peek(): Promise<QueuedVerdictPost[]>;
  append(post: QueuedVerdictPost): Promise<void>;
  remove(post: QueuedVerdictPost): Promise<void>;
}

/** `resetAt` from a rate limit's reset hint, or a default minute out when there
 *  is none. The hint (when present) is GitHub's own "when we will accept a
 *  post again", so the queue never retries before the upstream said it would. */
export function verdictPostResetAt(resetInMs: number | null, now: number): number {
  return now + (resetInMs ?? VERDICT_POST_DEFAULT_RETRY_MS);
}