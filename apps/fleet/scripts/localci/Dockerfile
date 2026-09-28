# Issue #267 — Linux lane image for localci.sh: bun run bun-test needs tmux
# (wake-cmd drives a real tmux server) and /usr/local/bin/chromium (the
# ego-browser shim launches that exact path, as Dockerfile.studio links it).
# Mirrors the disabled .github/workflows/fleet-check.yml lane. Every input is
# pinned: an edit here changes the image tag localci.sh derives, so it rebuilds.
#
# Issue #356 — zstd, for install-cache-security.test.ts's real `tar --zstd`
# lane (hasGnuTar() && hasZstd()): missing here, its ~8 tests silently
# describe.skip'd in the one place that's supposed to guarantee the tool.
#
# Issue #335 (review round 3) — gitleaks, for the new
# apps/fleet/test/bun/public-export.test.ts wrapper (shells out to
# scripts/test/public-export.test.sh, which needs a real `gitleaks` binary
# on PATH — see scripts/public-export.sh's own header for install notes,
# this mirrors those exact commands, version-pinned the same way every
# other tool in this Dockerfile already is).
FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS bun

FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git python3 ca-certificates curl zstd \
 && rm -rf /var/lib/apt/lists/* \
 && git config --global --add safe.directory '*' \
 && git config --global user.email localci@localhost \
 && git config --global user.name localci
RUN curl -fsSL -o /tmp/gitleaks.tar.gz \
      https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
 && tar xzf /tmp/gitleaks.tar.gz -C /tmp gitleaks \
 && install -m 0755 /tmp/gitleaks /usr/local/bin/gitleaks \
 && rm -f /tmp/gitleaks.tar.gz /tmp/gitleaks \
 && gitleaks version
# This IS the pinned local-ci Linux image: every tool test/bun/require-tool.ts
# gates on (tmux, zstd, coreutils, ...) is guaranteed present here. Read by
# requireTools() to turn a missing-tool `describe.skip` into a loud failure
# instead — inside this image, a skip means the image itself regressed, not
# that some arbitrary dev machine lacks the tool (issue #356).
ENV LOCALCI_IMAGE=1
# Playwright pinned to apps/fleet/bun.lock's playwright-core. The chromium
# dir is chrome-linux64 on amd64, chrome-linux-arm64 on arm64 — glob both.
WORKDIR /opt/pw
RUN bun x playwright@1.63.0 install chromium --with-deps \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf "$(ls -d /root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | head -1)" /usr/local/bin/chromium \
 && /usr/local/bin/chromium --version \
 && tmux -V && bun --version
