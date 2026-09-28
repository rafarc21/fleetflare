# fleet destroy: full teardown, not half (board issue #57)

## The bug, as measured

`fleet destroy <id>` (`cli/fleet.ts`'s `cmdDestroy` -> `POST /studio/:id/destroy`
-> `src/studio/destroy.ts`'s `destroyWithSync`) does exactly one thing: sync,
rescue-push, harvest learnings, stop the container. MEASURED on
`acme-os--scratch`: after that call returns, three things survive —

- the local Orca worktree `studio-<id>` under `~/orca/workspaces/<repo>/`,
  created by `ensureStudioWorkspace` (`cli/orca-workspace.ts`) on every
  `spawn`/`provision`/`recycle`/`ff` — but never torn down by anything.
- its attach terminal, now a dead `root@cloudchamber:/workspace#` shell.
- a sidebar row in Orca visually identical to a live studio's.

Full teardown needed two more, undocumented commands:
`orca terminal close --terminal <handle>` and
`orca worktree rm --worktree "path:<abs>" --force`.

## The docs defect, and why it is dangerous

`skills/fleet-cockpit/SKILL.md:218` (the `ensureStudioWorkspace` paragraph)
says of the worktree: "That is the visibility guarantee: nothing spends money
in the cloud where the operator cannot see it. **Do not delete it.**" No
scope, no exception, no post-destroy step anywhere. `SKILL.md:136`
(`fleet destroy`'s own entry) documents that destroy leaves the *registry*
entry and says nothing about the worktree or terminal surviving. `fleet
destroy`'s CLI help mentions neither.

A coordinator who reads both is told, correctly, three things: the container
stops, the registry row stays, and the worktree must not be deleted. Doing
exactly that produces the stale row — this is documentation instructing the
operator to do the wrong thing, not an operator error. Two coordinators did
this today.

## Fix shape

### 1 + 2 together: `fleet destroy` does the whole teardown, salvaging first

`cmdDestroy` (`cli/fleet.ts`) already calls `ensureStudioWorkspace` on every
path that *creates* a workspace (spawn/provision/recycle); the missing
counterpart is a `removeStudioWorkspace` it calls on success, using the SAME
injected-`run` Orca wrapper (`OrcaDeps`) `cli/orca-workspace.ts` already
defines — no new way of shelling out to `orca` gets invented.

`removeStudioWorkspace(id, deps)`:

1. `worktree list --json`, find the entry whose `displayName` is
   `studio-<id>` (same lookup `ensure()` already does). Not found -> `absent`
   (teardown already complete, or never had a row — a no-op, not an error).
2. `terminal list --worktree id:<found.id> --json`, `terminal close
   --terminal <handle>` for every terminal reporting `connected: true`. This
   runs even if the worktree's path later turns out to be unknown — a dead
   terminal handle is worth closing regardless of whether the worktree itself
   can be safely removed.
3. Salvage `.context/` (see below). A failed salvage refuses the removal.
4. Remove the worktree **by path, never by name**:
   `worktree rm --worktree "path:<abs>" --force --json`.

Same failure posture as `ensureStudioWorkspace`: every step after the
container is already stopped is best-effort from the caller's point of view
— a `fleet destroy` that successfully stopped the container must never exit
non-zero because Orca is absent, wedged, or errors on cleanup. Every failure
degrades to one clear stderr line (`describeWorkspaceRemoval`), never a
thrown error or a non-zero exit.

### 2: salvage `.context/` first, and say so

`.context/` is gitignored evidence — the board issue cites a real incident
where 11 screenshots and 24 context files across two studio worktrees would
have been destroyed by a blind `rm`. New module `cli/context-salvage.ts`,
pure/sync, no Orca dependency:

- `listContextFiles(worktreePath)` — every file under `<worktreePath>/.context`,
  recursively, relative to `.context` itself. `[]` when the directory is
  absent (nothing to salvage, matches an already-clean worktree).
- `inventoryContext(relFilePaths)` — pure classification: screenshot count
  (image extensions) vs. other context files, no I/O. This is the part board
  issue #57 calls out as unit-testable independent of a real filesystem walk.
- `salvageContext(worktreePath, studioId, dest)` — `{ kind: "empty" }` when
  there is nothing to copy; otherwise copies the whole `.context/` tree to a
  dated, studio-id-stamped destination (`~/fleet-teardown-salvage/<id>-<ISO
  timestamp>/`, so two teardowns of related studios never clobber each
  other) and returns `{ kind: "salvaged", destination, inventory }`; a copy
  that throws returns `{ kind: "refused", inventory, why }` instead of
  silently losing the evidence.

`removeStudioWorkspace` treats `"refused"` as a hard stop: the worktree `rm`
call is never made, and the outcome names exactly what is stuck there (file
counts), matching the UX board issue #57 asked for ("refuse the worktree
removal and name exactly what's in it"). `"empty"` and `"salvaged"` both let
teardown continue.

### The by-path-never-by-name invariant

`orca worktree rm --worktree "name:<x>"` also matches branch names and has
already destroyed a live agent mid-task in a real incident (per the board
issue). `removeStudioWorkspace` never constructs a `name:` selector for the
destructive `worktree rm` call — only `path:`. If Orca's `worktree list
--json` does not report a path for a found worktree (unconfirmed whether it
does; no real Orca is reachable from this container to check — same
limitation `orca-workspace.ts`'s own header already documents for its other
hypotheses), the removal is refused rather than falling back to `name:` or
guessing a path. `test/bun/orca-workspace.test.ts` asserts this directly: no
`worktree rm` call in any test scenario ever carries a `name:` argument, and
a worktree entry without a `path` field produces `refused`, never a removal.

### 3 (floor): scope the docs line, document the real sequence

`skills/fleet-cockpit/SKILL.md`:

- Line 218's "Do not delete it" gets scoped to a *running* studio explicitly.
- A new "Tearing a studio all the way down" section under `## Verbs`
  documents the real sequence: `fleet task state <n> completed` ->
  `fleet destroy <id>` (now does the whole teardown; **note the `--force`
  caveat**: destroy's guard reads the GitHub issue's open/closed state, not
  the board's `completed` label, and they can disagree — board issue #55
  defect A, not fixed here) -> confirm via `fleet ls` that the row is gone
  (the CLI-side teardown from fix 1 is best-effort; if it degraded, the
  section documents the manual fallback: `orca terminal close --terminal
  <handle>` then `orca worktree rm --worktree "path:<abs>"`, **by path, never
  by name** — `name:` also matches branch names and has destroyed a live
  agent mid-task).

### 4 (stretch, deferred if out of room)

`fleet ls` distinguishing a cleaned stopped studio from a stopped-with-stale-row
one is lower priority per the board issue's own ordering and is not required
for the floor. Noted as a follow-up rather than attempted silently.

## Test plan

`test/bun/orca-workspace.test.ts` (extended) and a new
`test/bun/context-salvage.test.ts`:

- `inventoryContext`: pure classification, screenshots vs. other files, given
  a fake path list — no filesystem.
- `listContextFiles` / `salvageContext`: real filesystem, `mkdtempSync` +
  `tmpdir()` fixtures (this repo's own established pattern — see
  `test/bun/blueprint-credential.test.ts`, `bringup-hooks.test.ts`), covering
  absent `.context/` (`empty`), a populated one (`salvaged`, destination
  contains every file, inventory counts correct), and a destination that
  cannot be written (`refused`).
- `removeStudioWorkspace`, via the same injected fake-`run` harness already
  in `orca-workspace.test.ts`: absent worktree is a no-op; a found worktree
  with a connected terminal closes it before removal; removal is refused
  when the worktree entry carries no `path`; removal is refused when salvage
  itself reports `refused`; every `worktree rm` call across every scenario
  carries a `path:` selector and never a `name:` one; a broken/timed-out Orca
  call degrades to one stderr line, never a throw (same contract
  `ensureStudioWorkspace` already proves).
- `cmdDestroy`'s call ordering (container-stop request happens before any
  Orca cleanup call) is implicit in its structure — the HTTP request is
  awaited and checked before `removeStudioWorkspace` is ever called — and is
  covered by reading the function, not by a new integration test: `cmdDestroy`
  itself is thin CLI glue with no fake-fetch harness in this repo today, and
  bolting one on for a two-line ordering guarantee is more machinery than the
  guarantee is worth; the ordering-sensitive logic that IS worth testing
  (salvage-before-remove, close-before-remove, path-not-name) lives inside
  `removeStudioWorkspace` itself and is covered directly.

Both lanes: `bun run check`, `bun run test`, `bun run bun-test`.

## What shipped vs. deferred

- Shipped: 1 (destroy does the whole teardown), 2 (salvage-first,
  by-path-never-by-name), 3 (docs scoped + full sequence documented,
  including the #55 `--force` caveat, honestly).
- Deferred: 4 (`fleet ls` cleaned/not-cleaned distinction) — noted here and
  in the PR as a clean follow-up, not attempted silently.
- Explicitly NOT touched: board issue #55's guard bug (destroy's open-task
  check reading the GitHub issue rather than the board) — out of scope for
  this task, mentioned honestly in the new docs section instead of hidden.
