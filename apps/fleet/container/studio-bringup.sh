#!/usr/bin/env bash
# Studio bring-up. Invoked BARE (src/studio/provision.ts's BRINGUP_CMD, the
# literal string "/opt/fleet/studio-bringup.sh") on EVERY provision AND every
# restart — Task 4 controller ruling: this script IS the entire bring-up
# exec, no separate "tailscale up" call from the Worker side. Every step
# below therefore guards itself: double-running this script must be a no-op,
# never a double-start.
#
# Does NOT touch /workspace/.git-credentials — src/studio/do.ts's
# runRefreshCredential writes that file via its own sbExec call, always
# BEFORE this script runs (provision()'s ordering). Nothing here reads
# GH_TOKEN either: the GitHub token is minted and written Worker-side, never
# handed to this container as an env var.
#
# CLAUDE_CODE_OAUTH_TOKEN is never referenced by name below — `claude` reads
# it straight from its process environment (the same assumption
# container/server.ts's bare `Bun.spawn(["claude", ...])` makes). This script
# is the first thing to ever run `tmux new-session` in a fresh container, so
# the tmux SERVER's captured environment IS this script's own environment;
# every pane tmux creates afterward inherits it automatically.
set -euo pipefail

# --- the studio's own tmux server (issue #117) ------------------------------
# Every tmux call in this script goes to `tmux -L fleet-studio`, never the
# default server. MEASURED 2026-09-24: with the studio on the DEFAULT server,
# a plain `tmux kill-server` in a real-tmux test run inside the studio killed
# fleetflare--web-studio's lead twice; three leads died the same way on
# 2026-09-18. On its own socket, the default server is free for tests,
# debugging shells and anything the lead runs, and none of them can reach it.
#
# A function, not a flag at each call site, so no call can be missed and the
# test harness runs these exact bytes. Scoped to THIS script: it is not
# exported, so nothing bring-up starts inherits it, and the lead is launched
# with TMUX/TMUX_PANE stripped (see cmd_str below) so its own plain `tmux`
# reaches the default server too. The socket name is the Worker's
# STUDIO_TMUX_SOCKET (src/studio/tmux.ts), whose withStudioTmux probes it
# first and falls back to the default server for containers on an older image.
tmux() {
  command tmux -L fleet-studio "$@"
}

# --- bring-up log (issue #38) -----------------------------------------------
# WHY THIS EXISTS. Measured 2026-09-23: a deploy bumped the studio image
# digest, Cloudflare replaced every running container, and SIX `acme-os`
# studios came back BARE -- /workspace EMPTY, no clone, the claude pane
# running `bash`. Nothing anywhere recorded why. /var/log held nothing,
# `find / -maxdepth 4 -name "*bringup*log*"` returned nothing, and this
# script ran and left no trace of where it got to. The only forensic
# evidence was indirect -- the mtimes of /workspace/.fleet/
# remote-branches.txt and working-set.md, read from inside a container
# shell, which is not a diagnostic an operator can reach from `fleet ls`.
#
# So: every step below announces itself here, timestamped and tagged with a
# run id, into a file that SURVIVES the run. Appended, never truncated, so
# the failed run and the retry that follows it sit side by side in one
# stream (that pairing is the whole of issue #38 part 3).
#
# WHERE. `${FLEET_WORKSPACE:-/workspace}/.fleet/bringup.log` -- the same
# directory working-set.md already lives in, ONE LEVEL ABOVE any studio's
# checkout and deliberately outside it (see src/studio/provision.ts's
# discoverRescueRefsCmd doc comment for why a file inside the checkout
# defeats the rescue-push fast path and gets swept into rescue commits).
# It lives on the container filesystem, so it dies with the container --
# which is the right lifetime: the log is about THIS container's own
# bring-up, and a hollow replaced container is the one still alive when an
# operator asks.
#
# NO SECRETS, and this is a hard requirement rather than advice precisely
# BECAUSE the file survives the run. `bringup_redact` below covers the same
# shapes src/studio/redact.ts's `redactSecrets` covers, shape for shape --
# test/bun/bringup-log.test.ts asserts that equivalence by running this
# filter and that function over the same specimens and comparing the two
# outputs, so the two can never drift apart silently. Nothing here is ever
# printed into the claude pane, which matters separately: the pane is
# pipe-pane'd to /workspace/.transcript/claude.log and shipped to R2, so
# pane output leaves the container entirely.
#
# Every knob is an env-var seam of the same kind FLEET_WORKSPACE already is:
# production sets none of them, so the defaults here ARE the production
# values, and test/bun/bringup-log.test.ts can pin a run id and a log path
# without a container.
FLEET_BRINGUP_LOG="${FLEET_BRINGUP_LOG:-${FLEET_WORKSPACE:-/workspace}/.fleet/bringup.log}"
FLEET_BRINGUP_LOG_MAX_LINES="${FLEET_BRINGUP_LOG_MAX_LINES:-4000}"
# Sortable UTC stamp plus 8 hex from the kernel's own uuid source -- already
# relied on elsewhere in this script (the transcript boot-id) and therefore a
# kernel feature rather than an extra binary dependency in this image.
FLEET_BRINGUP_RUN_ID="${FLEET_BRINGUP_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(cut -c1-8 /proc/sys/kernel/random/uuid 2>/dev/null || echo 00000000)}"
FLEET_BRINGUP_STEP=""
FLEET_BRINGUP_STDERR_TMP=""

# The redactor. Mirrors src/studio/redact.ts's seven regexes in the SAME
# order that file applies them, one `-e` per shape so each stays
# independently readable and greppable -- the exact reason that file keeps
# them as seven named constants instead of one alternation.
#
# `sed` is line-oriented while redactSecrets runs over a whole string; the
# only pattern where that could differ is the Bearer one (JS `\s` matches a
# newline, POSIX `[[:space:]]` inside a line-scoped sed cannot), and a
# header value split across two lines is not a shape this log can produce.
bringup_redact() {
  sed -E \
    -e 's/ghs_[A-Za-z0-9]+/«redacted»/g' \
    -e 's/github_pat_[A-Za-z0-9_]+/«redacted»/g' \
    -e 's/gh[pour]_[A-Za-z0-9]+/«redacted»/g' \
    -e 's/tskey-auth-[A-Za-z0-9-]+/«redacted»/g' \
    -e 's/sk-ant-[A-Za-z0-9_-]+/«redacted»/g' \
    -e 's/fsp_[0-9a-f]+/«redacted»/g' \
    -e 's/[Bb][Ee][Aa][Rr][Ee][Rr][[:space:]]+[^[:space:]]+/Bearer «redacted»/g' \
    -e 's|([Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]:[[:space:]]*[Bb][Aa][Ss][Ii][Cc])[[:space:]]+[A-Za-z0-9+/=]+|\1 «redacted»|g'
}

# One log line: timestamp, run id, message. Redacted on the way in, so the
# file on disk is clean regardless of who called this or with what.
#
# TOTAL -- never fails, never aborts its caller. `2>/dev/null` is placed
# BEFORE the append so that a redirection failure on an unwritable path has
# nowhere to print either, and the trailing `|| true` keeps this script's own
# `set -euo pipefail` out of it. A studio that cannot log is degraded; one
# that cannot boot because logging failed would be dead, and this convenience
# must never be able to do that (the same ruling working-set.md's own
# guarded write already carries below).
bringup_log() {
  [ -n "${FLEET_BRINGUP_LOG:-}" ] || return 0
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${FLEET_BRINGUP_RUN_ID:-unknown}" "$*" \
    | bringup_redact 2>/dev/null >> "$FLEET_BRINGUP_LOG" || true
  return 0
}

# Open a step, and close the previous one with its exit code.
#
# "exit code" is not a guess here: this script runs under `set -e`, so
# REACHING the next step is proof the previous region ran to completion
# without an unguarded failure -- that is the recorded `exit=0`. The one
# region that does NOT get a `step-ok` line is the region that killed the
# run, and bringup_finish names it explicitly as `last-step=`. That pair is
# exactly the forensic question the incident could not answer: which step did
# bring-up reach, and where did it stop.
bringup_step() {
  if [ -n "${FLEET_BRINGUP_STEP:-}" ]; then
    bringup_log "step-ok ${FLEET_BRINGUP_STEP} exit=0"
  fi
  FLEET_BRINGUP_STEP="$1"
  bringup_log "step $1"
}

# The EXIT trap: flush this run's stderr into the log, hand it back to the
# caller verbatim, and record the verdict.
#
# Stderr is BUFFERED to a temp file for the whole run rather than tee'd live
# through a process substitution, on purpose. Every diagnosis this script
# already emits goes to stderr ("declared skill X resolves to NOTHING",
# "session restore verification failed", "python3 missing -- refusing to
# boot"), and before this change those lines existed only inside the sbExec
# result the Worker DISCARDS on a zero exit -- which is precisely the hollow
# container case. A process substitution would risk losing the tail when the
# script exits before the reader drains; a file cannot. Nothing Worker-side
# notices the buffering: sbExec collects stderr after the process has already
# exited, so the bytes it sees, and their order, are unchanged.
#
# The copy that goes into the LOG is redacted. The copy handed back to the
# caller on fd 2 is verbatim, byte for byte what this script printed before
# -- src/studio/provision.ts slices `bringupRes.stderr` into
# StudioStatus.error and applies `redactSecrets` itself at that boundary, and
# changing what it receives here would be a silent behaviour change on a path
# this issue is not about.
bringup_finish() {
  bringup_rc=$?
  if [ -n "${FLEET_BRINGUP_STDERR_TMP:-}" ] && [ -f "$FLEET_BRINGUP_STDERR_TMP" ]; then
    exec 2>&9
    if [ -s "$FLEET_BRINGUP_STDERR_TMP" ]; then
      bringup_redact < "$FLEET_BRINGUP_STDERR_TMP" \
        | sed "s|^|$(date -u +%Y-%m-%dT%H:%M:%SZ) ${FLEET_BRINGUP_RUN_ID:-unknown} stderr |" \
          2>/dev/null >> "$FLEET_BRINGUP_LOG" || true
      cat "$FLEET_BRINGUP_STDERR_TMP" >&2 || true
    fi
    rm -f "$FLEET_BRINGUP_STDERR_TMP" || true
  fi
  bringup_log "end exit=$bringup_rc last-step=${FLEET_BRINGUP_STEP:-none}"
  return $bringup_rc
}

mkdir -p "$(dirname "$FLEET_BRINGUP_LOG")" 2>/dev/null || true
# Appending forever must not fill a container disk. Trimmed at the START of a
# run, never at the end, so the run about to happen always has its full
# budget and the newest evidence is the evidence that survives.
if [ -f "$FLEET_BRINGUP_LOG" ] \
  && [ "$(wc -l < "$FLEET_BRINGUP_LOG" 2>/dev/null || echo 0)" -gt "$FLEET_BRINGUP_LOG_MAX_LINES" ]; then
  { tail -n "$FLEET_BRINGUP_LOG_MAX_LINES" "$FLEET_BRINGUP_LOG" > "$FLEET_BRINGUP_LOG.trim" \
    && mv "$FLEET_BRINGUP_LOG.trim" "$FLEET_BRINGUP_LOG"; } 2>/dev/null || true
fi
FLEET_BRINGUP_STDERR_TMP="$(mktemp /tmp/studio-bringup-stderr.XXXXXX 2>/dev/null || echo "/tmp/studio-bringup-stderr.$$")"
# fd 9 is THE REAL STDERR, always, whether or not the buffer below arms.
# Unconditional so that anything which must not inherit the buffer can say
# `2>&9` without first having to know whether buffering happened -- see the
# tmux-session step, the one long-lived process this script starts.
exec 9>&2
# Only take stderr over if the buffer is genuinely writable. A bare
# `exec 2>file` on an unwritable path kills a non-interactive shell outright,
# which would turn this logging convenience into the one thing it must never
# be: a reason a studio fails to boot.
if : > "$FLEET_BRINGUP_STDERR_TMP" 2>/dev/null; then
  exec 2>"$FLEET_BRINGUP_STDERR_TMP"
else
  FLEET_BRINGUP_STDERR_TMP=""
fi
trap bringup_finish EXIT
bringup_log "start studio=${STUDIO_ID:-unknown} pid=$$ workspace=${FLEET_WORKSPACE:-/workspace}"

# --- memguard (issue #169) ---------------------------------------------------
# Userspace memory killer: SIGTERM/SIGKILL the largest gate before the
# container reaches its cap and thrashes (no kernel OOM kill fires there).
# See container/memguard.ts. `flock -n` makes it single-instance: a re-run of
# this script (heal, provision) starts it only if it died. setsid + no
# inherited fds (9 is the real stderr; 0-2 would hold sbExec's pipes open) so
# it outlives this exec and every lead relaunch.
# Kill log: ${FLEET_WORKSPACE:-/workspace}/.fleet/memguard.log.
bringup_step memguard
# >>> memguard-start >>>
setsid flock -n /run/fleet-memguard.lock bun /opt/fleet/memguard.ts </dev/null >/dev/null 2>&1 9>&- &
disown
# <<< memguard-start <<<

# --- tailscaled ------------------------------------------------------------
# `tailscale status` fails (no daemon socket) iff tailscaled isn't running
# yet. Reused below both as the "already running" guard and, after starting
# it, as the readiness poll — no pgrep/ps dependency (not guaranteed present
# in this image).
bringup_step tailscaled
if ! tailscale status >/dev/null 2>&1; then
  mkdir -p /var/lib/tailscale
  tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale \
    >/var/log/tailscaled.log 2>&1 &
  disown
  for _ in $(seq 1 20); do
    tailscale status >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# --- tailscale up ------------------------------------------------------------
# Local/integration runs have no TS_AUTHKEY — log and continue rather than
# failing the whole bring-up over it.
bringup_step tailscale-up
# >>> tailscale-up >>>
# Issue #395 follow-up, found investigating this exact line: `tailscale
# status --json` pretty-prints (real, live-verified output: `  "BackendState":
# "Running",` — a space after the colon, Go's standard indented-JSON
# encoding), never the bare `"BackendState":"Running"` this check's own
# literal always required. The check has never once matched real tailscale
# output — every bring-up called `tailscale up` unconditionally, regardless
# of whether it was already up. `[[:space:]]*` tolerates that space (and any
# future re-indent) without depending on an exact byte count.
#
# Issue #189: a failed `tailscale up` is NOT fatal. Measured 2026-10-01: a
# full tailnet (`backend error: node quota reached on this tailnet`) exited 1,
# `set -e` aborted bring-up, and every new studio in every repo came back
# bare. Nothing a studio does needs the tailnet -- `fleet attach` is a WSS
# through the Worker -- so log, leave a marker, and continue. The marker is
# read back by provision.ts's provisionedCheckCmd (TAILNET_DOWN_PATH there)
# and shown in `fleet ls` READY. Fixed strings only: tailscale's own stderr
# goes to the (redacted) log, never into the marker.
tailnet_marker="${FLEET_WORKSPACE:-/workspace}/.fleet/tailnet-down"
if [ -z "${TS_AUTHKEY:-}" ]; then
  echo "studio-bringup: TS_AUTHKEY not set, skipping tailscale up"
  rm -f "$tailnet_marker" 2>/dev/null || true
elif ts_status=$(tailscale status --json 2>/dev/null) && grep -qE '"BackendState":[[:space:]]*"Running"' <(printf '%s' "$ts_status"); then
  echo "studio-bringup: tailscale already up"
  rm -f "$tailnet_marker" 2>/dev/null || true
elif ts_up_err=$(tailscale up --ssh --authkey="$TS_AUTHKEY" --hostname="${STUDIO_ID:-studio}" 2>&1 >/dev/null); then
  rm -f "$tailnet_marker" 2>/dev/null || true
else
  # Parameter expansion, never `printf | head -n1`: head exits after one
  # line, printf takes SIGPIPE on stderr over 64KB, and pipefail + errexit
  # would kill bring-up right here (PR #190 review, reproduced rc=141).
  ts_up_first="${ts_up_err%%$'\n'*}"
  echo "studio-bringup: tailscale-up FAILED (${ts_up_first}), continuing without tailnet" >&2
  case "$ts_up_err" in
    *"quota reached"*) ts_warning="tailnet: quota reached" ;;
    *) ts_warning="tailnet: down" ;;
  esac
  { mkdir -p "$(dirname "$tailnet_marker")" && printf '%s\n' "$ts_warning" > "$tailnet_marker"; } 2>/dev/null || true
fi
# <<< tailscale-up <<<

# --- tailscaleHost (Task 6, P2 ride-along) ----------------------------------
# Publishes this container's own tailnet hostname to a file the Worker's
# refresh tick reads (do.ts's readTailscaleHost) and surfaces as
# StudioStatus.tailscaleHost for the grid/`fleet ls`. Same "container
# writes, Worker polls" idiom as the transcript/session-sync planes
# (R-P2-1) — no new inbound path from the Worker. Runs AFTER `tailscale up`
# above: DNSName is only populated once actually logged in.
#
# Guarded like every step above: no TS_AUTHKEY (skipped above already), no
# `tailscale` binary, or `tailscale up` itself failed -> DNSName comes back
# empty -> the file is simply never written. do.ts's reader already treats a
# missing file exactly like an absent host (null), so there is nothing
# special to signal here beyond "don't write". `|| true` on the status read
# keeps a missing/erroring tailscale from tripping this script's own
# `set -euo pipefail`.
bringup_step tailscale-host
ts_status_json="$(tailscale status --json 2>/dev/null || true)"
if [ -n "$ts_status_json" ]; then
  # tailscale emits "Self" before "Peer" (same field order the
  # "BackendState" check above already relies on implicitly) — truncating
  # at the Peer marker before extracting DNSName is a cheap, indentation-
  # agnostic way to guarantee the sed below can only ever match Self's own
  # DNSName, never a peer's. No jq in this image (see Dockerfile.studio) —
  # same sed-not-jq convention this script's session-restore manifest
  # re-derivation above already uses.
  PEER_MARKER='"Peer"'
  ts_self_json="${ts_status_json%%$PEER_MARKER*}"
  ts_dns_name="$(printf '%s' "$ts_self_json" | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -n1)"
  ts_dns_name="${ts_dns_name%.}" # tailscale's FQDN form has a trailing dot; strip it for display
  if [ -n "$ts_dns_name" ]; then
    printf '%s\n' "$ts_dns_name" > /workspace/.ts-host
  fi
fi

# --- tmux session + rendering options -----------------------------------------
#
# Everything between the two markers below is extracted VERBATIM and executed
# against a real tmux server by test/bun/bringup-tmux-render.test.ts, which
# then asserts on options READ BACK from the session it created. That is not
# ceremony: `tmux set -g history-limit 50000` sat in this file since 2026-08
# while `acme-os--release-studio` ran at tmux's default 2000, measured
# 2026-09-23 (issue #43). A source-text assertion cannot tell a setting that
# took from one that did not, so this block is written to be RUN by its test.
# Keep it self-contained: it must depend on nothing above it but $HOME.
#
# `bringup_step` is called OUTSIDE the markers on purpose (issue #38). The
# region is extracted and run standalone by its test, where that function does
# not exist; keeping the call above the opener keeps the region self-contained
# and still logs this step like every other.
bringup_step tmux-session
# >>> tmux-render-options >>>
#
# WHY A CONFIG FILE AND NOT FOUR `tmux set -g` LINES, measured 2026-09-23 on
# tmux 3.2a: a pane's history is ALLOCATED WHEN THE PANE IS CREATED and never
# grows afterwards. The old block created the session first and set the
# options second, so the `claude` pane was born at the default 2000 and stayed
# there while `show-options -g history-limit` happily answered 50000 -- which
# is exactly the pair of readings the operator hit. `tmux start-server` does
# not help either: a tmux server with no sessions exits immediately, so the
# options die with it before `new-session` runs.
#
# tmux reads ~/.tmux.conf at SERVER START, before it creates the first session
# — so writing the file here, before the first tmux command of the whole
# bring-up, is what makes the `claude` pane be BORN with 50000 lines. Measured:
# 50000 with the file, 2000 with the same values as `set -g` lines after
# `new-session`. The file is fleet-managed and rewritten on every bring-up.
tmux_conf="${HOME:-/root}/.tmux.conf"
cat > "$tmux_conf" <<'TMUXCONF'
# Managed by container/studio-bringup.sh (issue #43). Rewritten every
# bring-up; edit the script, not this file.

# `mouse off` -- THE GLYPH CORRUPTION FIX, and a reversal of `mouse on`
# (commit 5ee8587). Confirmed by controlled reproduction 2026-09-23 on
# `acme-os--release-studio`: clean pty cycle (close the attach, wait for
# ZERO clients -- the pty only dies when the last one leaves, terminal.ts:153
# -162 -- reopen) gave a clean terminal, the operator confirmed "It worked",
# the operator scrolled up and down, and it corrupted immediately. With
# `mouse on` the wheel belongs to TMUX, not to the outer terminal: tmux enters
# copy-mode and repaints the pane with history WHILE the lead is still writing
# new output, and the two interleave in one stream. That is where the extra
# letters and the stranded fragments of old lines came from. It explains what
# no earlier hypothesis could -- a fresh terminal, a single client, the correct
# size, and it always came back. The trigger was never time; it was scrolling.
# Verified from the other side too: with `mouse off` the operator scrolled up
# and down repeatedly and rendering held -- "the issue of the glyphs is fixed.
# I scroll up and down and it doesn't mess up the glyphs."
#
# WHAT `mouse on` WAS FOR, kept in full because this reverses it and the
# problem it solved was real, not a whim (the original note, 2026-09-16,
# translated from Portuguese):
#
#   `mouse on`: without it tmux stays at its default OFF, and the terminal
#   emulator applies alternate-scroll -- it turns the mouse wheel into up/down
#   arrows while claude's TUI is on the alternate screen. The operator cannot
#   scroll back to read what happened. MEASURED 2026-09-16 on acme-os--maestro:
#   `mouse off`, a single client, CLIENT 180x54 and WINDOW 180x53 (sizes
#   matching, so no size mix-up masking it), and the wheel sent
#   arrows. `tmux set -g mouse on` at runtime fixed it on the spot.
#
#   Accepted cost: dragging now selects into tmux's buffer, not the
#   terminal's. For the Mac's native selection, hold Option while dragging.
#
# THE TWO MEASUREMENTS DISAGREE, and the disagreement is left standing rather
# than resolved by assertion. 2026-09-16 measured `mouse off` sending arrows
# instead of scrolling (alternate-scroll, claude's TUI on the alternate
# screen). 2026-09-23 measured `mouse off` scrolling fine: the operator
# scrolled up and down repeatedly and reported "the issue of the glyphs is
# fixed. I scroll up and down and it doesn't mess up the glyphs." Only the
# terminal emulator's own alternate-scroll setting sits between those two
# readings, and nobody has isolated which one moved. The 2026-09-23 reading is
# the one taken with the operator who has to live with it, on the terminal he
# actually uses, and it is the reading this file follows.
#
# WHAT `mouse off` COSTS, recorded rather than glossed: the operator loses
# tmux copy-mode by wheel, loses click-to-select-pane and click-to-select-
# window on the status bar, and loses drag-select into the tmux buffer. What
# he gains back is the native terminal selection the note above listed as the
# accepted cost of `mouse on`. Scrolling INSIDE tmux remains available by
# keyboard whatever the emulator does with the wheel: `C-b [` enters
# copy-mode, and `C-b PageUp` goes straight up a page. If alternate-scroll
# ever bites again the way 2026-09-16 recorded, that is the workaround to
# reach for -- not `mouse on`, which is now known to corrupt the live view.
#
# The third way was considered and rejected: `mouse on` plus unbinding
# WheelUpPane stops the copy-mode repaint, but it does NOT give the wheel back
# to the outer terminal -- with the mouse on, the emulator keeps reporting
# wheel events to tmux, so the operator would end up with no scrolling at all,
# which is strictly worse than either option.
set -g mouse off

# `window-size largest` -- and this ANSWERS the comment that deliberately
# chose `latest` over `smallest` (this file, before issue #43). The right
# comparison was never latest-vs-smallest. With `latest`, ANY client that
# connects -- a coordinator probe, an `ff` with no tty, an attach in a small
# window -- takes over the pane size for everyone, including the human reading
# it; that is the failure measured on 2026-09-23, four studios pinned at 80
# columns by one tty-less client. With `largest`, the small client sees a crop
# and the operator's view stays intact. The cost falls on whoever peeks, not on
# whoever works. Applied by hand to four live acme-os containers the same
# day: panes went stable at 180x53.
set -g window-size largest

# `aggressive-resize off` -- with it ON the window follows whichever client is
# looking at it, so any client switching windows resizes the window and forces
# a repaint in everyone else's stream. Measured as a cause of live text
# corruption; see #47. (This is also tmux's own default, so the previous
# `aggressive-resize on` was an active choice, not an omission.)
setw -g aggressive-resize off

# `history-limit` -- 2000 (tmux's default) is short for a lead that runs for
# hours, and with `mouse off` the tmux history is what an agent reads back with
# `capture-pane`. Set HERE, in the file tmux reads at server start, because
# setting it after the pane exists does nothing to that pane (see the block
# comment above).
set -g history-limit 50000
TMUXCONF

# The session. Created AFTER the file exists, so the server that starts here
# reads it and the `claude` pane is born with the full 50000-line history.
#
# fd 9 is the real stderr, opened by the bring-up log region at the top of this
# file (issue #38). This region must stay runnable on its own, and when its
# test extracts it fd 9 is closed, so open it here only when it is not already
# open -- a no-op under the full script, where fd 9 is already the real stderr
# and must not be re-pointed.
if ! { : >&9; } 2>/dev/null; then exec 9>&2; fi
if ! tmux has-session -t studio 2>/dev/null; then
  # `2>&9` -- fd 9 is the real stderr (see the bring-up log region at the top
  # of this file). This is the ONE long-lived process this script starts: the
  # tmux SERVER outlives the script, and every pane under it, `claude`
  # included, inherits its stderr. Without this it would inherit the run's
  # buffered stderr file instead, which bringup_finish unlinks on exit --
  # leaving the server writing forever into a deleted inode no operator can
  # read and no `du` can find. The server keeps exactly the stderr it had
  # before this feature existed: the sandbox exec's own.
  #
  # `9>&-` -- and this closes the OTHER half of the same hazard. A redirection
  # only sets the child's fd 2; it does not take fd 9 away, so without this the
  # daemon walks off with a private write handle on fd 9 and holds it for the
  # life of the container. Measured 2026-09-23 on tmux 3.2a, this exact line
  # with `2>&9` alone, reading the LIVE `/proc/<server>/fd` of the daemon it
  # starts: `0,1,2 -> /dev/null` (tmux daemonises onto /dev/null, so fd 2 is
  # never the leak) and `9 -> pipe:[6961]`, the caller's own pipe. Whoever was
  # reading that pipe then never sees EOF: rc=124 at 10006ms with the region's
  # last line already printed -- a HANG, not a slowdown. That is the shape the
  # region's own test runs in, and it is what turned this branch's CI red.
  # Order matters and is left-to-right: fd 2 takes its dup of the real stderr
  # FIRST, then fd 9 is closed, so the client still reports its own startup
  # errors where issue #38 wants them and the server inherits nothing at all.
  # The redirections are on the command, so fd 9 stays open in this shell.
  tmux new-session -d -s studio -n claude 2>&9 9>&-
fi

# For a server that was ALREADY running when this bring-up started -- every
# re-provision, and every container that predates this change. `source-file`
# applies the very same bytes live, so `mouse`, `window-size` and
# `aggressive-resize` are corrected without a recycle. `history-limit` is the
# one that cannot be: the existing pane keeps whatever it was born with, which
# the readback below states plainly rather than hiding.
tmux source-file "$tmux_conf" 2>/dev/null || true

# READ BACK, never assume. Each value below comes out of the live server.
tmux_mouse="$(tmux show-options -gv mouse 2>/dev/null || echo '?')"
tmux_winsize="$(tmux show-options -gv window-size 2>/dev/null || echo '?')"
tmux_aggressive="$(tmux show-window-options -gv aggressive-resize 2>/dev/null || echo '?')"
#
# FLEET-WIDE PROBE DEFECT, found by the #41 work and guarded against here: on
# tmux 3.2a, `tmux display-message -p -t studio:claude '#{...}'` run where that
# window does NOT exist silently answers about the CURRENT pane and exits 0. It
# cannot fail; it lies. So the format carries `#{session_name}:#{window_name}`
# and an answer that is not about `studio:claude` is discarded, not believed.
# Addressing the window BY NAME also keeps this invisible: nothing is selected,
# no window is switched, an operator attaching later sees no trace.
tmux_pane_probe="$(tmux display-message -p -t studio:claude '#{session_name}:#{window_name} #{history_limit}' 2>/dev/null || true)"
case "$tmux_pane_probe" in
  "studio:claude "*) tmux_history="${tmux_pane_probe#studio:claude }" ;;
  *) tmux_history="?" ;;
esac
echo "studio-bringup: tmux mouse=$tmux_mouse window-size=$tmux_winsize aggressive-resize=$tmux_aggressive history_limit=$tmux_history"
if [ "$tmux_history" != "50000" ]; then
  echo "studio-bringup: WARNING pane studio:claude history_limit=$tmux_history, not 50000 -- tmux allocates a pane's history AT PANE CREATION and never grows it, so this pane was born before $tmux_conf existed; only a recycle (fresh container) gives it the full scrollback" >&2
fi
# <<< tmux-render-options <<<
#
# The prefix stays `C-b` -- the coordinator's decision (internal tooling,
# delegated by the operator) (board issue #4): "DO NOT change the prefix, keep C-b"
# (translated). Changing the prefix would break the coordinator's automation
# and the documented headless probe procedure, which both assume `Ctrl-b 1`/
# `Ctrl-b 0` to switch windows. `Ctrl-b Ctrl-b` sends a LITERAL Ctrl-b to
# claude (its own "run in background" chord) -- that is NOT tmux's copy-mode
# doing nothing; the tmux prefix stays `C-b` on
# purpose. With `mouse off` (issue #43), the mouse wheel belongs to the
# outer terminal: use it to scroll, or `C-b [` for tmux's copy-mode.

# --- session restore ---------------------------------------------------------
# src/studio/provision.ts's runSessionRestore writes chunked tar parts PLUS a
# manifest.json (partCount, totalBytes, sha256 of the full concatenated tar)
# to RESTORE_DIR (fresh container + an R2 `latest` snapshot exists) BEFORE
# this script ever runs — see that function's own doc comment. manifest.json
# is written LAST, only after every part succeeded, so its mere PRESENCE is
# the Worker's own "this restore write is complete" signal — parts without a
# manifest mean an interrupted write, and must be treated exactly like
# nothing being there at all. Placed AFTER the tmux session block above
# (ordering is a controller ruling, not a real dependency) and BEFORE the
# claude-launch block below, which is the part that actually matters:
# claude's own `--continue` check (a few lines down, now scoped to THIS
# project's own dir under ~/.claude/projects) must see the restored
# directory, not a still-empty one.
#
# Fix round (Critical, C2 — reviewer-reproduced): a torn/truncated part
# transfer used to be able to leave `~/.claude` PARTIALLY populated — a
# truncated tar stream extracts some entries before failing partway through,
# directly into the real `~/.claude`. Fixed by construction, in two parts:
#   1. Verify BEFORE touching `~/.claude` at all — part count (vs the
#      manifest's own partCount), total byte count, and a sha256 of the
#      concatenated parts must all match the manifest exactly, or the whole
#      attempt is abandoned right here.
#   2. Untar into a scratch temp dir first; only a FULLY successful tar
#      extraction is then placed into `~/.claude` via same-filesystem `mv`
#      (/root and /workspace/.session-restore share a mount, so each `mv` is
#      an atomic rename — either that one item appears at its final path,
#      or nothing does).
# Partial `~/.claude` is impossible by construction: nothing is ever written
# to `~/.claude/projects` or `~/.claude.json` except via those two atomic
# `mv`s, and neither runs unless the verify gate AND the tar extraction
# succeeded in full.
#
# Fix round 2 (Important, reviewer-reproduced): the two `mv`s are NOT
# jointly atomic WITH EACH OTHER — a kill between them used to be able to
# leave `~/.claude/projects` restored (which flips the freshness guard to
# "warm", so this whole block never runs again for this container) while
# `~/.claude.json` stayed orphaned in $TMP_RESTORE forever — permanent,
# silent data loss of one file. Fixed by ORDERING, not locking:
# `.claude.json` moves FIRST, `projects` moves LAST. ORDERING INVARIANT:
# `projects` is what the freshness guard itself keys on
# (`[ ! -d ~/.claude/projects ]`, this block's own entry guard above) — so
# it must always be the LAST placement step, the one thing that only ever
# happens once every other placement step has already succeeded. A kill
# (or any failure) before `projects` lands leaves the guard still reading
# "fresh", so the NEXT bring-up call retries the whole restore from
# scratch (the manifest/parts survive an abrupt kill too — the
# unconditional cleanup a few lines down never gets a chance to run
# either). This is the SAME "the last write is the commit marker" pattern
# src/studio/provision.ts's runSessionRestore already uses for its own
# manifest.json (written only after every part has already landed) — one
# more instance of that idea, not a new one.
#
# Fix round 2 (Minor): the placement steps (mkdir + both mvs) are now
# exit-checked (`placement_ok`, same 0/1 gate pattern `restore_ok` above
# already uses) — previously unchecked under this block's own `set +e`, so
# a placement that silently failed could still log "session restored
# (verified)". The success message is now gated on the WHOLE placement
# chain actually succeeding; any failure in it falls through to the same
# "continuing fresh" logging every other gate in this block already uses.
#
# Guarded: only attempted when a manifest is actually present AND the
# container is STILL fresh (~/.claude/projects absent) — a restart's repeat
# bring-up call must never re-restore over a session claude has since
# continued. Idempotent double-run: the manifest and parts are removed at the
# end regardless of outcome, so a second bring-up call on the SAME container
# finds nothing to restore and is a clean no-op either way.
#
# Entirely wrapped in its own `set +e` subshell rather than this script's
# usual "exempt one pipeline via if/else" trick (used just below, for
# claude-launch, and used by the prior version of this exact block): this
# block runs several independent command substitutions (sed, find, cat,
# sha256sum) against files that may legitimately not match what's expected
# (a corrupt/partial restore is the CASE THIS BLOCK EXISTS TO HANDLE, not an
# exceptional one), and guarding each individually would be far less
# readable than disabling abort-on-error for the whole self-contained block.
# Filesystem side effects made inside the subshell (mkdir/mv/rm) are real and
# permanent — only shell state (exit-on-error, variables) is scoped to it —
# and the subshell's own trailing `true` guarantees it always returns 0 so it
# can never itself trip the OUTER script's `set -e`.
# >>> session-restore >>>
bringup_step session-restore
RESTORE_DIR="${FLEET_WORKSPACE:-/workspace}/.session-restore"
MANIFEST="$RESTORE_DIR/manifest.json"
(
  set +e
  if [ -f "$MANIFEST" ] && [ ! -d ~/.claude/projects ]; then
    restore_ok=1

    manifest_part_count=$(sed -n 's/.*"partCount":\([0-9]*\).*/\1/p' "$MANIFEST")
    manifest_total_bytes=$(sed -n 's/.*"totalBytes":\([0-9]*\).*/\1/p' "$MANIFEST")
    manifest_sha256=$(sed -n 's/.*"sha256":"\([a-f0-9]*\)".*/\1/p' "$MANIFEST")
    actual_part_count=$(find "$RESTORE_DIR" -maxdepth 1 -name 'part-*' -type f | wc -l | tr -d ' ')

    if [ -z "$manifest_part_count" ] || [ -z "$manifest_total_bytes" ] || [ -z "$manifest_sha256" ]; then
      restore_ok=0
    elif [ "$actual_part_count" = "0" ] || [ "$actual_part_count" != "$manifest_part_count" ]; then
      restore_ok=0
    fi

    if [ "$restore_ok" = "1" ]; then
      actual_total_bytes=$(cat "$RESTORE_DIR"/part-* | wc -c | tr -d ' ')
      actual_sha256=$(cat "$RESTORE_DIR"/part-* | sha256sum | awk '{print $1}')
      if [ "$actual_total_bytes" != "$manifest_total_bytes" ] || [ "$actual_sha256" != "$manifest_sha256" ]; then
        restore_ok=0
      fi
    fi

    if [ "$restore_ok" = "1" ]; then
      TMP_RESTORE="${HOME:-/root}/.claude-restore-tmp"
      rm -rf "$TMP_RESTORE"
      mkdir -p "$TMP_RESTORE"
      if cat "$RESTORE_DIR"/part-* | tar -xzf - -C "$TMP_RESTORE"; then
        placement_ok=1
        mkdir -p ~/.claude || placement_ok=0
        # .claude.json FIRST — optional (some snapshots legitimately lack
        # it), but if it IS present its move must succeed before `projects`
        # (the guard key, see the ordering-invariant comment above this
        # block) is ever touched.
        if [ "$placement_ok" = "1" ] && [ -f "$TMP_RESTORE/.claude.json" ]; then
          mv "$TMP_RESTORE/.claude.json" ~/.claude.json || placement_ok=0
        fi
        # projects LAST, deliberately. Only reached once every other
        # placement step has already succeeded.
        if [ "$placement_ok" = "1" ]; then
          mv "$TMP_RESTORE/.claude/projects" ~/.claude/projects || placement_ok=0
        fi
        if [ "$placement_ok" = "1" ]; then
          echo "studio-bringup: session restored from R2 snapshot (verified)"
        else
          echo "studio-bringup: session restore placement failed after untar, continuing fresh" >&2
        fi
      else
        echo "studio-bringup: session restore untar failed after verification, continuing fresh" >&2
      fi
      rm -rf "$TMP_RESTORE"
    else
      echo "studio-bringup: session restore verification failed (missing/mismatched manifest, part count, size, or hash), continuing fresh" >&2
    fi

    rm -f "$RESTORE_DIR"/part-* "$MANIFEST"
  fi
  true
)
# <<< session-restore <<<

# --- session adopt (issue #146) ----------------------------------------------
# A lead that worked inside a Claude Code worktree has its whole transcript
# keyed to `<root key>--claude-worktrees-<name>`, where claude_has_conversation
# (root key only) never looks, and the heal launches it blank. The Worker
# adopts before bring-up (#120), but on a FRESH container the session tar is
# still only staged then: it saw nothing, and the blank root session it left
# outranked the real one on every later heal. So the adopt also runs HERE,
# after the untar above and before the --continue guard below. Idempotent:
# after one copy, root's newest wins and a re-run reports `root`.
#
# Its result line goes to STDOUT, where the Worker reads it for the row's
# sessionAdoption, and to stderr for the bring-up log. Bounded like the
# Worker's own call. No repo in the id, or no script (older image), is a
# no-op. FLEET_STUDIO_ADOPT is a test seam; production never sets it.
#
# Issue #28: FLEET_FRESH_SESSION=1 (`fleet provision|recycle --fresh-session`,
# one bring-up only -- the Worker never persists it) is the escape hatch for a
# session claude cannot resume: every heal would otherwise adopt it and
# `--continue` into the same wedge. No adopt. Every entry of the root key and
# of each `<root>--claude-worktrees-*` key except `memory/` moves (never
# deleted) into `fleet-aside-<ts>-<key>`: a flat sibling, so burn.ts keeps
# keying each transcript by its own id and session sync ships it to R2 as its
# own archive (issue #37: kept out of the main tar, so an oversize one cannot
# block every later sync), and a prefix the adopt's worktree glob can never match, so no later heal
# pulls it back. One `FLEET_SESSION_FRESH moved <dir>` stdout line per
# destination (`none` if nothing moved) for the Worker; the same to the log.
# A failed move says so and leaves that entry where it was: the launch guard
# then still sees it, which is a wedge, never a loss.
# >>> session-adopt >>>
bringup_step session-adopt
adopt_script="${FLEET_STUDIO_ADOPT:-/opt/fleet/studio-adopt.sh}"
if [ "${FLEET_FRESH_SESSION:-}" = "1" ] && [ -n "${STUDIO_ID:-}" ]; then
  fresh_projects="$HOME/.claude/projects"
  fresh_root="$(printf '%s' "/workspace/${STUDIO_ID%%--*}" | tr -c 'a-zA-Z0-9' '-')"
  fresh_ts="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  fresh_moved=0
  for fresh_dir in "$fresh_projects/$fresh_root" "$fresh_projects/$fresh_root"--claude-worktrees-*; do
    [ -d "$fresh_dir" ] || continue
    fresh_key="$(basename -- "$fresh_dir")"
    fresh_aside="fleet-aside-$fresh_ts-$fresh_key"
    fresh_here=0
    for fresh_entry in "$fresh_dir"/* "$fresh_dir"/.[!.]*; do
      [ -e "$fresh_entry" ] || continue
      [ "$(basename -- "$fresh_entry")" = memory ] && continue
      if mkdir -p -- "$fresh_projects/$fresh_aside" && mv -- "$fresh_entry" "$fresh_projects/$fresh_aside/"; then
        fresh_here=1
      else
        echo "FLEET_SESSION_FRESH failed $fresh_entry"
        echo "studio-bringup: fresh session: could not move $fresh_entry aside -- left in place" >&2
      fi
    done
    if [ "$fresh_here" = "1" ]; then
      fresh_moved=$((fresh_moved + 1))
      echo "FLEET_SESSION_FRESH moved ~/.claude/projects/$fresh_aside"
      echo "studio-bringup: fresh session: moved $fresh_key aside to ~/.claude/projects/$fresh_aside (issue #28)" >&2
    fi
  done
  if [ "$fresh_moved" = "0" ]; then
    echo "FLEET_SESSION_FRESH none"
    echo "studio-bringup: fresh session: no session to move aside" >&2
  fi
elif [ -n "${STUDIO_ID:-}" ] && [ -x "$adopt_script" ]; then
  # 2>&1: the script's own skip line (#155) belongs in the bring-up log.
  adopt_line="$(timeout -k 2 15 "$adopt_script" "${STUDIO_ID%%--*}" 2>&1 || echo "FLEET_SESSION_ADOPT failed")"
  printf '%s\n' "$adopt_line"
  echo "studio-bringup: session adopt: $adopt_line" >&2
fi
# <<< session-adopt <<<

# Bring the blueprint checkout at $1 to what BLUEPRINT_REPO holds NOW, at
# BLUEPRINT_REF (the ref provision resolved; unset = the remote's HEAD).
#
# Issue #11: the clone used to run only when $1/.git was absent, so a skill
# added to the blueprint after the container booted never appeared and
# provision marked the studio bare (`skills-unresolvable`) until a recycle.
# Now every bring-up fetches the ref (depth 1) and resets onto it.
#
# Both failures are tolerated, loudly: a network or auth hiccup on this one
# extra repo must not take the studio down, and claude still launches with
# whatever skills resolve. A failed clone leaves no .git, so the next
# bring-up retries it; a failed refresh keeps the checkout it already had.
# GIT_TERMINAL_PROMPT=0: a missing credential fails fast instead of blocking
# on a tty prompt this non-interactive script can never answer.
#
# Bounded (PR #14 review): a server that accepts the connection and never
# answers hung the fetch past a 90 s probe, and provision with it. Both
# network calls run under `timeout` (the same coreutils session-adopt above
# relies on); a timeout is just another failure, handled as above.
# BLUEPRINT_SYNC_TIMEOUT is a test seam; production never sets it.
blueprint_sync() {
  local dir="$1" ref="${BLUEPRINT_REF:-HEAD}" t="${BLUEPRINT_SYNC_TIMEOUT:-30}"
  [ -n "${BLUEPRINT_REPO:-}" ] || return 0
  if [ ! -d "$dir/.git" ]; then
    GIT_TERMINAL_PROMPT=0 timeout -k 2 "$t" git clone --depth 1 "https://github.com/${BLUEPRINT_REPO}.git" "$dir" \
      || { echo "studio-bringup: blueprint clone failed, skills will be missing" >&2; return 0; }
  fi
  if GIT_TERMINAL_PROMPT=0 timeout -k 2 "$t" git -C "$dir" fetch -q --depth 1 origin "$ref" && git -C "$dir" reset -q --hard FETCH_HEAD; then
    echo "studio-bringup: blueprint at $ref $(git -C "$dir" rev-parse --short HEAD)" >&2
  else
    echo "studio-bringup: blueprint refresh failed -- keeping $dir at $(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo unknown); skills added since will be missing" >&2
  fi
}

# --- studio materialization (Task 4, P4a-1) ---------------------------------
# No-op when STUDIO_NAME is unset -- the pilot/scratch ROLE_* path (below,
# unchanged) is what runs then. Set means studio-blueprint.ts's
# studioBringupEnv ran Worker-side and every STUDIO_* var below is present.
# Placed after session restore (that block only ever touches ~/.claude.json
# and ~/.claude/projects -- never agents/skills/settings, so there is no
# ordering conflict either way) and before claude-launch: agents must exist
# on disk before claude starts, its own agent registry resolves at session
# start, not lazily (Task 0 spike hit this directly: "registry cached at
# session start").
# A container that ALREADY materialized a studio must never be brought up
# again as a plain role. The role path installs no lead gate at all, so a
# bring-up whose studio env went missing would quietly replace a gated lead
# with an ungated one on the very same container -- and the marker file is the
# only thing on disk that remembers which of the two this container is
# (STUDIO_NAME lives in the per-exec env, so an env-less bring-up cannot tell
# by itself). Refuse instead: the studio's own provision path is what fixes
# it, and a container that will not restart is visible in a way an ungated
# lead is not. See the marker's own write, at the end of the studio block.
bringup_step studio-materialization
if [ -z "${STUDIO_NAME:-}" ] && [ -f ~/.claude/.fleet-studio ]; then
  echo "studio-bringup: this container was materialized as studio '$(cat ~/.claude/.fleet-studio)' but this bring-up carries no studio env -- refusing rather than relaunching an UNGATED lead (decision 11)" >&2
  exit 1
fi

if [ -n "${STUDIO_NAME:-}" ]; then
  # Precondition: python3. Everything below (members, mcp, lead-gate
  # settings.json) is written via `python3 -c`. Review fix round -- a
  # python3-less image used to die here on a bare exit 127 under this
  # script's own `set -e`, cryptic and silent. Made explicit on purpose:
  # this is a refusal, not an accident. A studio that cannot materialize
  # its lead-gate hook must NOT launch claude below -- an ungated lead would
  # come up holding Edit/Write with nothing stopping it, silently voiding
  # decision 11 (leads never implement). Do NOT soften this into a warn-and-
  # continue; a loud refusal to boot is the safe failure here, a degraded
  # boot is not. Dependency itself lives in Dockerfile.studio (P4a-1, T5).
  if ! command -v python3 >/dev/null 2>&1; then
    echo "studio-bringup: python3 missing -- refusing to boot, cannot materialize lead-gate hook (decision 11)" >&2
    exit 1
  fi

  # members -> native .claude/agents files, bytes verbatim. Bundle shape is
  # studio-blueprint.ts's own: b64(JSON: {filename: b64(raw)}). python3 reads
  # the decoded JSON from a FILE, not stdin: verified `decode | python3 -
  # <<EOF` does NOT hand the piped bytes to the script -- bash feeds fd0
  # both the pipe's output AND the heredoc body back to back, `-` makes
  # python consume that whole concatenated stream as its OWN source at
  # startup, and by the time the script's own json.load(sys.stdin) runs,
  # fd0 is already drained. A temp file sidesteps the conflict entirely.
  mkdir -p ~/.claude/agents
  if [ -n "${STUDIO_MEMBERS_B64:-}" ]; then
    base64 -d <<< "$STUDIO_MEMBERS_B64" > /tmp/studio-members.json
    python3 -c '
import json, base64, os
with open("/tmp/studio-members.json") as f:
    bundle = json.load(f)
agents_dir = os.path.expanduser("~/.claude/agents")
for fn, b64 in bundle.items():
    with open(os.path.join(agents_dir, fn), "wb") as out:
        out.write(base64.b64decode(b64))
'
    rm -f /tmp/studio-members.json
  fi

  # skills: sync the blueprint checkout (blueprint_sync: clone once, then
  # refresh to BLUEPRINT_REF on every bring-up, issue #11), symlink the
  # studio's own list into it. ln -sfn is idempotent (force +
  # no-dereference), so a repeat bring-up just re-links.
  #
  # Auth: deliberately NO token in this URL. This file's own header comment
  # is explicit that GH_TOKEN is never handed to this container -- do.ts's
  # runRefreshCredential already wrote /workspace/.git-credentials plus the
  # global credential.helper, ALWAYS before this script runs. Same mechanism,
  # same trust boundary provision.ts's guardedCloneCmd already relies on for
  # the workspace clone (also no embedded credential). Whether the
  # installation token's scope covers this SECOND repo is a provision-time
  # concern (Task 7), not bringup's -- left unguarded here on purpose so a
  # scope miss fails loudly instead of silently swallowing the clone.
  #
  # Unset BLUEPRINT_REPO skips it entirely; clone and refresh failures are
  # tolerated -- see blueprint_sync's own comment.
  blueprint_sync /opt/blueprint
  #
  # A declared-but-absent skill is now LOUD (fix wave, Critical #2). The old
  # `[ -d ] && ln` guard logged nothing at all, which is how 13 of web-
  # studio's 16 declared names came to resolve to nothing with no signal
  # anywhere -- delivery-standards (Tier 0, spec §4 "locked, non-negotiable")
  # among them. "Absent" means absent from BOTH legitimate sources, not just
  # from the clone: the baked plugins (Dockerfile.studio bakes superpowers +
  # caveman) ship their own skills, and claude loads a plugin's skills
  # straight from the plugin cache with no symlink -- so every Tier-0
  # superpowers name legitimately has no /opt/blueprint/skills entry and must
  # NOT warn. Checking the plugin cache before warning is what keeps this
  # signal honest instead of 9 false alarms per bring-up.
  mkdir -p ~/.claude/skills
  if [ -n "${STUDIO_SKILLS:-}" ]; then
    IFS=',' read -ra SKILL_LIST <<< "$STUDIO_SKILLS"
    for s in "${SKILL_LIST[@]}"; do
      if [ -d "/opt/blueprint/skills/$s" ]; then
        ln -sfn "/opt/blueprint/skills/$s" ~/.claude/skills/"$s"
      elif ! ls -d ~/.claude/plugins/cache/*/*/*/skills/"$s" >/dev/null 2>&1; then
        echo "studio-bringup: declared skill \"$s\" resolves to NOTHING -- absent from /opt/blueprint/skills and from every baked plugin; studio boots without it" >&2
      fi
    done
  fi

  # mcp: fixed server templates keyed by name -- adding a server means
  # editing this map, not touching studio.md. Secrets are already in the
  # container's env by the time this runs (provision's own concern, not this
  # script's).
  if [ -n "${STUDIO_MCP:-}" ]; then
    # WHERE, not just what (fix wave, Important #3). claude reads a project
    # .mcp.json out of ITS OWN cwd, and the claude pane's cwd is whatever the
    # tmux server started in -- /container-server, the sandbox exec's own
    # directory -- never /workspace. Measured on the built image: `claude mcp
    # list` from /container-server said "No MCP servers configured" while the
    # same command from /workspace listed the playwright entry, i.e. the file
    # was being written somewhere claude never looks and the whole mcp: block
    # was dead. Asked of tmux rather than hardcoded, so this keeps working if
    # the pty's start directory ever moves. Deliberately NOT fixed by cd-ing
    # the tmux session to /workspace instead: /workspace is load-bearing at
    # its absolute path elsewhere in this very script (transcript pipe,
    # .ts-host, session-restore), and moving the session would be a much
    # wider change than the bug warrants.
    mcp_dir="$(tmux display-message -p -t studio:claude '#{pane_current_path}' 2>/dev/null || true)"
    [ -n "$mcp_dir" ] || mcp_dir="$PWD"
    # command is "bun", not "bunx" -- review fix round: this base image's
    # bun (1.3.12) ships no `bunx` binary at all, only the `bun x`
    # subcommand (verified in the built T5 image, "bunx: command not
    # found"). MCP spawns command+args directly, no shell in between, so
    # the subcommand has to be its own argv element, same as typing
    # `bun x @playwright/mcp@latest` at a prompt.
    MCP_PATH="$mcp_dir/.mcp.json" python3 -c '
import json, os
known = {"playwright": {"command": "bun", "args": ["x", "@playwright/mcp@latest"]}}
names = [n for n in os.environ.get("STUDIO_MCP", "").split(",") if n]
cfg = {"mcpServers": {n: known[n] for n in names if n in known}}
with open(os.environ["MCP_PATH"], "w") as f:
    json.dump(cfg, f)
'
    # A project .mcp.json is APPROVAL-GATED per project directory: without
    # this, claude prompts before it will use any server declared there, and
    # nothing in a headless studio pane ever answers that prompt. Set
    # alongside the file itself, in the same guarded block, so the two can
    # never drift apart. Merge-not-clobber, same idiom the lead-gate
    # settings.json write below already uses.
    mkdir -p ~/.claude
    python3 -c '
import json, os
path = os.path.expanduser("~/.claude/settings.json")
try:
    with open(path) as f:
        cfg = json.load(f)
except (FileNotFoundError, ValueError):
    cfg = {}
cfg["enableAllProjectMcpServers"] = True
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
'
  fi

  # lead gate: PreToolUse hook, not --disallowedTools. Task 0 spike ruling
  # (.superpowers/spike-lead-tools.md): --disallowedTools removes the tool
  # from the WHOLE session's tool registry, not just the lead's own calls --
  # it starves every dispatched member too (proven, Probe A: a member's own
  # `tools: Write` frontmatter failed to resolve, "unrecognized [Write]").
  # A PreToolUse hook tells lead and member calls apart per-call instead: the
  # hook payload carries an `agent_id` field on a member's tool call and
  # omits it on the lead's own (proven, Probe B -- both real payloads are
  # recorded side by side in the spike doc). Gated on STUDIO_LEAD_DISALLOWED
  # itself, not STUDIO_NAME again: Task 3 always sets one whenever it sets
  # the other today, but the hook's own question is "is there a restriction
  # to enforce", not "is this a studio". That env var is read as a BOOLEAN
  # only -- the matcher below is `.*`, deliberately (P7a Task 5, spec
  # docs/fleet/firstmate-analysis.md §2.4): a fixed tool list only catches
  # tools named ahead of time, and firstmate hit exactly this live
  # (docs/subagent-guard.md:15-27, their 73 minutes of lost supervision) --
  # a new write-capable or delegation-shaped tool walks straight past a
  # list. The decision moves INTO the script instead, which still tells
  # Bash apart from every other tool -- now by SHAPE, not by a fixed name
  # (see the hook script's own comment below).
  #
  # Matcher covers Bash too (fix wave, Critical #1): every studio grants
  # Bash, --dangerously-skip-permissions means allowedTools gates nothing,
  # and the spike itself recorded the model writing a file via `printf`
  # through Bash the moment Write was blocked. See the hook script's own
  # HONEST SCOPE paragraph for exactly how far the Bash half reaches.
  if [ -n "${STUDIO_LEAD_DISALLOWED:-}" ]; then
    mkdir -p ~/.claude/hooks
    # Single source of truth (board issue #2): the hook script itself lives
    # at gates/lead-gate.sh in the blueprint repo (this monorepo's own
    # fleet.json points blueprint.repo at itself, so /opt/blueprint IS a
    # checkout of this same repo by the time the skills-clone block above
    # has run) -- copied here, not generated inline, so the identical file
    # is installable on the Mac side too (`fleet gates install`). Guarded
    # the same way a missing skill directory is above: a missing source file
    # warns loudly on stderr and falls through to the fail-closed refusal
    # further down rather than aborting bring-up outright.
    if [ -f /opt/blueprint/gates/lead-gate.sh ]; then
      cp /opt/blueprint/gates/lead-gate.sh ~/.claude/hooks/lead-gate.sh
    else
      echo "studio-bringup: /opt/blueprint/gates/lead-gate.sh missing -- cannot install lead-gate hook" >&2
    fi
    chmod 0755 ~/.claude/hooks/lead-gate.sh 2>/dev/null || true

    # Bake IS_MAESTRO into the hook script's own on-disk bytes, right here,
    # in the SAME bash block that has $STUDIO_NAME in its environment --
    # never left for the hook to re-derive from a separate file at decision
    # time (board issue #16; see the hook's own ONE-exception comment
    # above its "Two rules, one gate" section). Runs against the COPIED
    # file at ~/.claude/hooks/lead-gate.sh, never against
    # gates/lead-gate.sh itself -- that repo-tracked template keeps the
    # placeholder literally, so the identical file stays installable on
    # the Mac side too (`fleet gates install`). The placeholder is
    # substituted here, after the copy, with a plain one-time `sed -i`
    # instead of letting the copy itself interpolate anything. This is the
    # ONLY line that ever decides IS_MAESTRO; nothing at hook-run time
    # reads a file to determine it again.
    # Matches only the assignment line, not the token's own name where it
    # appears in the hook's comment above it -- an unscoped `s/__IS_MAESTRO_
    # BOOL__/.../` would rewrite that prose into nonsense too.
    if [ "$STUDIO_NAME" = "maestro" ]; then
      sed -i 's/^IS_MAESTRO = __IS_MAESTRO_BOOL__$/IS_MAESTRO = True/' ~/.claude/hooks/lead-gate.sh
    else
      sed -i 's/^IS_MAESTRO = __IS_MAESTRO_BOOL__$/IS_MAESTRO = False/' ~/.claude/hooks/lead-gate.sh
    fi

    # Working-set re-emit hook (Task 6, spec defect 2.2). Registered here, in
    # the SAME settings.json write as the lead gate above, so one bring-up
    # either installs both hooks or neither. Every studio gets this, maestro
    # included -- losing context to a compaction is not gated on whether the
    # studio writes code, unlike the completion gate below.
    # Same single-source-of-truth copy as the lead gate above -- see its
    # comment for the guard/warn posture and why the file now lives at
    # gates/session-reemit.sh in the blueprint repo instead of a heredoc.
    if [ -f /opt/blueprint/gates/session-reemit.sh ]; then
      cp /opt/blueprint/gates/session-reemit.sh ~/.claude/hooks/session-reemit.sh
    else
      echo "studio-bringup: /opt/blueprint/gates/session-reemit.sh missing -- cannot install session-reemit hook" >&2
    fi
    chmod 0755 ~/.claude/hooks/session-reemit.sh 2>/dev/null || true

    # Install-cache completion-marker hook (board #350, round 5 review, item
    # 1). Registered here, in the SAME settings.json write as the lead gate
    # above, so one bring-up either installs all three hooks or none. Every
    # studio gets this, maestro included, exactly like the re-emit hook just
    # above -- whether install-cache.ts's own INSTALL_CACHE_REPOS gate ever
    # applies to this repo is decided server-side, per (repo, tick), and is
    # never something this bring-up script can know or needs to: an unmatched
    # command is a silent no-op, and a written marker for a repo the gate
    # never checks costs nothing. See gates/install-marker.sh's own header for
    # the full design and its own PostToolUse hook and honest limitations
    # (Claude Code's own hook payload for Bash carries no exit code).
    if [ -f /opt/blueprint/gates/install-marker.sh ]; then
      cp /opt/blueprint/gates/install-marker.sh ~/.claude/hooks/install-marker.sh
    else
      echo "studio-bringup: /opt/blueprint/gates/install-marker.sh missing -- cannot install install-marker hook" >&2
    fi
    chmod 0755 ~/.claude/hooks/install-marker.sh 2>/dev/null || true

    # settings.json: merge, never clobber. A base file may already carry
    # unrelated keys (an earlier bring-up on this same live container, or a
    # future image bake) -- load what's there, replace this one PreToolUse
    # entry, write the merged whole back.
    #
    # FAIL CLOSED (fix wave, Important #5). exit 2 is the ONLY code the
    # pinned CLI treats as "block"; every other outcome permits the call. So
    # the three ways this hook could vanish -- script deleted (127), chmod
    # lost (126), $HOME different from the /root this script happened to
    # expand at bring-up time -- all used to let a lead write straight
    # through, silently. Both halves fixed here, and neither is in the script
    # itself (a missing script cannot defend itself):
    #   1. The command is a shell snippet that CHECKS for an executable
    #      script and exits 2 itself when it is not there.
    #   2. $HOME stays a literal, expanded by the shell at claude's runtime,
    #      instead of os.path.expanduser baking /root in right here.
    #
    # Prior entries are dropped rather than deduped: a live container brought
    # up again after this script changed would otherwise keep the OLD entry
    # (old matcher, baked path, no fail-closed guard) sitting beside the new
    # one -- the exact shape this fix exists to remove.
    mkdir -p ~/.claude
    python3 -c '
import json, os
path = os.path.expanduser("~/.claude/settings.json")
try:
    with open(path) as f:
        cfg = json.load(f)
except (FileNotFoundError, ValueError):
    cfg = {}
pre = cfg.setdefault("hooks", {}).setdefault("PreToolUse", [])
guarded = (
    "S=\"$HOME/.claude/hooks/lead-gate.sh\"; "
    "[ -x \"$S\" ] || { echo \"lead-gate hook absent or not executable -- refusing (decision 11)\" >&2; exit 2; }; "
    "exec \"$S\""
)
entry = {
    # `.*`, not a fixed tool list (P7a Task 5) -- the decision now lives
    # INSIDE lead-gate.sh (its own "Two rules, one gate" comment), because a
    # tool absent from a hardcoded matcher never even reaches a hook script.
    "matcher": ".*",
    "hooks": [{"type": "command", "command": guarded}],
}
pre[:] = [e for e in pre if "lead-gate.sh" not in json.dumps(e)]
pre.append(entry)
# Working-set re-emit hook (Task 6): registered here, in the SAME write, so
# one bring-up either installs both hooks or neither. Every studio gets this,
# maestro included -- losing context to a compaction is not gated on whether
# the studio writes code, unlike the PreToolUse entry above.
ss = cfg.setdefault("hooks", {}).setdefault("SessionStart", [])
ss[:] = [e for e in ss if "session-reemit.sh" not in json.dumps(e)]
ss.append({"hooks": [{"type": "command", "command": "$HOME/.claude/hooks/session-reemit.sh"}]})
# Install-cache completion-marker hook (board #350, round 5 review, item 1):
# registered here, in the SAME write, so one bring-up either installs all
# three hooks or none. `.*` matcher, same reasoning as the PreToolUse entry
# above -- the tool_name/command decision lives INSIDE install-marker.sh
# itself, never in a hardcoded matcher. Unlike lead-gate.sh/completion-gate.sh,
# a MISSING script here fails open (`|| exit 0`, not `|| exit 2`): this hook
# enforces no security or completion invariant, only a best-effort cache
# optimization (see install-marker.sh header) -- a missing/non-executable
# script costs one skipped save tick, never a reason to surface a refusal.
pt = cfg.setdefault("hooks", {}).setdefault("PostToolUse", [])
pt[:] = [e for e in pt if "install-marker.sh" not in json.dumps(e)]
pt.append({
    "matcher": ".*",
    "hooks": [{
        "type": "command",
        "command": "S=\"$HOME/.claude/hooks/install-marker.sh\"; [ -x \"$S\" ] && exec \"$S\" || exit 0",
    }],
})
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
'
  fi

  # --- activity heartbeat hook (issue #221, PR3b) -----------------------------
  # A second, higher-precision signal for the ACTIVITY column, composed with
  # (never replacing) PR3a's pane leg — see docs/superpowers/specs/
  # 2026-09-24-row-tells-truth-design.md, "PR3 — activity states". Every
  # studio gets this, maestro included, exactly like the session re-emit hook
  # just above — observability, not a write-permission gate, so this whole
  # block sits OUTSIDE both STUDIO_LEAD_DISALLOWED (lead-gate/session-reemit,
  # above) and STUDIO_COMPLETION_GATE (below): unconditional within the
  # materialization block, gated on neither.
  #
  # Single source of truth, same copy-then-chmod idiom as every other hook in
  # this file — see the lead-gate block's own comment for the guard/warn
  # posture (a missing source file warns loudly, falls through, never aborts
  # bring-up outright).
  mkdir -p ~/.claude/hooks
  if [ -f /opt/blueprint/gates/activity-heartbeat.sh ]; then
    cp /opt/blueprint/gates/activity-heartbeat.sh ~/.claude/hooks/activity-heartbeat.sh
  else
    echo "studio-bringup: /opt/blueprint/gates/activity-heartbeat.sh missing -- cannot install activity-heartbeat hook" >&2
  fi
  chmod 0755 ~/.claude/hooks/activity-heartbeat.sh 2>/dev/null || true

  # settings.json: merge, never clobber — same drop-prior-entry-then-append
  # idiom every other hook write in this file already uses, across FOUR
  # hook-event arrays at once (SessionStart alongside session-reemit's own
  # existing entry; UserPromptSubmit/Notification brand new in this
  # codebase). FAIL OPEN, not fail closed — the ONE deliberate departure
  # from the lead-gate/completion-gate command shape above/below: a missing
  # or non-executable heartbeat script is observability lost, never a
  # reason to block a turn, so the guarded command silently does nothing
  # (falls through to its own unconditional `exit 0`) rather than refusing
  # the call the way `[ -x "$S" ] || { ... exit 2; }` does for those two.
  #
  # >>> activity-heartbeat-settings-merge >>>
  mkdir -p ~/.claude
  python3 -c '
import json, os
path = os.path.expanduser("~/.claude/settings.json")
try:
    with open(path) as f:
        cfg = json.load(f)
except (FileNotFoundError, ValueError):
    cfg = {}
guarded = (
    "S=\"$HOME/.claude/hooks/activity-heartbeat.sh\"; "
    "[ -x \"$S\" ] && exec \"$S\"; "
    "exit 0"
)
entry = {"hooks": [{"type": "command", "command": guarded}]}
for evt in ("SessionStart", "UserPromptSubmit", "Stop", "Notification"):
    arr = cfg.setdefault("hooks", {}).setdefault(evt, [])
    arr[:] = [e for e in arr if "activity-heartbeat.sh" not in json.dumps(e)]
    arr.append(entry)
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
'
  # <<< activity-heartbeat-settings-merge <<<

  # --- completion gate (Tier 0, spec §4) -------------------------------------
  # "No completion without verification" + "scope-scaled process on every
  # task": a Stop hook that refuses to let the lead finish until the work
  # points at a COMMITTED plan doc and carries green build/lint/check/test
  # evidence. Spec §4's own words for this row: "Stop hook blocks 'done' until
  # build+lint+check+test outputs present and green. Deterministic, not
  # prompt-based."
  #
  # Installed ONLY for a studio whose roster holds a write tool
  # (STUDIO_COMPLETION_GATE, derived by studio-blueprint.ts's writesCode from
  # the members themselves). Never for the Maestro: it never implements, so a
  # gate demanding a plan doc and a build log would refuse every coordination
  # turn it ever takes and the studio would be unusable.
  #
  # Fix-tasks are exempt from re-brainstorming, never from plan+verify (spec
  # §4, verbatim) — which is exactly the line this gate draws: it asks for a
  # plan doc and verification, and never for a brainstorm.
  #
  # HONEST SCOPE -- read before trusting this. The gate does NOT re-run the
  # build. A Stop hook runs inside claude's own turn budget and a real build
  # takes minutes; a hook that shelled out to one would hang the studio far
  # more often than it would catch a lie. What it enforces is that a
  # verification RECORD exists, is complete against the repo's own scripts,
  # claims exit 0, and carries output for each command. A determined agent can
  # write a false record. A drifting one cannot skip the step silently, which
  # is the failure this exists for.
  #
  # ALSO demands verification INTENT (P5 spec §4): url, steps, expected --
  # where a HUMAN checks this landed, not a build log. Every studio, every
  # task, every domain -- not code-only, unlike the build/lint/check/test
  # row above. Same shape src/board/envelope.ts's payload.verification wants;
  # asked again here because this Stop hook cannot see the HTTP call the lead
  # makes later, and that later call cannot see inside a dead container.
  if [ -n "${STUDIO_COMPLETION_GATE:-}" ]; then
    mkdir -p ~/.claude/hooks
    # Same single-source-of-truth copy as the lead gate above -- see its
    # comment for the guard/warn posture and why the file now lives at
    # gates/completion-gate.sh in the blueprint repo instead of a heredoc.
    if [ -f /opt/blueprint/gates/completion-gate.sh ]; then
      cp /opt/blueprint/gates/completion-gate.sh ~/.claude/hooks/completion-gate.sh
    else
      echo "studio-bringup: /opt/blueprint/gates/completion-gate.sh missing -- cannot install completion-gate hook" >&2
    fi
    chmod 0755 ~/.claude/hooks/completion-gate.sh 2>/dev/null || true

    # Same merge-not-clobber, drop-prior-entry, fail-CLOSED idiom the
    # lead-gate settings.json write uses -- see its comment for why each half
    # is there (a deleted script, a lost chmod and a different $HOME all used
    # to let the call through silently).
    mkdir -p ~/.claude
    python3 -c '
import json, os
path = os.path.expanduser("~/.claude/settings.json")
try:
    with open(path) as f:
        cfg = json.load(f)
except (FileNotFoundError, ValueError):
    cfg = {}
stop = cfg.setdefault("hooks", {}).setdefault("Stop", [])
guarded = (
    "S=\"$HOME/.claude/hooks/completion-gate.sh\"; "
    "[ -x \"$S\" ] || { echo \"completion-gate hook absent or not executable -- refusing (Tier 0)\" >&2; exit 2; }; "
    "exec \"$S\""
)
entry = {"hooks": [{"type": "command", "command": guarded}]}
stop[:] = [e for e in stop if "completion-gate.sh" not in json.dumps(e)]
stop.append(entry)
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
'
  fi

  # --- fail closed on the gate ----------------------------------------------
  # SECURITY, and the reason this is an exit and not a warning: the lead gate
  # is the ONLY structural thing standing between a lead and Edit/Write
  # (spec decision 11 -- leads never implement; every studio grants Bash and
  # --dangerously-skip-permissions means allowedTools gates nothing). A studio
  # that comes up without it is an ungated lead holding write tools, and it
  # looks identical from outside to a healthy one -- that is exactly what
  # happened to websites--maestro on 2026-08-26 (SKILLS=0 AGENTS=0 BP=0
  # HOOKDIR=0, settings.json with no hooks key, and the provisioned route
  # answering "provisioned" the whole time).
  #
  # So bring-up verifies what it just installed instead of assuming the writes
  # landed, and REFUSES TO LAUNCH CLAUDE when they did not. Refusing to boot is
  # the safe direction: a studio that will not start is visible and one command
  # from repair, while an ungated one is invisible until it has already
  # implemented something. Do NOT soften this into a warn-and-continue -- same
  # ruling as the python3 precondition at the top of this block.
  #
  # Covers all three ways the gate can be absent here: STUDIO_LEAD_DISALLOWED
  # unset or empty (the install block above never ran), a python3 write that
  # silently produced nothing, and a settings.json some other step clobbered
  # after the fact.
  if [ ! -x ~/.claude/hooks/lead-gate.sh ]; then
    echo "studio-bringup: lead-gate hook missing or not executable at ~/.claude/hooks/lead-gate.sh -- refusing to boot an UNGATED lead (decision 11)" >&2
    exit 1
  fi
  if ! grep -q lead-gate.sh ~/.claude/settings.json 2>/dev/null; then
    echo "studio-bringup: ~/.claude/settings.json does not reference the lead-gate hook -- refusing to boot an UNGATED lead (decision 11)" >&2
    exit 1
  fi
  if [ -n "${STUDIO_COMPLETION_GATE:-}" ] && [ ! -x ~/.claude/hooks/completion-gate.sh ]; then
    echo "studio-bringup: completion-gate hook missing or not executable -- refusing to boot a code-writing studio with no verification gate (Tier 0)" >&2
    exit 1
  fi

  # The container's own record that it is a studio. Read by the guard ABOVE
  # this block on every later bring-up: a container that once materialized a
  # studio must never be re-brought-up as a plain role, because that path
  # installs no gate at all and this script would otherwise not know the
  # difference. Survives exactly as long as the container filesystem does,
  # which is the same lifetime the harness it describes has.
  printf '%s' "$STUDIO_NAME" > ~/.claude/.fleet-studio
fi

# window 0 ("claude") launch/respawn. Deliberately NOT
# `tmux new-session ... claude --continue ...` in one shot (handing the whole
# command through tmux's own re-parse breaks on a multi-line decoded prompt,
# and never re-fires if claude later exits — the session would just sit dead
# until someone noticed). Instead the window always runs a plain bash, and we
# `send-keys` the claude launch into it. That gives a real interactive shell
# for the terminal-watch bridge to attach to, AND makes "is claude currently
# running" answerable from tmux itself: `pane_current_command` reads "bash"
# exactly when nothing is running in the pane — true on first creation, and
# true again the moment claude exits for any reason (crash, /exit, a
# `--continue` session ending). Sending the launch only in that state is what
# makes a double bring-up a no-op (claude still running -> pane isn't "bash"
# -> skip) while still healing a dead session on the NEXT bring-up call —
# never on an internal timer/loop, so never a crash loop.
# --- first-run gates (operator-observed 2026-08-20) -------------------------
# claude launches fine in a fresh container and then STOPS, waiting on
# keyboard input nobody is there to give: the onboarding theme picker, the
# --dangerously-skip-permissions confirmation, and the per-directory folder
# trust dialog. Symptom from outside is indistinguishable from a dead studio
# -- container "running", zero burn, refresh frozen at spawn -- because the
# process IS up, just parked on a prompt. Seed the three flags claude itself
# writes once a human answers them.
#
# Merge, never clobber: ~/.claude.json also carries oauth/session state the
# image or a previous bring-up may already have put there, and settings.json
# carries the lead-gate hook installed above. Both are re-read on every
# bring-up, so this is idempotent by construction.
#
# Trust is seeded for BOTH paths a studio can run in: /container-server (the
# pane's actual cwd, what claude calls its project) and /workspace (the repo
# clone). Seeding only one leaves the dialog waiting the first time anything
# cds into the other.
bringup_step claude-launch
python3 - <<'PYSEED'
import json, os
home = os.path.expanduser("~")
cfg = os.path.join(home, ".claude.json")
d = json.load(open(cfg)) if os.path.exists(cfg) else {}
d["hasCompletedOnboarding"] = True
projects = d.setdefault("projects", {})
for path in ("/container-server", "/workspace"):
    e = projects.setdefault(path, {})
    e["hasTrustDialogAccepted"] = True
    e["hasClaudeMdExternalIncludesApproved"] = True
    e["hasClaudeMdExternalIncludesWarningShown"] = True
json.dump(d, open(cfg, "w"))

sp = os.path.join(home, ".claude", "settings.json")
os.makedirs(os.path.dirname(sp), exist_ok=True)
s = json.load(open(sp)) if os.path.exists(sp) else {}
s["skipDangerousModePermissionPrompt"] = True
json.dump(s, open(sp, "w"))
PYSEED

# --- claude launch helpers (issue #54) --------------------------------------
# Real functions rather than inline one-liners so the decisions below are
# executable off-container: test/bun/bringup-claude-launch.test.ts extracts
# these four bodies verbatim out of THIS file and runs them against a temp
# HOME and a fake tmux, so what the tests exercise is the shipped code, not a
# re-typed copy of it.

# Where claude keeps the conversation for a given launch cwd. claude scopes
# sessions by cwd, storing each under ~/.claude/projects/<cwd with every
# non-alphanumeric character replaced by `-`>, transcripts inside it as
# `<session-uuid>.jsonl` — the same layout src/studio/burn.ts already parses
# out of the session archive.
claude_project_dir() {
  printf '%s' ~/.claude/projects/"$(printf '%s' "$1" | tr -c 'a-zA-Z0-9' '-')"
}

# True only when a conversation claude can actually resume exists for that
# cwd — a session FILE, never the directory.
#
# Directory existence was the bug (issue #54, measured 2026-09-23 on
# `acme-os--web-studio` after an image rollout replaced its container):
# `/root/.claude/projects/-workspace-acme-os/` existed and contained ONLY
# `memory/`, no session file at all. The dir-existence guard passed, claude
# was launched with `--continue`, printed "No conversation found to continue"
# and EXITED — container `running`, lead dead, and every re-provision
# repeated it (runSessionRestore untars the directory back BEFORE bring-up,
# so moving it aside did not help either).
#
# `-maxdepth 1` is what keeps `memory/` out of the answer: it is claude's own
# memory-tool directory, written and restored independently of any
# conversation, and nothing in it is resumable. `-print -quit` stops at the
# first hit — a studio with hundreds of session files pays for one stat, not
# a full walk.
claude_has_conversation() {
  [ -n "$(find "$(claude_project_dir "$1")" -maxdepth 1 -type f -name '*.jsonl' -print -quit 2>/dev/null)" ]
}

# One tmux field about the claude window's pane, or empty if tmux did not
# answer ABOUT THAT WINDOW.
#
# HARDENED, and the hardening is load-bearing (issue #41 / PR #60, re-measured
# on tmux 3.2a for issue #67): `tmux display-message -p -t studio:claude
# '#{...}'` run where that window does NOT exist silently answers about the
# CURRENT pane and exits 0. It cannot fail; it lies. A server whose claude
# window is gone, with `studio:shell` active, answers `bash` — and a launch
# guard that believes it sends a claude at a pane it cannot identify. So the
# format carries `#{session_name}:#{window_name}` (exactly as the #43 readback
# above and src/studio/wake.ts's PANE_PROBE_CMD already do) and an answer that
# is not about `studio:claude` is DISCARDED, never believed. Empty therefore
# means "unknown", never "nothing running".
#
# INVISIBLE BY CONSTRUCTION, and this is a hard fleet rule, not a style
# choice: `display-message -p -t studio:claude` addresses the window BY NAME
# and does not require it to be active, so this switches nothing and leaves
# no trace an operator attaching later can see. A probe that selected a
# window and left window 1 active once made a healthy studio look dead and
# cost an hour. If a future variant ever DOES need a window switch, it must
# restore it in the SAME command line, never as a separate step.
claude_pane_field() {
  local answer
  answer="$(tmux display-message -p -t studio:claude "#{session_name}:#{window_name} $1" 2>/dev/null || true)"
  case "$answer" in
    "studio:claude "*) printf '%s' "${answer#studio:claude }" ;;
  esac
}

# What the claude window's pane is running right now. THE one liveness signal
# this script reads — every question below (launch or not, did the launch
# land, did the stop take) goes through this function, so no two decisions in
# this bring-up can ever disagree about whether the lead is up.
#
# KNOWN LIMIT, measured: `pane_current_command` returns `claude` in THREE
# different states — the lead mid-turn, the lead idle waiting on subagents,
# and the lead parked on a modal. It answers ALIVE-or-DEAD. It never answers
# WORKING-or-STOPPED, and nothing below may be read as evidence of work. In
# particular a WEDGED lead is indistinguishable here from a working one, which
# is why claude_launch_needed never replaces one on its own guess.
claude_pane_command() {
  claude_pane_field '#{pane_current_command}'
}

# Did the launch this script just sent actually land, and stay landed?
#
# The second half of issue #54, and arguably the worse half: bring-up
# `send-keys` the launch line and returned without ever looking at the pane
# again (see the window-0 comment above for why the launch is a send-keys at
# all). claude exiting one second later was therefore INVISIBLE to provision,
# which reported success over a container that was `running` with a dead
# lead. The readiness check catches this — it did, as "harness incomplete:
# caveman never activated", because claude never stayed up long enough for
# the SessionStart hook to fire — but only minutes later and under a name
# that reads as a plugin problem rather than a dead lead.
#
# Two observations, because one is not enough. The wait answers "did claude
# ever come up" (claude that exits immediately never becomes the pane command
# at all, so the loop simply times out). The settle re-check answers "is it
# still up", catching the case where the one-second poll happened to sample
# the pane during claude's brief life.
#
# CLAUDE_ALIVE_TRIES matches src/studio/provision.ts's
# PROVISIONED_CHECK_TRIES (20, one probe per second) deliberately: the
# readiness check has been treating "not claude after 20s" as not-running on
# this same fleet for a month, so bring-up adopting the same budget cannot
# newly fail a studio that check would have passed. Both knobs are test
# seams, the same kind FLEET_WORKSPACE already is above — production sets
# neither, so the defaults here ARE the production values.
claude_launch_landed() {
  local i=0
  local p=""
  while [ "$i" -lt "${CLAUDE_ALIVE_TRIES:-20}" ]; do
    p="$(claude_pane_command)"
    [ "$p" = claude ] && break
    i=$((i + 1))
    sleep 1
  done
  # The loop's OWN last observation, never a fresh probe: re-reading the pane
  # here would both spend a probe the loop already spent and mislabel a
  # claude that came up and then died in between as one that never came up.
  if [ "$p" != claude ]; then
    echo "studio-bringup: claude is not running in tmux studio:claude ${CLAUDE_ALIVE_TRIES:-20}s after the launch was sent (pane runs: ${p:-none}) -- the lead never came up" >&2
    return 1
  fi
  sleep "${CLAUDE_SETTLE_SECONDS:-3}"
  p="$(claude_pane_command)"
  # Only "bash" counts as an exit, never "anything that is not claude". The
  # window runs a plain bash, so `pane_current_command` reads "bash" exactly
  # when NOTHING is running in the pane — the script's own signal, reused
  # here rather than a second, differently-shaped liveness test. Any other
  # value means some process still owns the pane (a SessionStart hook, a git
  # subprocess seconds into startup) and the lead is not dead. The asymmetry
  # is deliberate: a missed dead lead costs one more provision cycle, a FALSE
  # dead lead costs an operator an hour chasing a healthy studio, and this
  # fleet has paid that price three times.
  if [ "$p" = bash ]; then
    echo "studio-bringup: claude exited within ${CLAUDE_SETTLE_SECONDS:-3}s of launching (pane runs: ${p:-none}); see /workspace/.transcript/claude.log" >&2
    return 1
  fi
  return 0
}

# --- never two leads (issue #67) ---------------------------------------------
# MEASURED 2026-09-23 on `fleetflare--release-studio`, after a day of repeated
# provisions: `pgrep -fc claude` = 62, `free -m` = 458MB free, and the lead
# dead twice in ten minutes — each death reported as `bare: claude is not
# running in tmux studio:claude`. After `fleet recycle`, the same container
# read 3 processes and 4978MB free. Same studio, same image, same work; the
# only variable was the accumulated processes.
#
# The loop is the dangerous part, and every step of it follows the runbook: a
# starved container kills the lead -> a dead lead reads `bare` -> the
# documented recovery for `bare` is `fleet provision` -> that adds another
# claude -> memory drops -> it dies sooner. Each cycle is faster than the last.
#
# Stopping a claude, deliberately, so a replacement can be launched without
# ever leaving two. `respawn-pane -k` is the fleet's existing idiom for this,
# not a new one: src/studio/failover.ts's accountSwitchCmd already kills and
# respawns this exact pane before re-running THIS script, and then waits for
# the pane to read `bash` the same way. It needs no procps (`pkill`/`pgrep`
# are NOT guaranteed present in this image — see the tailscale note at the top
# of this file), it addresses the window BY NAME so it stays invisible, and it
# returns the pane to the plain bash the rest of this script keys off.
#
# Refusing (non-zero) when the pane does not come back to `bash` is the half
# that matters: the caller must NOT launch into a pane something still owns.
claude_stop() {
  local i=0
  local p=""
  # C-c FIRST, and only then the kill. The lead being replaced is usually a
  # working process, not a corpse: claude flushes its session .jsonl on a
  # clean interrupt, and that file is what `--continue` reads on the very
  # next launch this function exists to make room for. respawn-pane -k skips
  # the flush, so going straight to it would trade a live lead's conversation
  # for a few seconds -- the same conversation claude_has_conversation is
  # about to look for.
  tmux send-keys -t studio:claude C-c 2>/dev/null || true
  while [ "$i" -lt "${CLAUDE_STOP_TRIES:-10}" ]; do
    p="$(claude_pane_command)"
    [ "$p" = bash ] && return 0
    i=$((i + 1))
    sleep 1
  done
  # A lead that ignores C-c is WEDGED, which is exactly the case the caller
  # asked to replace. respawn-pane keeps the PANE -- and with it the
  # 50000-line history and the pipe-pane target the transcript step
  # re-establishes below -- and replaces only the process inside it.
  echo "studio-bringup: tmux studio:claude ignored C-c for ${CLAUDE_STOP_TRIES:-10}s (runs '${p:-unknown}') -- killing the pane's process with respawn-pane -k" >&2
  tmux respawn-pane -k -t studio:claude 2>/dev/null || true
  i=0
  while [ "$i" -lt "${CLAUDE_STOP_TRIES:-10}" ]; do
    p="$(claude_pane_command)"
    [ "$p" = bash ] && return 0
    i=$((i + 1))
    sleep 1
  done
  echo "studio-bringup: tmux studio:claude still runs '${p:-unknown}' after respawn-pane -k -- the pane did not come back to a bare bash" >&2
  return 1
}

# Does this bring-up have to launch claude at all? The whole of issue #67's
# first point, and the reason it is a function: provision is documented as
# safe to re-issue (the guarded clone makes the FILESYSTEM side idempotent),
# so a coordinator re-issues it freely and the LEAD side has to be idempotent
# too.
#
# It reuses claude_pane_command — the same answer claude_launch_landed reads
# and the same signal src/studio/provision.ts's provisionedCheckCmd reads —
# rather than asking tmux a second, differently-shaped question that could
# disagree with the first. The previous inline probe here was exactly that
# second question, and it was the UNHARDENED form: on a server with no
# `studio:claude` window it would have read another window's `bash` and taken
# the launch branch.
#
# Only a bare `bash` is a launch. Every other answer is a refusal, and the
# asymmetry is deliberate — the cost of a missed launch is one more provision
# (the operator's own next step), while the cost of a launch too many is the
# loop above.
#
# WEDGED IS NOT DETECTABLE HERE, stated plainly because issue #67 asks for it:
# `pane_current_command` reads `claude` for a lead mid-turn, for a lead idle
# waiting on subagents, and for a lead parked on a modal. Nothing in this
# script can tell those apart, so nothing in this script may decide on its own
# that a live claude is "stuck" and kill it — the one wedged state this fleet
# CAN detect is the rate-limit modal, by its text, and that lives in
# src/studio/failover.ts, which does its own deliberate respawn before
# re-running this script. Replacement here is therefore operator-triggered
# only: STUDIO_REPLACE_CLAUDE=1 says "I have decided this one must go".
claude_launch_needed() {
  local p
  p="$(claude_pane_command)"
  case "$p" in
    bash)
      return 0
      ;;
    claude)
      if [ "${STUDIO_REPLACE_CLAUDE:-0}" = "1" ]; then
        echo "studio-bringup: STUDIO_REPLACE_CLAUDE=1 -- stopping the claude already running in tmux studio:claude before launching its replacement" >&2
        claude_stop && return 0
        echo "studio-bringup: refusing to launch a second claude over one that would not stop" >&2
        return 1
      fi
      # Reported, and reported on STDOUT as a normal bring-up line: an
      # operator who re-issues provision after a scare must be able to see
      # that this run did nothing to the lead, instead of assuming it
      # restarted it. Silence here is what let 62 processes look like 62
      # successful recoveries.
      # >&2, not bare echo. bringup_finish's EXIT trap flushes only
      # FLEET_BRINGUP_STDERR_TMP into FLEET_BRINGUP_LOG, and the Worker reads
      # only bringupRes.stderr. Nothing anywhere consumes bring-up STDOUT, so
      # the previous bare `echo` landed in no log, no status row and no Worker
      # tail -- while the comment above it claimed the opposite. That is the
      # exact silence this notice exists to end: an operator re-issuing
      # provision after a scare needs evidence the run left the lead alone.
      echo "studio-bringup: claude is ALREADY running in tmux studio:claude -- launched nothing and left the existing lead untouched (re-issuing provision does not restart a live lead; to replace it deliberately, re-run bring-up with STUDIO_REPLACE_CLAUDE=1)" >&2
      return 1
      ;;
    "")
      echo "studio-bringup: could not identify tmux studio:claude -- tmux answered about another window, or the window is gone; refusing to send a launch at a pane this script cannot name" >&2
      return 1
      ;;
    *)
      # >&2 for the same reason as the ALREADY-running notice above.
      echo "studio-bringup: tmux studio:claude runs '$p', which is neither claude nor a bare bash -- some process still owns that pane, so this bring-up launched nothing" >&2
      return 1
      ;;
  esac
}

# --- the launch keystrokes (issue #90) ---------------------------------------
# MEASURED 2026-09-24 (live capture on demosite-life--release-studio, and the
# real-tmux harness in test/bun/bringup-claude-relaunch.test.ts): an attach
# client -- Orca's xterm.js reconnecting to a fresh container -- answers
# tmux's DA2 and XTVERSION queries, and replies tmux does not consume land in
# this pane's readline as KEYSTROKES. `ESC P` is M-p, a history search: the
# launch typed next is eaten, nothing runs, and 20s later the verdict reads
# `pane runs: bash`. Typed again without clearing, the launch lands in front
# of the leftover `0;276;0c` and claude starts with a corrupted argv.
#
# C-c first discards whatever readline holds. Only ever sent here, where
# claude_launch_needed has already established the pane is a bare bash (or
# claude_stop made it one) -- never into a running claude.
#
# ONE retry, the same way, and only when the pane still reads exactly `bash`:
# nothing is running there, so a second launch can never make a second lead.
# Any other answer means some process owns the pane, and nothing is typed.
#
# The launch is typed with ONE leading space. MEASURED (#145 review): a C-c
# into a bash that is not yet idle at readline -- a fresh or respawned pane
# still running its rc files, e.g. the STUDIO_REPLACE_CLAUDE path -- makes
# bash eat the first byte typed after it (`d /workspace/..: command not
# found`, then +20s). Under load that lost 7/40 launches on tmux 3.4/bash 5.2
# and 17/40 on the image's tmux 3.2a/bash 5.1; with the space, 0/40. A
# leading space is a no-op to bash, so losing it costs nothing.
claude_launch() {
  tmux send-keys -t studio:claude C-c 2>/dev/null || true
  # Let bash act on the C-c before the launch keys (#145 review): under
  # load, typed right behind it the launch still went into the
  # reply-opened search, and the retry glued the leftover onto argv —
  # 4/250 leads ran as `claude 3000` on the prod stack; with a gap, 0/580.
  sleep 1
  tmux send-keys -t studio:claude -- " $1" Enter
  claude_launch_landed && return 0
  [ "$(claude_pane_command)" = bash ] || return 1
  echo "studio-bringup: retrying the launch ONCE, C-c first (issue #90: an attach client's terminal replies can eat the first launch)" >&2
  tmux send-keys -t studio:claude C-c 2>/dev/null || true
  sleep 1
  tmux send-keys -t studio:claude -- " $1" Enter
  claude_launch_landed
}

# The line claude_launch types: `claude_launch_line <prompt> <repo-dir> <arg>...`.
#
# Issue #6, measured 2026-09-28: the role prompt used to ride INSIDE this
# line, printf %q-quoted, and a 4.4 KB task brief pushed the send-keys past
# tmux's message limit -- `command too long`, launch and retry both failed,
# and the pane showed only the retry's ^C. So the prompt goes to a file under
# .fleet and the typed line reads it back with "$(cat ...)": the pane's bash
# expands it into ONE argv element, and the line stays the same few hundred
# bytes whatever the brief's size. $(...) strips trailing newlines, exactly
# as the $(base64 -d) that produced the prompt already did.
#
# A file that cannot be written falls back to the old inline line, loudly: a
# short brief still launches that way, and a studio that boots degraded
# beats one that never tries.
#
# `env -u TMUX -u TMUX_PANE` (issue #117): the pane's shell carries TMUX
# pointing at the studio's server, and a plain `tmux` honours $TMUX before
# anything else. Stripped here, the lead and every gate or test it spawns
# reach the DEFAULT server; the studio's is reachable only by name. `env`
# execs claude, so the pane still reads `claude`.
claude_launch_line() {
  local prompt="$1" dir="$2" line
  local file="${FLEET_WORKSPACE:-/workspace}/.fleet/role-prompt.md"
  shift 2
  if { mkdir -p "${file%/*}" && printf '%s' "$prompt" > "$file"; } 2>/dev/null; then
    line="$(printf '%q ' env -u TMUX -u TMUX_PANE claude "$@")--append-system-prompt \"\$(cat $(printf '%q' "$file"))\""
  else
    echo "studio-bringup: could not write the role prompt file $file -- inlining the prompt into the launch line (issue #6: a long one overflows tmux)" >&2
    line="$(printf '%q ' env -u TMUX -u TMUX_PANE claude "$@" --append-system-prompt "$prompt")"
    # Issue #21: past this, tmux answers only "command too long" -- the
    # symptom. 16338 bytes is the largest send-keys argument tmux accepts
    # (MEASURED 2026-09-29, tmux 3.2a in the studio image and 3.4).
    local n
    n="$(printf '%s' "$line" | wc -c | tr -d ' ')"
    [ "$n" -gt 16338 ] && echo "studio-bringup: launch line is $n bytes, over tmux's 16338-byte send-keys limit -- the role prompt is too large to inline and this launch will fail; fix the role prompt file write above" >&2
  fi
  # Start claude IN the checkout, not in the image's own WORKDIR (observed
  # 2026-08-20: a lead asked about README.md looked in /container-server).
  # Guarded: a missing checkout (clone failed, bare container) falls back to
  # the pane's own directory, so the studio still comes up attachable.
  [ -n "$dir" ] && [ -d "$dir" ] && line="cd $(printf '%q' "$dir") && $line"
  printf '%s' "$line"
}

# How many processes on this container match `claude` right now, logged on
# every bring-up. Pure observation: it kills nothing and fails nothing.
#
# Issue #67's "worth considering" item. The accumulation was only ever seen
# from the OUTSIDE, by an operator running `pgrep -fc claude` by hand after
# the container was already starved; nothing recorded it as it grew. This line
# puts the count and the free memory in the bring-up log of every provision,
# so the next occurrence arrives with its own history instead of a snapshot.
#
# Honest about what it counts: `pgrep -f` matches the whole COMMAND LINE, so
# hooks under ~/.claude, the transcript `cat >> .../claude.log`, and MCP
# servers with a claude path in their argv all count. It is a trend, not a
# lead census — which is exactly why it warns rather than acts.
#
# procps is NOT guaranteed in this image (see the tailscale note at the top of
# this file), so both tools are probed before use and their absence is silent.
claude_process_census() {
  command -v pgrep >/dev/null 2>&1 || return 0
  local n
  n="$(pgrep -fc claude 2>/dev/null)" || n=0
  local free_mb="?"
  if command -v free >/dev/null 2>&1; then
    free_mb="$(free -m | awk '/^Mem:/ {print $NF}' 2>/dev/null || echo '?')"
  fi
  echo "studio-bringup: processes matching 'claude' on this container: $n (free MB: $free_mb)"
  if [ "$n" -gt "${CLAUDE_PROCESS_WARN:-12}" ]; then
    echo "studio-bringup: WARNING $n processes match 'claude' on this container (threshold ${CLAUDE_PROCESS_WARN:-12}, free MB: $free_mb) -- 62 of them starved this fleet's lead to death twice in ten minutes (issue #67). Re-provisioning does NOT clear them; a recycle does" >&2
  fi
  return 0
}

# >>> claude-launch >>>
claude_process_census
if claude_launch_needed; then
  role_prompt="$(base64 -d <<< "${ROLE_PROMPT_B64:-}")"
  # The working set, kept on disk so a compaction can replay it. Bring-up
  # sends this once as claude's opening prompt; after a compact that prompt is
  # gone from context and nothing else holds it. FLEET_WORKSPACE below is a
  # deliberate test seam, not leaked config: /workspace is an absolute
  # container path with no hermetic way to test it off-container, and
  # production never sets this var, so the default IS the production value.
  #
  # Both lines guarded (review finding, Important): this script runs under
  # set -e (:21) and neither line was guarded, so an unwritable
  # FLEET_WORKSPACE (or a full disk) aborted bring-up before claude ever
  # launched -- confirmed by isolated repro under the same set flags. Same
  # `|| echo ... >&2` idiom already used at :331 for the blueprint clone: a
  # convenience must never be able to take the whole studio down. A studio
  # that cannot replay after a compaction is degraded; one that cannot boot
  # is dead -- replay is strictly the lower priority.
  mkdir -p "${FLEET_WORKSPACE:-/workspace}/.fleet" \
    || echo "studio-bringup: could not create .fleet dir -- compaction replay disabled this boot" >&2
  printf '%s\n' "$role_prompt" > "${FLEET_WORKSPACE:-/workspace}/.fleet/working-set.md" \
    || echo "studio-bringup: could not persist working-set.md -- compaction replay disabled this boot" >&2
  claude_args=()
  # Security (operator directive 2026-08-19): IS_SANDBOX=1 (baked into
  # Dockerfile.studio) unlocks --dangerously-skip-permissions as root
  # (verified on pinned 2.1.224 — without it, root gets "cannot be used with
  # root/sudo privileges"; with it, launches). Honest: this container IS a
  # Firecracker microVM. Safe: it holds NO Cloudflare creds, only a
  # 1h-scoped GitHub App installation token; merges/deploys are gated by the
  # Worker's approval flow, never claude's own prompts — so bypassing
  # in-container permission prompts widens nothing that reaches production.
  # Where claude will actually run: the checkout, when it exists. Computed
  # HERE because the --continue guard below is cwd-scoped and must agree
  # with the cd applied at launch — a guard testing one directory while
  # claude starts in another is what produced the exit above.
  repo_dir="/workspace/${STUDIO_ID%%--*}"
  [ -d "$repo_dir" ] || repo_dir=""
  claude_args+=(--dangerously-skip-permissions)
  # First run ever (no prior claude session on disk) must NOT pass
  # --continue — there is nothing to continue yet, and claude errors on it.
  #
  # The guard is PER PROJECT, not "any session anywhere", and it tests for a
  # session FILE, not for the project directory — see
  # claude_has_conversation's own doc comment above for both measured
  # failures that taught it those two things. A studio with no conversation
  # launches WITHOUT the flag and starts fresh with its full
  # --append-system-prompt brief, which is strictly better than dying: the
  # brief is 8KB the pane scrollback truncates, so a lead that exits takes
  # the only copy of its own instructions with it.
  if claude_has_conversation "${repo_dir:-$PWD}"; then claude_args+=(--continue); fi
  # ONE argv element, never word-split. Each rule in the string legitimately
  # CONTAINS spaces ("Bash(git *)"), so the previous `read -r -a` split turned
  # the real six-rule value into 10 broken tokens (`Bash(git`, `*)`, ...) —
  # claude silently ignores an unbalanced token, so the studio would have come
  # up with every mutating command denied and no error anywhere. Same shape
  # container/server.ts already relies on for the byte-identical string
  # (its runClaude argv: `"--allowedTools", "Bash(git *) ... Edit Write"`):
  # hand claude the whole policy and let its own paren-aware tokenizer split
  # it. The printf %q in claude_launch_line is what keeps it one argument
  # through the pane's bash re-parse. The role prompt itself is NOT in
  # claude_args: claude_launch_line passes it by file (issue #6).
  claude_args+=(--allowedTools "${ROLE_ALLOWED_TOOLS:-}")
  # Fleet CTO effort default (operator directive 2026-08-19): provision.ts
  # resolves this per-role (blueprint.ts's roleBringupEnv) — explicit
  # frontmatter effort wins, else "max" for the cto role, else empty. Empty
  # means claude's own default: only pass --effort when a real value is set.
  [ -n "${ROLE_EFFORT:-}" ] && claude_args+=(--effort "$ROLE_EFFORT")
  cmd_str="$(claude_launch_line "$role_prompt" "${repo_dir:-}" "${claude_args[@]}")"
  # Issue #6: the typed line's size, on record in the bring-up log. It no
  # longer grows with the brief; a large number here means it leaked back.
  echo "studio-bringup: launch line is $(printf '%s' "$cmd_str" | wc -c | tr -d ' ') bytes (role prompt $(printf '%s' "$role_prompt" | wc -c | tr -d ' ') bytes)" >&2
  # Issue #54: claude_launch observes what the keystrokes actually did.
  # Recorded, not acted on here — the transcript pipe-pane below is the only
  # record of WHY claude exited and the shell window is the operator's way
  # in, so a failed launch needs the rest of this script MORE than a healthy
  # one does. The script's own exit code is settled at the very end instead.
  claude_launch "$cmd_str" || claude_launch_failed=1
fi
# <<< claude-launch <<<

# --- transcript pipe-pane ----------------------------------------------------
# Mirrors the claude window's pane byte-for-byte (ANSI included — it is the
# truth of the terminal) into a file src/studio/transcript.ts's shipTranscript
# tick reads and ships to R2. Placed AFTER the session/window block above:
# pipe-pane's target (studio:claude) must already exist.
#
# Deliberately the non-`-o` form. `-o` TOGGLES: measured in this exact image
# (tmux 3.2a) — running `tmux pipe-pane -o -t studio:claude '...'` twice
# leaves `#{pane_pipe}` at 0 the second time, silently turning capture off on
# every second bring-up. Without `-o`, tmux SETS the pipe unconditionally:
# measured in the same image that a second (or third) run leaves
# `#{pane_pipe}` at 1 every time, replaces the previous `cat` process with
# exactly one new one (never zero, never two), and loses no bytes across the
# re-pipe (markers written immediately before and after a repeat run both
# landed in the file). mkdir -p is separately idempotent.
bringup_step transcript-pipe
mkdir -p /workspace/.transcript

# Fix round (Critical): the generation marker src/studio/transcript.ts's
# shipTranscriptTick reads alongside its stat, to detect a container recycle
# between ticks (DO storage survives one; this file does not — see that
# function's own doc comment for the full two-guard design). Guarded
# create-if-absent, same idiom as every other bring-up step: written ONCE per
# container lifetime (never rewritten once present), so it stays stable
# across repeat bring-ups on the SAME container (e.g. a restart) and only
# changes when the whole filesystem — this file included — was wiped by a
# genuine recycle. /proc/sys/kernel/random/uuid is a kernel feature, not an
# extra binary dependency (measured present in this exact image).
[ -f /workspace/.transcript/boot-id ] || cat /proc/sys/kernel/random/uuid > /workspace/.transcript/boot-id

tmux pipe-pane -t studio:claude 'cat >> /workspace/.transcript/claude.log'

# --- shell window ------------------------------------------------------------
# >>> shell-window >>>
# #314: -d, so creating the shell window never makes it CURRENT. A client
# that attached while bring-up ran (a reconnect after a container
# replacement) follows the session's current window: without -d every such
# client landed on `1:shell*` and the next message meant for the lead ran in
# bash. Then select claude outright, so a session already left on shell (an
# older bring-up, an operator) comes back to the lead on every bring-up.
{ tmux_windows=$(tmux list-windows -t studio) && grep -q shell <(printf '%s' "$tmux_windows"); } || tmux new-window -d -t studio -n shell
tmux select-window -t studio:claude
# <<< shell-window <<<

# --- did the lead actually survive the launch? (issue #54) -------------------
# LAST statement in the script, deliberately: every other bring-up step has
# run by now, so the container an operator attaches to is as complete as it
# can be, and only the verdict is left.
#
# Non-zero is the whole point. src/studio/provision.ts's runProvision throws
# on `bringupRes.code !== 0` and degrades the studio with this stderr text
# attached, so "claude exited on launch" reaches the operator as a degraded
# status with the reason in it, instead of `state: running, error: null` over
# a dead lead — which is exactly what issue #54 measured, twice, on
# `acme-os--web-studio`.
#
# `exit` is safe here and NOT the sandbox-session hazard PROVISIONED_OK's doc
# comment describes: this script is exec'd as a child process
# (/opt/fleet/studio-bringup.sh), never sourced into the long-lived
# container-server session shell, and it already exits 1 on the missing
# completion-gate check above for the same reason.
#
# Its own step (issue #38). Without this the verdict would exit under
# `transcript-pipe` and the log would read `end exit=1 last-step=transcript-
# pipe` over a dead lead -- naming the wrong region, which is precisely the
# forensic confusion the bring-up log exists to end.
bringup_step launch-verdict
if [ "${claude_launch_failed:-0}" = 1 ]; then
  echo "studio-bringup: claude is NOT running in tmux studio:claude -- refusing to report this bring-up as successful (reason above)" >&2
  exit 1
fi
