# Plan — S19-F2: reap close failures get their own outcome + `reap --terminal` exit 1 (refs #546)

Sweep 19 finding F2 (refs #539). Two defects, one outcome value: runTaskReap (src/studio/task-reap.ts:189) folds a close that threw or answered ok:false into `skipped` — same word as a deliberate park — and cmdTaskReap's --terminal branch (cli/fleet.ts:1916) always exits 0, so a batch of failed closes prints as handled with a green exit.

## Changes

1. task-reap.ts: a real close failure (thrown deps.close, or ok:false) reports `outcome: "failed"` + prNumber, not `skipped`. Deliberate/evidence skips keep `skipped`.
2. cli/fleet.ts --terminal print loop: after printing, `process.exit(1)` when any row outcome is `error` (closeTerminalTasks' failure word — board.ts TerminalCloseOutcome, issue #55). Dry pages never carry error rows; deliberate skips stay 0.
3. cli/fleet.ts non-terminal loop: failed rows print `#N (PR #P): failed — <reason>`; exit stays 0 there (Worker-side policy, sweep scoped out).

## Verification

- vitest: test/studio.task-reap.test.ts + test/board.routes.test.ts (99-shape pin flips to failed)
- bun: test/bun/cli.task-reap.test.ts (new exit-1 case + failed-line case)
- `cd apps/fleet && bun run check` (one heavy gate, alone)
