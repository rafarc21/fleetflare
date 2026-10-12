# Plan — #493: test cmdTaskReap's two print loops (S11-F5)

## Scope
Bounded, tests only. One new bun-lane test file; no src changes. Refs #467, sweep 11 doc `docs/maintainability/2026-10-12-cli-coverage-sweep-11.md` finding S11-F5.

## Why
`reapTerminalAll` the pagination helper is covered (test/cli.reap-terminal.test.ts), but `cmdTaskReap` (cli/fleet.ts:1899) prints through two untested loops — the terminal half's header/empty/per-result/N-left lines and the plain half's header/empty/skipped-vs-PR lines.

## Test design
`apps/fleet/test/bun/cli.task-reap.test.ts`: a real `Bun.spawn` of cli/fleet.ts against a local `Bun.serve` answering POST /studio/board/tasks/reap (accounts-cli.test.ts's pattern). Temp HOME holds the credentials; spawn cwd is that same temp HOME, so `detectRepo` finds no git origin — the POST body carries no `repo` key (Worker's own default stays the single fallback source) and `reportRepo` prints the fallback line on stderr.

Four runs, each asserting exit 0 and exact lines:
1. `task reap --terminal` (dry-run): closed + error results, remaining 3 → per-result lines, the N-left line, exactly one POST.
2. `task reap --terminal --dry-run`, empty page → the "(no open issue in a terminal state)" line, never the N-left line.
3. `task reap --apply` (plain): skipped + would-close + closed results → header with defaultBranch, skipped line shape, PR line shape.
4. bare `task reap`, empty results → the "(no open tasks)" line.

## TDD / mutation
Test passes against current source; mutation check: temporarily break one print template (change `as ${r.reason}` to `— ${r.reason}` in cli/fleet.ts:1912) → test fails; revert, green. Mutation is never committed.

## Verification
- `cd apps/fleet && bun test test/bun/cli.task-reap.test.ts` green (initial + after revert)
- `cd apps/fleet && bun run english-check`
- `cd apps/fleet && bun run check`
Full suite belongs to CI.
