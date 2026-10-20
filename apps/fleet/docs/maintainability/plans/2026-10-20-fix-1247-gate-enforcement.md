---
# fix #1247: gate enforcement — completed needs green merge, spawn needs gate config, gate protect verb

## What

Three enforcement gaps in the gate runner. All apps/fleet.

1. `fleet task state <n> completed` completes a task with no check that its
   PR merged green. Fix: for a gated repo (GATE_RUNNER_REPOS), the completed
   transition refuses unless the latest result envelope's PR is merged AND
   gate/verdict reads success on that PR's head sha. `--no-pr` (research/
   retro tasks) skips the check; the Worker logs a comment on the task.
2. `fleet spawn`/`ff` spawn a studio into a gated repo whose default-branch
   gate config has no valid gate block (today it silently skips, #1132).
   Fix: refuse with a message naming how to add one.
3. New verb `fleet gate protect <owner/repo>`: set branch protection on the
   default branch requiring status context gate/verdict
   (strict=false, enforce_admins=false). Idempotent, prints before/after.

## Fix

1. New pure module `src/board/completed-gate.ts`:
   `CompletedGatePort` = getPullRequest {merged}, getHeadSha, getCommitStatus
   (already gate/verdict-scoped). `completedGate(port, repo, pr)` -> ok, or
   409 "not merged" / "gate/verdict not success". `src/board/routes.ts` state
   action: when to=completed on a gated repo and no --no-pr, find the PR via
   showTask + latestResultPr, run the gate, refuse on 409. --no-pr writes one
   comment then transitions. `src/studio/cli-args.ts` + `cli/fleet.ts`:
   `--no-pr` flag on `task state`.
2. `src/studio/spawn.ts`: add `gatedRepos?: string[]` and
   `gateBlock?: (repoSlug) => Promise<GateConfig|null>` to SpawnDeps; pure
   `spawnGateConfigRefusal`; runSpawn refuses a gated repo whose gate block is
   null. `src/studio/routes.ts` spawnDeps wires gatedRepos from
   GATE_RUNNER_REPOS and gateBlock from loadGateConfig + fleetJsonReader.
3. New `src/gate/protect.ts` pure `runGateProtect` over `ProtectPort`
   (getDefaultBranch, getProtection, setProtection); github/api.ts
   getBranchProtection/setBranchProtection; route `/studio/gate/protect`;
   CLI `gate protect` verb in cli-args.ts + cli/gate.ts.

## TDD

- `test/board.completed-gate.test.ts`: merge+success ok; not-merged 409;
  missing/red status 409.
- `test/bun/spawn-gate-config.test.ts`: gated repo + no block refuses naming
  the fix; block present spawns; non-gated repo unaffected.
- `test/bun/gate-protect.test.ts`: idempotent before/after; first protect
  changes; no-op when already matching.
- `test/studio.cli-args-verbs.test.ts`: `--no-pr` and `gate protect` parse.
- Route wiring: board.routes.test.ts injects completedGatePort; gate-routes
  test for protect.

## Boundaries

apps/fleet/cli, apps/fleet/src/board, apps/fleet/src/gate,
apps/fleet/src/studio/{spawn,routes}.ts, apps/fleet/src/github/api.ts, tests.
No container/.

## Verify

`cd apps/fleet && bun test test/bun/gate-config.test.ts test/bun/gate-protect.test.ts
test/bun/spawn-gate-config.test.ts`, then targeted vitest files one at a time,
then `bun run check` last.
---