// Board issue #198: a shared wall-clock budget for one push's auto-close
// work -- Path 1's commit walk (src/github/promote-close.ts), Path 2's
// candidate scan (src/board/pr-landed.ts), and the close loop that follows
// both (src/github/webhook.ts's closeEach). Computed ONCE per push, from a
// LIVE `now()` call, not a `Date.now()` snapshot taken when the webhook
// arrived -- the budget exists to catch ELAPSED time during a scan that can
// run long, which a single frozen number can never measure.
//
// A single shared deadline across the whole push (not one budget per phase,
// per loop) is the more literal reading of issue #198's own "~25s budget
// across both phases" text, and it is simpler: one `deadline`, computed once
// in src/github/webhook.ts's `prepareAutoClose`, threaded through
// `AutoCloseSetup` to every loop site below that could run long. See that
// file's own header for why the whole of `autoCloseOnPromote` -- Path 1
// included -- now needs this, not just Path 2.

/** `clock` is called repeatedly, not once -- that repetition IS how elapsed
 *  time is measured. `deadline` is an absolute point on that same clock's
 *  timeline, fixed the moment the budget was created. */
export interface TimeBudget {
  clock: () => number;
  deadline: number;
}

/**
 * ~25s, issue #198's own starting number: comfortably inside a Cloudflare
 * `waitUntil` extension's own execution ceiling (~30s -- see
 * src/board/pr-landed.ts's own header on why that ceiling matters even once
 * nothing here is awaited by the HTTP response any more), with margin left
 * for the close loop that runs after both scans.
 */
export const AUTO_CLOSE_BUDGET_MS = 25_000;

export function makeTimeBudget(clock: () => number, budgetMs: number = AUTO_CLOSE_BUDGET_MS): TimeBudget {
  return { clock, deadline: clock() + budgetMs };
}

/**
 * `undefined` reads as "no budget configured" -- never exceeded. Every call
 * site that takes an optional budget but may be reached from a caller
 * outside the webhook's own push flow (e.g. src/studio/task-reap.ts's
 * poll-triggered scan, which has no 25s-response deadline to protect) keeps
 * its old, unbounded-by-time behavior unless a budget is actually threaded
 * in.
 */
export function budgetExceeded(budget: TimeBudget | undefined): boolean {
  return budget !== undefined && budget.clock() >= budget.deadline;
}
