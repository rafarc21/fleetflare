#!/bin/sh
# Issue #84: makes a Dockerfile RUN step reproducible. Wraps every RUN in the
# three container images:
#
#   RUN --mount=type=tmpfs,target=/tmp repro-seal begin && <step> && repro-seal end
#
# wrangler skips a container rollout only when a rebuild lands on the image
# id it pushed before. Without this a cold rebuild (empty build cache) of an
# unchanged Dockerfile never does, so every running studio is replaced.
#
# begin: marks the step's start and lists the files that exist before it (in
#   /tmp, a tmpfs: never in the layer), and points apt at the dated snapshot
#   $APT_SNAPSHOT (a Dockerfile ARG) of the base image's own archive: same
#   package versions on every build until the date is bumped. A step adds its
#   own snapshot sources to /tmp/repro-apt/sources.list.d/.
# end: drops what differs between two runs of the same step (apt lists and
#   logs, caches, ssh host keys, fontconfig ids, claude's per-machine ids),
#   rebuilds each directory the step deleted an older file from (see
#   rebuild_dirs), then sets the mtime of everything the step created or
#   changed to $SOURCE_DATE_EPOCH (a Dockerfile ARG). Fails loudly when it
#   cannot.
set -eu

marker=/tmp/.repro-t0
before=/tmp/.repro-before
conf=/etc/apt/apt.conf.d/00repro-snapshot

# Every path of the image filesystem. /etc/hosts, /etc/resolv.conf and
# /etc/hostname are BuildKit's bind mounts for this step, not image content.
all_paths() {
  find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /tmp -o -path /etc/hosts \
    -o -path /etc/resolv.conf -o -path /etc/hostname \) -prune -o -print | LC_ALL=C sort
}

# Deleting a file that an older layer holds leaves a whiteout in this layer,
# and a whiteout carries the build's wall-clock time: nothing inside the step
# can set it. A directory deleted and recreated instead becomes opaque (one
# marker with a fixed time, no per-file whiteouts). So each directory that
# lost an older entry is copied out, removed, and copied back. Measured: git's
# upgrade from the git-core PPA drops a few files of the base's older git.
rebuild_dirs() {
  all_paths > /tmp/.repro-after
  LC_ALL=C comm -23 "$before" /tmp/.repro-after > /tmp/.repro-gone
  while IFS= read -r p; do
    d=${p%/*}
    if [ -d "${d:-/}" ]; then echo "${d:-/}"; fi
  done < /tmp/.repro-gone | LC_ALL=C sort -u | awk '
    { a = $0; covered = 0
      while (a != "") { if (a in kept) { covered = 1; break }; sub(/\/[^\/]*$/, "", a) }
      if (!covered) { kept[$0] = 1; print } }' > /tmp/.repro-dirs
  while IFS= read -r d; do
    if [ "$d" = / ] || awk -v d="$d/" 'index($2 "/", d) == 1 { found = 1 } END { exit !found }' /proc/self/mounts; then
      echo "repro-seal: $d lost older files but holds a mount; cannot rebuild it" >&2
      exit 1
    fi
    rm -rf /tmp/.repro-rebuild
    cp -a "$d" /tmp/.repro-rebuild
    rm -rf "$d"
    cp -a /tmp/.repro-rebuild "$d"
    rm -rf /tmp/.repro-rebuild
  done < /tmp/.repro-dirs
}

case "${1:-}" in
  begin)
    : "${APT_SNAPSHOT:?repro-seal: APT_SNAPSHOT (Dockerfile ARG) is not set}"
    touch "$marker"
    all_paths > "$before"
    mkdir -p /tmp/repro-apt/sources.list.d
    . /etc/os-release
    case "$ID:$VERSION_CODENAME" in
      debian:trixie)
        kr=/usr/share/keyrings/debian-archive-keyring.pgp
        cat > /tmp/repro-apt/sources.list <<EOF
deb [signed-by=$kr] http://snapshot.debian.org/archive/debian/$APT_SNAPSHOT trixie trixie-updates main
deb [signed-by=$kr] http://snapshot.debian.org/archive/debian-security/$APT_SNAPSHOT trixie-security main
EOF
        ;;
      ubuntu:jammy)
        kr=/usr/share/keyrings/ubuntu-archive-keyring.gpg
        u=http://snapshot.ubuntu.com/ubuntu/$APT_SNAPSHOT
        cat > /tmp/repro-apt/sources.list <<EOF
deb [signed-by=$kr] $u jammy main restricted universe multiverse
deb [signed-by=$kr] $u jammy-updates main restricted universe multiverse
deb [signed-by=$kr] $u jammy-backports main restricted universe multiverse
deb [signed-by=$kr] $u jammy-security main restricted universe multiverse
EOF
        ;;
      *) echo "repro-seal: no apt snapshot mapping for $ID $VERSION_CODENAME" >&2; exit 1 ;;
    esac
    # Snapshot Release files are past their Valid-Until by design.
    cat > "$conf" <<'EOF'
Dir::Etc::SourceList "/tmp/repro-apt/sources.list";
Dir::Etc::SourceParts "/tmp/repro-apt/sources.list.d";
Acquire::Check-Valid-Until "false";
EOF
    ;;
  end)
    : "${SOURCE_DATE_EPOCH:?repro-seal: SOURCE_DATE_EPOCH (Dockerfile ARG) is not set}"
    [ -f "$marker" ] && [ -f "$before" ] || { echo "repro-seal: end without begin" >&2; exit 1; }
    rm -f "$conf"
    # Run-varying, created by the step. /root/.claude.json and its backups
    # hold claude's per-machine ids (machineID, userID, first start time):
    # every container must make its own, not share the image's.
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/cache/apt/archives/*.deb \
      /var/cache/apt/archives/partial/* /root/.bun/install/cache /root/.npm /etc/ssh/ssh_host_* \
      /root/.claude.json /root/.claude/backups
    # fontconfig names its caches and per-directory ids with random UUIDs;
    # it rebuilds them on first use.
    for d in /usr/share/fonts /usr/local/share/fonts /var/cache/fontconfig; do
      if [ -d "$d" ]; then find "$d" -newer "$marker" \( -name .uuid -o -name '*.cache-*' \) -type f -delete; fi
    done
    # Logs with timestamps, and ldconfig's cache of inode/ctime data: may exist
    # in the base, so emptied rather than removed.
    for f in /var/log/dpkg.log /var/log/alternatives.log /var/log/apt/* /var/cache/ldconfig/aux-cache; do
      if [ -f "$f" ]; then : > "$f"; fi
    done
    # claude plugin install stamps its records with the wall clock.
    iso=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%S.000Z)
    for f in /root/.claude/plugins/installed_plugins.json /root/.claude/plugins/known_marketplaces.json; do
      if [ -f "$f" ]; then sed -i -E "s/\"(installedAt|lastUpdated)\": *\"[^\"]*\"/\"\\1\": \"$iso\"/g" "$f"; fi
    done
    rebuild_dirs
    find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /tmp -o -path /etc/hosts \
      -o -path /etc/resolv.conf -o -path /etc/hostname \) -prune -o -newer "$marker" -print0 \
      | xargs -0r touch -h -d "@$SOURCE_DATE_EPOCH"
    ;;
  *) echo "usage: repro-seal begin|end" >&2; exit 2 ;;
esac
