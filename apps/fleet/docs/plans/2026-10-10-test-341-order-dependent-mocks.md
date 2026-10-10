# Guard against order-dependent module mocks + file-count regression guard (board issue #341)

Issue #341 (re-scoped 2026-10-10): a test that passes only because an
alphabetically EARLIER file in the same run already mocked a dependency via
module-scope `mock.module(...)` proves nothing alone and breaks under
reordering, sharding or a solo run. Task has three parts: (1) solo-run
audit of every test file, (2) fix any order-dependent file found,
(3) cheap regression guard: CI asserts the 'across M files' count equals
test files on disk.

## Current state (recon, verified)

- `mock.module` is used in exactly ONE real place: `test/bun/orca-workspace.test.ts:2168-2178` — mocks `node:os` INSIDE a test body, restores in `finally` with a captured spread. `test-lies-check.test.ts` mentions it only inside string fixtures (detectors, not calls).
- vitest's 13 `vi.mock` files run in vitest-pool-workers; vitest isolates per file by default (each file gets fresh module registry) — verify empirically in the sweep, don't assume.
- No `.only` markers anywhere.
- `bun run bun-test` = `bun test test/bun test/studio.files.test.ts test/studio.studio-blueprint.test.ts` (130 + 2 files). Vitest = `test/**/*.test.ts` minus bun dir (178 files).
- test-lies-check.ts:517-521 counts `*.test.ts` files via its own `git ls-files` (minus ALLOWLIST) for the 'across M test files' line.
- Container: tmux 3.2a, chromium at /usr/local/bin/chromium, NO docker, node_modules installed, tsc 5.9.3 available.

## Tasks

### Task 1 — solo-run sweep (the audit, evidence only)
Sequential per-file runs, no parallelism, one heavy-gate budget shared:
- bun lane: `bun test <file>` for each of the 130 `test/bun/*.test.ts` + `test/studio.files.test.ts` + `test/studio.studio-blueprint.test.ts`, from apps/fleet. Record per-file exit code. Known-solo-issue (pre-verified, expected, NOT a finding): files needing TMUX unset (`env -u TMUX -u TMUX_PANE`), and any test that spawns docker-dependent suites already skips itself.
- vitest lane: `bun x vitest run <file>` per file across the 178 non-bun test files. Some workerd/D1 tests may be slow solo; per-file timeout 120s, record exit + first error line.
Compare solo exit vs in-suite: a file passing in suite but failing solo is a CANDIDATE. Triage candidates: mock-related failure (module import wins over mock registration, 'Unhandled error between tests') = real finding; env/docker skip = expected, not a finding.

### Task 2 — fix any real order-dependent file
If Task 1 finds one: minimal fix — move `mock.module` before the target module's import (dynamic `await import` after mock registration), or restore in `finally`. Characterization first: solo run red, fix, solo run green, suite green. If none found (recon suggests none), Task 2 is a no-op recorded as such — the issue says "Fix any that are order-dependent", conditional.

### Task 3 — file-count regression guard
Where the count lives: test-lies-check's 'across M test files' line (M = `git ls-files` `*.test.ts` minus its ALLOWLIST). Guard: a bun-test lane test asserting bun's OWN footer count matches files-on-disk for the bun lane, pinning: `bun test test/bun test/studio.files.test.ts test/studio.studio-blueprint.test.ts` footer 'Ran N tests across M files' M == number of `*.test.ts` files in that invocation's scope. New test file `test/bun/file-count-guard.test.ts`: runs the lane as a subprocess, parses footer, asserts. Cheap: one subprocess per CI run. TDD: write test, run red against a synthetic dropped file (temp dir), green on real repo.

## Boundaries
- Only `test/bun/file-count-guard.test.ts` (new) + any file Task 2 convicts. No other file changes.
- No changes to localci.sh, workflows, package.json, vitest.config.
- Targeted tests only. Solo sweep runs ONE file at a time — that is the one-heavy-gate rule by construction; no other gate may run during it.
- English only, conventional commits, fleet-studio identity.

## Verification
- Sweep result table (or summary) in the PR body.
- `bun run bun-test` green (the guard rides in it).
- `bun run check` green.
- If Task 2 convicted a file: its solo run green before PR.
