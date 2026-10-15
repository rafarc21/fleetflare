# Sweep 49 — vitest per-file setup cost (refs #992, refs #715)

CI (98 green runs, #715 comment 6188308109): vitest setup totals 403-524s
against 74-86s of tests — about 2.0-2.7s fixed cost per file, 81-83% of all
vitest work, 208 files. This sweep finds what that cost is and what would
shrink it. All timings measured locally in the studio container (bun 1.3.12,
vitest 4 / vitest-pool-workers 0.19.1, `vitest run <one file>
--reporter=verbose`, Duration line of vitest's own summary).

## Baseline measurements

| File | Duration | transform | setup | tests |
|---|---|---|---|---|
| test/board.envelope.test.ts (53 tests) | 10.13s | 4.14s | 8.15s | 32ms |
| test/board.leak.test.ts (18) | 7.46s | 3.17s | 6.05s | 32ms |
| test/studio.burn.test.ts (141) | 72.35s | 3.26s | 5.94s | 64.96s |
| test/agents.do.test.ts (20) | 6.82s | 2.83s | 5.55s | 179ms |

`setup` is vitest-pool-workers' workerd-isolate boot + setupFiles, not
counted inside `tests`. `Duration` excludes pool startup too: a single-file
run's wall clock is ~2.4-3.5s higher than its Duration (envelope: 10.13s
Duration, 13.6s real). CI's "2.0-2.7s per file" is the floor amortized
across ~2.4 effective parallel workers.

## Findings

### F1 — workerd isolate boot per test file is the floor (structural)

vitest.config.ts:11 mounts `cloudflareTest({...})` with no pool tuning. The
pool's model: each test file runs in a fresh workerd isolate — isolated
per-file storage is the package's core guarantee. Measured floor: `setup`
5.5-8.2s per file on all four files even when `tests` is 32ms. Isolate boot,
worker script transformation and binding construction happen per file before
any test runs.

- Proposed change: none within vitest-pool-workers (isolation IS the
  product). The lever is #715's shard runner: balance shards by measured
  per-file time (Task 8's parseVitestTimings) and one vitest invocation per
  shard leg so the pool boot amortizes inside the leg.
- Expected saving: n/a — this is the floor other findings sit on.
- Isolation risk: none (no change proposed).

### F2 — D1 migrations re-applied in every isolate (test/apply-migrations.ts:8)

`await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` runs as the
setupFile for every test file (vitest.config.ts, setupFiles line). The
migrations are read once on the Node side and passed as a binding, but the
APPLY is per-isolate: with N test files the D1 schema is built N times.
Files that never touch env.DB pay it too.

- Proposed change: gate the apply on a cheap presence check — `SELECT name
  FROM sqlite_master` for the latest migration tag, apply only when absent.
  Keeps per-isolate semantics, makes the apply idempotent-cheap.
- Expected saving: part of the 5.5-8.2s setup; measure by timing
  apply-migrations inside one isolate before/after.
- Isolation risk: LOW (presence-check only, storage still per-isolate);
  HIGH if a shared DB crossed isolate boundaries — do not share storage.

### F3 — 24 source files read at config load, per pool boot (vitest.config.ts:28-108)

The Node-side config reads 24 files (migrations, container/server.ts,
studio-bringup.sh, both Dockerfiles, studio-fleet, three do.ts sources,
sandbox-api.ts, survival-delivery.ts, terminal.template.html, cli/fleet.ts,
blueprint fleet.json + roles + org.json + README, three gates/*.sh) and
binds each as a TEST_* string. Cost is once per pool boot, amortized across
files in one run — but every single-file `vitest run` and every #715 shard
leg pays it in full, inside `transform` (measured 2.83-4.14s).

- Proposed change: none for full-suite CI (one boot). For #715: one
  `--shard` invocation per shard leg, never one invocation per file.
- Expected saving: transform collapses toward ~1s per invocation.
- Isolation risk: none.

### F4 — bun shim startup on every invocation (package.json "test" script)

`bun run vitest run <file>` pays bun's bin resolution + node shim startup
(~0.3-0.5s) before vitest starts; CI runs the same way.

- Proposed change: none (portability beats ~0.4s). Noted so nobody
  "optimizes" this by hardcoding a node path.
- Expected saving: ~0.4s per invocation.
- Isolation risk: none.

### F5 — the real lever for #715: duration-balanced shards, not setup micro-tuning

Even if F2 saved its whole setup cost, the per-file floor stays ~5s+; CI's
amortized 2.0-2.7s already reflects parallelism. The gate-runner model
(#715 comment 6188308109: vitest 8 shards, 67s slowest-shard floor at N=8)
is right: pack shards by measured per-file Duration, keep one vitest
invocation per leg so F1's pool boot and F3's config reads amortize inside
the leg. This sweep's only shippable in-repo change is F2's
presence-check; everything else is shard-runner design already in the plan.

- Proposed change: none beyond the existing #715 plan.
- Expected saving: n/a (design confirmation).
- Isolation risk: none.

## Non-findings (checked, not causes)

- `environment: 0ms` everywhere — no jsdom/happy-dom per-file browser env.
- `import` 38-214ms — no pathological top-level import chain in test files.
- `fetchMock` (vitest.config.ts) is pool-level, not per-file.
- wrangler.test.jsonc DO/container bindings are miniflare-fabricated;
  containers are never booted in tests (container-backed DOs are
  source-pinned instead — vitest.config.ts:28-108's comments).

## Issues filed

- test(GLM-OK): S49-F2 D1 migrations presence-check before per-isolate apply
  (refs #992, #715)
