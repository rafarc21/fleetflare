#!/usr/bin/env bash
# scripts/public-export.sh — issue #335.
#
# THIS SCRIPT IS PREP / VERIFICATION ONLY. It never creates a GitHub repo and
# never pushes anywhere. It exists to answer one question, repeatably: "if we
# published THIS ref, right now, as a brand-new public repo with zero prior
# history, would it be clean?"
#
# Background (see issue #335's own body for the full plan): this repo's git
# HISTORY (1200+ commits) carries private data throughout — client names in
# ~170 files and 100+ commit messages, fleet/memory/ internal notes, infra
# ids, a real Telegram id, local machine paths, real author emails — that a
# simple "make the repo public" toggle on the CURRENT repo would expose
# forever, since GitHub keeps full history public once a repo is public. The
# plan is: rename the current private repo out of the way, then create a
# genuinely NEW public repo from a scrubbed, SQUASHED export of the tree —
# one commit, no history, so none of those old commits' diffs or messages
# ever reach the public repo.
#
# A separate, in-flight task (issue #347 / PR #351) does the actual
# SCRUBBING — deleting fleet/memory/, replacing real names/ids with neutral
# placeholders. This script is the VERIFICATION tool that confirms that
# scrubbing (and everything before it) actually worked. It is expected, and
# correct, for this script to find real violations when run against a ref
# where #351 hasn't landed (e.g. `main` today) — that is proof the checker
# works, not a bug in the checker.
#
# What this script does NOT do: fix anything it finds (that's #351's job),
# create any GitHub repo, or push anywhere. See `--publish` below: it is a
# permanent, deliberate stub. Creating the public repo and pushing to it is
# a manual step, run by hand only after the repo owner explicitly confirms.
#
# ---- Round 2 (issue #335, PR #364): this script must not leak either -----
#
# Round 1 of this script hardcoded ~12 private-name/string `grep_check`
# patterns directly in its own source (a real Telegram id, a real client
# repo name, a real person's name variants, a real domain, a real local
# machine username, a real private repo slug) plus two real personal email
# addresses in this very header, as "here's what must not leak" examples.
# That was itself the bug this script exists to prevent: since this script
# is a generally-useful tool (not scrubbed OUT of the export), every one of
# those strings would have shipped in the public repo's own source the
# moment this file was exported. Fixed in round 2 by moving every private
# string OUT of this script entirely:
#   - the private-name/string patterns now live in an external file this
#     script reads at runtime (see PUBLIC_DENYLIST below) — never baked in
#     here, never exported;
#   - this header no longer names any real email address, even as an
#     illustrative "what must not leak" example (see the author-identity
#     section below);
#   - the squashed-commit author name/email have no default value at all
#     (see PUBLIC_EXPORT_AUTHOR_NAME / PUBLIC_EXPORT_AUTHOR_EMAIL below) —
#     the script refuses to run rather than guess or fall back to one.
# The structural checks that stayed inline (fleet/memory/ must not exist;
# .fleet/done.json must not be tracked and must be gitignored) are not
# private strings — those two paths are generic, already-public naming
# conventions used throughout this repo's own ordinary application source
# (see apps/fleet/src/memory/, apps/fleet/src/studio/harvest-record.ts,
# .gitignore, etc.) — so keeping them here doesn't reintroduce the bug.
#
# Usage:
#   scripts/public-export.sh <ref> [--dry-run]
#       Export <ref> (branch/tag/commit) via `git archive`, squash it into
#       one commit in a fresh throwaway directory, and run every check below
#       against that squashed export. This is the default (and, right now,
#       the ONLY implemented) behavior — `--dry-run` is accepted for anyone
#       who wants to say so explicitly, but it changes nothing.
#
#   scripts/public-export.sh <ref> --publish <remote-url>
#       Not implemented. Exits immediately with a clear message. See below.
#
# Env vars:
#   PUBLIC_EXPORT_AUTHOR_NAME   Author name for the squashed commit.
#                               REQUIRED — no default. This script refuses
#                               to run (dry-run included) unless both this
#                               and PUBLIC_EXPORT_AUTHOR_EMAIL are set. See
#                               the author-identity section below for why.
#   PUBLIC_EXPORT_AUTHOR_EMAIL  Author email for the squashed commit.
#                               REQUIRED — no default. See above.
#   FLEET_OPS_DIR               Path to a local checkout of the private
#                               rafarc21/fleetflare-ops repo — the SAME
#                               env-var convention apps/fleet/scripts/
#                               deploy.sh already uses. Used, by default, to
#                               compute PUBLIC_DENYLIST below (irrelevant if
#                               PUBLIC_DENYLIST is set directly).
#   PUBLIC_DENYLIST             Path to the private-name denylist file — one
#                               grep -P (PCRE) pattern per line, blank lines
#                               and lines starting with `#` ignored. Default:
#                               "$FLEET_OPS_DIR/public-denylist.txt" (repo
#                               root of the ops checkout — this file isn't
#                               specific to any one app the way deploy.sh's
#                               fleet/wrangler.jsonc is to apps/fleet/, so it
#                               doesn't live under a "fleet/" subpath).
#                               Required for the private-name checks to run
#                               at all: if missing or unreadable, this script
#                               WARNS, SKIPS the private-name checks, and
#                               still runs gitleaks — it never silently
#                               reports those checks as passing. Every
#                               non-comment, non-blank line is matched
#                               case-INsensitively with `grep -rIn -iP`
#                               against the exported tree, so it may use any
#                               PCRE construct (word boundaries, alternation,
#                               negative lookahead, ...) and never needs its
#                               own inline `(?i)` for case-insensitivity —
#                               that is the default for every line, so a
#                               name leaks the same whether it shows up
#                               UPPER, lower, or Mixed case in the tree.
#                               PCRE is used uniformly (not plain ERE, and
#                               not a per-line dialect selector) because it
#                               is a strict superset of POSIX ERE for every
#                               construct these patterns need, AND is the
#                               only one of the three that can express a
#                               negative-lookahead pattern (e.g. excluding
#                               one specific, allowed sibling from an
#                               otherwise-denied prefix) — one consistent
#                               invocation, every line works under it. This
#                               script does not, and must not, know the real
#                               content of this file; it is seeded separately
#                               in the private ops repo.
#   GITLEAKS_CONFIG             Path to the gitleaks config to use. Default:
#                               <repo-root>/.gitleaks.toml — resolved next to
#                               THIS script, not inside the exported tree,
#                               because a ref being checked (e.g. `main`
#                               before this very PR merges) may not carry
#                               .gitleaks.toml yet.
#   KEEP_EXPORT_DIR             If set to "1", don't delete the temporary
#                               export directory on exit. Useful for
#                               inspecting a failing run by hand.
#   SOURCE_REPO                 Git checkout to resolve <ref> in and
#                               `git archive` from. Default: this script's
#                               own repo. Overridden by the test suite
#                               (scripts/test/public-export.test.sh) to point
#                               at small synthetic repos instead.
#
# ---- Squashed-commit author identity: the reasoning, no real examples ----
#
# GitHub auto-generates a "noreply" email for every account, in the form
# `<numeric-id>+<username>@users.noreply.github.com`. It exists precisely for
# this situation: attributing a commit to a real GitHub account's real
# public identity without ever putting that person's real, personal email
# address (the shape `<local-part>@<personal-domain>`) into a commit's
# metadata — commit author/committer emails are permanent, public, and
# mirrored everywhere the instant a repo goes public, unlike almost anything
# else in a git history. A `users.noreply.github.com` address avoids that
# permanently, while still resolving back to a specific, real GitHub account.
# The numeric id for any account can be looked up with a read-only, public
# API call (`gh api users/<username>`, which returns public profile data for
# anyone — no auth secrets, no write, no repo access needed), so the noreply
# address can always be reconstructed without ever handling a private email.
#
# This script does NOT default PUBLIC_EXPORT_AUTHOR_NAME / _EMAIL to
# anything, on purpose (round 2 of issue #335): no baked real name, no baked
# noreply address, no baked placeholder that looks real enough to mistake
# for one. Whoever runs a real export sets both explicitly, e.g.:
#   PUBLIC_EXPORT_AUTHOR_NAME="Your Name" \
#   PUBLIC_EXPORT_AUTHOR_EMAIL="<id>+<username>@users.noreply.github.com" \
#     scripts/public-export.sh <ref>
# (or any other address the repo owner prefers — this script does not care
# which, only that both are set explicitly, every time, by a human.)
#
# ---- Installing gitleaks (needed once per machine) ------------------------
#
# Not vendored, not a package.json dependency — this is a bash script, so it
# just needs the `gitleaks` binary on PATH. It was not preinstalled in the
# environment this script was built and tested in either; here is exactly
# how it was obtained there (GitHub CLI already authenticated as a token
# with no special scopes needed — this is a public repo, read-only):
#
#   gh release download v8.30.1 --repo gitleaks/gitleaks \
#     --pattern '*linux_x64*' -D /tmp/gitleaks-install
#   tar xzf /tmp/gitleaks-install/gitleaks_8.30.1_linux_x64.tar.gz \
#     -C /tmp/gitleaks-install
#   sudo install -m 0755 /tmp/gitleaks-install/gitleaks /usr/local/bin/gitleaks
#
# (For macOS: `brew install gitleaks`, or grab the darwin asset from the same
# release instead of the linux_x64 one above.) Verify with `gitleaks
# version`. See https://github.com/gitleaks/gitleaks/releases for other
# platforms/architectures.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
# SOURCE_REPO is the git checkout `<ref>` is resolved and archived from.
# Defaults to this script's own repo (the normal case: run this script from
# inside a checkout of rafarc21/fleetflare). Overridable so the test suite
# (scripts/test/public-export.test.sh) can point it at a small synthetic git
# repo instead of exporting this entire real repo on every test run.
SOURCE_REPO="${SOURCE_REPO:-$REPO_ROOT}"
GITLEAKS_CONFIG="${GITLEAKS_CONFIG:-$REPO_ROOT/.gitleaks.toml}"
# No defaults, by design — see the author-identity section above. Checked
# (and refused if unset) below, before anything else happens.
PUBLIC_EXPORT_AUTHOR_NAME="${PUBLIC_EXPORT_AUTHOR_NAME:-}"
PUBLIC_EXPORT_AUTHOR_EMAIL="${PUBLIC_EXPORT_AUTHOR_EMAIL:-}"
KEEP_EXPORT_DIR="${KEEP_EXPORT_DIR:-0}"
# FLEET_OPS_DIR: same convention as apps/fleet/scripts/deploy.sh. See the
# PUBLIC_DENYLIST doc comment above for why this file lives at the ops
# checkout's root rather than under a "fleet/" subpath.
FLEET_OPS_DIR="${FLEET_OPS_DIR:-}"
PUBLIC_DENYLIST="${PUBLIC_DENYLIST:-${FLEET_OPS_DIR}/public-denylist.txt}"

usage() {
  cat <<'EOF'
Usage:
  scripts/public-export.sh <ref> [--dry-run]
  scripts/public-export.sh <ref> --publish <remote-url>   (not implemented — see script header)

<ref> is any git ref resolvable in this checkout: a branch, tag, or commit.

Requires PUBLIC_EXPORT_AUTHOR_NAME and PUBLIC_EXPORT_AUTHOR_EMAIL to both be
set in the environment (no default — see script header). For the full
private-name checks, also set FLEET_OPS_DIR (or PUBLIC_DENYLIST directly) to
point at the denylist file; without it those checks are skipped with a
warning, not silently passed.
EOF
}

REF=""
PUBLISH_REMOTE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      shift
      ;;
    --publish)
      if [[ $# -lt 2 ]]; then
        echo "public-export.sh: --publish requires a <remote-url> argument" >&2
        exit 2
      fi
      PUBLISH_REMOTE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "public-export.sh: unknown flag: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$REF" ]]; then
        echo "public-export.sh: unexpected extra argument: $1" >&2
        usage >&2
        exit 2
      fi
      REF="$1"
      shift
      ;;
  esac
done

if [[ -z "$REF" ]]; then
  usage >&2
  exit 2
fi

# --- author identity is required, always — no fallback, no guessing -------
# Applies to every invocation shape (default dry-run included): even a
# dry-run's squashed export is diagnostic output a human could look at, and
# this script must never put together a commit under a guessed identity.
if [[ -z "$PUBLIC_EXPORT_AUTHOR_NAME" || -z "$PUBLIC_EXPORT_AUTHOR_EMAIL" ]]; then
  echo "public-export.sh: refusing to run -- PUBLIC_EXPORT_AUTHOR_NAME and PUBLIC_EXPORT_AUTHOR_EMAIL must both be set in the environment. Neither has a default (issue #335 round 2: no baked name/email, ever). Example:" >&2
  echo "  PUBLIC_EXPORT_AUTHOR_NAME=\"Your Name\" PUBLIC_EXPORT_AUTHOR_EMAIL=\"you@example.com\" scripts/public-export.sh <ref>" >&2
  exit 2
fi

# --- the real-publish path: a permanent stub, not a TODO ------------------
# This branch never touches git-archive, git-init, or any of the checks
# below. It never runs, and must never run, any command that creates a
# repository or pushes to a real remote. That is deliberate: creating the
# public GitHub repo, and pushing this export to it, is a manual step, done
# by hand only after the repo owner explicitly confirms. See issue #335.
#
# Once this path is ever implemented for real (it is not today): a missing
# PUBLIC_DENYLIST must be a HARD requirement/refusal there, unlike the
# dry-run path's warn-and-skip degrade below — a real publish must never
# proceed without the full private-name checks having actually run. Not
# enforced in code here because the stub above already refuses
# unconditionally, before any such check would matter.
if [[ -n "$PUBLISH_REMOTE" ]]; then
  echo "public-export.sh: --publish is not implemented." >&2
  echo "public-export.sh: this is a deliberate, permanent stub — not a TODO." >&2
  echo "public-export.sh: creating the public repo and pushing '$REF' to $PUBLISH_REMOTE is a manual step, run by hand only after the repo owner explicitly confirms. See issue #335." >&2
  exit 3
fi

echo "public-export.sh: verifying ref '$REF' resolves to a commit in $SOURCE_REPO ..."
if ! REF_SHA="$(git -C "$SOURCE_REPO" rev-parse --verify "${REF}^{commit}" 2>/dev/null)"; then
  echo "public-export.sh: '$REF' does not resolve to a commit in $SOURCE_REPO" >&2
  exit 2
fi
echo "public-export.sh: $REF -> $REF_SHA"

EXPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/public-export.XXXXXX")"
cleanup() {
  if [[ "$KEEP_EXPORT_DIR" != "1" ]]; then
    rm -rf "$EXPORT_DIR"
  else
    echo "public-export.sh: KEEP_EXPORT_DIR=1 — leaving export at $EXPORT_DIR"
  fi
}
trap cleanup EXIT

# ---- step 1: export the tree, no history at all ---------------------------
echo "public-export.sh: exporting tree via 'git archive' (no .git history) ..."
git -C "$SOURCE_REPO" archive "$REF" | tar -x -C "$EXPORT_DIR"

# ---- step 2: squash into exactly one commit --------------------------------
echo "public-export.sh: squashing into a single commit ..."
git -C "$EXPORT_DIR" init -q
git -C "$EXPORT_DIR" add -A
COMMIT_MSG="Public release: squashed export of ${REF} @ ${REF_SHA:0:12}

History intentionally starts here. This tree is a point-in-time export of
${REF} (${REF_SHA}) from the private development repo; the 1000+ commits
that produced it are not carried forward, by design (see issue #335)."

GIT_AUTHOR_NAME="$PUBLIC_EXPORT_AUTHOR_NAME" \
GIT_AUTHOR_EMAIL="$PUBLIC_EXPORT_AUTHOR_EMAIL" \
GIT_COMMITTER_NAME="$PUBLIC_EXPORT_AUTHOR_NAME" \
GIT_COMMITTER_EMAIL="$PUBLIC_EXPORT_AUTHOR_EMAIL" \
  git -C "$EXPORT_DIR" commit -q --no-verify -m "$COMMIT_MSG"

SQUASHED_SHA="$(git -C "$EXPORT_DIR" rev-parse HEAD)"
COMMIT_COUNT="$(git -C "$EXPORT_DIR" rev-list --count HEAD)"

# ---- checks -----------------------------------------------------------------
FAILURES=0
DENYLIST_SKIPPED=0
declare -a FAIL_LINES=()
declare -a RESULT_LINES=()

record_pass() { RESULT_LINES+=("PASS [$1] $2"); }
record_fail() {
  RESULT_LINES+=("FAIL [$1] $2")
  FAIL_LINES+=("[$1] $2")
  FAILURES=$((FAILURES + 1))
}
record_skip() { RESULT_LINES+=("SKIP [$1] $2"); }

# Generic, reusable grep check: searches the exported tree (not a hardcoded
# file list) so it keeps working after #351 lands and renames/relocates
# files, and so it also catches the same problem newly introduced anywhere
# else in the tree.
#
# Issue #335 (post-#396 review): `2>/dev/null || true` used to swallow BOTH
# grep's stderr AND its exit code — so a `-P` (PCRE) pattern run against a
# grep binary that doesn't support it (BSD/macOS's system `grep`, real exit
# 2, "invalid option -- P") produced an EMPTY match set and a silent PASS,
# indistinguishable from "really found nothing". Every prior macOS run of
# this script was vacuously green this way — an independent GNU-grep re-scan
# of the same export found real private-name hits the Mac run had reported
# clean (five distinct denylist terms, real occurrence counts in the dozens
# to low hundreds — never named here, per this file's own round-2 rule: this
# script's source must never carry the private strings it exists to catch).
# Fixed by capturing grep's own
# exit status explicitly and treating anything >= 2 (a real grep ERROR —
# bad option, unreadable path, malformed pattern, anything that means "this
# check did not actually run") as its own FAIL, never silently folded into
# "no matches". Exit 0 (matches) and exit 1 (no matches) are grep's only two
# defined "the search ran fine" outcomes; anything else means the search
# itself is broken and cannot vouch for a clean tree.
grep_check() {
  local item="$1" desc="$2"
  shift 2
  local matches rc grep_err
  grep_err="$(mktemp)"
  if matches="$("${GREP_BIN:-grep}" -rIn --exclude-dir=.git "$@" -- "$EXPORT_DIR" 2>"$grep_err")"; then
    rc=0
  else
    rc=$?
  fi
  if [[ "$rc" -ge 2 ]]; then
    record_fail "$item" "$desc — grep ERROR (exit $rc), cannot verify: $(tr '\n' ' ' <"$grep_err" | sed 's/ *$//')"
  elif [[ "$rc" -eq 0 ]]; then
    local count
    count="$(printf '%s\n' "$matches" | wc -l | tr -d ' ')"
    record_fail "$item" "$desc — $count occurrence(s)"
    printf '%s\n' "$matches" | sed "s|^$EXPORT_DIR/||"
  else
    record_pass "$item" "$desc"
  fi
  rm -f "$grep_err"
}

# Reads PUBLIC_DENYLIST (one grep -P pattern per line; blank lines and lines
# starting with `#` ignored) and runs a grep_check for each pattern found.
# This is the ONLY place private-name/string patterns enter this script, at
# runtime, from a file this script's own source never contains — see the
# round-2 note near the top of this file. Deliberately does NOT print the
# raw pattern text as part of a check's description (only actual matched
# lines found IN THE EXPORTED TREE, i.e. real violations, are ever printed)
# so a clean run's own log never has to carry the denylist's contents either.
run_denylist_checks() {
  if [[ ! -f "$PUBLIC_DENYLIST" || ! -r "$PUBLIC_DENYLIST" ]]; then
    echo "public-export.sh: WARNING: denylist file not found or unreadable at $PUBLIC_DENYLIST" >&2
    echo "public-export.sh: WARNING: private-name checks SKIPPED. Set FLEET_OPS_DIR to a local checkout of the private rafarc21/fleetflare-ops repo (same convention as apps/fleet/scripts/deploy.sh), which must contain public-denylist.txt at its root -- or set PUBLIC_DENYLIST directly." >&2
    DENYLIST_SKIPPED=1
    record_skip "denylist" "private-name checks: SKIPPED (denylist not found at $PUBLIC_DENYLIST)"
    return
  fi
  # Issue #335 (maestro review round 3): a PCRE capability probe, once, up
  # front, BEFORE the per-pattern loop below. Without this, a grep lacking
  # -P support (BSD/macOS's system grep) hit grep_check's own fail-closed
  # behavior once PER denylist LINE — dozens of individual "grep ERROR"
  # FAILs, drowning whatever real signal was in there. One check, one clear
  # message, same SKIPPED/INCOMPLETE outcome as the missing-denylist-file
  # case above (never a false PASS either way). `ggrep` is Homebrew
  # coreutils' own prefixed name for GNU grep on macOS (installed
  # alongside, never replacing, the system `grep`) — tried second, since a
  # real Mac dev machine commonly has it even though this sandbox's own
  # `grep` already supports -P natively. The probe pattern is guaranteed to
  # MATCH if -P is genuinely supported, so "no match" (exit 1, a working
  # grep that legitimately found nothing) is never confused with "-P
  # itself is rejected" (exit >=2, invalid option) — the ONLY thing this
  # probes for.
  GREP_BIN="grep"
  if ! printf 'x' | grep -P 'x' >/dev/null 2>&1; then
    if command -v ggrep >/dev/null 2>&1 && printf 'x' | ggrep -P 'x' >/dev/null 2>&1; then
      GREP_BIN="ggrep"
    else
      echo "public-export.sh: WARNING: this system's grep has no PCRE (-P) support, and no working ggrep (Homebrew coreutils' GNU grep) was found either." >&2
      echo "public-export.sh: WARNING: private-name checks SKIPPED -- every denylist pattern needs -P (word boundaries, negative lookahead; see PUBLIC_DENYLIST's own doc comment above). On macOS: 'brew install grep', or run this script under GNU grep (Linux/Docker) instead." >&2
      DENYLIST_SKIPPED=1
      record_skip "denylist" "private-name checks: SKIPPED (this grep has no PCRE support, and no working ggrep was found)"
      return
    fi
  fi
  local lineno=0 trimmed
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    trimmed="${line#"${line%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    [[ -z "$trimmed" ]] && continue
    [[ "$trimmed" == \#* ]] && continue
    grep_check "D$lineno" "denylist pattern at $(basename "$PUBLIC_DENYLIST"):$lineno" -iP "$trimmed"
  done < "$PUBLIC_DENYLIST"
}

echo
echo "=== private-name / structural checks ======================================"

# --- item 1: fleet/memory/ must not exist (structural, not a grep) --------
# Not moved to the denylist: this is a directory-existence check, not a
# private string. "fleet/memory" is a generic, already-public naming
# convention used throughout this repo's own ordinary application source
# (see e.g. apps/fleet/src/memory/, apps/fleet/src/studio/do.ts).
if [[ -d "$EXPORT_DIR/fleet/memory" ]]; then
  N="$(find "$EXPORT_DIR/fleet/memory" -type f | wc -l | tr -d ' ')"
  record_fail "1" "fleet/memory/ must not exist in a public export — found with $N file(s)"
else
  record_pass "1" "fleet/memory/ does not exist"
fi

# --- items 2-6 (private-name/string patterns): read from PUBLIC_DENYLIST --
# Round 1 hardcoded these directly (real Telegram id, real client repo name,
# real person's name variants, real domain, real local machine username,
# real private repo slug) — exactly the self-inflicted leak issue #335
# round 2 exists to fix. See PUBLIC_DENYLIST in the header doc comment.
run_denylist_checks

# --- item 7: .fleet/done.json should be untracked + gitignored ------------
# Not moved to the denylist: same reasoning as item 1 above — ".fleet/
# done.json" is a generic gate-file name already used throughout this
# repo's own ordinary source (apps/fleet/src/studio/harvest-record.ts,
# .gitignore), not a private string. Item 7b in particular is a POSITIVE
# assertion ("this path IS gitignored"), which can't be expressed as a
# denylist entry anyway — a denylist is inherently a "must NOT match" list.
if [[ -e "$EXPORT_DIR/.fleet/done.json" ]]; then
  record_fail "7a" ".fleet/done.json is tracked (present in the export) — gate records belong in the ops repo"
else
  record_pass "7a" ".fleet/done.json is not tracked"
fi
if git -C "$EXPORT_DIR" check-ignore -q .fleet/done.json 2>/dev/null; then
  record_pass "7b" ".fleet/done.json is gitignored"
else
  record_fail "7b" ".fleet/done.json is not gitignored (no matching .gitignore pattern)"
fi

echo
echo "=== gitleaks secret scan ===================================================="
GITLEAKS_REPORT="$EXPORT_DIR/../$(basename "$EXPORT_DIR").gitleaks.json"
if ! command -v gitleaks >/dev/null 2>&1; then
  record_fail "gitleaks" "gitleaks binary not found on PATH — see scripts/public-export.sh header for install notes"
elif [[ ! -f "$GITLEAKS_CONFIG" ]]; then
  record_fail "gitleaks" "config not found: $GITLEAKS_CONFIG"
else
  if gitleaks detect --no-git --source "$EXPORT_DIR" --config "$GITLEAKS_CONFIG" \
      --report-format json --report-path "$GITLEAKS_REPORT" -v >/tmp/public-export-gitleaks.log 2>&1; then
    record_pass "gitleaks" "0 findings (config: ${GITLEAKS_CONFIG#"$REPO_ROOT"/})"
  else
    GL_COUNT="$(jq 'length' "$GITLEAKS_REPORT" 2>/dev/null || echo "unknown")"
    record_fail "gitleaks" "$GL_COUNT finding(s) — see $GITLEAKS_REPORT"
    jq -r '.[] | "  " + .RuleID + " | " + .File + ":" + (.StartLine|tostring) + " | " + .Match' \
      "$GITLEAKS_REPORT" 2>/dev/null || cat /tmp/public-export-gitleaks.log
  fi
  rm -f "$GITLEAKS_REPORT"
fi

# ---- summary -----------------------------------------------------------------
echo
echo "=============================================================================="
echo "public-export.sh summary — ref=$REF ($REF_SHA)"
echo "=============================================================================="
echo "Squashed export: $SQUASHED_SHA (commit count: $COMMIT_COUNT)"
echo "Author:          $PUBLIC_EXPORT_AUTHOR_NAME <$PUBLIC_EXPORT_AUTHOR_EMAIL>"
echo "Export dir:      $EXPORT_DIR$( [[ "$KEEP_EXPORT_DIR" == "1" ]] && echo " (kept)" || echo " (will be removed)" )"
echo "Mode:            DRY RUN — nothing published, nothing pushed, no repo created"
echo
for line in "${RESULT_LINES[@]}"; do
  echo "$line"
done
echo
if [[ "$FAILURES" -gt 0 ]]; then
  echo "RESULT: FAIL — $FAILURES check(s) failed:"
  for line in "${FAIL_LINES[@]}"; do
    echo "  - $line"
  done
elif [[ "$DENYLIST_SKIPPED" -eq 1 ]]; then
  echo "RESULT: INCOMPLETE — 0 other violation(s), 0 gitleaks finding(s), but private-name checks: SKIPPED (denylist not found at $PUBLIC_DENYLIST)."
  echo "RESULT: this is NOT a pass. Set FLEET_OPS_DIR (or PUBLIC_DENYLIST) and re-run before treating this export as clean."
else
  echo "RESULT: PASS — 0 violations, 0 gitleaks findings. Safe to hand off for the (separate, manual) publish step."
fi
echo "=============================================================================="

exit "$(( FAILURES > 0 ? 1 : 0 ))"
