---
# S47-F4 heartbeat cached stubs — rmSync in afterAll (refs #965, refs #944, refs #715)

`bringup-heartbeat-core.test.ts` caches two mkdtemp'd stub dirs at module
scope: `cachedFakeClaude` (holds `dir/claude`, a bash copy) and
`cachedTmuxStubDir` (holds `dir/tmux`). Nothing ever rmSyncs them, so a solo
run leaks two tmpdirs per process; a shard retry can return a cached path
whose dir was reaped, failing the stub spawn.

## Change
- `test/bun/bringup-heartbeat-core.test.ts` only. Add an `afterAll` that
  rmSyncs both dirs (`dirname(cachedFakeClaude)` for the binary — the cache
  stores the file path; the tmux cache stores the dir directly), force +
  recursive. Add `afterAll` to the `bun:test` import and `dirname` to the
  `node:path` import. No other files. No src/, cli/, container/.

## Steps (TDD)
1. Plan doc commit + push.
2. RED (unmodified): run the file solo, then list tmpdir for
   `fleet-fake-claude-*` / `fleet-fake-tmux-*` — two leaked dirs present.
3. GREEN: add afterAll cleanup; same run + list — no leaked dirs.

## Verify (sequential, one gate at a time)
- `bun test test/bun/bringup-heartbeat-core.test.ts` — all pass.
- leak check: no `fleet-fake-claude-*` / `fleet-fake-tmux-*` dirs remain in tmpdir after a run.
- `npx tsc --noEmit -p test` — exit 0.
- `bun run english-check` — clean.

## Boundaries
- One test file only. No src/, cli/, container/. No closing keywords for #944/#715.
---