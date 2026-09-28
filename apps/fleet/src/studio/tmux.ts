/**
 * The one place the Worker names the tmux binary (issue #117).
 *
 * WHY: bring-up has always run the studio session on tmux's DEFAULT server,
 * so any plain `tmux` — a real-tmux test's `kill-server`, a debugging shell —
 * addresses the lead's own server. That killed fleetflare--web-studio's lead
 * twice on 2026-09-24 and three leads on 2026-09-18. The durable fix moves the
 * studio session to a private socket, `tmux -L fleet-studio`, which is an
 * IMAGE change (studio-bringup.sh, studio-shell.sh) and ships only in a
 * batched container window.
 *
 * The Worker half ships first and must not be a flag day: every command the
 * Worker hands sbExec reaches the lead on EITHER server. `withStudioTmux`
 * prefixes a command with a shell function, `__ff_tmux`, that re-probes on
 * every call — the private socket when it holds a `studio` session, the
 * default server otherwise — and passes its arguments through `"$@"`
 * untouched. Re-probing per call (not once per command) matters for
 * provisionedCheckCmd, whose loop polls for up to 20 s while bring-up may
 * still be creating the session.
 *
 * `has-session` on a socket with no server exits non-zero and starts
 * nothing, so the probe is invisible on an old image. `=studio` matches the
 * name EXACTLY: bare `-t studio` falls back to a prefix match, so a session
 * named `studio-old` on the private socket would pass the probe and take the
 * lead's wakes. The function name is
 * namespaced (`__ff_`) because sbExec runs in the container's ONE long-lived
 * session shell, where a definition persists after the command; redefining
 * it each time is harmless, shadowing `tmux` itself would not be.
 *
 * IMAGE HALF, for the batched window: every container-side tmux call must
 * name `-L ${STUDIO_TMUX_SOCKET}` — bring-up's new-session/pipe-pane/
 * set-option/relaunch, studio-shell.sh's attach, and any other script. Once
 * every container runs that image the default-server fallback here is dead
 * code and can go.
 */

/** The private tmux socket (`tmux -L <this>`) the studio session moves to. */
export const STUDIO_TMUX_SOCKET = "fleet-studio";

/** The shell word a command built with `withStudioTmux` uses in place of
 *  `tmux`. */
export const STUDIO_TMUX = "__ff_tmux";

const DEFINE =
  `${STUDIO_TMUX}() { ` +
  `if tmux -L ${STUDIO_TMUX_SOCKET} has-session -t =studio 2>/dev/null; ` +
  `then tmux -L ${STUDIO_TMUX_SOCKET} "$@"; else tmux "$@"; fi; }; `;

/** `cmd`, prefixed with the `__ff_tmux` definition it calls tmux through. */
export function withStudioTmux(cmd: string): string {
  return DEFINE + cmd;
}
