# Adopted-Task Brief Delivery

**Bug (Fleet board task #118):** `cfg.briefPrompt` was only ever populated on
two provisioning paths — `src/studio/spawn.ts`'s `runSpawn` and
`board/routes.ts`'s `POST /studio/:id/provision?task=N` — both of which
require a *caller* to hand in a task number. Recycle and a bodyless
re-provision never do: they spread the studio's existing repo/role forward
with no `briefPrompt` field at all. The result: a studio first created
without a task, later *adopted* onto one via `fleet task assign`, never
received that task's brief on recycle. Its container's working-set carried
the role prompt and zero task text, forever, until a human typed a prompt at
it by hand.

**Fix:** `resolveBringupEnv` (`src/studio/provision.ts`) now falls back to a
board lookup whenever `cfg.briefPrompt` is unset:

```
const briefPrompt = cfg.briefPrompt ?? await deps.resolveAssignedBrief?.(`${cfg.repo}--${cfg.role}`, workRepoSlug);
```

`cfg.briefPrompt ?? ...` means a caller-supplied brief always wins and the
board is never even queried in that case — the spawn and operator-provision
paths are completely unaffected by this change.

The lookup is threaded through as a new optional port,
`ProvisionDeps.resolveAssignedBrief?: (studioId: string, workRepoSlug: string) => Promise<string | undefined>`.
Optional for the same reason `r2Get`/`writeFile`/`setKeepAlive` are: every
`ProvisionDeps` literal built before this task, including every existing
test fixture, never supplies it, and its absence must mean "behave exactly
as today" — no board lookup attempted at all, not even a network call.

Queried against `workRepoSlug`, not `fleetRepoSlug` — per the file's own
"board repo = repo being worked" convention, which on a recycle is
`existing.repoSlug`, the fleet's own repo only when nothing else was ever
bound. `resolveBringupEnv` takes `workRepoSlug` as a new parameter because it
has no access to `existing` itself; `runProvision` already resolves that
slug one call earlier and now passes it through.

Board-side, `board.ts` gets a new `resolveLatestAssignedBrief(api, repo,
studioId)`: it looks up open tasks carrying the studio's `studio:<id>`
label via `listTasks`, filters to `open` (closed-but-labeled issues exist for
board-UI reasons and are not live work), and sorts by `updatedAt` descending
as a proxy for "most recently assigned" (no dedicated assignment timestamp
exists, but `assignTask`'s own write is what bumps `updatedAt` in the first
place). It renders the brief for the newest task and — when more than one
open task is assigned — prefixes the prompt with a note naming the chosen
task and listing the others by number, so a lead is never silently handed
one of several assigned tasks with nothing on the page to say the others
exist. Like the file's existing `resolveMemoryIndex`, it is total and
fail-open: a thrown error or an `{ ok: false }` result from `listTasks` is
logged and answered with `null`, identical to "no task assigned."

`board/routes.ts` exposes this as `assignedBriefResolver(env, api)`, the
board-side sibling of the existing `briefPromptResolver`, minus the task
number — it returns `(studioId, repoSlug) => Promise<string | undefined>`,
wrapped in its own try/catch as a backstop against the default
`githubBoardApi(env)` construction throwing. `do.ts`'s real `deps()` wires
`resolveAssignedBrief: assignedBriefResolver(this.env)` into the
`ProvisionDeps` it builds for every studio.

## Files touched

- `apps/fleet/src/board/board.ts` — new `resolveLatestAssignedBrief`
- `apps/fleet/src/board/routes.ts` — new `assignedBriefResolver`
- `apps/fleet/src/studio/do.ts` — wires `resolveAssignedBrief` into `deps()`
- `apps/fleet/src/studio/provision.ts` — new `ProvisionDeps.resolveAssignedBrief`
  port; `resolveBringupEnv` gains a `workRepoSlug` parameter and the
  `cfg.briefPrompt ?? deps.resolveAssignedBrief?.(...)` fallback;
  `runProvision` passes `workRepoSlug` through
- `apps/fleet/test/board.board.test.ts` — coverage for
  `resolveLatestAssignedBrief` (single task, multiple open tasks, closed
  tasks filtered out, `listTasks` throwing, `{ ok: false }`); also retitles
  a pre-existing test that actually exercised `listIssues` throwing rather
  than `listTasks` returning `ok: false`
- `apps/fleet/test/directus.provision.test.ts` — updated `resolveBringupEnv`
  call sites for the new `workRepoSlug` parameter
- `apps/fleet/test/memory.prompt.test.ts` — same call-site update
- `apps/fleet/test/studio.provision.test.ts` — coverage for the adopted-task
  fallback itself, plus a review-follow-up test proving
  `deps.resolveAssignedBrief` is never called when `cfg.briefPrompt` is
  already set (the mechanism that keeps spawn/operator-provision unaffected)

## Boundary respected

`src/studio/spawn.ts` is untouched — verified byte-identical to `origin/main`:

```
$ git diff origin/main -- apps/fleet/src/studio/spawn.ts
(empty)
```

Spawn already names a task number when one exists, so it was never in scope
for this fix; the two commits below never touch it.

## Commits / PR

- `fb0ae3e` — `fix(fleet): resolve adopted-task brief from the board on recycle/re-provision`
- `1eec2aa` — `test(fleet): cover the briefPrompt short-circuit, retitle mislabeled test`
  (review follow-up: adds the short-circuit coverage above, retitles the
  mislabeled `board.board.test.ts` test, collapses a stray double blank
  line in `do.ts`)
- PR #122: https://github.com/acme-org/websites/pull/122

## Verification

- `bun run check` — clean, no output, exit 0 (5 tsconfig projects)
- `bun run test` — 1583/1583 tests passing across 64 files
- `git diff origin/main -- apps/fleet/src/studio/spawn.ts` — empty
