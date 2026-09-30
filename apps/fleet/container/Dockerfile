# Issue #84: reproducible build -- the rules are in Dockerfile.deploy's
# header; scripts/image-repro-check.sh proves them. Bumping APT_SNAPSHOT or a
# pin IS an image change and a rollout: batch it.
ARG SOURCE_DATE_EPOCH=1790640000

FROM oven/bun:1.3-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS src
ARG SOURCE_DATE_EPOCH
COPY repro-seal.sh server.ts fleet-cli.ts /src/
# /etc/hosts: the base has none (see Dockerfile.deploy). Trees copied onto /,
# so every directory they touch carries a normalized mtime.
RUN mkdir -p /src/base/etc /src/base/usr/local/bin /src/app/app \
    && printf '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n' > /src/base/etc/hosts \
    && mv /src/repro-seal.sh /src/base/usr/local/bin/repro-seal \
    && mv /src/server.ts /src/fleet-cli.ts /src/app/app/ \
    && chmod -R u=rwX,go=rX /src && chmod 0755 /src/base/usr/local/bin/repro-seal \
    && find /src -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

FROM oven/bun:1.3-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f
ARG SOURCE_DATE_EPOCH
ARG APT_SNAPSHOT=20260929T000000Z
COPY --from=src /src/base/ /

# gh: a pinned release .deb, checksum-verified (issue #84). GitHub's apt repo
# keeps only its newest gh, so a version pin there breaks on its next release.
# 2.101.0 = what the images deployed 2026-09-29 already run. Same package, same
# /usr/bin/gh as the apt install it replaces; no GitHub apt source in the image.
RUN --mount=type=tmpfs,target=/tmp repro-seal begin \
    && apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg \
    && curl -fsSL -o /tmp/gh.deb https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_linux_amd64.deb \
    && echo "f876a3b87bf67c94f773d17becca4dc7340b056dab901473a9260ee2a73e237b  /tmp/gh.deb" | sha256sum -c - \
    && apt-get install -y --no-install-recommends /tmp/gh.deb \
    && repro-seal end

# Pinned. The auth gate and the JSON contract in server.ts are written
# against this CLI's output shape; a floating install would change both
# with zero diff to review. 2.1.224 is the version verified working.
RUN --mount=type=tmpfs,target=/tmp repro-seal begin \
    && bun install -g @anthropic-ai/claude-code@2.1.224 \
    && repro-seal end

WORKDIR /workspace
COPY --from=src /src/app/ /
RUN --mount=type=tmpfs,target=/tmp repro-seal begin \
    && printf '#!/bin/sh\nexec bun run /app/fleet-cli.ts "$@"\n' > /usr/local/bin/fleet \
    && chmod +x /usr/local/bin/fleet \
    && repro-seal end

# Issue #335 (public-release scrub): a neutral, generic default for the
# image itself — server.ts's mountRepo() overrides this per-repo at runtime
# from FLEET_BOT_NAME/_EMAIL (real operator identity, config not code) the
# moment any studio actually checks a repo out; this only governs a git
# operation that somehow runs outside that path.
RUN --mount=type=tmpfs,target=/tmp repro-seal begin \
    && git config --global user.name  "fleetflare[bot]" \
    && git config --global user.email "fleetflare[bot]@users.noreply.github.com" \
    && git config --global --add safe.directory '*' \
    && git config --global credential.helper '!gh auth git-credential' \
    && repro-seal end

# Security (operator directive 2026-08-19): unlocks
# --dangerously-skip-permissions for claude running as root in this
# container (server.ts's runClaude argv) — verified live on pinned 2.1.224:
# root is refused without this var, accepted with it. Honest, not a
# workaround: this base image IS a Firecracker microVM. See runClaude's own
# comment for the full safety case (no Cloudflare creds in this container;
# merge/deploy gated by the Worker, not by claude's own prompts).
ENV IS_SANDBOX=1
# The image pins a claude version deliberately (every permission/gate probe in
# this fleet was verified against THAT build). claude's own auto-updater
# rewrites /usr/local/bin/claude underneath the container, which both defeats
# the pin and -- observed live 2026-08-20 -- can leave the binary without its
# exec bit: `-bash: /usr/local/bin/claude: Permission denied`, studio dead
# until someone chmods it by hand. Updating the pin is a Dockerfile change and
# a deploy, never a silent in-place swap.
ENV DISABLE_AUTOUPDATER=1
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "run", "/app/server.ts"]
