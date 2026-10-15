#!/usr/bin/env bash
# apps/fleet/scripts/gate/maestro-gate.sh <pr> — run the gate on one PR and wait
# for its verdict (#715 Phase 1). Runs `fleet gate start <pr>`, then
# `fleet gate watch <pr> <runId>` with the run id start printed. Exit: 0 green, 1 red, 2 error or gate off.
# FLEET_BIN overrides the fleet binary (tests point it at a stub).
set -uo pipefail

PR="${1:-}"
FLEET_BIN="${FLEET_BIN:-fleet}"

if ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "usage: maestro-gate.sh <pr>" >&2
  exit 2
fi

# A start that fails (gate off, or the Worker refused) is an error, not a verdict.
out=$("$FLEET_BIN" gate start "$PR") || exit 2
echo "$out"
# `gate watch` is keyed by the run id that `gate start` prints.
RUN=$(printf '%s\n' "$out" | sed -n 's/^gate-start: run \([^ ]*\) started for PR.*/\1/p')
[ -n "$RUN" ] || exit 2

"$FLEET_BIN" gate watch "$PR" "$RUN"
rc=$?
case $rc in
  0) exit 0 ;;
  1) exit 1 ;;
  *) exit 2 ;;
esac
