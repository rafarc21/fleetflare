# task new: warn on path overlap with open PRs/tasks (issue #112)

Board issue #70 ask 8's own gist, verbatim: "Two coordinators overlapped on
the same helper script (two PRs fixing one thing, one wasted). Ask: `task
new` warns when the brief's paths overlap files touched by open PRs / open
tasks (a lightweight path-claim check)."

## Design

**Pure module, `src/board/path-overlap.ts`** — same house style as
`src/board/brief.ts` (pure, no I/O, unit-tested directly):

- `extractPaths(text)` — a loose regex pulling path-looking tokens (at least
  one `/`, letters/digits/`._-` per segment) out of free text, deduped.
  Deliberately loose per the ask's own wording ("lightweight path claim") —
  a false positive costs one warning line a human reads and ignores; a false
  negative silently misses the whole point of the ask. Erring toward
  matching is therefore the correct default, not a shortcut.
- `findPathOverlaps(briefPaths, prClaims, taskClaims)` — exact-string
  overlap only, no fuzzy/prefix matching. Also explicitly lightweight per
  the ask ("a lightweight path-claim check") — a prefix match would need a
  real path-containment model (is `apps/fleet/src` a claim on
  `apps/fleet/src/board/board.ts`?) that this check has no business
  answering; exact-string keeps the false-positive rate low without that
  complexity.
- `formatPathOverlapWarnings(overlaps)` — one human-readable line per
  overlapping path, naming every PR/task number that also touches it.

**GitHub read, `github/api.ts`'s new `listOpenPullFiles`** — reuses the
existing `listOpenPullNumbers` (one page, GitHub's own 100 max, same
"a PR count bigger than that is out of scope" posture that function's own
comment already states) and asks each PR's changed files
(`GET .../pulls/{n}/files?per_page=100`, one page per PR, same posture).
Same `ghJson`/`GH_HEADERS` helpers and the same "GitHub's own words on any
non-2xx, token never in the message" convention as every other function in
that file.

**Wiring, `board.ts`'s `createTask`** — a new private helper
`pathClaimWarnings(api, repo, brief, selfNumber)`:

- Extracts paths from `[title, objective, outputFormat, boundaries].join`.
  Empty → returns `[]` immediately, before touching the network. Most
  briefs describe BEHAVIOR, not files, so this keeps ordinary task creation
  exactly as cheap (one GitHub write, no extra reads) as it is today for the
  overwhelming common case.
- Otherwise: `Promise.all([api.listOpenPullFiles(repo), api.listIssues(repo,
  {})])`, filters tasks to OTHER, LIVE (`LIVE_TASK_STATES`) ones, extracts
  paths from each task body, and calls `findPathOverlaps` +
  `formatPathOverlapWarnings`.
- The WHOLE body is wrapped in try/catch — any throw is logged
  (`console.error`) and swallowed to `[]`. FAILS OPEN, deliberately, same
  posture this file's own `fireOnAssigned` doc comment states for the
  assign-wake hook a few lines above: a GitHub read going down must never
  refuse a task that otherwise validated. This is a WARN-not-refuse check by
  the issue's own title; the one thing worse than no warning is a task
  creation that fails because the WARNING mechanism itself broke.

`createTask` calls this once `created` is known, and returns
`{ ...created, pathWarnings: warnings }` only when `warnings.length > 0` —
an empty array is never attached, so every existing caller/test that reads
`res.value` and does not expect a `pathWarnings` key keeps not seeing one.

**CLI, `cli/fleet.ts` / `cli/ff.ts`** — both already print the assign-wake
report (`AssignWakeReport`) the same way after filing a task; the new
`pathWarnings` array is printed identically, one line per warning, via each
file's own existing convention (`console.error` in `fleet.ts` — advisory
diagnostics, not the stdout table; `say()` in `ff.ts`).

## Files touched

- `apps/fleet/src/board/path-overlap.ts` (new)
- `apps/fleet/test/board.path-overlap.test.ts` (new)
- `apps/fleet/src/github/api.ts` — `listOpenPullFiles`
- `apps/fleet/src/board/board.ts` — `BoardApi.listOpenPullFiles`,
  `pathClaimWarnings`, `createTask`'s return type/value
- `apps/fleet/src/board/routes.ts` — `listOpenPullFiles` import + wiring in
  `githubBoardApi`
- `apps/fleet/cli/fleet.ts` — `AssignedTask.pathWarnings`, printed in
  `cmdTaskNew`
- `apps/fleet/cli/ff.ts` — `fileTask`'s `filed` type, printed after the wake
  line
- Eight `fakeApi`/`fakeBoardApi` test fixtures (`board.board.test.ts`,
  `board.close-action.test.ts`, `board.envelope.test.ts`,
  `board.fleet-routes.test.ts`, `board.leak.test.ts`,
  `board.pr-landed.test.ts`, `board.routes.test.ts`, `board.verify.test.ts`)
  — add `listOpenPullFiles: vi.fn(async () => [])`
- `apps/fleet/test/board.board.test.ts`'s `describe("createTask", ...)` —
  new cases
- This plan doc

Also fixed in passing: `board.board.test.ts`'s shared `brief` fixture
(`boundaries: "No sprint open/close."`) accidentally LOOKED like a path
claim to `extractPaths` (`"open/close"` has a slash) — reused by nearly
every existing `createTask` test in that file, so it would have made every
one of them start exercising `listOpenPullFiles`/the extra `listIssues`
call it never intended to. Reworded to `"No sprint open or close."`; no test
asserted on the literal text.

## TDD

RED first throughout:

- `apps/fleet/test/board.path-overlap.test.ts` — written and committed
  against a nonexistent `path-overlap.ts` (confirmed red: `Cannot find
  module '../src/board/path-overlap'`), then `path-overlap.ts` implemented
  and the file went green, 15/15.
- `apps/fleet/test/board.board.test.ts`'s new `describe("path overlap
  warning (#112)", ...)` block was written AFTER `board.ts`'s own
  `pathClaimWarnings`/`createTask` wiring (steps 3-6 of this task landed as
  one commit ahead of it) rather than strict red-first for that one block —
  the wiring itself needed to exist for the 8 fixture files' interface
  change to typecheck at all, so splitting "wire the interface" from "add
  the createTask tests" into two RED/GREEN passes would have meant a
  deliberately broken intermediate commit across 8 unrelated test files.
  Stated as a deviation, not hidden.

## Verification

All four commands run from `apps/fleet/`, sequentially, one gate at a time
per the shared-lock rule (`flock /tmp/fleet-gate.lock <cmd>` on the two
repo-wide ones).

- `bun x vitest run` — exit 0.
  ```
   Test Files  147 passed (147)
        Tests  5118 passed (5118)
     Start at  13:45:27
     Duration  271.95s
  ```

- `bun run bun-test` — exit 1, real. Investigated rather than dismissed:
  run TWICE in full (the first run's own capture was piped through `tail
  -60` by my own mistake and lost the early lines, so I reran it captured
  to a plain file for a complete, honest record) — 9 failures the first
  time, 13 the second, entirely in two files: `test/bun/localci-run.test.ts`
  and `test/bun/deploy-rescue-gate.test.ts` (plus a couple of adjacent
  ops-checkout/install-cache timing tests on the second run). EVERY single
  failure is a hard real-time budget assertion (`expect(elapsed).
  toBeLessThan(15_000)`, `this test timed out after 5000ms/60000ms`), and
  the SAME tests got WORSE on the second run (e.g. localci's own SIGTERM
  test: 15260ms over budget the first run, 57260/51313ms over budget the
  second) — the signature of host-load contention, not a regression, and
  the test file's own comments already name this class of flake explicitly
  ("the same host-load-driven overhead the harder... scenario budgets 15s
  for"). Confirmed unrelated to this diff two ways: (1) none of the 4
  `test/bun/*.ts` files that import anything from `src/board` (`orca-
  workspace.test.ts`, `write-proxy-e2e.test.ts`, `fleet-tabs-scope.test.ts`,
  `fleet-reap.test.ts`) are among the failures — ran all 4 in isolation,
  225/225 pass; (2) `bun-test`'s own script scope (`test/bun`, `test/
  studio.files.test.ts`, `test/studio.studio-blueprint.test.ts`) contains
  nothing this task touched — `localci.sh`/`deploy.sh` timing and process
  management have no relation to `createTask`/`path-overlap.ts`/the board
  routes this diff changed. Reported honestly rather than papered over; see
  "Deviations" below.

- `flock /tmp/fleet-gate.lock bun run check` (5-tsconfig repo-wide
  typecheck) — exit 0, clean (no diagnostics on any of the 5 tsconfigs).

- `bun run english-check` — exit 0: `english-check: clean`.

## Deviations / judgment calls

- **`bun run bun-test`'s real exit code is 1**, not 0, on both full runs —
  see "Verification" above for the full investigation. Every failure is a
  pre-existing, host-load-timing flake in `test/bun/localci-run.test.ts` /
  `test/bun/deploy-rescue-gate.test.ts` (and adjacent ops-checkout/install-
  cache timing tests on the second run), none of it in a file this diff
  touches or that imports anything this diff changed. Not silently accepted
  — investigated with a targeted isolation run (the 4 board-importing
  `test/bun` files, 225/225 green) and a second full run that reproduced the
  SAME failures with WORSE timing margins under increasing host load, which
  is the actual signature of environmental contention rather than a code
  regression. A third full run was deliberately not attempted: the second
  run's own trend (worse, not better) plus this container's own documented
  memory-ceiling/wedge risk from repeated heavy-gate runs made a third
  attempt the wrong call, not a more thorough one.
- **No PR opened, no completion record written** by this developer: per
  this role's own framing, PR/merge/deploy is the lead's job, and the task's
  own "Completion record" section is explicitly conditional on "Code Review
  and QA both pass" — neither has run yet (the lead dispatches them next).
  Reported back to the lead instead, with branch name and this real
  verification output.
