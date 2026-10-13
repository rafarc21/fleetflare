# Plan — fix #769: `.dev.vars` ambient-env leak breaks 7 github.webhook-core tests in studio containers

Task: https://github.com/rafarc21/fleetflare/issues/769
Branch: `fix-769-devvars-ambient-env`
Scope: bounded fix. Root cause pre-measured by the operator (issue body) and re-verified at source level in this session before planning.

## Root cause (traced to source, not guessed)

`@cloudflare/vitest-pool-workers` 0.19.1 (`parseCustomPoolOptions`, `dist/pool/index.mjs`) reads the wrangler config via `wrangler.unstable_getMiniflareWorkerOptions(wranglerConfig, ...)`. That calls `getBindings2` → `getVarsForDev(config.userConfigPath, envFiles, ...)`. `getVarsForDev` (wrangler `cli.js` ~185476) resolves `.dev.vars` against **the config file's own directory** and loads it UNCONDITIONALLY whenever `envFiles` is empty — the pool never forwards `envFiles`. The `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV` env flag gates only the `.env` fallback, NOT `.dev.vars` pickup, so there is no supported knob to disable it.

`wrangler.test.jsonc` sits at `apps/fleet/` — the same directory the operator's `.dev.vars` occupies in every studio container (untracked; written by test-integration/harness.ts and by normal `wrangler dev` convention). Every key in it merges into the vitest-pool-workers ambient test env as a `secret_text` binding.

Two failure surfaces, both from that one merge:

1. `test/github.webhook-core.test.ts:329` ("returns 503, not a throw, when the secret is unset") passes raw ambient `env` — the test's whole point is that `GITHUB_WEBHOOK_SECRET` is ABSENT from ambient env. Leaked key → signature check runs → 401 instead of 503.
2. The five alarm/window count tests + the push-wakes-nobody test assert on `sent` (a global fetch mock recording every fetch body the handler makes). `wrangler.test.jsonc` deliberately carries fake `GITHUB_APP_ID` / `GITHUB_INSTALLATION_ID` / `GITHUB_REPO_AUTH=acme-org=app` but NOT `GITHUB_APP_PRIVATE_KEY`, so `prepareAutoClose` (src/github/webhook.ts) always early-outs today (`assertConfigured` throws, swallowed). The leaked key completes the trio → `prepareAutoClose` proceeds → `mintInstallationToken` (src/github/app.ts, JSON POST body) and `getDefaultBranch` fetches land in the `sent` mock → every count is off by one.

local-ci never sees any of this: fresh-clone docker has no `.dev.vars`. That is why main stays green while every studio full-suite run fails.

This violates the repo invariant `vitest.config.ts` itself documents: `bun run test` must pass with zero operator config present — `.dev.vars` reintroduces exactly that class of dependence.

## Fix options considered

- (a) vitest.config.ts pins an explicit empty/override for the affected keys: per-key whack-a-mole, must grow every time a new secret name is added to `.dev.vars`; does not stop the ambient leak for every OTHER consumer of ambient env; the 503 test would need its key explicitly deleted, which contradicts what it is testing (ambient absence is the invariant under test).
- (b) Test file builds env per test instead of spreading ambient env: same per-suite whack-a-mole at the test layer; every future suite that spreads `env` re-imports the hazard.
- (c, CHOSEN) Make the `.dev.vars` lookup directory not be `apps/fleet/`: move `wrangler.test.jsonc` to `apps/fleet/test/wrangler.test.jsonc`. Wrangler resolves `.dev.vars` against the config's own directory, so the lookup then targets `apps/fleet/test/.dev.vars` — a path no operator workflow and no harness ever writes. Fixes the leak structurally, for every key present and future, with one move.

Option (c) is the issue's own "preferred if reachable" branch; it is reachable and is the only option that fixes the class, not the instances.

## Changes

1. `git mv apps/fleet/wrangler.test.jsonc apps/fleet/test/wrangler.test.jsonc` (preserves history). Config-relative paths inside it adjust one level up:
   - `"main": "src/index.ts"` → `"../src/index.ts"`
   - `"migrations_dir": "migrations"` → `"../migrations"`
   - each container `"image"`: `"./container/Dockerfile*"` → `"../container/Dockerfile*"`; `"image_build_context": "."` → `".."`
   - `"$schema"`: `"node_modules/wrangler/config-schema.json"` → `"../node_modules/wrangler/config-schema.json"`
   - extend the file's own header comment with the #769 reason for the move (the `.dev.vars` lookup dir is the config's own dir).
2. `apps/fleet/vitest.config.ts`: `configPath: "./wrangler.test.jsonc"` → `"./test/wrangler.test.jsonc"`; update the surrounding #329 comment to record the #769 reason (lookup dir ≠ `.dev.vars` dir).
3. Update stale location references: `apps/fleet/src/env.ts:21` comment, `apps/fleet/test/memory.store.test.ts:74` comment.
4. New pin test (TDD, RED before GREEN): a source-pin test asserting the config path used by vitest lives under `test/` — same "no filesystem in workerd" source-pin technique vitest.config.ts already uses for container/server.ts etc. Implemented as a bun test (`test/bun/`) that reads `apps/fleet/vitest.config.ts` text and asserts the `configPath` is `./test/wrangler.test.jsonc`, plus asserts `apps/fleet/wrangler.test.jsonc` no longer exists. A future move back to `apps/fleet/` fails the pin, which is the exact regression this fix exists to prevent.
5. No change to `.dev.vars.example`, `.gitignore`, harness.ts (DEV_VARS path stays `apps/fleet/.dev.vars` — that is `wrangler dev`'s own lookup dir for the real config, which is correct and untouched).

## Config-relative path safety (checked at source)

`normalizeAndValidateMainField` (wrangler cli.js ~20564) resolves `main` against `dirname(configPath)`; `image_build_context` similarly (cli.js ~22324). `migrations_dir` in the pool is not read from the config at all — `vitest.config.ts` reads `readD1Migrations(path.join(rootDir, "migrations"))` itself, unchanged — but adjusting it in the config keeps `wrangler d1` shape-consistent.

## Verification (one heavy gate at a time)

1. RED: pin test added first, run alone → fails against current layout (config still at `apps/fleet/`).
2. GREEN: after the move, pin test passes; `bun run test` full vitest suite green.
3. Leak repro (in this studio container, where the bug lives): write a dummy `apps/fleet/.dev.vars` with the five secret names (`GITHUB_WEBHOOK_SECRET=leaked-secret`, `TELEGRAM_BOT_TOKEN=x`, `TELEGRAM_WEBHOOK_SECRET=x`, `CLAUDE_CODE_OAUTH_TOKEN=x`, `CLOUDFLARE_DEPLOY_TOKEN=x`, plus `GITHUB_APP_PRIVATE_KEY` with a syntactically valid dummy PKCS#8 PEM), run `bun vitest run test/github.webhook-core.test.ts` → expect the 7 named failures at pre-move HEAD and green after the move; then run the full suite with the dummy file still present → green. Remove the dummy file after.
4. `bun run check` (all five tsc projects) green.
5. `bun test test/bun` green (includes the new pin test).
6. local-ci stays green by construction: fresh clone has no `.dev.vars`; the pin test is pure text/fs and passes there too.

## Out of scope

- Any change to `.dev.vars` handling in the real (ops-repo) deploy config or `wrangler dev` itself — the leak is test-only.
- Hardening other suites against ambient-env keys they don't declare — the move removes the ambient source for all of them at once.

## One-way door

`apps/fleet/wrangler*.jsonc` matches `ONE_WAY_GLOBS` in `apps/fleet/scripts/merge-danger.ts` — this PR is classified one-way by the path classifier regardless of the diff being effectively reversible via git.
