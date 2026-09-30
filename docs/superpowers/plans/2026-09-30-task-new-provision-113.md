# `fleet task new --provision [--fresh-session]` (board issue #113 ask 9)

## Problem

`fleet task new` files a board task (a GitHub issue) via the Worker's
`POST /studio/board/tasks`, and `fleet provision <id> [--fresh-session]`
separately `POST`s `/studio/:id/provision` to boot or heal a studio
container. Filing a task against a STOPPED studio has always succeeded and
printed "NO WAKE" (`apps/fleet/cli/task-format.ts`, `reportAssignWake` in
`apps/fleet/cli/fleet.ts`) because nothing provisions the studio — a human
has always had to run a second `fleet provision <id>` by hand. The reaper
often stops a studio seconds before its next task lands, so this has been a
routine paper-cut for a fleet coordinator. This task lets
`fleet task new --provision [--fresh-session]` do both in one call.

## Design

**Grammar (`apps/fleet/src/studio/cli-args.ts`).** `--provision` and
`--fresh-session` are two more bare booleans on `task new`, extracted in the
exact same argv-walking loop `--junior` already uses (`parseTask`'s `sub ===
"new"` branch): a token that IS one of `TASK_FLAGS.new`'s value-taking flag
names still claims the very next token as ITS value first, so a value that
happens to equal the literal string `"--provision"` (e.g. `--boundaries
--provision`) is never mistaken for the bare flag — the same protection
`--junior` already gets, reused rather than reimplemented.

Two validations run after the brief is fully assembled, in this order:

1. `--fresh-session` without `--provision` refuses
   (`fleet task new --fresh-session needs --provision`) — `--fresh-session`
   only ever means something as a provision modifier, exactly as it does for
   `fleet provision`/`fleet recycle`.
2. `--provision` given but the brief carries neither `--studio` nor
   `--continues` (`brief.assignee === undefined && brief.continues ===
   undefined`) refuses (`fleet task new --provision needs --studio or
   --continues (nothing to provision)`) — an unassigned task has no studio id
   to provision, and this is caught at parse time rather than as a runtime
   surprise after the issue is already filed.

**Return shape.** `provision`/`freshSession` are OPTIONAL fields present ONLY
when true, never `false`: `return provision ? { cmd: "task-new", brief,
provision: true as const, ...(freshSession ? { freshSession: true as const }
: {}) } : { cmd: "task-new", brief };`. This keeps every pre-existing test
that does `toEqual({ cmd: "task-new", brief: {...} })` (no other top-level
keys) passing unmodified for a plain `task new`.

**Wiring (`apps/fleet/cli/fleet.ts`).** `cmdTaskNew` takes two more
parameters, `provision = false` and `freshSession = false`. After it files
the task and calls the existing `reportAssignWake(task)`, when `provision`
is true: if the Worker's own assignment (`task.assignee`, `BoardTask
.assignee: string | null`) is `null`, print
`fleet task new --provision: task has no assignee — nothing to provision` to
stderr and exit 1 (defensive — parse-time validation already refuses a brief
with no target, but the Worker's own assignment resolution is out of this
CLI's control); otherwise call the EXISTING, already-shipped `cmdProvision(
creds, task.assignee, freshSession)` unchanged — no Worker route was
touched, `/studio/:id/provision` is reused as-is. The dispatch site (`case
"task-new"`) passes `parsed.provision === true, parsed.freshSession ===
true`.

**Help text.** `VERBS["task-new"]` (the ONE table `CLI_USAGE` and
`fleet help` both render from) gets `[--provision [--fresh-session]]`
appended to `args`, and one sentence appended to `summary` explaining what
`--provision` does, that it needs `--studio` or `--continues`, reusing the
shared `FRESH_SESSION_HELP` prose (the same text `provision`'s and
`recycle`'s own help entries already carry) for the fresh-session half.

## Files touched

- `apps/fleet/src/studio/cli-args.ts` — `CliCommand`'s `task-new` variant
  gains `provision?: true; freshSession?: true`; `parseTask`'s bare-boolean
  extraction loop gains `--provision`/`--fresh-session`; the two usage-error
  validations; `VERBS["task-new"]`'s `args`/`summary` updated.
- `apps/fleet/cli/fleet.ts` — `cmdTaskNew` takes `provision`/`freshSession`
  params and calls the existing `cmdProvision` after filing when
  `provision` is true; the `case "task-new"` dispatch site passes the two
  new fields through.
- `apps/fleet/test/studio.cli-args.test.ts` — RED-then-GREEN coverage (see
  Verification below).
- This plan doc.

Untouched deliberately: no Worker route (`src/studio/routes.ts`) — the
existing `/studio/:id/provision` route is reused as-is via `cmdProvision`,
which was already shipped and already tested in practice; this is a
pure CLI-side orchestration change. `cli/fleet.ts` itself carries no direct
unit test — it has genuine Bun-only globals (`Bun.file` et al. inside
`loadCredentials`) that only type-check under `cli/tsconfig.json`'s own
`"bun"` types, not this repo's root `tsconfig` (`workers-types`); this is a
deliberate, pre-existing boundary (see that test file's own header comment
in `apps/fleet/test/cli.fleet.test.ts`), not something this task tried to
work around.

## Verification

RED-then-GREEN, `apps/fleet/test/studio.cli-args.test.ts`
(`describe("parseCliArgs: task", ...)`):

- `--studio x --provision` → succeeds, exact object equality:
  `{ cmd: "task-new", brief: {...assignee: "x"}, provision: true }` — no
  `freshSession` key at all (catches an accidental `freshSession: false`
  leaking in).
- `--continues 7 --provision` → succeeds, `provision: true` (`--continues`
  alone satisfies the "has a target" check).
- `--studio x --provision --fresh-session` → succeeds, both `provision: true`
  and `freshSession: true`.
- `--fresh-session` alone (no `--provision`) → usage error, message contains
  `--provision`.
- `--provision` alone (no `--studio`, no `--continues`) → usage error,
  message contains `--studio` and `--continues`.
- `--boundaries "--provision"` → the value slot, not the bare flag: stays
  `boundaries: "--provision"`, `provision` stays undefined (mirrors the
  existing `--boundaries "--junior"` test proving the same protection for
  `--junior`).
- Plain `task new` (no `--provision`/`--fresh-session` at all) → exactly
  `{ cmd: "task-new", brief: {...} }`, no `provision`/`freshSession` keys —
  regression pin alongside the two pre-existing tests (lines ~267–276, ~280)
  asserting the same shape.

Commands actually run, in this order, one at a time
(`flock /tmp/fleet-gate.lock <cmd>` for the full-suite gates), from
`apps/fleet/`:

1. Targeted RED run before implementing (confirmed 4 of the new assertions
   failing, 103 pre-existing passing):
   `bun x vitest run test/studio.cli-args.test.ts` → `4 failed | 103 passed
   (107)`.
2. Same command after implementing:
   `bun x vitest run test/studio.cli-args.test.ts` →
   ```
    Test Files  1 passed (1)
         Tests  107 passed (107)
   ```
3. `bun run check` (five `tsc --noEmit` passes across the repo's tsconfigs)
   → exit 0, no output (clean).
4. `bun x vitest run` (full suite) → exit 0:
   ```
    Test Files  146 passed (146)
         Tests  5106 passed (5106)
      Duration  189.61s
   ```
5. `bun run bun-test` (`bun test test/bun test/studio.files.test.ts
   test/studio.studio-blueprint.test.ts`) → exit 1:
   ```
    2051 pass
       2 skip
       7 fail
    5667 expect() calls
   Ran 2060 tests across 107 files.
   ```
   All 7 failures are in `test/bun/deploy-ops-guard.test.ts` (6) and
   `test/bun/localci.sh`'s own SIGTERM test (1), NONE of which this task's
   diff touches (`git diff --stat` against this branch's base confirms no
   change to those files or to `scripts/deploy.sh`/the git wrapper).
   Root cause, confirmed by re-running `deploy-ops-guard.test.ts` alone and
   reading the error: this container's own globally-installed
   `/usr/local/bin/git` wrapper (issue #253, `fleet: studios never push the
   default branch — open a PR`) refuses the test's OWN fixture `git push -q
   origin main` calls against its own throwaway local `origin` remote — the
   wrapper cannot distinguish a test fixture repo from a real one, and
   blocks any push to a branch literally named `main` regardless of which
   repo. This is a pre-existing interaction between this specific
   studio-container environment and that test file, reproducible on a clean
   checkout of `main` with no relation to `--provision`; it is not a
   regression from this task's diff and out of this task's scope to fix.
6. `bun run english-check` → exit 0: `english-check: clean`.

## Push discipline

Pushed after the RED commit (`55b97b9`) and again after the GREEN commit
(`4affc0f`); both landed on `origin/task-113-task-new-provision` (confirmed
via `git log origin/main..FETCH_HEAD --oneline` — this repo's `origin`
remote fetch refspec is restricted to `main` only, so the feature branch's
own ref has to be fetched explicitly by name before it is comparable).
