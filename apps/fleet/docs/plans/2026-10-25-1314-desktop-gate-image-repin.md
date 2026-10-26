# 1314 — detect+repin digest-pinned desktop gate image on Dockerfile change

## Root cause

`Dockerfile.gate-desktop` backs the `desktop` named image in `GateRunnerDO`'s
`images` map. The LIVE ops config pins `images.desktop` to digest form
`{ "image": "<ref>@sha256:..." }`. wrangler's `isRegistryImage()` treats that
as already-built (`pushOrResolveImage`): it never builds or pushes it, so a
`Dockerfile.gate-desktop` edit is invisible to `wrangler deploy` and the pin
goes stale (Sprint 3: Tauri deps missed, image 3e820487).

## Design (review r1)

Deploy never rebuilds/pushes/rewrites unattended. Image changes ship only in an
operator window; tools never edit the ops clone.

New `scripts/gate-desktop-image.ts`, pure decision + thin runner.

- **Default (DETECT ONLY, no docker):** hash `Dockerfile.gate-desktop` plus the
  files it COPYs, compare against a `dockerfile-sha: <64hex>` marker the
  operator records next to the pin in the ops config.
  - unchanged → exit 0, deploy continues silently
  - changed → print manual build/push/repin steps, exit 1 (deploy.sh refuses,
    distinct rc 75)
  - no docker: a Docker-less host still runs Worker-only deploys
- **Opt-in `--repin-desktop-image`:** build once, push through `wrangler
  containers push`, print the new digest. Never writes `FLEET_CONFIG` or the
  ops clone — the operator commits the pin bump.

## Wiring (deploy.sh, plain deploy only)

Consume `--repin-desktop-image` (never forwarded to wrangler). Plain deploy:
repin mode → build+push+print, refuse on failure; else detect-only → refuse on
change (rc 75). No `$(...)` capture around anything that runs wrangler; stdout
stays a TTY; build noise to stderr.

## Boundaries

deploy scripts + image pin config only. No gate runtime change. No pipes on
wrangler.