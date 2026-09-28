// Reconnect delay for `fleet attach`'s WS reconnect loop. Pure — no timers,
// no I/O — so it is exercised directly by test/cli.backoff.test.ts rather
// than through a live reconnect.
//
// Shape (controller ruling, ledgered in progress.md against a plan/test
// mismatch: interface text said jitter ±25%, tests are the authority):
// exponential doubling from a 500ms base, capped at 10_000ms BEFORE jitter,
// then a PLUS-ONLY jitter of [0, +25%] is applied on top — so a capped
// attempt can still land up to 12_500ms, never below the capped/uncapped
// exponential value itself. `rnd` defaults to Math.random but is injectable
// so callers (tests) can pin the jitter and assert exact bounds.
const BASE_MS = 500;
const CAP_MS = 10_000;
const JITTER_MAX = 0.25;

/** `attempt` is 1-based — the first reconnect try is attempt 1. Values below
 *  1 are clamped so a caller bug (attempt 0, a negative count) still yields
 *  a sane delay instead of a smaller-than-base or negative-exponent result. */
export function reconnectDelayMs(attempt: number, rnd: () => number = Math.random): number {
  const doublings = Math.max(0, attempt - 1);
  const exp = Math.min(BASE_MS * 2 ** doublings, CAP_MS);
  return exp * (1 + rnd() * JITTER_MAX);
}

/**
 * Reconnect floor-loop (P1 T10 ledger / P2 ride-along): a connection that
 * closes within 5s of opening must NOT reset the backoff counter, or an
 * open-then-1011 studio (server accepts the WS, then kills it almost
 * immediately — a crash-looping pty is the realistic case) gets hammered at
 * the ~500ms base delay forever instead of backing off. Before this, the
 * caller reset `attempt` to 0 unconditionally on every WS "open" event,
 * regardless of how quickly that connection then died.
 *
 * `attempt` only resets to 0 when the PRIOR connection actually survived
 * past the floor; otherwise it carries forward unchanged (the caller still
 * increments it once more for the attempt about to run — see cli/fleet.ts's
 * reconnect loop). Pure — table-tested directly below.
 * page/terminal.template.html inlines the identical 3-line body (that file
 * ships with no bundler/import of its own — same reason reconnectDelayMs
 * above is hand-copied there too), pinned against this source by
 * test/cli.backoff.test.ts's source-pin test.
 */
export function nextAttempt(prevAttempt: number, connLifetimeMs: number): number {
  return connLifetimeMs >= 5000 ? 0 : prevAttempt;
}

/**
 * Issue #123: a stopped or destroying studio answers its terminal route with
 * a 409 refusal instead of starting a container. The WebSocket handshake
 * hides the status, so after a failed connection `fleet attach` probes the
 * same route with a plain GET: 409 = refused (its message, printed once, and
 * the client exits); anything else, or no answer at all, = keep reconnecting.
 */
export async function attachRefusal(probe: () => Promise<Response>): Promise<string | null> {
  let res: Response;
  try {
    res = await probe();
  } catch {
    return null;
  }
  if (res.status !== 409) return null;
  const text = await res.text();
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text;
  }
}
