#!/usr/bin/env bash
# Root process of the studio's pty — NOT a bring-up step.
#
# The SDK's PtyOptions has exactly one command knob, `shell`, and the
# container spawns it as `Bun.spawn([shell])`: ONE argv element, no shell
# parsing, no arguments (read from the pinned container image's own
# /container-server/dist/index.js, class h8's `initialize`:
# `let Y = $.shell ?? "bash"; this.process = Bun.spawn([Y], {terminal: ...})`).
# A compound command therefore cannot be passed inline — it has to be a real
# executable, which is what this file is. src/studio/sandbox-api.ts passes its
# absolute path (STUDIO_SHELL) to proxyTerminal.
#
# Everything below exists because the spec's terminal is "attach lands you in
# the shared tmux session", with no typing, from the Mac, the phone, and every
# automatic reconnect.
set -u

# --- 0. which tmux server holds the studio (issue #117) ---------------------
# The studio session lives on `tmux -L fleet-studio` (studio-bringup.sh), so
# a plain `tmux` from a test or a debugging shell cannot reach the lead. This
# prints the socket arguments for the server that holds `studio`, re-probed
# on every call: fleet-studio first; the default server when only it has one
# (a session an older bring-up created, during the rollout); and fleet-studio
# when neither does, because that is where bring-up will look. Arguments,
# not a function wrapping tmux, because `setsid` below execs tmux directly.
studio_socket() {
  if tmux -L fleet-studio has-session -t =studio 2>/dev/null; then
    echo "-L fleet-studio"
  elif tmux has-session -t =studio 2>/dev/null; then
    :
  else
    echo "-L fleet-studio"
  fi
}

# --- 1. let bring-up win the race for the session ---------------------------
# studio-bringup.sh is what creates the `studio` session in the normal flow
# (provision runs before anyone attaches), and the tmux SERVER it starts
# captures ITS environment — including the per-exec ROLE_PROMPT_B64 /
# ROLE_ALLOWED_TOOLS that only the bring-up exec carries. A pty that raced
# ahead and created the session itself would give every later pane a server
# environment missing those. So wait ~10s for bring-up's session before
# falling back to creating one.
#
# The fallback is still a real recovery path, not a formality: a pty opened
# against a container that recycled without a re-provision would otherwise sit
# on a blank screen forever. It creates the session with window 0 named
# `claude` precisely so a LATER bring-up heals it — that script keys its
# claude (re)launch off `studio:claude`'s `pane_current_command`, which only
# resolves if a window by that name exists.
for _ in $(seq 1 20); do
  # shellcheck disable=SC2046 # word-split on purpose: "" or "-L fleet-studio"
  tmux $(studio_socket) has-session -t studio 2>/dev/null && break
  sleep 0.5
done

# --- 2. attach, forever -----------------------------------------------------
# `setsid --ctty` is load-bearing, not hygiene. The container opens the pty
# without making it a controlling terminal (measured in the real image: bash
# starts with "cannot set terminal process group (1)" and no job control), and
# with no controlling terminal there is no foreground process group for the
# kernel to signal — so TIOCSWINSZ changes the window size but SIGWINCH is
# never delivered. That is the whole root cause of the "resize does not reach
# tmux" behaviour: tmux only re-reads its size on SIGWINCH. Measured, same
# image, same Bun.Terminal: without setsid a `trap ... WINCH` never fires and
# tmux keeps drawing at the old size; with `setsid --ctty` it fires on every
# resize. `--wait` keeps this script as the parent so the loop below can run.
#
# The loop is what makes ctrl-b d harmless. The container caches ONE pty per
# session and never clears it when the process exits (`getPty` returns
# `session.pty` unconditionally; only session teardown nulls it), so a pty
# whose root process ends leaves the studio's terminal permanently dead —
# every later attach gets a 101 onto a closed pty. Re-attaching instead of
# exiting means a detach is just a redraw.
while true; do
  # `-d` detaches every other client as this one attaches. A studio has one
  # operator but accumulates clients (each `fleet attach`, plus sockets whose
  # drop tmux has not noticed yet); leaving them attached is what makes tmux
  # size the window to the smallest of them and lets each redraw its own
  # status line over the others.
  # Land on claude, not on whatever window happened to be current. The
  # studio's point IS the claude window; the shell window exists for
  # diagnostics, and anything that touched it (an operator, a headless
  # probe) otherwise leaves the NEXT attach staring at a bash prompt and
  # concluding the studio is dead. Selecting before attaching means the
  # client's first paint is already the right window.
  sock="$(studio_socket)"
  # shellcheck disable=SC2086 # word-split on purpose: "" or "-L fleet-studio"
  tmux $sock select-window -t studio:claude 2>/dev/null || true
  # shellcheck disable=SC2086
  setsid --ctty --wait tmux $sock attach -d -t studio 2>/dev/null \
    || setsid --ctty --wait tmux $sock new-session -A -s studio -n claude
  sleep 0.3
done
