#!/usr/bin/env bash
# apps/fleet/scripts/gate/maestro-gate.sh <pr> — run the gate on one PR and wait
# for its verdict (#715 Phase 1). A thin wrapper over `fleet gate run <pr>`, which
# starts the run and polls its run id to a verdict. Exit: 0 green, 1 red, 2 error or gate off.
# FLEET_BIN overrides the fleet binary (tests point it at a stub).
set -uo pipefail

PR="${1:-}"
FLEET_BIN="${FLEET_BIN:-fleet}"

if ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "usage: maestro-gate.sh <pr>" >&2
  exit 2
fi

"$FLEET_BIN" gate run "$PR"
case $? in
  0) exit 0 ;;
  1) exit 1 ;;
  *) exit 2 ;;
esac
