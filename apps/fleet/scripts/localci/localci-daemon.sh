#!/bin/bash
# Issue #267 — polls open PRs and runs localci.sh on each head sha that has
# no local-ci/fleet-check status yet. One run at a time (the loop is serial
# and localci.sh holds the Mac-wide gate lock for its lanes).
#
#   localci-daemon.sh run                  poll forever, every LOCALCI_POLL (120s)
#   localci-daemon.sh once [--dry-run]     one poll; --dry-run only names the PRs
#   localci-daemon.sh install [--dry-run]  launchd agent; --dry-run prints the plist
#   localci-daemon.sh uninstall
#
# A head is run when it has no local-ci/fleet-check status, or when that status
# is `error` (infra, timeout, killed run) older than LOCALCI_ERROR_BACKOFF
# (1800s). success/failure/pending are never re-polled. By hand: localci.sh <pr>.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SELF="$HERE/$(basename "$0")"
LABEL=life.demosite.fleetflare-localci
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/fleetflare-localci"
LOCALCI=${LOCALCI_SCRIPT:-$HERE/localci.sh}
REPO_DIR=${LOCALCI_REPO_DIR:-$(git -C "$HERE" rev-parse --show-toplevel)}
POLL=${LOCALCI_POLL:-120}
BACKOFF=${LOCALCI_ERROR_BACKOFF:-1800}
# Floor: a typo'd LOCALCI_POLL must never hammer the GitHub API.
case "$POLL" in '' | *[!0-9]*) POLL=120 ;; esac
[ "$POLL" -lt 30 ] && POLL=30

gh_repo() {
  [ -n "${LOCALCI_GH_REPO:-}" ] && { echo "$LOCALCI_GH_REPO"; return; }
  git -C "$REPO_DIR" remote get-url origin | sed -E 's#^(git@[^:]+:|https://[^/]+/)##; s#\.git$##'
}

poll() { # poll <dry 0|1>
  local repo prs n sha st state age rc
  repo=$(gh_repo)
  prs=$(gh pr list --repo "$repo" --state open --limit 100 --json number,headRefOid \
    --jq '.[] | "\(.number) \(.headRefOid)"') || { echo "$(date -u +%FT%TZ) pr list failed" >&2; return 1; }
  while read -r n sha; do
    [ -z "$n" ] && continue
    st=$(gh api "repos/$repo/commits/$sha/status" --jq '.statuses[]
        | select(.context == "local-ci/fleet-check")
        | "\(.state) \((now - (.updated_at | fromdateiso8601)) | floor)"') \
      || { echo "$(date -u +%FT%TZ) status read failed for #$n $sha" >&2; continue; }
    read -r state age <<<"$st"
    if [ -n "$state" ]; then
      [ "$state" = error ] && [ "${age:-0}" -gt "$BACKOFF" ] || continue
    fi
    if [ "$1" = 1 ]; then
      echo "would run #$n $sha"
    else
      echo "$(date -u +%FT%TZ) run #$n $sha"
      LOCALCI_REPO_DIR="$REPO_DIR" "$LOCALCI" "$n"
      rc=$?
      echo "$(date -u +%FT%TZ) done #$n exit=$rc"
    fi
  done <<<"$prs"
}

plist() {
  local path="/usr/bin:/bin:/usr/sbin:/sbin" tool
  # node too: vitest is `#!/usr/bin/env node`; without it `bun run test` runs
  # vitest on Bun, its config fails to load, 0 tests run (2026-09-25, nvm node).
  for tool in bun gh docker git node; do
    command -v "$tool" >/dev/null 2>&1 && path="$(dirname "$(command -v "$tool")"):$path"
  done
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$SELF</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$path</string>
    <key>LOCALCI_REPO_DIR</key><string>$REPO_DIR</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$LOGDIR/daemon.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/daemon.log</string>
</dict>
</plist>
EOF
}

case "${1:-}" in
  run)
    # One daemon per machine. A kernel lock, not a pidfile: it dies with its
    # holder, so a reboot or SIGKILL never leaves a stale one behind.
    if [ -z "${LOCALCI_DAEMON_LOCKED:-}" ]; then
      mkdir -p "$LOGDIR"
      export LOCALCI_DAEMON_LOCKED=1
      if command -v flock >/dev/null 2>&1; then
        flock -n -E 75 "$LOGDIR/daemon.lock" /bin/bash "$SELF" run
      else
        lockf -t 0 "$LOGDIR/daemon.lock" /bin/bash "$SELF" run
      fi
      [ $? = 75 ] && { echo "localci-daemon already running (lock $LOGDIR/daemon.lock) — exiting" >&2; exit 0; }
      exit 1
    fi
    while :; do
      poll 0
      sleep "$POLL"
    done
    ;;
  once) poll "$([ "${2:-}" = --dry-run ] && echo 1 || echo 0)" ;;
  install)
    if [ "${2:-}" = --dry-run ]; then
      echo "# would write $PLIST and: launchctl bootstrap gui/$(id -u) $PLIST"
      plist
      exit 0
    fi
    mkdir -p "$(dirname "$PLIST")" "$LOGDIR"
    plist >"$PLIST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "installed $LABEL — logs $LOGDIR/daemon.log"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    rm -f "$PLIST" && echo "uninstalled $LABEL"
    ;;
  *)
    echo "usage: localci-daemon.sh run | once [--dry-run] | install [--dry-run] | uninstall" >&2
    exit 2
    ;;
esac
