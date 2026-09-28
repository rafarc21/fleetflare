// #151 — `fleet attach` liveness, pure (no Bun globals) so tests import it
// directly, same reason cli/inspect-request.ts is split out.
//
// Measured 2026-09-24: a viewer socket stayed ESTABLISHED for hours with
// nothing on it, and the CLI showed that frozen frame as if it were live —
// two coordinators trusted it for 20+ minutes.

/** Silence past this means a dead view, not a quiet one: tmux redraws its
 *  status-line clock every minute, so a live pty never goes 90s frameless. */
export const ATTACH_STALE_MS = Number(process.env.FLEET_ATTACH_STALE_MS ?? 90_000);

/** An upgrade with no answer in this long is abandoned and retried (#48
 *  point 3: an attach that never settles leaves the upgrade pending forever).
 *  #123/#151 merge: a cold first attach measured ~15s, so 15s flapped on a
 *  slow cold start — 30s is issue #123's original CONNECT_TIMEOUT_MS. */
export const ATTACH_CONNECT_TIMEOUT_MS = Number(process.env.FLEET_ATTACH_CONNECT_TIMEOUT_MS ?? 30_000);

/** `HH:MM:SS` in UTC. */
export function hhmmssZ(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 19)}Z`;
}

/** The terminal title, one of three states:
 *  - "waiting": the socket is open but no frame has arrived yet (issue
 *    #151's own bug was a joiner that opened and then went silent forever —
 *    a title that already says "live" on open hides exactly that).
 *  - "live": at least one frame has arrived, and it was recent.
 *  - `{ since, now }`: `STALE <age> since <HH:MM:SS>Z`, measured from the
 *    last frame that arrived (or from open, if none ever did). */
export function attachTitle(id: string, state: "waiting" | "live" | { since: number; now: number }): string {
  if (state === "waiting") return `fleet ${id} · waiting for first frame`;
  if (state === "live") return `fleet ${id} · live`;
  return `fleet ${id} · STALE ${Math.round((state.now - state.since) / 1000)}s since ${hhmmssZ(state.since)}`;
}

/** #206: which `attachTitle` state `title` is for studio `id`, or null when
 *  it is not this studio's attach title. Built from `attachTitle` itself so
 *  the reader can never drift from the writer. */
export function attachTitleState(id: string, title: string | undefined): "waiting" | "live" | "stale" | null {
  if (title === attachTitle(id, "waiting")) return "waiting";
  if (title === attachTitle(id, "live")) return "live";
  const probe = attachTitle(id, { since: 0, now: 0 });
  const at = probe.indexOf(" STALE ");
  // Fail closed: a reworded writer must never turn the prefix into a catch-all.
  if (at < 0) return null;
  return title?.startsWith(probe.slice(0, at + " STALE ".length)) ? "stale" : null;
}

/** OSC 0: set the terminal window/tab title. */
export function titleSequence(title: string): string {
  return `\x1b]0;${title}\x07`;
}
