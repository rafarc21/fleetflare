import { checkQuiescence, nextStreak, shouldStop, QUIESCENT_SWEEPS_REQUIRED, type QuiescenceDeps, type QuiescenceVerdict } from "./quiescence";
import type { WakeOutcome } from "./wake";

/**
 * The sweep — maestro's crash detector, and its heartbeat.
 *
 * NOT a fallback for the webhook. Studios emit no events: a container that
 * dies, goes bare, or leaves READY stale produces no GitHub delivery and no
 * Cloudflare signal of any kind. The sweep is the ONLY thing that ever
 * notices. It stays even with webhooks live.
 *
 * 20 minutes, reset by every wake (webhook or sweep), so a busy fleet fires
 * zero sweeps and an idle one fires three an hour until it goes quiescent.
 */
export const SWEEP_SECONDS = 20 * 60;

export const SWEEP_COUNT_KEY = "sweepCount";
export const QUIESCENT_STREAK_KEY = "quiescentStreak";
/** Set when the sweep chain stopped itself; the recorded end state. Cleared
 *  by armSweep, which is what re-arming means. */
export const SWEEP_STOPPED_KEY = "sweepStoppedAt";

/** The DO-storage slice this tick touches — the same narrow-port style
 *  StudioStorage/SessionSyncStorage take, so the tick is testable over a Map. */
export interface SweepStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface SweepDeps {
  quiescence: QuiescenceDeps;
  /**
   * Is this studio stopped? Asked FIRST, before anything touches the
   * container: `sbExec` STARTS a container that is not running, so a sweep
   * that woke a stopped studio would resurrect one the operator deliberately
   * shut down — every 20 minutes, forever. Stopping a studio is the only off
   * switch the sweep has.
   */
  isStopped: () => Promise<boolean>;
  wake: (prompt: string) => Promise<WakeOutcome>;
}

/**
 * One line, always: a literal newline in the claude TUI submits the turn, so
 * a two-line prompt would arrive as two half-prompts.
 */
export function sweepPrompt(n: number, verdict: QuiescenceVerdict, final: boolean): string {
  const head = `WAKE SWEEP #${n}`;
  if (final) {
    return `${head} | FINAL — fleet quiescent ${QUIESCENT_SWEEPS_REQUIRED} consecutive sweeps. ` +
      "Emit the FINAL wave and record end state. Sweeps stop after this one.";
  }
  if (verdict.quiescent) {
    return `${head} | quiescent 1 of ${QUIESCENT_SWEEPS_REQUIRED} consecutive sweeps | report a wave, then act unprompted.`;
  }
  const reason = verdict.reason.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return `${head} | fleet NOT quiescent: ${reason} | report a wave, then act unprompted.`;
}

export interface SweepResult {
  stop: boolean;
  /** Why the chain ended, or null while it continues. Two different reasons
   *  end it, and a caller that could not tell them apart would report a
   *  deliberately stopped studio as a finished fleet. */
  why: "quiescent" | "studio-stopped" | null;
  verdict: QuiescenceVerdict;
  wake: WakeOutcome;
}

/**
 * One sweep: decide, wake, and say whether the chain should end.
 *
 * `stop` is true only on a fully decided path — two consecutive confirmed-
 * quiescent sweeps AND a FINAL wave that actually landed. Every other outcome,
 * including a quiescence check that threw, leaves it false so the caller's
 * `finally` re-arms. Ending supervision on a wave nobody received is the one
 * way this feature could fail silently.
 */
export async function sweepTick(deps: SweepDeps, storage: SweepStorage): Promise<SweepResult> {
  if (await deps.isStopped()) {
    // No wake, no sweep number, no streak change: this studio is off, not
    // finished. provision/restart re-arms — see StudioDO.armSweep.
    return {
      stop: true, why: "studio-stopped",
      verdict: { quiescent: false, reason: "studio stopped" },
      wake: { ok: false, error: "skipped: studio stopped" },
    };
  }
  const n = ((await storage.get<number>(SWEEP_COUNT_KEY)) ?? 0) + 1;
  await storage.put(SWEEP_COUNT_KEY, n);

  const verdict = await checkQuiescence(deps.quiescence);
  const streak = nextStreak((await storage.get<number>(QUIESCENT_STREAK_KEY)) ?? 0, verdict);
  await storage.put(QUIESCENT_STREAK_KEY, streak);

  const final = shouldStop(streak);
  const wake = await deps.wake(sweepPrompt(n, verdict, final));
  const stop = final && wake.ok;
  if (stop) await storage.put(SWEEP_STOPPED_KEY, new Date().toISOString());
  return { stop, why: stop ? "quiescent" : null, verdict, wake };
}
