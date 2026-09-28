FROM oven/bun:1.3-debian

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Pinned. The auth gate and the JSON contract in server.ts are written
# against this CLI's output shape; a floating install would change both
# with zero diff to review. 2.1.224 is the version verified working.
RUN bun install -g @anthropic-ai/claude-code@2.1.224

WORKDIR /workspace
COPY server.ts /app/server.ts
COPY fleet-cli.ts /app/fleet-cli.ts
RUN printf '#!/bin/sh\nexec bun run /app/fleet-cli.ts "$@"\n' > /usr/local/bin/fleet \
    && chmod +x /usr/local/bin/fleet

# Issue #335 (public-release scrub): a neutral, generic default for the
# image itself — server.ts's mountRepo() overrides this per-repo at runtime
# from FLEET_BOT_NAME/_EMAIL (real operator identity, config not code) the
# moment any studio actually checks a repo out; this only governs a git
# operation that somehow runs outside that path.
RUN git config --global user.name  "fleetflare[bot]" \
    && git config --global user.email "fleetflare[bot]@users.noreply.github.com" \
    && git config --global --add safe.directory '*' \
    && git config --global credential.helper '!gh auth git-credential'

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
