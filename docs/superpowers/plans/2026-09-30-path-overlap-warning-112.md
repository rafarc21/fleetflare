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

## Verification

See below — filled in once real command output exists.
