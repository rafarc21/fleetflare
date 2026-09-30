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
# begin: marks the step's start (in /tmp, a tmpfs: never in the layer), and
#   points apt at the dated snapshot $APT_SNAPSHOT (a Dockerfile ARG) of the
#   base image's own archive: same package versions on every build until the
#   date is bumped. A step adds its own snapshot sources to
#   /tmp/repro-apt/sources.list.d/.
# end: drops what differs between two runs of the same step (apt lists and
#   logs, caches, generated ssh host keys), then sets the mtime of everything
#   the step created or changed to $SOURCE_DATE_EPOCH (a Dockerfile ARG).
#   Fails when a changed path cannot be normalized.
set -eu

marker=/tmp/.repro-t0
conf=/etc/apt/apt.conf.d/00repro-snapshot

case "${1:-}" in
  begin)
    : "${APT_SNAPSHOT:?repro-seal: APT_SNAPSHOT (Dockerfile ARG) is not set}"
    touch "$marker"
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
    [ -f "$marker" ] || { echo "repro-seal: end without begin" >&2; exit 1; }
    rm -f "$conf"
    # Created by this step: removed. Deleting a file the base image already
    # has would instead leave a whiteout carrying the build-time mtime.
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/cache/apt/archives/*.deb \
      /var/cache/apt/archives/partial/* /root/.bun/install/cache /root/.npm /etc/ssh/ssh_host_*
    # Logs with timestamps, and ldconfig's cache of inode/ctime data: may exist
    # in the base, so emptied rather than removed.
    for f in /var/log/dpkg.log /var/log/alternatives.log /var/log/apt/* /var/cache/ldconfig/aux-cache; do
      if [ -f "$f" ]; then : > "$f"; fi
    done
    # /etc/hosts, /etc/resolv.conf, /etc/hostname are BuildKit's bind mounts
    # for this step, not image content.
    find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /tmp -o -path /etc/hosts \
      -o -path /etc/resolv.conf -o -path /etc/hostname \) -prune -o -newer "$marker" -print0 \
      | xargs -0r touch -h -d "@$SOURCE_DATE_EPOCH"
    ;;
  *) echo "usage: repro-seal begin|end" >&2; exit 2 ;;
esac
