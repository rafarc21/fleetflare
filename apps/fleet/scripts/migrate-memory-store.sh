#!/usr/bin/env bash
# Issue #341: build the private memory STORE repo from the fleet repo's
# fleet/memory/ history. Offline and push-free: it only writes <out-dir>.
# The maestro reviews the result and pushes it (commands: PR #341 body).
#
# usage: migrate-memory-store.sh <fleet-repo path or URL> <out-dir> [ref]
#
# `git subtree split` keeps every commit that touched fleet/memory/ (and only
# those), with the files lifted to the root; `git subtree add` then re-nests
# them under fleet/memory/ in a fresh repo, so the store keeps the SAME layout
# every reader and writer uses (src/memory/index-file.ts's MEMORY_DIR).
set -euo pipefail

SRC="${1:?usage: migrate-memory-store.sh <fleet-repo> <out-dir> [ref]}"
OUT="${2:?usage: migrate-memory-store.sh <fleet-repo> <out-dir> [ref]}"
REF="${3:-main}"
PREFIX="fleet/memory"
# Issue #335 (public-release scrub): same FLEET_BOT_NAME/_EMAIL convention
# as the container/Worker side (env.ts) — the real operator sets these when
# running this by hand; neutral default otherwise.
FLEET_BOT_NAME="${FLEET_BOT_NAME:-fleetflare[bot]}"
FLEET_BOT_EMAIL="${FLEET_BOT_EMAIL:-fleetflare[bot]@users.noreply.github.com}"

if [ -e "$OUT" ]; then
  echo "migrate-memory-store: $OUT exists -- refusing to mix into it" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone -q --no-local --branch "$REF" "$SRC" "$work/src"
git -C "$work/src" subtree split -q --prefix="$PREFIX" -b memory-split >/dev/null

git init -q -b main "$OUT"
git -C "$OUT" -c user.name="$FLEET_BOT_NAME" -c user.email="$FLEET_BOT_EMAIL" \
  commit -q --allow-empty -m "store: fleet memory, migrated from the fleet repo (#341)"
git -C "$OUT" -c user.name="$FLEET_BOT_NAME" -c user.email="$FLEET_BOT_EMAIL" \
  subtree add -q --prefix="$PREFIX" "$work/src" memory-split >/dev/null

src_files="$(git -C "$work/src" ls-tree -r --name-only HEAD -- "$PREFIX" | wc -l | tr -d ' ')"
out_files="$(git -C "$OUT" ls-files | wc -l | tr -d ' ')"
commits="$(git -C "$OUT" rev-list --count HEAD)"
if [ "$src_files" != "$out_files" ]; then
  echo "migrate-memory-store: file count mismatch (source $src_files, store $out_files)" >&2
  exit 1
fi
echo "migrate-memory-store: ok files=$out_files commits=$commits out=$OUT"
