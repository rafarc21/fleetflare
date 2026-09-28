#!/bin/sh
# Adopt the lead's newest worktree-keyed claude session into the root project
# key, so bring-up's `--continue` resumes it (issues #116, #146).
#
#   studio-adopt.sh <repo> [log]
#
# Prints exactly one `FLEET_SESSION_ADOPT <outcome> [<id> <key>]` line on
# stdout; outcome is adopted, root, none or failed. Callers bound it with
# `timeout -k`: studio-bringup.sh (its session-adopt step, right after the
# session-restore untar) and, before bring-up, the Worker's
# adoptWorktreeSessionCmd in src/studio/provision.ts, whose inline fallback
# for older images carries these same rules and runs the same tests
# (test/bun/studio-adopt.test.ts).
#
# WHY INSIDE BRING-UP (#146): on a fresh container the session tar is only
# STAGED when the Worker's pre-bring-up adopt runs; bring-up untars it later.
# That adopt saw nothing, the lead launched blank, and the blank root session
# then outranked the real one on every later heal.
#
# The rules, each one a reviewed failure (PR #120, #131, #165's verifier):
# - WORKTREE KEYS ONLY: `<root key>--claude-worktrees-*`, never a sibling
#   such as `<root key>-web` (another repo's session).
# - RESUMABLE ONLY: a UUID file name, `"entrypoint":"cli"` in its first 50
#   lines, no `"teamName":`. Root is judged by the same rule: an sdk-cli file
#   there is not what --continue would resume, so it never blocks.
# - Newest first, from `ls -t` of the directory (never a glob of files as
#   arguments: ARG_MAX on a big key). Adopt only when the worktree candidate
#   is STRICTLY newer than root's newest resumable session; a tie keeps root.
# - COPY, never a symlink (claude does not resume a symlinked transcript),
#   via a non-`.jsonl` temp name then `mv`, so bring-up never sees half a
#   file. Plain `cp`, not `cp -p`: the copy's fresh mtime makes it root's
#   newest, which is what `--continue` picks and what stops a re-adopt.
# - EXTEND-ONLY (#155): a same-id root file is replaced only by a candidate
#   that begins with its exact bytes; otherwise the root copy is kept and
#   one line says so. `head -c <root size> | cmp -`, not `cmp -n`: macOS
#   cmp -n reports EOF at an exact-length limit, so the tests would disagree
#   with the container's GNU cmp.
# - A same-id root file is kept first as `<id>.jsonl.pre-adopt-<epoch>`, and
#   only the newest such backup per id survives (#131: each is a full
#   transcript inside the session tar).
# - The worktree original is never touched.
set -u
M=FLEET_SESSION_ADOPT
P="${HOME:-/root}/.claude/projects"
R=$(printf '%s' "/workspace/$1" | tr -c 'a-zA-Z0-9' '-')
LOG=${2:-}

ok() {
  head -n 50 -- "$1" 2>/dev/null | grep -q '"entrypoint":"cli"' || return 1
  ! head -n 50 -- "$1" 2>/dev/null | grep -q '"teamName":'
}

first() {
  ls -t -- "$1" 2>/dev/null | grep -E '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$' | while IFS= read -r f; do
    if ok "$1/$f"; then printf '%s\n' "$1/$f"; break; fi
  done
}

root=$(first "$P/$R")
wt=
for d in "$P/$R"--claude-worktrees-*/; do
  [ -d "$d" ] || continue
  c=$(first "${d%/}")
  [ -n "$c" ] || continue
  if [ -z "$wt" ] || [ "$c" -nt "$wt" ]; then wt=$c; fi
done

if [ -z "$wt" ]; then
  if [ -n "$root" ]; then echo "$M root"; else echo "$M none"; fi
elif [ -n "$root" ] && ! [ "$wt" -nt "$root" ]; then
  echo "$M root"
else
  id=$(basename -- "$wt" .jsonl)
  k=$(basename -- "$(dirname -- "$wt")")
  dst="$P/$R/$id.jsonl"
  # Issue #155, extend-only: a same-id root copy is replaced ONLY by a
  # candidate that starts with its exact bytes. Anything else (a stale,
  # shorter original; a divergent file) would drop lines only the root holds
  # from the next `latest` snapshot, so it is skipped and said once.
  if [ -e "$dst" ] && ! head -c "$(($(wc -c < "$dst")))" -- "$wt" | cmp -s - "$dst"; then
    msg="studio-adopt: skipped $id from $k: not a byte-extension of $R/$id.jsonl, root copy kept (issue #155)"
    echo "$msg" >&2
    if [ -n "$LOG" ]; then
      printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg" >> "$LOG" 2>/dev/null || true
    fi
    echo "$M root"
  elif mkdir -p -- "$P/$R" && { [ ! -e "$dst" ] || cp -p -- "$dst" "$dst.pre-adopt-$(date +%s)"; } \
    && cp -- "$wt" "$dst.adopt-tmp" && mv -f -- "$dst.adopt-tmp" "$dst"; then
    # Epochs are 10 digits until 2286, so a reverse name sort is newest-first.
    ls -- "$P/$R" 2>/dev/null | grep -E "^$id\.jsonl\.pre-adopt-[0-9]+\$" | sort -r | tail -n +2 | while IFS= read -r b; do
      rm -f -- "$P/$R/$b"
    done
    echo "$M adopted $id $k"
    if [ -n "$LOG" ]; then
      printf '%s session-adopt: copied %s from %s into %s so --continue resumes it (issue #146)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$id" "$k" "$R" >> "$LOG" 2>/dev/null || true
    fi
  else
    rm -f -- "$dst.adopt-tmp"
    echo "$M failed"
  fi
fi
