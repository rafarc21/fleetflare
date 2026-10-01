#!/bin/bash
# Issue #168 (spike) — read-only measurement for the "sensor-to-task control
# loop" design (docs/superpowers/specs/2026-10-01-sensor-task-control-loop-168-design.md).
#
#   measure.sh
#
# Prints the real numbers behind two of the four proposed sensors:
#   - CI failures, read from GitHub Actions RUN HISTORY (`gh run list`), not
#     from commit statuses. Commit statuses are empty on this repo now —
#     Actions runs natively (docs/operations.md#ci) and the old Mac daemon
#     that posted `local-ci/*` statuses is superseded. A merged PR's own head
#     commit is also the wrong place to look: the merge gate requires it
#     green, so its final state is tautologically always success — the only
#     place failure history survives is run history, across both all
#     branches (PR iteration, noisy) and `main` alone (the real baseline).
#   - known-flaky entries, a plain count of the local flake-policy file.
#
# Deliberately does NOT measure dead-account sightings or Worker exceptions —
# neither is reachable from here today (see the design doc's gap sections);
# this script does not stub them with fake numbers.
#
# Read-only: every call below is a GET (`gh run list`, `gh api`, `grep -c`).
# No POST, no task filing, no state written anywhere. Safe to run any time,
# by hand or from a scheduled job, without an operator approval gate.
set -euo pipefail

REPO=${SENSOR_REPO:-rafarc21/fleetflare}
FLEET_CHECK=fleet-check.yml
ENGLISH_CHECK=english-check.yml
HERE=$(cd "$(dirname "$0")" && pwd)
KNOWN_FLAKY="$HERE/../localci/known-flaky.txt"

echo "# sensor measurement — $(date -u +%Y-%m-%dT%H:%M:%SZ) — repo=$REPO"
echo

echo "## CI failures — fleet-check.yml, all branches (last 100 runs)"
gh run list --repo "$REPO" --workflow="$FLEET_CHECK" --limit 100 \
  --json conclusion -q '.[].conclusion' | sort | uniq -c

echo
echo "## CI failures — fleet-check.yml, main only (last 50 runs; the dampener baseline)"
gh run list --repo "$REPO" --workflow="$FLEET_CHECK" --branch main --limit 50 \
  --json conclusion -q '.[].conclusion' | sort | uniq -c

echo
echo "## CI failures — english-check.yml, all branches (last 100 runs)"
gh run list --repo "$REPO" --workflow="$ENGLISH_CHECK" --limit 100 \
  --json conclusion -q '.[].conclusion' | sort | uniq -c

echo
echo "## known-flaky entries ($KNOWN_FLAKY)"
if [ -f "$KNOWN_FLAKY" ]; then
  count=$(grep -c '^test/' "$KNOWN_FLAKY" || true)
  echo "$count"
else
  echo "known-flaky.txt not found at $KNOWN_FLAKY"
fi
