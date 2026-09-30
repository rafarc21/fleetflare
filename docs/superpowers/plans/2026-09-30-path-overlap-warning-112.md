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
- **No PR opened, no completion record written** by this developer at the
  time this section was first written: per this role's own framing, PR/
  merge/deploy is the lead's job, and the task's own "Completion record"
  section is explicitly conditional on "Code Review and QA both pass" —
  neither had run yet. Both have since run (the lead's own message): Code
  Review approved with no blockers, QA passed. PR opened by the lead:
  https://github.com/rafarc21/fleetflare/pull/128 (closes #112). The
  completion record `/workspace/.fleet/done/112.json` (outside the repo
  checkout, never committed) was written after that confirmation.

## Fix round: merge `main` (PR #128 CI went red)

`main` had moved 9 commits ahead of the branch point (9b7c213 -> 149779c)
by the time PR #128's CI ran. One of those 9, `b219438` ("maestro
in-container: resume, instance spawn, task new/assign under org-chart gate
— #59 (#75)"), added a new file, `test/board.fleet-directs.test.ts`, with
its own `fakeApi(): BoardApi` literal that predates this task's
`listOpenPullFiles` addition to the `BoardApi` interface — missing field,
`TS2322`. It was the only new `BoardApi`-literal fixture among those 9
commits (confirmed by the coordinator's own grep of
`function fakeApi`/`function fakeBoardApi`/`: BoardApi = {` across
`origin/main`).

Two of the 9 new commits also touched files this task already changed —
`src/board/routes.ts` (b219438: org-chart-gated `/fleet/tasks` create/
assign, `directGate`, `PolicyFetch`) and `cli/fleet.ts` (b219438 + 191040e:
fresh-session cancel path). `git merge origin/main` (merge, not rebase —
the branch is already pushed and PR-open) resolved BOTH with zero
conflicts: this task's changes (the `listOpenPullFiles` import/wiring near
the top of `routes.ts`'s `githubBoardApi`, `AssignedTask.pathWarnings` +
`reportPathWarnings` in `fleet.ts`) and main's new changes (the org-chart
gate machinery further down `routes.ts`, the fresh-session flags in
`fleet.ts`) touched non-overlapping regions of both files. Verified by
grepping the merged files for both sets of symbols — every one present
exactly once, no duplication, no silent drop.

Fixed the ONE real gap (`board.fleet-directs.test.ts`'s missing
`listOpenPullFiles` mock) with the same one-line pattern as the 8 fixtures
already patched earlier in this task. Checked its brief fixture for the
same "accidentally looks like a path" trap the earlier `board.board.test.ts`
fix caught (`"open/close"`) — this file's `BRIEF` (`"Ship it"`, `"A PR"`,
`"Touch nothing else"`) has no slash, so no hidden trigger.

### Verification (this round)

- `flock /tmp/fleet-gate.lock bun run check` (5-tsconfig repo-wide
  typecheck, post-merge) — exit 0, clean.
- `bun x vitest run test/board.fleet-directs.test.ts
  test/board.path-overlap.test.ts test/board.board.test.ts
  test/board.routes.test.ts test/board.fleet-routes.test.ts
  test/board.leak.test.ts` (every file that imports `src/board/routes` or
  `src/board/board`, i.e. every file that could see either side of the
  merge) — 6 files, 315/315 tests pass.

Full `bun x vitest run` deliberately NOT rerun for this fix round (already
run once in full earlier this task, per the one-heavy-gate-at-a-time
budget) — the targeted set above covers every file that imports anything
touched by the merge's conflict-adjacent regions.
