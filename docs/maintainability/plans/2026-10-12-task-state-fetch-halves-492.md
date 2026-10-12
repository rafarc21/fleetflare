# Plan — S11-F4: behavioral tests for `fleet task state`'s real fetch halves (#492)

Sweep 11 finding S11-F4 (refs #467). Tests only — cli/fleet.ts untouched.

## Gap

`taskStateFetchCurrent` (cli/fleet.ts:1825) and `taskStateFetchTransition` (:1845)
are the real-I/O halves behind `fleet task state`. The pure core
`runTaskStateTransition` is tested with injected fetches
(test/studio.task-state.test.ts:24); the real halves are not:

- fetchCurrent's no-single-state-label 409 (:1833-1840) — names the labels,
  prints the `--from-none` repair hint (the operator's only repair instruction
  for an interrupted transition)
- fetchCurrent's `!res.ok` slice (:1831)
- fetchTransition's "wrote the transition but returned no single state label
  back" 500 (:1855-1859)
- fetchTransition's `!res.ok` slice (:1853)

## Approach

One new bun-lane file, `test/bun/task-state-cli.test.ts`, following
test/bun/accounts-cli.test.ts's real-subprocess pattern: `Bun.spawn` of
cli/fleet.ts, a real `Bun.serve` stand-in for the Worker, a temp HOME with a
synthetic credentials file. No vi.mock, no source-reading — behavioral.

Test cases:

1. **Happy control**: GET /studio/board/tasks/12 answers `{task:{state:"working"}}`,
   POST answers 200 `{state:"completed", ...}` → exit 0, stdout
   `task #12: working -> completed`.
2. **fetchCurrent 409**: GET answers `state: null`, labels `["urgent","bug"]` →
   exit 1, stderr carries the full message: labels named, `--from-none` hint
   (`fleet task state 12 completed --from-none`), the "no from this CLI can
   read" clause. POST never called (stand-in 500s if hit).
3. **fetchCurrent !res.ok**: GET answers 500 "board upstream failed" → exit 1,
   stderr carries the first 500 chars of that body verbatim after the
   `fleet task state: ` prefix.
4. **fetchTransition 500**: GET answers `state:"working"`, POST answers 200
   with `state: null` → exit 1, stderr carries "wrote the transition but
   returned no single state label back" verbatim.
5. **fetchTransition !res.ok**: POST answers 409 with the route's stale-from
   message → exit 1, stderr carries it verbatim (the byte-identical contract
   end to end through the real fetch).

Temp cwd (no git repo) so `detectRepo` reports "using the fleet's default
repo" and `repoQuery` stays empty — cmdTaskState runs `detectRepo()` against
the spawn's cwd, so pass an empty temp dir as cwd to keep the test hermetic.

## Steps

1. Write test/bun/task-state-cli.test.ts with the 5 cases above.
2. RED check: temporarily assert one wrong expected string, confirm the run
   FAILS, then restore the exact assertion and confirm GREEN.
3. Commit, push branch after first commit.
4. `bun run test-lies-check` + `flock /tmp/fleet-gate.lock bun run check`.

## Verification

- `bun test test/bun/task-state-cli.test.ts` — all cases pass
- `bun run test-lies-check` — 0 findings
- `flock /tmp/fleet-gate.lock bun run check` — all 5 tsc projects exit 0

## Out of scope

- cli/fleet.ts changes (none — tests only)
- task-state.ts core (already covered)
- vitest-lane re-covering of the same slices
