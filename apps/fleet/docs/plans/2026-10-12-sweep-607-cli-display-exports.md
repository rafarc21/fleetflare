# Plan — sweep 24 F9: CLI display types exported with no importer (#607)

Refs #588 (sweep doc docs/maintainability/2026-10-12-unused-exports-sweep-24.md,
S24-F9). Bounded: export-keyword drop only, no behavior change.

## Finding

Nine CLI type/const exports have zero importers — each greps to its own
file only (verified repo-wide at 2f4a77e). cli/fleet.ts imports from these
modules but never these names (it takes classifyInput/CTRL_V,
reapTerminalAll/TerminalPage, formatMemoryTable/MemoryFileRow,
sweepAllPages/SweepPage). Intercept is the return type of the IMPORTED
classifyInput, so callers see the type without importing it — the export
keyword is a convenience nobody took.

## Steps

1. Drop `export` on 9 names, all kept in-file:
   - cli/poll.ts:5 PollOpts (interface)
   - cli/readiness-format.ts:458 LsJsonRow (interface)
   - cli/recycle-outcome.ts:86 RecycleReport (interface)
   - cli/wip-format.ts:58 WipCheckEntry (type alias)
   - cli/input.ts:14 CTRL_RBRACKET (const), :17 Intercept (type alias)
   - cli/orca-workspace.ts:113 OrcaRun (type alias), :167 WorkspaceOutcome (type alias)
   - cli/junior.ts:20 JuniorPaths (interface)
2. Commit + push branch sweep-607-cli-display-exports.
3. Verify: tsc all 5 projects (root, container, cli, test-integration, test), targeted test files, english-check (one gate at a time).

## Verification

- cd apps/fleet && tsc --noEmit  (exit 0)
- cd apps/fleet && tsc --noEmit -p cli  (exit 0 — the compile pin: any hidden importer fails here)
- cd apps/fleet && tsc --noEmit -p test  (exit 0)
- cd apps/fleet && tsc --noEmit -p container  (exit 0)
- cd apps/fleet && tsc --noEmit -p test-integration  (exit 0)
- cd apps/fleet && flock /tmp/fleet-gate.lock bun run test test/cli.input.test.ts test/cli.recycle-outcome.test.ts test/cli.junior-sweep.test.ts (exit 0)
- cd apps/fleet && flock /tmp/fleet-gate.lock bun test test/bun/poll.test.ts test/bun/orca-workspace.test.ts test/bun/fleet-ls-wip.test.ts  (exit 0 — bun:test lane; vitest.config.ts excludes test/bun/**)
- cd apps/fleet && bun run english-check  (exit 0)

## Boundaries

- No test changes, no behavior changes, no new deps. One heavy gate at a
  time (vitest under flock). Review cap 2 rounds. No browser QA — no
  visual surface, compile-level change.
