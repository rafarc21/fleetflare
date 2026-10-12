# Plan — S11-F4: behavioral tests for `fleet task state`'s real fetch halves (refs #492)

Sweep 11 finding S11-F4 (refs #467). Tests only — cli/fleet.ts untouched.
Covers the 4 untested slices of taskStateFetchCurrent/Transition (cli/fleet.ts:1825,1845) — no-label 409 + `--from-none` hint, "no single state label back" 500, both !res.ok slices — plus a happy control.

## Steps

1. `test/bun/task-state-cli.test.ts` — accounts-cli.test.ts's pattern: Bun.spawn of cli/fleet.ts, Bun.serve stand-in, temp HOME+cwd (no git → no `?repo=`). 5 cases: happy control (exit 0, before -> after, POST body `{from,to}`); no-label 409 (labels named, hint `fleet task state 12 <to> --from-none`, POST never reached); GET !res.ok (body verbatim); POST 200 null state (500 message); POST 409 stale-from (verbatim).
2. RED check: one mutated assertion fails, then restore.
3. Commit, push, PR refs #492 (no closing keyword).

## Verification

- `bun test test/bun/task-state-cli.test.ts` — all pass
- `bun run test-lies-check` — 0 findings

## Out of scope

cli/fleet.ts changes; task-state.ts core (already covered); vitest-lane re-covering.
