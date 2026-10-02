#!/bin/bash
# Issue #267 — local CI for one PR (or sha), replacing GitHub Actions.
#
#   localci.sh <pr-number|sha> [--dry-run] [--native]
#
# Tested tree = PR head merged onto origin/main (git merge-tree), checked out
# as a detached worktree. Mac lanes: bun install, bun run check,
# test-lies-check (#174), vitest, english-check. Linux lane: bun run bun-test
# in docker (tmux + chromium).
# Posts two commit statuses on the PR head: local-ci/fleet-check and
# local-ci/english — pending first, then success/failure/error. --dry-run
# prints the statuses instead of posting them.
#
# --native (#279): every lane runs on this host, no docker — for a Linux host
# such as a studio container, which has tmux and chromium but no docker. The
# bun-test lane runs with TMUX/TMUX_PANE unset so no test can reach the host's
# own tmux server. Refused on a non-Linux host. Descriptions end with
# runner=mac (docker mode) or runner=studio (native; LOCALCI_RUNNER overrides).
#
# The lanes hold the Mac-wide gate lock (/tmp/fleetflare-gate.lock, lockf):
# one heavy job at a time on this machine — parallel runs under host load
# flake the #176 session-memory peak test (#256).
#
# Exit: 0 all green · 1 red · 2 infra error · 3 a status POST failed twice.
# Bash 3.2 (macOS /bin/bash): no associative arrays, no mapfile.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)

# sweep_procs <worktree> <run-id> [pid-to-spare...]: kill every process the run
# left behind (PR #306 review). A suite daemonizes things — ego-browser
# daemons, tmux servers, daemon loops — that escape the lane's process group;
# docker mode's --rm reaps the container's, nothing reaps a native host's.
# A process belongs to the run when its command line or cwd is under the
# worktree, or it carries LOCALCI_RUN=<run-id> (set on the lanes' env).
# Matching uses bash builtins only: a helper's own command line never names
# the worktree, so the sweep never matches itself.
#
# Issue #159: the Linux branch used to fork `tr`×2 + `readlink` per entry in
# /proc, for EVERY process on the host (not just this run's), twice per
# interrupted run — O(3 × host-wide process count), measured to take over a
# minute on a process-dense host (#382 flagged this as a follow-up). Fixed to
# fork exactly twice for the WHOLE sweep: cwd membership is one batched
# `ls -la /proc/*/cwd | grep` across every pid up front (`cwd_hits`), checked
# per pid with a bash pattern match (no fork); cmdline/environ are read with
# bash's own NUL-delimited `read` builtin straight from each process's own
# file (no fork at all). Net: O(1) forks for the entire /proc walk.
sweep_procs() {
  local w=$1 rid=$2 d pid matched arg kv cmd cwd line victims=""
  shift 2
  # The worktree's physical path too: macOS /var is a symlink, lsof and
  # /proc/*/cwd report /private/var/…
  local wp
  wp=$(cd "$w" 2>/dev/null && pwd -P) || wp=$w
  local spare=" $$ $* "
  if [ -d /proc/self ]; then
    local cwd_hits
    cwd_hits=$(ls -la /proc/[0-9]*/cwd 2>/dev/null | grep -F -- "$wp")
    for d in /proc/[0-9]*; do
      pid=${d#/proc/}
      case "$spare" in *" $pid "*) continue ;; esac
      [ -r "$d/cmdline" ] || continue
      matched=0
      while IFS= read -r -d '' arg; do
        case "$arg" in *"$w/"*|*"$wp/"*) matched=1; break ;; esac
      done 2>/dev/null <"$d/cmdline"
      if [ "$matched" = 0 ]; then
        case "$cwd_hits" in *"/proc/$pid/cwd"*) matched=1 ;; esac
      fi
      if [ "$matched" = 0 ]; then
        while IFS= read -r -d '' kv; do
          [ "$kv" = "LOCALCI_RUN=$rid" ] && { matched=1; break; }
        done 2>/dev/null <"$d/environ"
      fi
      [ "$matched" = 1 ] && victims="$victims $pid"
    done
  else
    # macOS: no /proc, and `ps -E` shows no other process's environment
    # (measured 2026-09-25) — match command lines (ps) and cwds (lsof).
    while read -r pid cmd; do
      case "$spare" in *" $pid "*) continue ;; esac
      [[ "$cmd" == *"$w/"* || "$cmd" == *"$wp/"* ]] && victims="$victims $pid"
    done < <(ps -ww -A -o pid=,command= 2>/dev/null)
    while read -r line; do
      case "$line" in
        p*) pid=${line#p} ;;
        n*) cwd=${line#n}
            case "$spare" in *" $pid "*) continue ;; esac
            [[ "$cwd" == "$wp" || "$cwd" == "$wp/"* ]] && victims="$victims $pid" ;;
      esac
    done < <(lsof -w -d cwd -Fpn 2>/dev/null)
  fi
  [ -z "$victims" ] && return 0
  echo "localci: sweeping run leftovers:$victims" >&2
  kill -TERM $victims 2>/dev/null
  sleep 1
  kill -KILL $victims 2>/dev/null
  return 0
}

# Test-only hook (#159): lets test/bun/sweep-procs.test.ts call sweep_procs
# directly, against the real /proc on whatever host runs the test, without
# running the rest of this script (which would otherwise require a PR/sha
# target and touch GitHub/git/docker for real). Never invoked by a real run.
if [ "${1:-}" = "--sweep-procs-only" ]; then
  shift
  sweep_procs "$@"
  exit 0
fi

# --- lanes: re-invoked by the main flow under the gate lock -----------------
if [ "${1:-}" = "--lanes" ]; then
  W=$2 RUN=$3 COMMON=$4 IMAGE=$5 NAME=$6
  F="$W/apps/fleet"
  TIMEOUT=${LOCALCI_LANE_TIMEOUT:-2400}
  # Job control: every background job gets its own process group, so the
  # watchdog can kill a hung lane's whole tree (bun, vitest workers, chromium).
  set -m
  # SIGTERM (launchd bootout, the main flow's trap): take the running lane's
  # process group and its watchdog down with us — they live in their own
  # groups, so nothing else would. `wait` below returns on a trapped signal.
  # Exit only once the lane is really gone (#291): lockf above us holds the
  # gate lock exactly until we exit, so a lane that ignores TERM gets KILL
  # after LOCALCI_KILL_GRACE seconds instead of outliving the lock.
  CUR="" DOG=""
  echo $$ >"$RUN/lanes.pid"
  stop_lanes() {
    local g t=0
    for g in $CUR $DOG; do kill -TERM -"$g" 2>/dev/null; done
    while [ "$t" -lt "${LOCALCI_KILL_GRACE:-5}" ] && kill -0 -"${CUR:-0}" 2>/dev/null; do sleep 1; t=$((t + 1)); done
    for g in $CUR $DOG; do kill -KILL -"$g" 2>/dev/null; done
    docker rm -f -v "$NAME-linux" "$NAME-linux-rerun" >/dev/null 2>&1
    sweep_procs "$W" "${LOCALCI_RUN:-}" "$PPID"
    exit 143
  }
  trap stop_lanes TERM INT HUP
  lane() { # lane <name> <cmd...>: <name>.log, <name>.exit; <name>.timeout if the watchdog fired
    local n=$1 pid dog; shift
    "$@" >"$RUN/$n.log" 2>&1 &
    pid=$!
    ( sleep "$TIMEOUT"; echo "$TIMEOUT" >"$RUN/$n.timeout"
      kill -TERM -"$pid" 2>/dev/null; sleep 5; kill -KILL -"$pid" 2>/dev/null ) &
    dog=$!
    CUR=$pid DOG=$dog
    wait "$pid"
    echo $? >"$RUN/$n.exit"
    { kill -TERM -"$dog"; wait "$dog"; } 2>/dev/null
    # Killing `docker run` leaves its container running: remove it by name.
    [ -f "$RUN/$n.timeout" ] && docker rm -f -v "$NAME-$n" >/dev/null 2>&1
    return 0
  }
  english() { cd "$W" && bun run apps/fleet/scripts/english-check.ts; }
  lane english english
  [ -n "$(grep -s '^skip_fleet=' "$RUN/meta")" ] && exit 0
  cd "$F" || exit 2
  lane install bun install
  lane check bun run check
  # #174: a real failing gate now the tautological/source-reading/own-module-
  # mock backlog is 0 — a test-quality check, so it feeds fleet-check, not
  # the separate english() lane above.
  lane test-lies-check bun run test-lies-check
  lane vitest bun run test --reporter=default --reporter=json "--outputFile=$RUN/vitest.json"
  linux() { # linux <name> <command>: in docker, or on this host when IMAGE=native
    if [ "$IMAGE" = native ]; then
      (cd "$F" && env -u TMUX -u TMUX_PANE bash -c "tmux -V && $2")
      return
    fi
    # Issue #388: docker's DEFAULT seccomp profile refuses the
    # unshare(CLONE_NEWUSER|CLONE_NEWNS|...) combination
    # test/bun/install-cache-security.test.ts's own unshare-gated suite needs
    # (issue #388's own real-full-disk ENOSPC proof) -- "Operation not
    # permitted", for both root and an unprivileged user inside the
    # container, confirmed live against a plain `docker run` with no
    # security-opt override. `seccomp=unconfined` removes docker's syscall
    # filter for this container entirely (this lane already runs an
    # ephemeral, --rm, non-persistent container built from this repo's own
    # pinned Dockerfile -- the same trust boundary a bare `--native` run on
    # this exact host already has, not a new one) so that suite runs for
    # real here instead of silently skipping.
    docker run --rm --name "$NAME-$1" --label fleetflare-localci=1 \
      --security-opt seccomp=unconfined \
      -v "$W:$W" -v "$F/node_modules" -v "$COMMON:$COMMON:ro" -w "$F" "$IMAGE" \
      bash -c "tmux -V && bun install >/dev/null 2>&1 && $2"
  }
  lane linux linux linux "bun run bun-test"
  # Flake policy: a failure ONLY in known-flaky files reruns those files alone, once.
  FLAKY="$HERE/known-flaky.txt"
  if [ "$(cat "$RUN/vitest.exit")" != 0 ]; then
    files=$(bun "$HERE/summarize.ts" rerun-plan vitest "$RUN/vitest.json" "$FLAKY" | tr '\n' ' ')
    [ -n "$files" ] && lane vitest-rerun bun run test $files --reporter=default --reporter=json "--outputFile=$RUN/vitest-rerun.json"
  fi
  if [ "$(cat "$RUN/linux.exit")" != 0 ]; then
    files=$(bun "$HERE/summarize.ts" rerun-plan bun "$RUN/linux.log" "$FLAKY" | tr '\n' ' ')
    [ -n "$files" ] && lane linux-rerun linux linux-rerun "bun test $files"
  fi
  # Still under the gate lock: nothing the lanes started outlives it. Spare
  # our parent (lockf holds the lock until we exit).
  sweep_procs "$W" "${LOCALCI_RUN:-}" "$PPID"
  exit 0
fi

# --- main flow ---------------------------------------------------------------
TARGET=${1:?usage: localci.sh <pr-number|sha> [--dry-run] [--native]}
shift
DRY=0 NATIVE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --native) NATIVE=1 ;;
    *) echo "usage: localci.sh <pr-number|sha> [--dry-run] [--native]" >&2; exit 2 ;;
  esac
done
# runner=<host>/<mode>, from the host itself (PR #306 review), never guessed
# from the flag: mac (Darwin), studio (Linux + IS_SANDBOX=1, which
# Dockerfile.studio sets), or linux; then docker or native.
case "$(uname -s)" in
  Darwin) HOST=mac ;;
  Linux) if [ "${IS_SANDBOX:-}" = 1 ]; then HOST=studio; else HOST=linux; fi ;;
  *) HOST=$(uname -s | tr '[:upper:]' '[:lower:]') ;;
esac
RUNNER=${LOCALCI_RUNNER:-$HOST/$([ "$NATIVE" = 1 ] && echo native || echo docker)}
REPO_DIR=${LOCALCI_REPO_DIR:-$(git -C "$HERE" rev-parse --show-toplevel)}
LOGS=${LOCALCI_LOGS:-$HOME/Library/Logs/fleetflare-localci}
WORK=${LOCALCI_WORK:-$HOME/Library/Caches/fleetflare-localci}
LOCK=${LOCALCI_LOCK:-/tmp/fleetflare-gate.lock}
RETRY_SLEEP=${LOCALCI_RETRY_SLEEP:-5}
cd "$REPO_DIR" || exit 2
GH_REPO=${LOCALCI_GH_REPO:-$(git remote get-url origin | sed -E 's#^(git@[^:]+:|https://[^/]+/)##; s#\.git$##')}
COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd)

RID="$(date +%Y%m%d-%H%M%S)-$$"
RUN="$LOGS/runs/$RID"
W="$WORK/wt-$RID"
NAME="localci-$RID"
mkdir -p "$RUN" "$WORK"
log() { echo "localci[$RID]: $*" >&2; }

SHA="" POST_FAILED=0 FINISHED=0
post() { # post <context> <state> <description>
  if [ "$DRY" = 1 ]; then echo "[dry-run] $1 $2: $3"; return 0; fi
  local try
  for try in 1 2; do
    if gh api -X POST "repos/$GH_REPO/statuses/$SHA" -f "state=$2" -f "context=$1" -f "description=$3" \
      >/dev/null 2>>"$RUN/gh.err"; then
      return 0
    fi
    log "status POST failed ($1=$2, try $try/2): $(tail -1 "$RUN/gh.err" 2>/dev/null)"
    [ "$try" = 1 ] && sleep "$RETRY_SLEEP"
  done
  POST_FAILED=1
  return 1
}
post_both() { post local-ci/fleet-check "$1" "$2"; post local-ci/english "$1" "$2"; }

remove_run() { # remove_run <rid>: its containers, worktree and refs/localci/<rid>/*
  # -v: the lane's anonymous node_modules volume goes with its container.
  docker rm -f -v "localci-$1-linux" "localci-$1-linux-rerun" >/dev/null 2>&1
  git worktree remove --force "$WORK/wt-$1" >/dev/null 2>&1
  rm -rf "${WORK:?}/wt-$1"
  git worktree prune
  git for-each-ref --format='%(refname)' "refs/localci/$1/" | while read -r ref; do git update-ref -d "$ref"; done
}
LANES=""
cleanup() {
  # Lanes run in their own process group (set -m below). TERM the lanes script
  # itself, never lockf: lockf would die at once and free the gate lock under a
  # lane still dying (#291). The lanes' trap kills lane groups and containers;
  # lockf exits after it. Still queued on the lock (no lanes.pid): TERM lockf.
  if [ -n "$LANES" ]; then
    if [ -s "$RUN/lanes.pid" ]; then kill -TERM "$(cat "$RUN/lanes.pid")" 2>/dev/null
    else kill -TERM -"$LANES" 2>/dev/null; fi
    wait "$LANES" 2>/dev/null
    sweep_procs "$W" "$RID"
  fi
  if [ -n "$SHA" ] && [ "$FINISHED" = 0 ]; then
    post_both error "error: run interrupted"
    # Our own cleanup ran: mark the run finished so the next sweep skips it (#291).
    echo '{"interrupted": true}' >"$RUN/result.json"
  fi
  remove_run "$RID"
}
trap cleanup EXIT
trap 'exit 2' INT TERM HUP

# Sweep runs a reboot or SIGKILL ended before their trap could: the trap
# never ran, so their worktree, refs and containers are still here and their
# sha still reads `pending`. A run id ends in its pid; a live pid is left alone.
sweep() {
  local rid pid sha
  { ls "$WORK" 2>/dev/null | sed -n 's/^wt-//p'
    # A log dir with result.json is a finished run's history, not a leftover.
    for d in "$LOGS"/runs/*/; do [ -f "$d/meta" ] && [ ! -f "$d/result.json" ] && basename "$d"; done
    git for-each-ref --format='%(refname)' refs/localci/ | cut -d/ -f3
  } | grep -E '^[0-9]{8}-[0-9]{6}-[0-9]+$' | sort -u | while read -r rid; do
    [ "$rid" = "$RID" ] && continue
    pid=${rid##*-}
    kill -0 "$pid" 2>/dev/null && continue
    log "sweeping killed run $rid"
    remove_run "$rid"
    if [ -f "$LOGS/runs/$rid/meta" ] && [ ! -f "$LOGS/runs/$rid/result.json" ]; then
      sha=$(sed -n 's/^sha=//p' "$LOGS/runs/$rid/meta")
      [ -n "$sha" ] && (SHA=$sha; post_both error "error: run killed before it finished (reboot or SIGKILL)")
      echo '{"swept": "run killed before it finished"}' >"$LOGS/runs/$rid/result.json"
    fi
  done
}
sweep

# Resolve the target and the base. Refs live under refs/localci/<run>/.
git fetch -q origin "+refs/heads/main:refs/localci/$RID/main" || { log "fetch main failed"; exit 2; }
PR=""
if [[ "$TARGET" =~ ^[0-9]{1,6}$ ]]; then
  PR=$TARGET
  git fetch -q origin "+refs/pull/$PR/head:refs/localci/$RID/head" || { log "fetch PR #$PR failed"; exit 2; }
  SHA=$(git rev-parse "refs/localci/$RID/head")
else
  SHA=$(git rev-parse --verify -q "$TARGET^{commit}") || { git fetch -q origin "$TARGET" 2>/dev/null; SHA=$(git rev-parse --verify -q "$TARGET^{commit}"); } \
    || { SHA=""; log "unknown sha $TARGET"; exit 2; }
fi
BASE=$(git rev-parse "refs/localci/$RID/main")
log "PR ${PR:-none} head $SHA base $BASE — logs $RUN"
post_both pending "running on $RUNNER (queued behind the gate lock if busy)"
{ echo "sha=$SHA"; echo "pr=$PR"; echo "base=$BASE"; echo "runner=$RUNNER"; } >"$RUN/meta"

finish() {
  local out state code=0
  out=$(bun "$HERE/summarize.ts" result "$RUN") || { log "summarize failed"; exit 2; }
  echo "$out"
  while IFS=$'\t' read -r ctx state desc; do
    post "$ctx" "$state" "$desc"
    case "$state" in failure) [ "$code" = 0 ] && code=1 ;; error) code=2 ;; esac
  done <<<"$out"
  FINISHED=1
  [ "$POST_FAILED" = 1 ] && { log "one or more status POSTs failed — statuses on $SHA are stale"; exit 3; }
  exit "$code"
}

# merge-tree exits 1 on a conflict; anything else is git failing — report git's
# own words, never "conflicts with main" (PR #306 review).
TREE=$(git merge-tree --write-tree "$BASE" "$SHA" 2>"$RUN/merge-tree.err")
case $? in
  0) ;;
  1) echo "conflict=1" >>"$RUN/meta"; finish ;;
  *) echo "error=merge-tree failed: $(head -1 "$RUN/merge-tree.err")" >>"$RUN/meta"; finish ;;
esac
TREE=$(echo "$TREE" | head -1)
echo "tree=$TREE" >>"$RUN/meta"
COMMIT=$(git commit-tree "$TREE" -p "$BASE" -p "$SHA" -m "localci: $SHA onto $BASE" 2>"$RUN/commit-tree.err") \
  || { echo "error=commit-tree failed: $(head -1 "$RUN/commit-tree.err")" >>"$RUN/meta"; finish; }
git update-ref "refs/localci/$RID/tested" "$COMMIT"
git worktree add -q --detach "$W" "$COMMIT" || { echo "error=worktree add failed" >>"$RUN/meta"; finish; }

# Same paths filter fleet-check.yml had; the context is posted either way.
# Issue #395: a bare `cmd | grep -q` under this script's own `set -o
# pipefail` (line 25) misclassifies a large diff as "no fleet path touched"
# whenever grep's own early-exit-on-match races ahead of git's writes and
# kills it with SIGPIPE -- the exact class of bug #393 proved live against
# install-cache.ts's own listing-pass check. Captured into a variable first,
# then checked via process substitution, so an early-closing reader can
# never flip this pipeline's exit status.
# Issue #335 (review round 3): `scripts/` added -- scripts/public-export.sh
# lives at the repo root, not under apps/fleet/, so a change to it (or its
# own scripts/test/public-export.test.sh) used to be silently skipped here
# entirely, even though the new apps/fleet/test/bun/public-export.test.ts
# wrapper (below) only runs as PART of this same fleet-check lane.
CHANGED_FILES=$(git diff --name-only "$BASE...$SHA")
if ! grep -qE '^(apps/fleet/|skills/|fleet/blueprint/|scripts/)' <(printf '%s' "$CHANGED_FILES"); then
  echo "skip_fleet=no apps/fleet, skills, fleet/blueprint or scripts change" >>"$RUN/meta"
  IMAGE=none
elif ! command -v node >/dev/null 2>&1; then
  # vitest is `#!/usr/bin/env node`: without node, `bun run test` runs it on
  # Bun, its config fails to load and 0 tests run (launchd PATH and the
  # localci image, 2026-09-25). Say so instead.
  echo "error=node not on PATH — vitest would run on Bun" >>"$RUN/meta"
  finish
elif [ "$NATIVE" = 1 ]; then
  [ "$(uname -s)" = Linux ] || { echo "error=--native needs a Linux host (this is $(uname -s))" >>"$RUN/meta"; finish; }
  # The bun-test lane needs a working tmux and the chromium the ego-browser
  # shim launches; the docker image carries both, a native host must too.
  MISSING=""
  tmux -V >/dev/null 2>&1 || MISSING="$MISSING tmux"
  "${LOCALCI_CHROMIUM:-/usr/local/bin/chromium}" --version >/dev/null 2>&1 || MISSING="$MISSING chromium"
  [ -z "$MISSING" ] || { echo "error=native prerequisites missing:$MISSING" >>"$RUN/meta"; finish; }
  IMAGE=native
else
  docker info >/dev/null 2>&1 || { echo "error=docker daemon unreachable" >>"$RUN/meta"; finish; }
  # Image tag follows the Dockerfile's content: an edit rebuilds, nothing else does.
  IMAGE="fleetflare-localci:$(git hash-object "$HERE/Dockerfile" | cut -c1-12)"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "building $IMAGE"
    docker build -t "$IMAGE" "$HERE" >"$RUN/image-build.log" 2>&1 || { echo "error=image build failed" >>"$RUN/meta"; finish; }
  fi
fi

if command -v flock >/dev/null 2>&1; then LOCKCMD=(flock "$LOCK"); else LOCKCMD=(lockf -k "$LOCK"); fi
log "waiting for gate lock $LOCK"
# In the background + wait, never as a foreground child: bash defers a trap
# until a foreground child exits, so SIGTERM would wait out every lane.
set -m
LOCALCI_RUN=$RID "${LOCKCMD[@]}" /bin/bash "$0" --lanes "$W" "$RUN" "$COMMON" "$IMAGE" "$NAME" &
LANES=$!
wait "$LANES"
LANES=""
finish
