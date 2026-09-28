#!/usr/bin/env bash
# SessionStart hook. Stdout is injected into the model's context.
#
# Fires on EVERY session open; acts only on compact/clear. A normal startup
# already got the working set as claude's opening prompt, and a resume has the
# transcript. Re-emitting on those would duplicate what is already there.
#
# Silent on every failure. This is a CHECK, not a gate: an unreadable payload
# says nothing about the studio, and a SessionStart hook cannot block anyway.
#
# FLEET_WORKSPACE below is a deliberate test seam, not leaked config:
# production never sets it, so the default IS the production value.
ws="${FLEET_WORKSPACE:-/workspace}/.fleet/working-set.md"
src="$(python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("source", ""))
except Exception:
    print("")
' 2>/dev/null || true)"
case "$src" in
  compact|clear) ;;
  *) exit 0 ;;
esac
[ -r "$ws" ] || exit 0
# Review finding (Minor): readable is not the same as REAL. Bring-up writes
# this file with `printf '%s\n' "$role_prompt"` -- an empty role_prompt
# (ROLE_PROMPT_B64 unset or empty) still lands one byte on disk, a lone
# newline, which passes `-r` (and would pass a size check too, since one
# byte is still > 0). Only a check for actual non-whitespace content tells
# "nothing to replay" apart from "a real working set". grep is already a
# dependency of this same script (the settings.json hook-presence check
# further down uses it), so this adds nothing new to the image.
grep -q '[^[:space:]]' "$ws" || exit 0
printf 'Context was compacted. Your working set, replayed from disk:\n\n'
cat "$ws"
exit 0
