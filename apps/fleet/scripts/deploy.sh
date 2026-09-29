#!/usr/bin/env bash
# Runs a wrangler command (deploy, or a D1 migration) against the operator's
# REAL wrangler config, which no longer lives in this (public) repo at all —
# see issue #329's critical fix round. The real config (App id, installation
# ids, D1/R2 ids, real repo/org names, workers.dev host) lives in a separate
# private repo (your own, e.g. a "fleetflare-ops"-shaped one — not tracked in
# this repo), at fleet/wrangler.jsonc, checked out locally on the operator's
# own deploy machine.
#
# Why this script exists instead of a bare `wrangler <cmd>`: wrangler always
# resolves a config's relative paths (this config's own `main`, and each
# container's `image` Dockerfile path) relative to the DIRECTORY THE CONFIG
# FILE LIVES IN, not the caller's cwd. If wrangler were pointed straight at
# `$FLEET_OPS_DIR/fleet/wrangler.jsonc`, every one of those relative paths
# would resolve inside the ops-repo checkout instead of here, regardless of
# where that checkout happens to sit on disk. So this script copies the real
# config to a new, gitignored file INSIDE apps/fleet (wrangler.local.jsonc)
# before invoking wrangler, so those paths resolve exactly as they did back
# when the real config was tracked in this directory.
#
# Env vars:
#   FLEET_OPS_DIR   Path to a local checkout of your private ops repo. Only
#                   used to compute the default FLEET_CONFIG path below;
#                   irrelevant if FLEET_CONFIG is set directly.
#   FLEET_CONFIG    Path to the real wrangler config file to run wrangler
#                   with. Default: "$FLEET_OPS_DIR/fleet/wrangler.jsonc".
#
# Usage: scripts/deploy.sh [wrangler subcommand + args, forwarded verbatim]
#   No args           -> `wrangler deploy` (the common case; `bun run deploy`).
#   Any args given     -> `wrangler "$@"` instead, e.g. `bun run migrate:remote`
#                         calls `scripts/deploy.sh d1 migrations apply fleet
#                         --remote`, which runs `wrangler d1 migrations apply
#                         fleet --remote`. Either way, `-c wrangler.local.jsonc`
#                         is appended so every subcommand resolves the same
#                         real, gitignored, locally-copied config — wrangler
#                         accepts `-c`/`--config` as a global flag on every
#                         subcommand, not just `deploy`.
#
# Refuses loudly (non-zero exit, message on stderr) instead of running wrangler
# when:
#   - the resolved FLEET_CONFIG file does not exist, or
#   - its contents, EXCLUDING `//` comment lines, still contain the literal
#     substring `<YOUR_` — the same scrub-check pattern
#     wrangler.example.jsonc's own placeholders use (e.g.
#     `<YOUR_R2_BUCKET_NAME>`), meaning it was never filled in. Comment lines
#     are excluded so wrangler.example.jsonc's own explanatory comments about
#     that placeholder syntax (which themselves contain the substring
#     `<YOUR_`) do not cause a fully-filled config to be refused, or
#   - (issue #365) the command is not a known read-only one (see
#     is_read_only: everything else is treated as changing remote state) and
#     the config sits in a git checkout (the ops repo) that is not safe to
#     ship from: the config is not tracked, or differs from HEAD's copy
#     (catches assume-unchanged/skip-worktree edits git status hides), or,
#     after a `git fetch`, the config differs between HEAD and its upstream
#     or local unpushed commits touch it (both commits are printed; issue
#     #377: behind/ahead on OTHER paths only, e.g. completion records, is
#     allowed with a note), or the fetch/upstream cannot be checked.
#     A symlinked config is judged by the repo it points into. 2026-09-26 an agent overwrote
#     the operator's ops checkout's config with the example, uncommitted; the
#     next deploy would have shipped it.
#     `--allow-dirty-ops` (consumed here, never passed to wrangler) skips
#     these checks with a loud warning. A config outside any git repo cannot
#     be checked: warning only.
#   - (issue #20) the command replaces the studio containers (no args,
#     deploy except --dry-run, versions deploy, rollback, delete,
#     containers delete; see
#     replaces_containers) and `fleet rescue-all`, run first, exits non-zero
#     (a studio FAILED/TIMED OUT, or no creds to list studios -- a first
#     deploy). `--allow-unrescued` (consumed here, never passed to wrangler)
#     deploys anyway with a loud warning. Read-only commands and d1
#     migrations never run rescue-all.
#     Issue #40: a plain `deploy` that changes no container (same image
#     digest, same container settings -- scripts/deploy-containers-changed.ts,
#     asked only after rescue-all fails) replaces no studio: the failure is a
#     WARNING and the deploy proceeds. An image or settings change, or
#     anything the probe cannot tell, stays refused. Every override
#     (--allow-unrescued, or this Worker-only pass) appends one JSON line to
#     ~/.fleet/deploy-overrides.jsonl (time, command, target Worker, target
#     check, rescue-all verdict, operator = git user.name or $USER; flag
#     VALUES never recorded -- --var/--define/--secrets-file may carry
#     secrets); an unwritable record refuses the deploy.
#   - (issue #36) same commands, checked BEFORE rescue-all: the Worker
#     wrangler will replace (this config read by the pinned wrangler's own
#     reader, + --env/-e or CLOUDFLARE_ENV, + --name / `delete <name>`) is
#     not provably the fleet ~/.fleet/credentials points rescue-all at, or
#     cannot be determined (see scripts/deploy-target.ts). Same
#     --allow-unrescued override. Issue #48: a workers.dev credentials host
#     must also sit on the DEPLOYING account's workers.dev subdomain -- a
#     read-only lookup that needs network and a logged-in wrangler
#     (CLOUDFLARE_ACCOUNT_ID when the login sees several accounts).
#   `secret put`/`secret delete`/`secret bulk` are NOT gated (issue #36,
#   measured 2026-09-29 on a throwaway Worker: plain @cloudflare/containers
#   Container DO, instance lite, one container, n=1): each deploys a new
#   Worker version and restarts the Durable Object; the container kept the
#   same boot id throughout. StudioDO extends Sandbox -- not measured
#   directly. The DO restart drops attached terminals (TerminalBridge) and
#   aborts in-flight exec/rescue calls. A secret copied into a container at
#   start stays OLD there until it next starts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_DIR="$(dirname "$SCRIPT_DIR")"

FLEET_OPS_DIR="${FLEET_OPS_DIR:-}"
FLEET_CONFIG="${FLEET_CONFIG:-${FLEET_OPS_DIR}/fleet/wrangler.jsonc}"

if [[ ! -f "$FLEET_CONFIG" ]]; then
  echo "deploy.sh: refusing to deploy — config file not found: $FLEET_CONFIG" >&2
  echo "deploy.sh: set FLEET_CONFIG (or FLEET_OPS_DIR, whose default path this derives) to point at your real wrangler.jsonc, e.g. in a local checkout of your private ops repo. See README.md's \"Quickstart from zero\" section." >&2
  exit 1
fi

FLEET_CONFIG_FILTERED=$(grep -v '^[[:space:]]*//' "$FLEET_CONFIG")
if grep -q '<YOUR_' <(printf '%s' "$FLEET_CONFIG_FILTERED"); then
  echo "deploy.sh: refusing to deploy — $FLEET_CONFIG still contains an unfilled '<YOUR_...>' placeholder." >&2
  echo "deploy.sh: fill in every placeholder (see apps/fleet/wrangler.example.jsonc for the full list) before deploying." >&2
  exit 1
fi

# Issue #365: --allow-dirty-ops is ours, never wrangler's. Issue #20: so is
# --allow-unrescued.
ALLOW_DIRTY_OPS=0
ALLOW_UNRESCUED=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --allow-dirty-ops) ALLOW_DIRTY_OPS=1 ;;
    --allow-unrescued) ALLOW_UNRESCUED=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

# Issue #365 round 2: an ALLOWLIST of read-only commands — everything else is
# treated as changing remote state (versions, rollback, delete, triggers, kv,
# r2, ... and whatever wrangler adds next). Round 3: the parse is strict and
# anything it does not recognise is guarded — an unknown flag before the
# command word (it may take the next word as its value: "--profile whoami
# deploy" is a deploy), any flag between the command and its subcommand
# ("versions --message list deploy"), and flags are matched as WHOLE args,
# never substrings ('--var "X: --dry-run y"' is not a dry run).
is_value_flag() {
  case "$1" in --env|-e|--config|-c|--cwd) return 0 ;; *) return 1 ;; esac
}

# Issue #380: d1's own flags. The values of --command/--file/--persist-to
# are opaque text: "d1 execute fleet --command --local" is guarded, because
# this script does not model wrangler's (yargs) parse of such an argv — it
# never guesses that a word after a value flag is the --local flag (wrangler
# 4.119 happens to read it as the flag, with an empty command, and fails
# locally; a guess either way could open the guard). Local-only means a real
# --local flag, only flags known here, and no --remote in any form; anything
# unrecognised is guarded. Bare "d1" (help) is read-only.
d1_is_local() {
  local tok local_seen=0 skip=0
  [[ "$#" == 0 ]] && return 0
  for tok in "$@"; do
    if [[ "$skip" == 1 ]]; then skip=0; continue; fi
    case "$tok" in
      --command|--file|--persist-to) skip=1 ;;
      --command=*|--file=*|--persist-to=*) ;;
      --local|--local=true) local_seen=1 ;;
      --json|--yes|-y) ;;
      -*) return 1 ;;
      *) ;;
    esac
  done
  [[ "$local_seen" == 1 ]]
}

is_read_only() {
  local a w1="" w2="" phase=0 skip=0 flag_before_w2=0
  local -a after=()
  for a in "$@"; do
    if [[ "$skip" == 1 ]]; then skip=0; continue; fi
    if is_value_flag "$a"; then skip=1; continue; fi
    case "$a" in --env=*|--config=*|--cwd=*) continue ;; esac
    if [[ "$phase" == 0 ]]; then
      case "$a" in
        -*) return 1 ;;
        *) w1="$a"; phase=1; continue ;;
      esac
    fi
    after+=("$a")
    if [[ "$phase" == 1 ]]; then
      case "$a" in -*) flag_before_w2=1 ;; *) w2="$a"; phase=2 ;; esac
    fi
  done
  case "$w1" in
    deploy)
      [[ "${#after[@]}" == 1 && ( "${after[0]}" == "--dry-run" || "${after[0]}" == "--dry-run=true" ) ]] ;;
    tail|whoami) return 0 ;;
    d1) d1_is_local ${after[@]+"${after[@]}"} ;;
    secret|versions) [[ "$flag_before_w2" == 0 && "$w2" == "list" ]] ;;
    *) return 1 ;;
  esac
}

# Issue #20: commands that replace (or destroy) the running studio
# containers, losing any unpushed work in them: no args (deploy), deploy
# (not --dry-run), versions deploy, rollback, delete, containers delete.
# Same strict parse as is_read_only: an unknown flag before the command word,
# or any flag between `versions`/`containers` and its subcommand, is guarded
# (it may hide a deploy or a delete).
replaces_containers() {
  local a w1="" w2="" phase=0 skip=0
  [[ "$#" == 0 ]] && return 0
  is_read_only "$@" && return 1
  for a in "$@"; do
    if [[ "$skip" == 1 ]]; then skip=0; continue; fi
    if is_value_flag "$a"; then skip=1; continue; fi
    case "$a" in --env=*|--config=*|--cwd=*) continue ;; esac
    if [[ "$phase" == 0 ]]; then
      case "$a" in -*) return 0 ;; *) w1="$a"; phase=1; continue ;; esac
    fi
    if [[ "$phase" == 1 ]]; then
      case "$a" in -*) [[ "$w1" == versions || "$w1" == containers ]] && return 0 ;; *) w2="$a"; phase=2 ;; esac
    fi
  done
  case "$w1" in
    deploy|rollback|delete) return 0 ;;
    versions) [[ "$w2" == deploy ]] ;;
    containers) [[ "$w2" == delete ]] ;;
    *) return 1 ;;
  esac
}

# Issue #40: `deploy` (or no args) -- the one gated command a Worker-only
# soft pass may apply to. versions deploy, rollback, delete and containers
# delete stay hard. Strict (PR #60 review F4): only the word `deploy`,
# -e/--env <env>, --env=<env> and --profile <p>; any other flag may change
# what wrangler does to containers (--containers-rollout, --name, --var ...).
# scripts/deploy-containers-changed.ts applies the same rule again.
is_plain_deploy() {
  local a skip=0 seen=0
  [[ "$#" == 0 ]] && return 0
  for a in "$@"; do
    if [[ "$skip" == 1 ]]; then skip=0; continue; fi
    case "$a" in
      -e|--env|--profile) skip=1 ;;
      --env=*) ;;
      deploy) [[ "$seen" == 0 ]] || return 1; seen=1 ;;
      *) return 1 ;;
    esac
  done
  [[ "$skip" == 0 && "$seen" == 1 ]]
}

# PR #60 review F3: the override record's command, without values that may
# be secrets (--var K:V, --define, --secrets-file ...): flag names only;
# a word right after any other flag is taken as that flag's value and
# dropped; -e/--env keep theirs (the target env, never a secret).
record_command() {
  local a prev="" out=()
  for a in "$@"; do
    case "$a" in
      -*) out+=("${a%%=*}") ;;
      *) case "$prev" in -e|--env|""|[!-]*) out+=("$a") ;; esac ;;
    esac
    prev="$a"
  done
  printf '%s' "${out[*]}"
}

# A JSON string literal: backslash and quote escaped, control characters
# dropped.
json_str() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$(printf '%s' "$s" | tr -d '\000-\037')"
}

# Kill a process and every descendant (a hung fetch's transport helpers and
# their children). pgrep when present; otherwise the process itself.
kill_tree() {
  local c
  if command -v pgrep >/dev/null 2>&1; then
    for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
  fi
  kill -TERM "$1" 2>/dev/null || true
}

refuse_ops() {
  echo "deploy.sh: refusing — $1" >&2
  echo "deploy.sh: commit/pull/push the ops checkout first, or pass --allow-dirty-ops to override (loudly)." >&2
  exit 1
}

# Judge a symlinked config by the file it points to (the ops checkout), not
# by the directory the link happens to sit in.
CONFIG_REAL="$FLEET_CONFIG"
while [[ -L "$CONFIG_REAL" ]]; do
  target="$(readlink "$CONFIG_REAL")"
  case "$target" in
    /*) CONFIG_REAL="$target" ;;
    *) CONFIG_REAL="$(dirname "$CONFIG_REAL")/$target" ;;
  esac
done

# Issue #383: the operator's own pathspec-mode env vars conflict with the
# --literal-pathspecs the guard's git calls use (git dies, and the guard would
# report a misleading "not tracked"). The guard wants literal paths: drop them.
unset GIT_GLOB_PATHSPECS GIT_ICASE_PATHSPECS GIT_NOGLOB_PATHSPECS

if ! is_read_only ${ARGS[@]+"${ARGS[@]}"}; then
  CONFIG_DIR="$(dirname "$CONFIG_REAL")"
  if OPS_TOP="$(git -C "$CONFIG_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
    if [[ "$ALLOW_DIRTY_OPS" == 1 ]]; then
      echo "deploy.sh: WARNING — --allow-dirty-ops: NOT checking that $CONFIG_REAL is committed and current in $OPS_TOP." >&2
    else
      REL="$(git -C "$CONFIG_DIR" rev-parse --show-prefix)$(basename "$CONFIG_REAL")"
      git --literal-pathspecs -C "$OPS_TOP" ls-files --error-unmatch -- "$REL" >/dev/null 2>&1 \
        || refuse_ops "$CONFIG_REAL is not tracked in the ops checkout $OPS_TOP (untracked or gitignored)"
      # Byte-compare with HEAD's copy, not `git status`: assume-unchanged and
      # skip-worktree hide a local edit from status, never from this.
      cmp -s "$CONFIG_REAL" <(git -C "$OPS_TOP" show "HEAD:$REL") \
        || refuse_ops "$CONFIG_REAL has uncommitted changes in the ops checkout $OPS_TOP (differs from HEAD:$REL)"
      # Fail fast offline: no credential prompt, and a hard watchdog — an
      # HTTPS connect that never answers is not covered by lowSpeed* (round 3:
      # measured 75s). The operator's own ssh setup wins over our default.
      # An EMPTY GIT_SSH_COMMAND still counts as set to git (it would shadow
      # core.sshCommand with an empty command) — treat it as unset.
      [[ -n "${GIT_SSH_COMMAND:-}" ]] || unset GIT_SSH_COMMAND
      if [[ -z "${GIT_SSH_COMMAND:-}" && -z "${GIT_SSH:-}" && -z "$(git -C "$OPS_TOP" config core.sshCommand 2>/dev/null)" ]]; then
        export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"
      fi
      FETCH_TIMEOUT="${DEPLOY_FETCH_TIMEOUT:-20}"
      GIT_TERMINAL_PROMPT=0 git -C "$OPS_TOP" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 fetch --quiet &
      FETCH_PID=$!
      waited=0
      while kill -0 "$FETCH_PID" 2>/dev/null && (( waited < FETCH_TIMEOUT * 10 )); do
        sleep 0.1
        waited=$((waited + 1))
      done
      if kill -0 "$FETCH_PID" 2>/dev/null; then
        kill_tree "$FETCH_PID"
        wait "$FETCH_PID" 2>/dev/null || true
        refuse_ops "fetching the ops checkout $OPS_TOP timed out after ${FETCH_TIMEOUT}s — cannot check it is current"
      fi
      wait "$FETCH_PID" || refuse_ops "could not fetch the ops checkout $OPS_TOP to check it is current"
      UPSTREAM="$(git -C "$OPS_TOP" rev-parse --verify --quiet '@{upstream}')" \
        || refuse_ops "the ops checkout $OPS_TOP has no upstream to compare against"
      HEAD_SHA="$(git -C "$OPS_TOP" rev-parse HEAD)"
      # Issue #377: judge the CONFIG, not the whole checkout. The Worker
      # commits completion records to this repo, so HEAD is routinely behind
      # its upstream on paths that are not the config — that must not block a
      # deploy. Refused: the config differs between HEAD and upstream, or any
      # local unpushed commit touches it (even a change and its revert).
      git --literal-pathspecs -C "$OPS_TOP" diff --quiet "$HEAD_SHA" "$UPSTREAM" -- "$REL" \
        || refuse_ops "$REL differs between the ops checkout's HEAD $HEAD_SHA and its upstream $UPSTREAM"
      [[ -z "$(git --literal-pathspecs -C "$OPS_TOP" rev-list "$UPSTREAM..$HEAD_SHA" -- "$REL")" ]] \
        || refuse_ops "local unpushed commits in $OPS_TOP touch $REL: HEAD $HEAD_SHA, upstream $UPSTREAM"
      if [[ "$HEAD_SHA" != "$UPSTREAM" ]]; then
        echo "deploy.sh: note — the ops checkout $OPS_TOP is behind/ahead of its upstream ($HEAD_SHA vs $UPSTREAM) on paths other than $REL; deploying." >&2
      fi
    fi
  else
    echo "deploy.sh: WARNING — $CONFIG_REAL is not in a git repo; cannot check that it is committed and current." >&2
  fi
fi

# Issue #379: the repo's OWN pinned wrangler (package.json/bun.lock), never
# whatever `wrangler` is first on PATH. Run directly, a bare `wrangler` found a
# global 4.74 on the operator's Mac, so a bump in this repo never reached the
# deploy (4.119 silently skipped applying an image already in the registry).
WRANGLER="$FLEET_DIR/node_modules/.bin/wrangler"
if [[ ! -x "$WRANGLER" ]]; then
  echo "deploy.sh: refusing — the repo's pinned wrangler is not installed at $WRANGLER." >&2
  echo "deploy.sh: run 'bun install' in $FLEET_DIR first; a wrangler from PATH is never used." >&2
  exit 1
fi

# Issue #379 round 2: a node_modules installed before the bump still holds the
# old wrangler, and ran it silently. Refuse when the installed version is
# OLDER than bun.lock's top-level pin (4-space `"wrangler": ["wrangler@X"` --
# never a nested entry such as vitest-pool-workers' own wrangler). Numeric
# per-part compare: 4.99 < 4.141.
version_lt() {
  local IFS=.
  local -a a=($1) b=($2)
  local i
  for i in 0 1 2; do
    ((10#${a[i]:-0} < 10#${b[i]:-0})) && return 0
    ((10#${a[i]:-0} > 10#${b[i]:-0})) && return 1
  done
  return 1
}
WRANGLER_INSTALLED="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p' "$FLEET_DIR/node_modules/wrangler/package.json" 2>/dev/null | head -n 1)"
WRANGLER_LOCKED="$(sed -n 's/^    "wrangler": \["wrangler@\([0-9][0-9.]*\)".*/\1/p' "$FLEET_DIR/bun.lock" 2>/dev/null | head -n 1)"
if [[ -z "$WRANGLER_INSTALLED" || -z "$WRANGLER_LOCKED" ]]; then
  echo "deploy.sh: refusing — cannot read the installed wrangler version (${WRANGLER_INSTALLED:-unreadable}) or bun.lock's pin (${WRANGLER_LOCKED:-not found})." >&2
  echo "deploy.sh: run 'bun install' in $FLEET_DIR." >&2
  exit 1
fi
if version_lt "$WRANGLER_INSTALLED" "$WRANGLER_LOCKED"; then
  echo "deploy.sh: refusing — installed wrangler $WRANGLER_INSTALLED is older than bun.lock's $WRANGLER_LOCKED." >&2
  echo "deploy.sh: run 'bun install' in $FLEET_DIR, then deploy again." >&2
  exit 1
fi

# Copied BEFORE the gate (PR #44 hold): the #36 target check must read the
# exact file wrangler gets, from wrangler's cwd. The ops config names its
# container images relative to this app dir (./container/Dockerfile); read
# in the ops checkout, wrangler's config reader throws on them.
LOCAL_CONFIG="$FLEET_DIR/wrangler.local.jsonc"
cp "$FLEET_CONFIG" "$LOCAL_CONFIG"

# Issue #20: the pre-deploy rescue gate, run here and not left to a README
# `fleet rescue-all && bun run deploy` convention (a bare `bun run deploy`
# skipped it). rescue-all pushes every running studio's unpushed work before
# the containers are replaced; any FAILED/TIMEOUT (or no creds to list the
# studios, as on a first deploy) exits non-zero and this refuses.
# Unpiped: its per-studio progress reaches the operator live.
if replaces_containers ${ARGS[@]+"${ARGS[@]}"}; then
  # Issue #36: rescue-all rescues the fleet ~/.fleet/credentials names;
  # wrangler replaces the Worker this config (+ --env/CLOUDFLARE_ENV,
  # --name) names. Refuse unless they are provably the same Worker --
  # otherwise the gate rescues the wrong fleet and says SAFE. Unknown target
  # fails closed. scripts/deploy-target.ts reads the config with wrangler's
  # own reader.
  TARGET_RC=0
  RESCUE_RC=0
  TARGET_WORKER=""
  if command -v bun >/dev/null 2>&1; then
    TARGET_WORKER="$(cd "$FLEET_DIR" && bun scripts/deploy-target.ts wrangler.local.jsonc ${ARGS[@]+"${ARGS[@]}"})" || TARGET_RC=$?
  else
    echo "deploy.sh: bun not found on PATH -- cannot check the target or run fleet rescue-all." >&2
    TARGET_RC=127
  fi
  if [[ "$TARGET_RC" != 0 ]]; then
    if [[ "$ALLOW_UNRESCUED" == 1 ]]; then
      echo "deploy.sh: WARNING -- --allow-unrescued: wrangler's target Worker is NOT proven to be the fleet rescue-all rescues (exit $TARGET_RC); continuing. The target's studios may lose unpushed work." >&2
    else
      echo "deploy.sh: refusing -- wrangler's target Worker is not proven to be the fleet rescue-all rescues -- pre-deploy gate UNSAFE; point ~/.fleet/credentials at the target fleet, or pass --allow-unrescued to override (exit $TARGET_RC)." >&2
      exit 1
    fi
  fi
  if [[ "$TARGET_RC" == 127 ]]; then
    RESCUE_RC=127
  else
    bun "$FLEET_DIR/cli/fleet.ts" rescue-all || RESCUE_RC=$?
  fi
  OVERRIDE=""
  if [[ "$RESCUE_RC" != 0 ]]; then
    # Issue #40: a plain deploy that changes no container (same image
    # digest, same settings) replaces no studio -- a failed rescue then only
    # warns. Asked only here, after a failure: the probe builds the image.
    CHANGED_RC=1
    if [[ "$ALLOW_UNRESCUED" != 1 && "$RESCUE_RC" != 127 ]] && is_plain_deploy ${ARGS[@]+"${ARGS[@]}"}; then
      CHANGED_RC=0
      (cd "$FLEET_DIR" && bun scripts/deploy-containers-changed.ts wrangler.local.jsonc ${ARGS[@]+"${ARGS[@]}"}) >&2 || CHANGED_RC=$?
    fi
    if [[ "$ALLOW_UNRESCUED" == 1 ]]; then
      echo "deploy.sh: WARNING -- --allow-unrescued: rescue-all exited $RESCUE_RC; deploying anyway. Unpushed work in running studios may be LOST." >&2
    elif [[ "$CHANGED_RC" == 0 ]]; then
      echo "deploy.sh: WARNING -- rescue-all exited $RESCUE_RC, but this deploy makes no container changes (Worker-only): no studio container is replaced; deploying. Fix the failed rescues before the next image change." >&2
      OVERRIDE="worker-only"
    else
      echo "deploy.sh: refusing -- rescue-all reported FAILED -- pre-deploy gate UNSAFE; pass --allow-unrescued to override (exit $RESCUE_RC)." >&2
      exit 1
    fi
  fi
  [[ "$ALLOW_UNRESCUED" == 1 ]] && OVERRIDE="--allow-unrescued"
  # Issue #40: every override leaves a durable record, not just a stderr
  # line. Append-only JSON lines in ~/.fleet/ (the same small local-record
  # convention as orca-workspaces.json and locks/). Unwritable -> refused.
  if [[ -n "$OVERRIDE" ]]; then
    OVERRIDE_LOG="$HOME/.fleet/deploy-overrides.jsonl"
    case "$TARGET_RC" in 0) TARGET_CHECK="matched" ;; 1) TARGET_CHECK="mismatch (exit 1)" ;; *) TARGET_CHECK="undeterminable (exit $TARGET_RC)" ;; esac
    if [[ "$RESCUE_RC" == 0 ]]; then RESCUE_VERDICT="passed"; else RESCUE_VERDICT="exit $RESCUE_RC"; fi
    OPERATOR="$(git -C "$FLEET_DIR" config user.name 2>/dev/null || true)"
    [[ -n "$OPERATOR" ]] || OPERATOR="${USER:-unknown}"
    if [[ "${#ARGS[@]}" == 0 ]]; then COMMAND="deploy"; else COMMAND="$(record_command "${ARGS[@]}")"; fi
    RECORD="{\"ts\":$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)"),\"override\":$(json_str "$OVERRIDE"),\"command\":$(json_str "$COMMAND"),\"target_worker\":$(json_str "${TARGET_WORKER:-unknown}"),\"target_check\":$(json_str "$TARGET_CHECK"),\"rescue_all\":$(json_str "$RESCUE_VERDICT"),\"operator\":$(json_str "$OPERATOR")}"
    if ! { mkdir -p "$HOME/.fleet" && printf '%s\n' "$RECORD" >> "$OVERRIDE_LOG"; } 2>/dev/null; then
      echo "deploy.sh: refusing -- cannot write the override record $OVERRIDE_LOG; an override must leave a durable trace." >&2
      exit 1
    fi
    echo "deploy.sh: override recorded in $OVERRIDE_LOG" >&2
  fi
fi

cd "$FLEET_DIR"
if ((${#ARGS[@]})); then
  exec "$WRANGLER" "${ARGS[@]}" -c wrangler.local.jsonc
fi
exec "$WRANGLER" deploy -c wrangler.local.jsonc
