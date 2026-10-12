# Plan — #424: flaky studio-tmux-socket.test.ts:220 + timing-dependent test sweep

## Scope
Bounded: one test-side flake fix + one sweep doc. No production code changes.

## The flake (root-caused)
`studio-tmux-socket.test.ts:220` sets `CLAUDE_ALIVE_TRIES=8`. `claude_launch_landed` polls pane command 8x at 1s. Under CI load, fork+exec of the fake lead exceeded the ~8s window: every probe read `bash`, the poll failed, `claude_launch` fired its ONE retry, and the test's `not.toContain("retrying")` assertion failed. Production is unaffected (default 20 tries; the retry landing is by design). Fix: test gets the production 20-try budget — still asserts no retry, still a test seam.

Mutation-verified: bypassing the shadow on the first send (`command tmux send-keys`) fails the test as intended with 20 tries.

## Sweep doc
`docs/maintainability/2026-10-12-flaky-tests-sweep-8.md` — max 10 findings, timing-dependent tests, each: file:line, why flaky, proposed fix. Follow-up fixes filed as separate issues by the lead.

## Verification (targeted only)
- `bun test test/bun/studio-tmux-socket.test.ts` x4 green
- Mutation check: RED as described above, then reverted
- `bun run english-check`
- `bun run check` (typecheck)
Full suite belongs to CI.
