#!/usr/bin/env bash
# Issue #221 (PR3b) — the hook heartbeat: a second, higher-precision signal
# for the ACTIVITY column, COMPOSED WITH (never replacing) PR3a's pane leg
# (activity.ts's readActivityFrame/nextActivity — the pane still decides
# LIMIT/WAITING MEMBERS unconditionally, and wins ties on WORKING/IDLE). See
# docs/superpowers/specs/2026-09-24-row-tells-truth-design.md, "PR3 —
# activity states", the paragraph beginning "Preserved from the pre-existing
# PR3 sketch... for PR3b".
#
# Registered on FOUR hook events (studio-bringup.sh's own settings.json merge
# block, every studio, maestro included — same "observability, not a
# write-permission gate" shape gates/session-reemit.sh already established).
# Event -> state map, this hook's whole job:
#   UserPromptSubmit                                 -> working
#   Stop                                              -> idle
#   Notification, permission_prompt/elicitation_dialog -> waiting-question
#   Notification, idle_prompt                          -> idle
#   SessionStart                                      -> writes NOTHING (see below)
#
# SessionStart fires too (installed unconditionally, same as the other
# three) but writes nothing to the heartbeat file. Its own `source` field
# (startup/resume/clear/compact) is a cross-check against PR1's own
# container-boot session verdict (observed.ts's computeSessionVerdict) — a
# genuinely separate concern from this file's WORKING/IDLE/waiting-question
# axis. Wiring that cross-check into a stored field is explicitly out of
# scope for this PR (see the plan doc's own Task 5 section) — this event
# fires, does nothing, exits 0, same as every unmatched branch below.
#
# SILENT, ALWAYS EXIT 0 — load-bearing, not a style choice. SessionStart and
# UserPromptSubmit hook stdout is injected into the LEAD's OWN context window
# (the same measured fact gates/session-reemit.sh's own header documents),
# and a NONZERO exit from UserPromptSubmit specifically BLOCKS the call
# outright (gates/lead-gate.sh's/gates/completion-gate.sh's own "exit 2
# blocks" convention) — this heartbeat hook must NEVER be able to interrupt a
# turn, under any failure. Deliberately no `set -e`: every guarded command
# below falls through to a silent no-op on failure, and the script's last
# line is an unconditional `exit 0` regardless of what happened above.
#
# FAIL OPEN, not fail closed — the ONE deliberate departure from
# gates/lead-gate.sh's/gates/completion-gate.sh's own guard shape (both
# refuse, exit 2, when their own script/hook is missing or broken, because
# they protect decision 11). This is an OBSERVABILITY signal, not a safety
# gate: a missing/broken heartbeat script must never block a turn, only ever
# cost the fleet a still-accurate (if less precise) pane-only ACTIVITY read.
# This is about the EXIT CODE only (always 0, below) — `is_lead_session`
# (issue #221 fix round 2, item 2) separately fails CLOSED on the narrower
# question of whether to WRITE at all, for the opposite reason: writing an
# unverified claim can corrupt the real lead's own heartbeat, where skipping
# one write costs nothing. See that function's own doc comment.
#
# ATOMIC WRITE: tmp-then-mv into the SAME directory (same filesystem, so `mv`
# is an atomic rename) — the ship tick's own guarded read
# (`cat ... 2>/dev/null`, transcript.ts's shipTickCmd) must never be able to
# observe a torn/partial write. Same durability idiom this repo's own
# container scripts already use elsewhere (studio-bringup.sh's session-
# restore placement steps: write to a temp path first, `mv` only once the
# whole write has succeeded).
#
# Defense in depth (board issue #20, same guard every other gate in this
# repo already carries): STUDIO_ID is set in every real cloud studio's own
# process environment and inherited by any hook subprocess Claude Code
# spawns as a child of it — never set on a bare Mac. This makes the hook do
# nothing at all outside a real cloud studio, regardless of how it got onto
# disk.
[ -n "${STUDIO_ID:-}" ] || exit 0

FLEET_ACTIVITY_PATH="${FLEET_ACTIVITY_PATH:-${FLEET_WORKSPACE:-/workspace}/.fleet/activity.json}"

# Issue #221 fix round 2, item 2 (maestro review, PR #352) — a NESTED
# `claude -p` subprocess the LEAD itself spawns (container/memguard.ts's own
# doc comment, ~line 25 -- the SAME scenario memguard's own #238 fix already
# guards against, via resolveLeadParentPid/isProtected) shares the SAME
# STUDIO_ID/HOME/FLEET_ACTIVITY_PATH and fires the SAME hook events. Without
# this check, that subprocess's OWN Stop (finishing its own sub-task)
# overwrites the REAL lead's heartbeat with "idle" while the lead itself is
# still mid-turn.
#
# comm_of/ppid_of read straight from /proc rather than shelling out to `ps`
# (not guaranteed installed in every container image; /proc always is under
# Linux). ppid_of parses AFTER the last ") " in /proc/<pid>/stat, since the
# comm field (2nd, in parens) can itself contain spaces or parens.
comm_of() { cat "/proc/$1/comm" 2>/dev/null; }
ppid_of() {
  local stat rest
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  [ -n "$stat" ] || return 1
  rest="${stat##*) }"
  set -- $rest
  # $1 here is `state` (the field right after the closing paren); ppid is $2.
  [ -n "${2:-}" ] || return 1
  printf '%s\n' "$2"
}

# Walks up from THIS hook's own pid to the nearest ancestor whose comm is
# "claude" -- the claude process that actually fired this hook, lead or
# nested -- and prints THAT process's own ppid. Bounded (a handful of hops
# is always enough for a real hook-invocation chain; this must never loop
# forever on a corrupt /proc).
MAX_ANCESTOR_HOPS=10
nearest_claude_ancestor_ppid() {
  local pid=$$ hops=0
  while [ "$hops" -lt "$MAX_ANCESTOR_HOPS" ]; do
    if [ "$(comm_of "$pid")" = "claude" ]; then
      ppid_of "$pid"
      return $?
    fi
    pid="$(ppid_of "$pid")" || return 1
    [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null || return 1
    hops=$((hops + 1))
  done
  return 1
}

# THE lead is the one claude-named process whose own ppid is the pane shell
# tmux holds for studio:claude -- the SAME address studio-bringup.sh/
# memguard.ts's own resolveLeadParentPid already use for this exact pane. A
# nested claude -p's own parent is whatever spawned it (a Bash-tool shell),
# several hops further from the pane, so its nearest claude ancestor's own
# ppid never matches.
#
# FAILS CLOSED here -- the ONE deliberate departure from this script's own
# fail-open posture (this file's own header): tmux missing, the socket not
# up yet, or no claude-named ancestor found within MAX_ANCESTOR_HOPS all
# return 1 (not the lead). Skipping ONE heartbeat write costs nothing (the
# pane leg, PR3a, still covers the studio unconditionally); writing a
# heartbeat that MIGHT be a nested subprocess's own event risks corrupting
# the real lead's read. "Write nothing" is always the safer wrong answer
# here, unlike the rest of this script's own instrumentation, which is
# right to fail open toward "keep going" because there is no unverified
# CLAIM at stake if it does.
is_lead_session() {
  command -v tmux >/dev/null 2>&1 || return 1
  local pane_pid claude_ppid
  pane_pid="$(tmux -L fleet-studio display-message -p -t studio:claude '#{pane_pid}' 2>/dev/null)"
  [ -n "$pane_pid" ] || return 1
  claude_ppid="$(nearest_claude_ancestor_ppid)" || return 1
  [ "$claude_ppid" = "$pane_pid" ]
}

# One python3 read of stdin -> exactly three lines: the hook event name, a
# best-effort notification type/category (several real payload shapes
# tried), and the notification message text (newlines flattened, so the
# 3-line contract can never be broken by message content). Never raises past
# this block — an unreadable payload (missing python3, malformed JSON, stdin
# that is not even valid UTF-8) prints three empty lines, the exact same
# input an unrecognised event already produces below.
read_payload() {
  command -v python3 >/dev/null 2>&1 || { printf '\n\n\n'; return 0; }
  python3 -c '
import json, sys
try:
    raw = sys.stdin.read()
    d = json.loads(raw) if raw.strip() else {}
except Exception:
    d = {}
if not isinstance(d, dict):
    d = {}
event = d.get("hook_event_name", "")
ntype = d.get("notification_type") or d.get("type") or ""
message = d.get("message") or ""
if not isinstance(event, str):
    event = ""
if not isinstance(ntype, str):
    ntype = ""
if not isinstance(message, str):
    message = ""
print(event)
print(ntype)
print(message.replace(chr(10), " "))
' 2>/dev/null || printf '\n\n\n'
}

payload_out="$(read_payload)"
event="$(printf '%s\n' "$payload_out" | sed -n 1p)"
ntype="$(printf '%s\n' "$payload_out" | sed -n 2p)"
message="$(printf '%s\n' "$payload_out" | sed -n 3p)"

# Atomic tmp-then-mv write of one heartbeat line. Every failure mode here —
# an unwritable/non-existent parent directory, a full disk, a `date` call
# that somehow fails — degrades to a silent no-op (`return 0`), never a
# nonzero exit from the CALLER (write_state is called, never sourced/execed
# directly, so its own `return` only ends the function, not the script).
write_state() {
  is_lead_session || return 0
  local state="$1"
  local at dir tmp
  # Issue #221 fix round 3, LOW (maestro review, PR #352) — millisecond
  # precision (`%3N`). The whole-second-truncated stamp this used to write
  # loses ordering between two real events landing in the SAME second (a
  # UserPromptSubmit immediately followed by a Stop, or vice versa, both
  # measured to happen well under a second apart) — `nextActivity`'s own
  # `hookWinsAxis` (activity.ts) compares `hook.at` against `prev.observedAt`
  # with `<=` deciding "no new information," so a same-second SECOND event
  # could be silently dropped as a false tie. `%3N` is GNU coreutils' own
  # millisecond-of-second specifier, producing `...:00.123Z` — still a valid
  # ISO 8601 instant `Date.parse` on the Worker side accepts natively, and
  # `parseHookHeartbeat`'s own validation (activity.ts) is just
  # `Number.isFinite(Date.parse(at))`, no format regex to also update.
  #
  # Issue #370 (maestro review, PR #352 post-merge) — round 3's own comment
  # here claimed "this container never runs a date without %N support," true
  # of the PRODUCTION studio container (Linux/GNU always) but false of WHERE
  # THIS SCRIPT ALSO RUNS: `test/bun/bringup-hooks.test.ts` execs this exact
  # file for real, on whatever host `bun test` runs on — a maestro's own Mac
  # included. macOS ships BSD date, which has no `%N` at all and prints the
  # LITERAL characters `%3N` was asking for verbatim (`...:00.3NZ`) instead of
  # milliseconds — a malformed timestamp `Date.parse` reads as `NaN`, which is
  # why this broke 13 tests in that file on a Mac host, not just the one
  # asserting the ms-regex directly (anything reading `at` at all breaks once
  # it stops parsing). Fixed by VALIDATING the shape after asking for it,
  # falling back through: GNU `date` -> `gdate` (what `brew install coreutils`
  # installs on Mac — same fallback shape issue #310 already established for
  # `timeout`/`gtimeout` in git-wrapper.test.ts, reused here rather than
  # inventing a second convention) -> plain whole-second GNU/BSD `date` (both
  # dialects support this shape identically, so this floor never fails).
  # Never a python3/perl fallback: this script's own "silent, always exit 0,
  # zero new dependencies" posture (this file's own header) rules out adding
  # a runtime dependency neither prior tier already required.
  looks_like_ms() { case "$1" in *[0-9][0-9][0-9]Z) return 0 ;; *) return 1 ;; esac; }
  at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null)"
  if ! looks_like_ms "$at" && command -v gdate >/dev/null 2>&1; then
    at="$(gdate -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null)"
  fi
  if ! looks_like_ms "$at"; then
    at="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
  fi
  [ -n "$at" ] || return 0
  dir="$(dirname "$FLEET_ACTIVITY_PATH")"
  mkdir -p "$dir" 2>/dev/null || return 0
  tmp="${FLEET_ACTIVITY_PATH}.tmp.$$"
  # Issue #221 fix round 2, item 3 (maestro review, PR #352) — bash sets up
  # redirections left to right: when `> "$tmp"` itself fails to OPEN
  # (unwritable/missing parent dir, name too long, ...), bash reports that
  # failure to whatever stderr target is ALREADY in effect at that point in
  # the parse -- the ORIGINAL, unredirected stderr, since the trailing
  # `2>/dev/null` has not been applied yet. Wrapping the whole fallible
  # command in a `{ ...; }` group establishes the group's OWN `2>/dev/null`
  # redirection before the inner `>` redirection is ever attempted, so an
  # open failure is suppressed same as everything else here. Confirmed
  # empirically: the un-grouped form leaks "... File name too long"/
  # "Permission denied" straight to the real stderr regardless of the
  # trailing `2>/dev/null`; the grouped form does not.
  { printf '{"state":"%s","at":"%s"}\n' "$state" "$at" > "$tmp"; } 2>/dev/null \
    || { rm -f "$tmp" 2>/dev/null; return 0; }
  mv -f "$tmp" "$FLEET_ACTIVITY_PATH" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  return 0
}

case "$event" in
  UserPromptSubmit)
    write_state working
    ;;
  Stop)
    write_state idle
    ;;
  Notification)
    case "$ntype" in
      permission_prompt|elicitation_dialog)
        write_state waiting-question
        ;;
      idle_prompt)
        write_state idle
        ;;
      *)
        # Best-effort fallback when notification_type/type is absent from
        # the payload — matched against the message text a real Claude Code
        # Notification hook actually carries. Narrow on purpose: a false
        # negative here just costs one missed heartbeat tick, and the pane
        # leg (PR3a, always running) still covers the studio regardless.
        case "$message" in
          *ermission*) write_state waiting-question ;;
          *"aiting for your input"*) write_state idle ;;
        esac
        ;;
    esac
    ;;
  *)
    : # SessionStart (see header), and any event this hook does not know
      # about yet — no state write, no error, exit 0 below either way.
    ;;
esac

exit 0
