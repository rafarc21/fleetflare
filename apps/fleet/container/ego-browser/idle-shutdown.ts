/**
 * Pure idle-shutdown scheduling logic for daemon.ts (board issue #32).
 * Deliberately has no Bun/playwright-core import and does no I/O -- same
 * spirit as registry.ts: fast, deterministic, unit-testable on its own via
 * injected fake timers and state predicates. daemon.ts is the only module
 * that plugs real state (registry.list().length, process.exit) in here;
 * the in-flight request counter lives inside this class now.
 *
 * See docs/plans/2026-09-23-ego-browser-idle-shutdown.md for the full
 * design/tension writeup. Short version: the daemon must shut itself down
 * once idle with ZERO task spaces open (nothing left to preserve), but must
 * never shut down while a space is still open and expected to be resumable
 * by a later, separate `ego-browser` invocation -- that persistence
 * contract is the entire reason this daemon exists.
 */

/** Same override-via-env style as paths.ts's EGO_BROWSER_HOME: trimmed,
 * parsed as a number, falling back to a sane default (1 minute) on
 * anything missing or unparsable. Tests override this to a tiny value
 * (e.g. "500") so they don't have to wait out a real minute. */
export function resolveIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EGO_BROWSER_IDLE_MS?.trim();
  if (!raw) return 60000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
}

export interface IdleShutdownOptions {
  idleMs: number;
  /** True when zero task spaces remain open, read fresh each time it's called. */
  spacesEmpty: () => boolean;
  onIdle: () => void | Promise<void>;
  /** Injectable for tests -- real daemon.ts uses the platform globals. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * A single re-armable idle timer. `schedule()` is meant to be called after
 * every daemon startup and after every RPC request settles (resolve OR
 * throw) -- any request can be the one that took the space count to zero
 * (space.finish) or away from zero (taskSpace), so every request needs to
 * re-arm this.
 */
export class IdleShutdown {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleMs: number;
  private readonly spacesEmpty: () => boolean;
  private readonly onIdle: () => void | Promise<void>;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private inFlight = 0;

  constructor(opts: IdleShutdownOptions) {
    this.idleMs = opts.idleMs;
    this.spacesEmpty = opts.spacesEmpty;
    this.onIdle = opts.onIdle;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  }

  /**
   * Clears any pending timer first (only ever one live timer at a time),
   * then arms a fresh one ONLY if spaces are empty right now. If a space is
   * open, there is nothing to arm -- a later call (the request that closes
   * the last space) will schedule correctly when that actually happens.
   *
   * `overrideMs`, when given, arms with that duration instead of the
   * configured `idleMs` for THIS call only (daemon.ts's one startup call
   * site is the only caller that ever passes it -- see its own comment for
   * why: board #36's live reproduction found the real daemon
   * self-destructing before the very client that spawned it had sent its
   * first byte, because the startup call armed the same short idleMs a
   * test/config might use, with no allowance for spawn+connect overhead).
   * Every other call (track()'s finally, after a real request has actually
   * settled) keeps calling schedule() with no argument, so the steady-state
   * idle window is completely unaffected.
   */
  schedule(overrideMs?: number): void {
    if (this.timer !== undefined) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
    if (!this.spacesEmpty()) return;

    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined;
      // Re-check at fire time: state can have changed in the idle window
      // (a new task space opened), or a request that will soon push the
      // space count away from zero can be genuinely in flight right now
      // (past the point registry.list().length still reads 0, not yet
      // past the point it becomes 1) -- see the plan doc's race section.
      // If either check fails, this fired timer is just a no-op: the
      // in-flight request's own completion re-arms via track()'s finally,
      // and that re-arm sees the real, settled state.
      if (this.spacesEmpty() && this.inFlight === 0) {
        void this.onIdle();
      }
    }, overrideMs ?? this.idleMs);
  }

  /**
   * Wraps one RPC request: the in-flight counter is this module's own
   * state now, callers never touch it (the fire-time in-flight re-check
   * is the create-space race guard), and every settled request re-arms
   * the idle window with the plain configured idleMs.
   */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      this.schedule();
    }
  }
}
