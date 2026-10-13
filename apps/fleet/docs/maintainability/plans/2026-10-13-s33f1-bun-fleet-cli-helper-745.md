# S33-F1: bun CLI trio -> bun/helpers/fleet-cli.ts (refs #733, refs #745)

## What

7 bun-lane CLI suites copy the same three-part setup. Extract to one helper:
`apps/fleet/test/bun/helpers/fleet-cli.ts` exporting:

- `FLEET` — `join(import.meta.dir, "../../../cli/fleet.ts")` (helper sits one
  level deeper than the suites, so three `..`, not two).
- `tmpDir(prefix)` — mkdtempSync under os.tmpdir(), pushed on one module-level
  `tempDirs` stack.
- `cleanupTempDirs()` — the shared afterEach body: pops and rmSyncs the stack.
  Exported as a plain function so each suite wires `afterEach(cleanupTempDirs)`
  itself (bun:test's afterEach registered at import time in a helper would fire
  per-module, not per-suite — the suite keeps the hook).

## Sites (trio verbatim in each)

accounts-cli.test.ts:19,22 · cli.task-verify.test.ts:31,34 ·
memory-cmd.test.ts:18,21 · cli.task-reap.test.ts:17,24 ·
paste-cmd.test.ts:17,26 · paste-mac.test.ts:23 (FLEET const there is
PASTE_MAC, same join shape — tmpDir trio only) · task-state-cli.test.ts:17,20

Cousins NOT folded (per task): cli-check-clear-guard.test.ts, cli-destroy-unmerged.test.ts.

## Steps (TDD)

1. RED: helper file + refactor ONE suite (task-state-cli, smallest) to import
   it; delete the local trio. `bun test test/bun/task-state-cli.test.ts` proves
   the helper resolves FLEET correctly (a wrong `..` count fails every spawn).
2. GREEN: refactor the remaining 6 suites the same way.
3. `bun run bun-test` on the 7 touched files; english-check; test-lies-check;
   `tsc --noEmit -p test`.

## Boundaries

- Test files + new helper only. No src/, cli/ (runtime), container/ changes.
- paste-mac.test.ts keeps its local `PASTE_MAC` path (points at
  ../../cli/paste-mac, not fleet.ts) — only its tmpDir trio moves.
- One heavy gate at a time: bun-test runs under flock.

Estimated ~60 lines removed.
