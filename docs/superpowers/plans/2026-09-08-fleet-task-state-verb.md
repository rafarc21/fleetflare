# Fleet Task State Verb

**Problem (Fleet board task #131):** the board is the fleet's source of
truth for task progress, and the Worker is its sole writer — `transitionTask`
(`src/board/board.ts:140`) already exists, already routed at
`POST /studio/board/tasks/<n>/state` (`src/board/routes.ts:256`), and already
enforces a compare-and-swap keyed on the state the caller believes the task
is in. But no CLI verb ever called it. Seven real tasks shipped and merged
in this session — reviewed, tested, PR'd, merged — while all seven still
read `state=submitted` on the board, because the only way to close one out
was a raw `bun` HTTP call made directly against the route by hand. The board
cannot be the fleet's source of truth for progress if nothing routine moves
a task out of `submitted`.

**Fix:** a new verb, `fleet task state <n> <to>`, that wraps the
already-correct `transitionTask` route rather than reimplementing or
loosening it. The orchestration reads the task's current state first — via
the same task-show endpoint `fleet task show` already calls — and sends that
value as `from`, so the route's own compare-and-swap still protects against
a stale caller; the verb never invents or trusts a caller-supplied `from`.
On a stale-`from` 409 the route's own message is surfaced completely
verbatim, never reformatted or summarized, so an operator sees exactly what
the Worker found instead of a paraphrase that could hide what actually
happened. The target state (`to`) is validated against the full
`TASK_STATES` vocabulary (`src/board/types.ts`) at CLI-parse time, before
any network round trip — an unknown state name is a usage error, not a
wasted request.

The pure read-then-write orchestration lives in a new
`apps/fleet/src/studio/task-state.ts`, following the same "pure logic, DI'd
over the credentials type" convention `src/studio/onboard.ts` set for task
#125: `runTaskStateTransition` takes a `TaskStateDeps<C>` (a
`getCurrentState` and a `transition` function) and never needs to know what
a `Credentials` value actually looks like, only that the same opaque value
flows from `cli/fleet.ts`'s `loadCredentials` through both. `getCurrentState`
failures are returned as-is (no `from` to send, so `transition` is never
called); `transition` failures — most notably the route's own 409 — are
likewise returned unchanged, `message` byte-identical to what the route
sent. On success, `to` is read back from the transition's own response
rather than echoing the caller's requested value, the same "trust what was
actually written" discipline `transitionTask` itself follows.

`cli/fleet.ts` supplies the real I/O: `taskStateFetchCurrent` GETs the same
task-show URL `cmdTaskShow` already calls and pulls `.task.state` out of it
(refusing, with a 409-shaped message, a task whose `state` is `null` because
its board labels don't resolve to a single state — there is no `from` this
CLI could read to transition it safely); `taskStateFetchTransition` POSTs to
the existing `/tasks/<n>/state` route. Neither goes through `boardRequest`,
because that helper calls `process.exit(1)` on any non-ok response, which
would make a stale-`from` 409 unreachable for `runTaskStateTransition` to
surface — `cmdTaskState` is the one place that decides whether to print and
exit. On success it prints the before -> after line (`task #42: submitted ->
completed`); on failure it prints the surfaced message and exits 1, the same
posture every other board verb in this file already takes.

`src/studio/cli-args.ts` gains the `task-state` command variant
(`{ cmd: "task-state"; number: number; to: TaskState }`) and its parse case:
`to` is checked against `isTaskState`/`TASK_STATES` at parse time, so
`fleet task state 42 bogus` fails immediately with the full vocabulary
listed in the usage message rather than reaching the network. `from` is
deliberately not a CLI argument at all — a caller typing what it *believes*
the state to be is exactly the stale value the route's compare-and-swap
exists to catch; the verb always reads the live value itself.

## Files touched

- `apps/fleet/src/studio/task-state.ts` (new) — `runTaskStateTransition`,
  `TaskStateDeps`, `TaskStateFetchResult`, `TaskStateResult`
- `apps/fleet/cli/fleet.ts` — `cmdTaskState`, `taskStateFetchCurrent`,
  `taskStateFetchTransition`; wired into `main`'s command dispatch as
  `case "task-state"`
- `apps/fleet/src/studio/cli-args.ts` — new `task-state` command variant,
  its parse case (numeric id + `TASK_STATES`-validated `to`), and verb help
  text
- `apps/fleet/test/studio.task-state.test.ts` (new) — `runTaskStateTransition`'s
  happy path (reads current state, sends it as `from`, reports before ->
  after), the stale-`from` 409 passed through byte-identical, and a
  `getCurrentState` failure short-circuiting before `transition` is ever
  called
- `apps/fleet/test/studio.cli-args.test.ts` — coverage for the new
  `task-state` parse path: valid states across more than one vocabulary
  value, missing/non-numeric issue number, an unknown target state rejected
  at parse time with the vocabulary listed, and a missing target state
  refused rather than defaulted

## Boundaries respected

`transitionTask`, its route dispatch, and the compare-and-swap
semantics/vocabulary in `board/board.ts`, `board/routes.ts`, and
`board/types.ts` are byte-identical to `main` — confirmed independently by
both the code review and QA passes on this PR, and reconfirmed here:

```
$ git diff origin/main -- apps/fleet/src/board/board.ts apps/fleet/src/board/routes.ts apps/fleet/src/board/types.ts
(empty)
```

This feature is a new caller of the existing route, never a change to what
the route does or how it decides to accept or refuse a transition.

No auto-close-on-merge or auto-close-on-envelope-receipt logic was added
anywhere — the verb is operator-invoked only, exactly the way `fleet
destroy` and `fleet onboard` before it are. A repo-wide search for every
reference to the new orchestration turns up only the three files that wire
it up on purpose:

```
$ grep -rln "runTaskStateTransition\|task-state" apps/fleet/src apps/fleet/cli apps/fleet/container
apps/fleet/src/studio/cli-args.ts
apps/fleet/src/studio/task-state.ts
apps/fleet/cli/fleet.ts
```

Nothing in `container/studio-bringup.sh`, a git hook, or a merge-time script
calls it — a task's state changes only when an operator explicitly runs
`fleet task state <n> <to>`.

## Commits / PR

- `e9533f2` — `feat(fleet): add fleet task state <n> <to> verb (board task #131)`
- PR #132: https://github.com/acme-org/websites/pull/132

## Verification

- `bun run check` — clean, no output, exit 0 (5 tsconfig projects)
- `bun run test` — 1658/1658 tests passing across 68 files
- `git diff origin/main -- apps/fleet/src/board/board.ts apps/fleet/src/board/routes.ts apps/fleet/src/board/types.ts` —
  empty; the CAS route and its vocabulary are untouched by this feature
