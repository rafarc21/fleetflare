// The REJECTING deadline idiom's one src/ home (sweep-6 F4, refs #450):
// timer + Promise.race + cleared-timer-on-every-settle. Deliberately
// dependency-free — same rule as src/base64.ts's header:
// container/Dockerfile.studio ships container/ into the image but never
// apps/fleet/src/, and an import here would drag the Worker type graph
// into the cli/bun tsconfig projects.

/**
 * Races `promise` against a deadline that REJECTS. The timer is armed via
 * `setTimeoutFn` (injectable for tests) for `timeoutMs`, and cleared before
 * the caller's own reaction can run — a fast settle must never leak a timer
 * that holds the isolate alive for the full budget. When the deadline wins,
 * the rejection is exactly `makeTimeoutError()`'s Error; when the promise
 * wins, its own value or rejection propagates unchanged. `makeTimeoutError`
 * runs only on the deadline path, so a fast settle never pays to construct
 * one.
 */
export function raceWithDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeTimeoutError: () => Error,
  setTimeoutFn: typeof setTimeout = setTimeout,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, deadlineReject) => {
    // WHY the error is built here, inside the timer callback: constructing
    // it eagerly would call makeTimeoutError() on every fast settle, which
    // sbExec's abandoned-set side work (which lives in its factory closure)
    // must not do.
    timer = setTimeoutFn(() => deadlineReject(makeTimeoutError()), timeoutMs);
  });
  // WHY the race's own promise is returned, with cleanup attached as its
  // FIRST reaction instead of a trailing `.finally`:
  // 1. Promise reactions run FIFO, so cleanup runs BEFORE any caller
  //    reaction — the caller resuming on a fast settle sees the timer
  //    already cleared, exactly like the inline idiom this replaces, whose
  //    `finally { clearTimeout }` ran before the enclosing async function's
  //    own promise settled. A `.finally` here would clear it one microtask
  //    AFTER the caller resumes instead.
  // 2. `raced.then(cleanup, cleanup)` also marks the race's rejection
  //    handled at construction. A caller that attaches its own catch
  //    across an await boundary (every fake-clock consumer advances the
  //    clock, then asserts on the rejection) never trips the host's
  //    unhandledRejection check while the rejection sits unobserved.
  //    Reactions multicast, so every later .then/.catch still sees the
  //    exact same settle value or rejection — awaiting callers observe no
  //    difference.
  const raced = Promise.race([promise, deadline]);
  const cleanup = () => clearTimeout(timer);
  raced.then(cleanup, cleanup);
  return raced;
}
