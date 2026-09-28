# Fleet Check CI Workflow

**Goal:** `apps/fleet` currently has no GitHub Actions workflow at all — nothing runs `bun run check` or `bun run test` on PRs/pushes that touch it. Add a workflow so regressions in the fleet worker are caught in CI instead of only locally.

**Scope:** One file: `.github/workflows/fleet-check.yml`. No changes to `apps/fleet/` itself (no package.json, no test files, no source), and no changes to the existing reporting workflows (`client-reports.yml`, `reporting-check.yml`).

## What the workflow does

Triggers on `pull_request` and `push`, both filtered to `apps/fleet/**`. One job, `ubuntu-latest`, `working-directory: apps/fleet`, with each step separate (no piping/chaining — a prior mistake here silently swallowed non-zero exits through `tail` and produced two false-green CI reports, so this is a hard requirement):

1. `actions/checkout@v4`
2. `oven-sh/setup-bun@v2`
3. `bun install`
4. `bun run check`
5. `bun run test`
6. `bun run bun-test`

No `continue-on-error`, no redirect-swallowing shells — any of the six steps failing fails the job.

## Known blocker — `bun-test` script does not exist yet

`apps/fleet/package.json` defines `dev`, `deploy`, `test`, `test:integration`, `test:acceptance`, `check`, `build:page`, `migrate:local`, `migrate:remote`. There is no `bun-test` script.

The intent (per the board task) is two test lanes:
- `bun run test` — vitest-pool-workers, 1575 tests, runs in workerd. No filesystem or child_process access, so it can only assert on the TEXT of `studio-bringup.sh`, not that the shell it emits actually runs correctly.
- `bun run bun-test` — meant to be ~80 tests that actually EXECUTE the emitted shell in containers, the only lane that would catch a broken hook. This is the lane this workflow is written for, per the task spec's literal step list.

Re-verified locally: grepping the repo for `bun:test` imports finds only `apps/fleet/test/studio.files.test.ts` and `apps/fleet/test/studio.studio-blueprint.test.ts` (plus `bun-types`/`vitest.config.ts` type references) — both excluded from the vitest run and both about blueprint file parsing, not shell execution in containers. So the container-execution test lane does not exist in this checkout yet.

This workflow calls `bun run bun-test` anyway, per the literal task spec — the step is expected to fail with `error: Script not found "bun-test"` until a follow-up task adds the script (and presumably the ~80 tests behind it). That failure is expected today, not a bug in this workflow.

**Follow-up (separate task, not this one):** add a `bun-test` script to `apps/fleet/package.json` and the container-execution test suite it should run.

## Verification run locally, from `apps/fleet`

- `bun install` — exit 0, installed 100 packages.
- `bun run check` — exit 0 (`tsc --noEmit` across 5 tsconfig projects, no output = clean).
- `bun run test` — vitest-pool-workers suite, see `.fleet/done.json` for exit code and output tail.
- `bun run bun-test` — exit 1, `error: Script not found "bun-test"` (expected, see blocker above).

YAML sanity-checked with `bun x js-yaml .github/workflows/fleet-check.yml`, parses cleanly with the triggers/paths/steps matching the spec.
