# THROWAWAY Task 0a spike image. Baseline = apps/fleet at a pinned main SHA, bun install done.
# Base image digest reused from apps/fleet's own Dockerfile (oven/bun:1.3-debian).
FROM oven/bun:1.3-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f

# bun (base) + node + git. unshare/free/nproc/df come from util-linux, procps, coreutils (base).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates nodejs util-linux procps \
    && rm -rf /var/lib/apt/lists/*

# Pinned main SHA of the public repo. Only apps/fleet is copied into the baseline.
ARG FLEET_SHA=3e8ef2ad42a3ef4ce39bf57f167d07141195806d
RUN git init -q /src \
    && git -C /src remote add origin https://github.com/rafarc21/fleetflare \
    && git -C /src fetch -q --depth 1 origin "$FLEET_SHA" \
    && git -C /src checkout -q FETCH_HEAD \
    && mkdir -p /baseline \
    && cp -a /src/apps/fleet /baseline/fleet \
    && cd /baseline/fleet && bun install --frozen-lockfile \
    && rm -rf /src

WORKDIR /baseline/fleet
# Container idles; all work runs via ctx.container.exec().
CMD ["sleep", "infinity"]
