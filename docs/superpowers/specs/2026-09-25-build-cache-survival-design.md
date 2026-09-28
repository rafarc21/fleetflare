# Build-cache survival across container replacement — design (#115)

Status: DESIGN + MEASUREMENT. Implementation deferred on measured evidence; go conditions below.

## Problem as filed
demosite-life studios report cold vite builds of ~25-30 min after each container replacement (image window, recycle). Ask: persist build caches per studio in R2, restore at bring-up.

## Measurement (2026-09-25, demositeltda/demosite.life a6a37af, read-only clone)
Throwaway container per run: ubuntu 24.04, bun 1.3, node 22.12, `--cpus=4 --memory=8g`, `NODE_OPTIONS=--max-old-space-size=6144`, Mac docker. Under the gate lock.

| step | A cold container | B warm, same container | C replaced container, `.turbo` + bun cache restored |
|---|---:|---:|---:|
| `bun install --frozen-lockfile` | 41 s | 0 s | 16 s |
| `bun run typecheck` (turbo: beta + beta-embed) | 25 s | 2 s (2/2 cached) | 3 s (2/2 cached) |
| `turbo run build --filter=beta` | 42 s | 1 s (FULL TURBO) | 1 s (FULL TURBO) |

Candidate dirs and sizes:
| dir | size | survives replacement today |
|---|---:|---|
| `.turbo/cache` (root; per-package `.turbo` hold logs only) | 1 MiB | no |
| bun install cache (`BUN_INSTALL_CACHE_DIR`) | 3,112 MiB | no |
| `node_modules` | 3,164 MiB | no |
| `node_modules/.vite`, `apps/beta/node_modules/.vite`, `node_modules/.cache` | absent after build | — |

Earlier #115 comment (same harness, 5 repos): vite production builds write no persistent cache; build-cache gain 5-20%; install cache pays only for acme-org/websites (623 s cold).

### Hazard found: turbo replays an empty build
`apps/beta` is a react-router app: output goes to `apps/beta/build/`. Root `turbo.json` declares `build.outputs: ["dist/**", ".react-router/**"]` — `build/**` is missing. Measured: `.turbo` restored into a fresh container -> `turbo run build --filter=beta` = FULL TURBO in 0.7 s, and `apps/beta/build/` does NOT exist. Cold control (no restore) -> `build/` 46 MiB. Inside ONE container this bug is masked (build/ already on disk); carrying `.turbo` across containers exposes it. Restoring turbo cache for this repo today would make a green build produce nothing.

## Conclusions
1. The 25-30 min is not cache. The whole cold path here is ~108 s on 4 CPUs. Earlier measurement: two full vite builds each need > 4 GiB heap; inside an 11.65 GiB studio with the lead + parallel gates that is the memory ceiling (#104): swap, kill, crawl. A cache cannot recover that.
2. Worth-caching set for demosite.life = `.turbo` (1 MiB): saves ~22 s typecheck per replaced container. Unsafe until demosite.life adds `build/**` to turbo `outputs`.
3. Install cache saves ~25 s but is 3.1 GiB: needs a streaming route, not worth it for this repo.

## Design (to build when go conditions hold)
- **Opt-in per repo, default off.** Worker var `BUILD_CACHE_BY_REPO` (JSON, #271 pattern): `{"demosite-life": {"dirs": [".turbo"], "maxMiB": 16}}`. Keys = repo segment of studio id. `dirs` validated: relative, `[A-Za-z0-9._/-]`, no `..`, no leading `/` (they reach an exec string). Bad entry -> dropped + logged.
- **Object:** `build-cache/<studio-id>/latest.tar.gz` in `STUDIO_ARCHIVE`, with a manifest `{lockHash, dirs, bytes, sha256}`. Per studio (one lead writes it; no cross-studio write race). Staleness key: sha256 of the repo's lockfile(s) at save time.
- **Transport while small (<= maxMiB, hard cap 16 MiB):** reuse the session path (DO exec + base64 parts, `SESSION_TOTAL_MAX` heap budget #176). No image change, no new route. Anything bigger needs a Worker streaming route (container `curl` with spawn token -> Worker streams R2 body; never through the DO) — out of scope until a repo measures > 2 min saved.
- **Save:** on the sync tick, at most once per lockHash change or every 6 h, only if the tarball of configured dirs is <= maxMiB (else skip + one log).
- **Restore:** in `runProvision` / `runRestart` right after `runSessionRestore`, before bring-up. Only if manifest lockHash == current lockfile hash, and only into dirs that are ABSENT in the checkout (tar member list = missing dirs) — never over existing work. Failure = log, never degrade.
- **Prune:** one object per studio (overwrite); destroy leaves it (7-day R2 cost ~0); follow-up prune with sessions.

## Go conditions (maestro decides)
1. demosite.life fixes turbo `outputs` (`build/**` for apps/beta) — its repo, its PR. Without it, restore is harmful.
2. The cold-build complaint is re-measured IN a studio after #104-class memory fixes (serialized builds, explicit heap, bigger instance). If replaced-container cold time is then still dominated by typecheck/build that turbo would cache, build this (~1 day Worker-only).
3. A repo whose install is > 2 min cold (websites: 623 s) is the case for the streaming install cache — separate design.
