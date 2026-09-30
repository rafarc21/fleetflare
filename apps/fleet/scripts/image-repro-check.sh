#!/bin/bash
# Issue #84 — are the container images reproducible?
#
#   scripts/image-repro-check.sh [agent|deploy|studio ...]   (default: all three)
#
# wrangler (4.141+, containers deploy) rebuilds each image and skips the push
# ("no changes") only when the build lands on the image id it pushed before.
# That used to hold only while the deploy host's build cache survived: a
# `docker builder prune -af` on 2026-09-29 made the next deploy rebuild all
# three images from nothing, get new digests from an unchanged container/,
# and replace every running studio.
#
# This builds each image TWICE with wrangler's exact flags
# (`docker build --load --platform linux/amd64 --provenance=false -f - <ctx>`)
# plus --no-cache, the second time from a fresh copy of the context (new file
# mtimes: a different checkout). Pass = both builds give the same image id,
# the id wrangler's "already exists remotely" check keys on. Fail = prints the
# first differing layer, the Dockerfile step that made it, and the files that
# differ in it.
#
# Heavy (network, ~10 min cold, a few GB of layers): not in the default suite.
# Run it on any change to a Dockerfile or to what it installs. Holds the
# Mac-wide gate lock (/tmp/fleetflare-gate.lock) when lockf exists. Never
# prunes the host's build cache; removes only the images it tagged.
#
# Exit: 0 reproducible · 1 not reproducible · 2 build/infra error.
# Bash 3.2 (macOS /bin/bash).
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
FLEET_DIR=$(dirname "$HERE")
LOCK=/tmp/fleetflare-gate.lock
if [[ -z "${IMAGE_REPRO_LOCKED:-}" ]] && command -v lockf >/dev/null 2>&1; then
  IMAGE_REPRO_LOCKED=1 exec lockf -k "$LOCK" "$0" "$@"
fi

DOCKER=${WRANGLER_DOCKER_BIN:-docker}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/image-repro.XXXXXX")
TAGS=()
cleanup() {
  local t
  for t in ${TAGS[@]+"${TAGS[@]}"}; do "$DOCKER" image rm -f "$t" >/dev/null 2>&1 || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT

# name -> Dockerfile, build context (relative to apps/fleet), build args.
# Mirrors wrangler.example.jsonc's containers[].
spec() {
  case "$1" in
    agent) echo "container/Dockerfile|container|" ;;
    deploy) echo "container/Dockerfile.deploy|container|" ;;
    studio) echo "container/Dockerfile.studio|.|ENABLE_CAVEMAN_PLUGIN=false" ;;
    *) return 1 ;;
  esac
}

# copy_context <ctx> <dest>: the context without its heavy/ignored parts,
# with NEW mtimes (no -p): what a fresh checkout looks like to COPY.
copy_context() {
  (cd "$FLEET_DIR/$1" && tar -cf - --exclude ./node_modules --exclude ./.wrangler --exclude ./.git \
    --exclude ./page/dist --exclude './.dev.vars*' --exclude './.env*' --exclude '*.pem' .) \
    | (mkdir -p "$2" && cd "$2" && tar -xmf -)
}

build() { # build <dockerfile> <ctx-dir> <tag> <build-arg>
  local args=()
  [[ -n "$4" ]] && args=(--build-arg "$4")
  "$DOCKER" build --load -t "$3" --platform linux/amd64 --provenance=false --no-cache \
    ${args[@]+"${args[@]}"} -f - "$2" < "$FLEET_DIR/$1" >"$TMP/build-$3.log" 2>&1
}

# explain <tagA> <tagB>: every differing layer, the Dockerfile step that made
# it, and (for the first one) the tar entries that differ.
explain() {
  local i t
  for i in a b; do
    t=$1; [[ $i == b ]] && t=$2
    mkdir -p "$TMP/save-$i"
    "$DOCKER" save "$t" -o "$TMP/save-$i/img.tar" && (cd "$TMP/save-$i" && tar -xf img.tar) || { echo "  docker save of $t failed"; return; }
  done
  python3 - "$TMP/save-a" "$TMP/save-b" <<'PY'
import hashlib, json, sys, tarfile

def load(d):
    m = json.load(open(f"{d}/manifest.json"))[0]
    cfg = json.load(open(f"{d}/{m['Config']}"))
    steps = [h.get("created_by", "") for h in cfg["history"] if not h.get("empty_layer")]
    return d, m["Layers"], cfg["rootfs"]["diff_ids"], steps, cfg

def entries(d, layer):
    t = tarfile.open(f"{d}/{layer}")
    out = {}
    for e in t.getmembers():
        h = hashlib.sha256(t.extractfile(e).read()).hexdigest()[:12] if e.isfile() else ""
        out[e.name] = {"mode": oct(e.mode), "owner": f"{e.uid}:{e.gid}", "mtime": e.mtime, "type": e.type.decode(), "link": e.linkname, "sha": h}
    return out

A, B = load(sys.argv[1]), load(sys.argv[2])
diff = [i for i, (x, y) in enumerate(zip(A[2], B[2])) if x != y]
if not diff and len(A[2]) == len(B[2]):
    keys = [k for k in A[4] if A[4][k] != B[4].get(k)]
    print(f"  layers identical; image config differs in: {keys}")
    sys.exit()
for i in diff:
    print(f"  layer #{i + 1} differs: {A[3][i][:160]}")
first = diff[0]
for i in diff:
    la, lb = entries(A[0], A[1][i]), entries(B[0], B[1][i])
    only = sorted(set(la) ^ set(lb))
    changed = {n: [k for k in la[n] if la[n][k] != lb[n][k]] for n in sorted(set(la) & set(lb))}
    changed = {n: ks for n, ks in changed.items() if ks}
    mtime_only = [n for n, ks in changed.items() if ks == ["mtime"]]
    other = {n: ks for n, ks in changed.items() if ks != ["mtime"]}
    print(f"  layer #{i + 1}: {len(mtime_only)} entries differ in mtime only; {len(other)} in content/metadata; {len(only)} in one build only")
    for n in mtime_only[:8]:
        print(f"    mtime  {n}")
    for n, ks in list(other.items())[:25]:
        print(f"    {','.join(ks):<6} {n}")
    for n in only[:15]:
        print(f"    {'A-only' if n in la else 'B-only'} {n}")
PY
}

NAMES=("$@")
[[ ${#NAMES[@]} == 0 ]] && NAMES=(agent deploy studio)
rc=0
for name in "${NAMES[@]}"; do
  s=$(spec "$name") || { echo "unknown image '$name' (agent|deploy|studio)" >&2; exit 2; }
  IFS='|' read -r df ctx barg <<< "$s"
  ta="fleet-repro-check:$name-a-$$"; tb="fleet-repro-check:$name-b-$$"
  TAGS+=("$ta" "$tb")
  echo "== $name ($df, context $ctx)"
  build "$df" "$FLEET_DIR/$ctx" "$ta" "$barg" || { echo "  build A failed:"; grep -vE "^ *[0-9]+ \| " "$TMP/build-$ta.log" | tail -40; exit 2; }
  copy_context "$ctx" "$TMP/ctx-$name"
  build "$df" "$TMP/ctx-$name" "$tb" "$barg" || { echo "  build B failed:"; grep -vE "^ *[0-9]+ \| " "$TMP/build-$tb.log" | tail -40; exit 2; }
  ia=$("$DOCKER" image inspect "$ta" --format '{{.Id}}'); ib=$("$DOCKER" image inspect "$tb" --format '{{.Id}}')
  echo "  build A: $ia"
  echo "  build B: $ib"
  if [[ "$ia" == "$ib" ]]; then
    echo "  REPRODUCIBLE"
  else
    echo "  NOT REPRODUCIBLE"
    explain "$ta" "$tb"
    rc=1
  fi
done
exit $rc
