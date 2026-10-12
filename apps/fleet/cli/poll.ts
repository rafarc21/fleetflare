// cli/poll.ts — the bounded poll-loop shape ff's attach-wait and accounts
// --watch share (#404). Clock/sleep injected so tests pin the budget math —
// the budget counts from `at`, not loop entry; ff.ts's operator-facing lines
// print Math.round'd elapsed seconds, so that rounding lives here, once.
interface PollOpts<T> {
  /** The start the budget counts from, NOT loop entry: ff's spawn POST
   *  blocks for most of a bring-up, and the wait must not get a fresh
   *  budget on top of that. */
  at: number;
  /** Absent = unbounded (accounts --watch runs until SIGINT). */
  budgetMs?: number;
  /** Between reads. Callers own the timings; this module owns none. */
  sleepMs: number;
  /** Test seam — default Date.now. */
  now?: () => number;
  /** Test seam — default Bun.sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** One iteration's read; the first non-null value resolves the poll. */
  read: () => Promise<T | null>;
  /** Fires after each null read, in elapsed whole seconds. */
  tick?: (elapsedSecs: number) => void;
}

/** Read, then budget, then tick+sleep: a read that succeeds on the budget's
 *  final instant attaches rather than timing out, and the timeout fires the
 *  moment the budget is spent, not a sleep later. */
export async function poll<T>(
  opts: PollOpts<T>,
): Promise<T | { timedOut: true; elapsedSecs: number }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? Bun.sleep;
  for (;;) {
    const v = await opts.read();
    if (v !== null) return v;
    const elapsedMs = now() - opts.at;
    if (opts.budgetMs !== undefined && elapsedMs >= opts.budgetMs) {
      return { timedOut: true, elapsedSecs: Math.round(elapsedMs / 1000) };
    }
    opts.tick?.(Math.round(elapsedMs / 1000));
    await sleep(opts.sleepMs);
  }
}

/** Heartbeat for a long blocking call (ff's spawn/provision POSTs). Returns
 *  its own stopper — the interval must be cleared or it keeps the process
 *  alive after the work is done. */
export function ticker(
  what: string, tickMs: number, say: (line: string) => void, now: () => number = Date.now,
): () => void {
  const started = now();
  const timer = setInterval(() => say(`${what}... (${Math.round((now() - started) / 1000)}s)`), tickMs);
  return () => clearInterval(timer);
}
