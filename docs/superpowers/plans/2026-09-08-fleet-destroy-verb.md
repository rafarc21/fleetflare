# Fleet Destroy Verb

**Problem (Fleet board task #124):** the operator has no way to stop a
studio. `fleet recycle` is the only verb that ever tears a container down,
and it always reprovisions on the current image afterwards — that is the
whole point of it (the only way an image change reaches a running studio).
There is no path that destroys a container and leaves it down. Every studio
ever spawned therefore runs forever, until someone manually intervenes at
the Cloudflare dashboard: a finished studio just keeps burning container
hours with nothing left to do.

**Fix:** a new verb, `fleet destroy <id> [--force]`, that runs the same
pre-teardown rescue sequence `recycleWithSync` already runs — session sync,
`rescuePush`, `harvestLearnings` — then kills the container and persists
`state: "stopped"`, with no `awaitReady`/`provision` tail at all. A
destroyed studio must never come back on its own; not reprovisioning is
exactly the behavior this feature exists to have.

The new logic lives in `apps/fleet/src/studio/destroy.ts` (new), following
the same "pure logic split out of `do.ts`" convention `provision.ts`
documents in its own header: a live `StudioDO` cannot be constructed under
`vitest-pool-workers`, so anything worth unit-testing has to be a plain
function taking its dependencies as arguments, not a method on the DO.

- `destroyWithSync` mirrors `recycleWithSync`'s sync/rescue-push/harvest
  prefix exactly (same functions, same best-effort try/catch-and-continue
  posture, same `console.error` wording), then diverges at the end: no
  `awaitReady`, no `provision`. On a `destroy()` failure the studio is left
  `degraded` (never `stopped` — a destroy that didn't complete means nobody
  actually knows whether the container is gone), scrubbed via
  `redactSecrets` at the catch boundary the same way `recycleWithSync`'s own
  failure path is, and the function throws so a caller can't mistake it for
  success. On success it persists `stopped`, `error: null`, and — unlike
  `recycleWithSync`'s own success path, which leaves that write to the
  downstream `provision()` call — records the studio itself, since there is
  no downstream step here to do it.
- `runDestroy` sits one layer above that: the refusal gate. Before any of
  `destroyWithSync`'s steps run, it asks "does this studio have an open
  assigned board task", and refuses (a tagged `{ ok: false, refused: true,
  reason }`, not a throw — see below) unless `--force` was passed. The
  refusal has to happen strictly before the pre-destroy sequence starts: a
  board task must never race a rescue-push/harvest that could still save
  work meant for it.
- `DestroyOutcome` is a tagged union (`{ ok: true; status }` |
  `{ ok: false; refused: true; reason }`), not a thrown exception, so the
  route layer (`routes.ts`) can map a refusal to 409 and every other failure
  to 500 without inspecting `Error` subclasses across what is, in
  production, a Durable Object RPC boundary.

Worker-side, `do.ts` gains `StudioDO.destroyStudio(force)`, which resolves
`workRepoSlug` (via the DO's own existing helper, not a re-implementation of
it — see "review round" below), builds the shared `memoryDeps()` (also
factored out in review — see below), and calls `runDestroy`. `routes.ts`
widens `ROUTE_RE` to accept `destroy` alongside `recycle`, and dispatches
`POST /studio/:id/destroy?force=true` to `stub.destroyStudio(force)`: a
refusal (`!result.ok`) returns 409 with the reason as the body, and a genuine
throw (the container kill itself failing) is caught and mapped to 500, same
posture the existing `recycle` branch already takes.

`src/studio/cli-args.ts` gains a `destroy` command (`fleet destroy <id>
[--force]`) — a bespoke parse rather than routing through the existing
`parseFlags` table, since `--force` is the only boolean (non-value-taking)
flag any verb here needs, and extending `parseFlags` for one boolean would
cost more than the parse block itself. `cli/fleet.ts`'s `cmdDestroy` POSTs to
the new route with `?force=true` when passed, and surfaces a 409 refusal
through the same generic `!res.ok` branch every other verb already uses —
the response body already carries the reason, so there is nothing
destroy-specific to special-case at the CLI layer.

## Two-round review story

**Round 1** flagged a fail-open safety bug. The first version of the refusal
gate reused task #118's `resolveAssignedBrief`/`assignedBriefResolver`
(`board/board.ts`, `board/routes.ts`) to answer "does this studio have an
open assigned task". That resolver collapses "no open task" and "couldn't
tell" (a board API failure) into the *same* `undefined` — which is exactly
correct for the bringup fallback it backs (boot with no brief either way),
but is precisely the fail-OPEN behavior a destructive-action gate must never
have: a transient board hiccup would have silently let a `fleet destroy`
proceed against a studio that in fact still had an open task assigned to it.

**Round 2**'s fix did not touch task #118's primitive at all. It added a
dedicated, fail-closed *sibling*:

- `hasOpenAssignedTask` (`board/board.ts`) — same `listTasks(api, repo,
  { assignedTo: studioId })` call `resolveLatestAssignedBrief` makes, but
  the `BoardResult` it gets back is propagated as-is on failure, never
  caught or collapsed to a boolean.
- `openTaskChecker` (`board/routes.ts`) — `assignedBriefResolver`'s sibling;
  wraps `hasOpenAssignedTask` in a try/catch, and both a caught exception and
  a `{ ok: false }` result are returned to the caller unchanged, never
  swallowed into "no open task".

`runDestroy` only proceeds (absent `--force`) on a *positive* confirmation —
`{ ok: true, hasOpenTask: false }`. Anything else — a confirmed open task, a
board API error, or no checker configured at all — refuses, exactly matching
this codebase's own documented "fail SAFE, not fail open" discipline
(`do.ts`'s `rescuePushCmd`). `--force` skips the check entirely (the checker
is never even called), so an operator who explicitly overrides never pays
for, or races, a board read they told the call to ignore.

The same review round also cleaned up three nits: `recycle()` and
`destroyStudio()` had each independently built the identical
`resolveBlueprintRepo`/`commitFile` closure pair, factored out into one
shared `do.ts#memoryDeps()`; `destroyStudio` now calls the DO's own existing
`workRepoSlug()` helper instead of reimplementing it inline; and
`cli-args.ts`'s parse for bare `fleet destroy --force` (id omitted, the flag
sliding into the id's position) is now its own usage error instead of
silently treating the flag string as the studio id.

## Files touched

- `apps/fleet/src/studio/destroy.ts` (new) — `destroyWithSync`, `runDestroy`,
  `DestroyOutcome`, `OpenTaskChecker`
- `apps/fleet/src/studio/do.ts` — `StudioDO.destroyStudio`; shared
  `memoryDeps()` (also now used by `recycle()`); `destroyStudio` calling the
  existing `workRepoSlug()` helper
- `apps/fleet/src/studio/routes.ts` — `ROUTE_RE` accepts `destroy`;
  `POST /studio/:id/destroy` dispatched to `stub.destroyStudio`, 409 on
  refusal, 500 on a genuine throw
- `apps/fleet/src/studio/cli-args.ts` — new `destroy` command + verb help
  text; the bare-`--force`-as-id usage-error fix
- `apps/fleet/cli/fleet.ts` — new `cmdDestroy`, wired into `main`'s command
  dispatch
- `apps/fleet/src/board/board.ts` — new `hasOpenAssignedTask`, a fail-closed
  sibling of `resolveLatestAssignedBrief`; that function itself untouched
- `apps/fleet/src/board/routes.ts` — new `openTaskChecker`, a fail-closed
  sibling of `assignedBriefResolver`; that function itself untouched
- `apps/fleet/test/studio.destroy.test.ts` (new) — `destroyWithSync`'s
  sync/rescue/harvest-then-destroy sequencing and its degraded-on-failure
  path, `runDestroy`'s refusal-gate matrix (confirmed open task, confirmed
  none, checker failure, no checker configured, `--force` skipping the check
  entirely)
- `apps/fleet/test/studio.routes.test.ts` — coverage for the new
  `POST /studio/:id/destroy` route (dispatch, `?force=true` passthrough, 409
  on refusal, 500 on throw)
- `apps/fleet/test/studio.cli-args.test.ts` — coverage for the new `destroy`
  parse path, including the bare-`--force` usage error

## Boundaries respected

`recycleWithSync`'s own body and its existing test suite are completely
untouched — `destroyWithSync` mirrors its pre-destroy sequence but is its
own function, not a refactor of it. No hook, no `container/studio-bringup.sh`,
and no image-revision logic is touched anywhere in this change:

```
$ git diff origin/main -- container/studio-bringup.sh
(empty)
```

`board/board.ts`'s diff against `origin/main` is additive only — the new
`hasOpenAssignedTask` function appended at the end of the file;
`resolveLatestAssignedBrief` itself is byte-identical to `main`. Same shape
in `board/routes.ts`: `openTaskChecker` is appended, `assignedBriefResolver`
is untouched. Task #118's own primitive keeps its fail-open posture exactly
as that task designed it, for exactly the caller it was designed for; this
feature never repurposes it.

## Commits / PR

- `2a0f6db` — `feat(fleet): add read-only-when-refused fleet destroy verb (board task #124)`
- `5e8c3ad` — `fix(fleet): destroy fails closed on open-task lookup failure (board task #124 review)`
- PR #128: https://github.com/acme-org/websites/pull/128

## Verification

- `bun run check` — clean, no output, exit 0 (5 tsconfig projects)
- `bun run test` — 1622/1622 tests passing across 66 files
- `git diff origin/main -- apps/fleet/src/board/board.ts` — additive only,
  `hasOpenAssignedTask` appended, `resolveLatestAssignedBrief` untouched
