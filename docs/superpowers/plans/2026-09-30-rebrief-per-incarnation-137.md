# Bring-up task re-delivery: scope to every open task, dedup per incarnation

**Issue:** https://github.com/rafarc21/fleetflare/issues/137 ("After an image
rollout, restored leads idle until task re-sent by hand")

**Goal:** An image rollout replaces every studio's container. The DO survives
and re-provisions/restarts it, and `deliverAssignedTaskOnBringup` (do.ts,
board issue #213/#229) is supposed to re-type the assigned-task pointer into
the freshly restored pane on every bring-up — same mechanism #213/#229 built,
sibling of `deliverSurvivalBriefOnBringup`. Two bugs, both root-caused before
this plan was written:

1. **The dedup marker never expires.** `DELIVERED_TASK_KEY`
   (`deliveredTaskIn`/`recordDeliveredTask`, do.ts) records a task NUMBER
   forever, with no notion of container identity. A task delivered once —
   even days before a rollout — is never re-delivered again on any future
   bring-up for that same task, even though the container was fully destroyed
   and rebuilt and the new lead has zero memory of it.
   `deliverSurvivalBriefOnBringup`'s own dedup
   (`Observed.survivalBriefDeliveredFor`) already solves this correctly by
   scoping to the bring-up's `incarnation` token (`Observed.incarnation`, a
   fresh random id written by every bring-up) — `deliverAssignedTaskOnBringup`
   never adopted that scoping.
2. **Scope was one task, not every open one.** `deliverAssignedTaskOnBringup`
   was wired to `resolveLatestAssignedBrief`'s "newest wins" single task, so a
   studio holding two or more live tasks only ever got re-briefed on one of
   them.

This closes both gaps: every assigned task in state `working` or
`input_required` (not `submitted` — a submitted task hasn't been started, so
the normal fresh-assignment wake, `wakeOnAssign`, already covers it) gets its
own re-delivery wake on bring-up, and the dedup that gates it is scoped to the
bring-up's own incarnation token, so a container replacement always earns a
fresh delivery even for a task that had already been delivered before the
replacement.

## One thing checked before touching anything

`deliveredTaskIn(storage)` is ALSO consulted by `harvestLearnings` (do.ts,
called from `recycleWithSync` and `destroy.ts`) as "the task this studio was
delivered" — the task number whose completion record
(`/workspace/.fleet/done/<task>.json`) to harvest learnings from at teardown.
That consumer genuinely wants "the single most-recently-delivered task
number, forever, not incarnation-scoped" — confirmed by reading both call
sites (`do.ts` ~1475, `destroy.ts` ~316) and `harvestLearnings`'s own doc
comment ("The task this studio was delivered (`deliveredTaskIn`) — its record
is the one harvested (#316)").

So `DELIVERED_TASK_KEY`/`deliveredTaskIn`/`recordDeliveredTask` are kept
EXACTLY as they were — still written unconditionally on every landed wake,
still "last delivered wins", still read only by harvest/teardown — as a
separate, parallel piece of bookkeeping. A NEW, independent
incarnation-scoped record is what the delivery GATE now actually reads.

## Design

### 1. `apps/fleet/src/studio/observed.ts`

New optional field on `Observed`:

```ts
/** Issue #137: task numbers that have already received a bring-up
 *  re-delivery wake for THIS incarnation. Reset implicitly: a record whose
 *  own `incarnation` no longer matches `Observed.incarnation` reads as
 *  empty, so a container replacement (new incarnation) earns every open
 *  working/input_required task exactly one fresh wake again, even a task
 *  that had already been delivered before the replacement — the gap
 *  `DELIVERED_TASK_KEY` (do.ts) left, because that marker is keyed on the
 *  task number alone and never expires.
 *
 *  OPTIONAL, same trailing-optional shape `survivalBriefDeliveredFor` above
 *  uses: absent means "nothing delivered against any incarnation yet". */
taskWakesDeliveredFor?: { incarnation: string; numbers: number[] } | null;
```

`emptyObserved()` sets it `null` explicitly, matching every other field's
convention there.

The `survivalBriefDeliveredFor` doc comment's own contrast ("not per task the
way board #213's own `DELIVERED_TASK_KEY` is") is reworded: `DELIVERED_TASK_KEY`
itself is unchanged (still per-task-forever, still the harvest/teardown
pointer), but it is no longer what gates the rebrief wake — that gate is now
`taskWakesDeliveredFor` above, which follows the SAME per-incarnation
discipline `survivalBriefDeliveredFor` already does.

### 2. `apps/fleet/src/board/board.ts`

New exported constant + function, siblings of `LIVE_TASK_STATES`/
`resolveLatestAssignedBrief`:

```ts
export const REBRIEF_TASK_STATES: readonly TaskState[] = ["working", "input_required"];

export async function openTasksNeedingRebrief(
  api: BoardApi, repo: string, studioId: string,
): Promise<{ taskNumber: number; title: string }[]>
```

Same `listTasks(api, repo, {assignedTo: studioId})` call
`resolveLatestAssignedBrief` makes, same fail-open-to-`[]` posture (a thrown
error or `{ok:false}` is logged and answered `[]` — a board hiccup at
bring-up must never block provisioning), filtered to `t.open && t.state !==
null && REBRIEF_TASK_STATES.includes(t.state)`, sorted newest-updated-first
(the same `Date.parse(b.updatedAt) - Date.parse(a.updatedAt)` sort
`resolveLatestAssignedBrief` uses — order does not change which tasks get
delivered here, kept only for deterministic test output).

### 3. `apps/fleet/src/studio/do.ts`

`deliverAssignedTaskOnBringup` rewritten to take an `incarnation: string |
null` and an array-returning `boardLookup`, and loop over every task:

```ts
export async function deliverAssignedTaskOnBringup(
  storage: StudioStorage,
  incarnation: string | null,
  boardLookup: () => Promise<{ taskNumber: number; title: string }[]>,
  wake: (prompt: string, taskNumber: number) => Promise<WakeOutcome>,
  moved: () => Promise<boolean> = async () => false,
): Promise<void>
```

- `incarnationKey = incarnation ?? ""` — a null incarnation behaves the same
  way the old per-task-number key always did (forever, no reset): real
  incarnation tokens (`crypto.randomUUID()`) are never the empty string, so
  this never collides with a genuine one.
- Reads the incarnation-scoped delivered set (`taskWakesDeliveredIn`, a new
  private helper, modeled on how `survival-delivery.ts` reads
  `survivalBriefDeliveredFor`/`survivalBriefPending` via `getObserved`/
  `mergeObserved`, cast the same way `deliveredTaskIn` already casts `storage`
  to its own narrow port).
- For each task not already in that set: checks `moved()` (same "check AFTER
  boardLookup, right before wake" ordering the existing "destroy landing mid-
  delivery vetoes the send" test already pins) and, if moved, stops the WHOLE
  loop (a destroy tore the container down; there is nothing left to deliver
  the remaining tasks into either).
- On `outcome.ok`: records BOTH the old `recordDeliveredTask` (unconditional,
  unchanged, for harvest) AND appends to the new incarnation-scoped set via
  `recordTaskWakeDelivered` (write once per landed wake, so a mid-loop
  failure/restart still remembers what already landed).

`assignedTaskOnBoard` (private) is replaced by a call to the new
`openTasksNeedingRebrief`. `deliverTaskOnBringup` (private, ~4988) reads
`(await getObserved(this.ctx.storage)).incarnation` the same way
`deliverSurvivalOnBringup` already does, and threads it through; the refusal
log line still names the specific task refused (the wake closure receives
`taskNumber` as its second argument now, rather than a captured outer
variable, since a single bring-up can refuse more than one task).

Doc comments updated: `deliverAssignedTaskOnBringup`'s own header (the
"at-most-once per task id" framing is now "at-most-once per task id PER
INCARNATION", and the function description no longer talks about a single
task), `DELIVERED_TASK_KEY`/`deliveredTaskIn`'s header (no longer "exactly one
current live task at a time" — it's the harvest/teardown pointer only,
decoupled from the rebrief gate), `assignedTaskOnBoard`'s replacement
(`openTasksNeedingRebrief`'s own JSDoc lives in board.ts), and
`observed.ts`'s `survivalBriefDeliveredFor` contrast (see section 1 above).

## Test-drive it (TDD, RED then GREEN)

`apps/fleet/test/studio.wake-gate.test.ts`'s `describe("deliverAssignedTaskOnBringup
— board issue #213's bring-up delivery wake")` block:

- Every existing test ported to the new `(storage, incarnation, boardLookup,
  wake, moved?)` signature, array-returning `boardLookup`, two-arg `wake`.
- NEW, RED-first: same task number, SAME storage, bring-up #2 has a DIFFERENT
  incarnation than bring-up #1 → the task IS re-delivered. Confirmed this goes
  red against the ported-but-unfixed code before implementing the fix.
- NEW: two simultaneously open working/input_required tasks in ONE
  `boardLookup` call → both get their own wake, independently recorded.
- The old "a newer task supersedes the dedup marker — newest wins" test no
  longer makes sense under the array model (every open task is delivered, not
  just the newest) — replaced with: two separate bring-ups on the SAME
  incarnation, second bring-up's `boardLookup` returns the first task again
  plus a newly-assigned second one → only the new one gets a fresh wake (the
  first is still correctly deduped within the same incarnation).
- "limit modal refused → nothing persisted → retry delivers" and "destroy
  lands mid-delivery → vetoed" kept, adapted to the new signature.

`apps/fleet/test/board.board.test.ts` — new coverage for
`openTasksNeedingRebrief` (empty, board-error fail-open, filters to
working/input_required only, excludes submitted, excludes closed/terminal),
modeled on the existing `resolveLatestAssignedBrief` describe blocks'
fixture/API-fake style.

## Deviations from the brief

1. **`deliverAssignedTaskOnBringup`'s `storage` param stays typed
   `StudioStorage`, not `StudioStorage & ObservedStorage`.** The sketch says
   "model [the helpers] on survival-delivery.ts" but does not mandate a
   signature change. `do.ts` already has an established idiom for a function
   whose param is the narrow `StudioStorage` port but that also needs one
   other key: cast to the narrower port internally
   (`storage as unknown as DeliveredTaskStorage`, this same function's own
   `deliveredTaskIn`/`recordDeliveredTask`; `storage as unknown as
   ActivityStorage` in `applyActivityVerdict`). The two new private helpers
   (`taskWakesDeliveredIn`/`recordTaskWakeDelivered`) follow that exact
   pattern — `storage as unknown as ObservedStorage` — rather than widening
   the exported function's public param type. This keeps
   `test/studio.wake-gate.test.ts`'s existing `fakeStorage()` (typed
   `StudioStorage`) working unchanged for every test in this block, with no
   second, wider fake needed.
2. **`survival-delivery.ts`'s own line ~175** (flagged in the brief as
   possibly needing a reworded contrast) turned out, on inspection, to be
   `SurvivalTaskRef`'s doc comment about artifact ordering — it does not
   mention `DELIVERED_TASK_KEY` or `deliverAssignedTaskOnBringup` at all and
   needed no change. Left untouched.

## Files touched

- `apps/fleet/src/studio/observed.ts` — `Observed.taskWakesDeliveredFor`,
  `emptyObserved()`, reworded `survivalBriefDeliveredFor` contrast comment.
- `apps/fleet/src/board/board.ts` — `REBRIEF_TASK_STATES`,
  `openTasksNeedingRebrief`.
- `apps/fleet/src/studio/do.ts` — `deliverAssignedTaskOnBringup` rewritten
  (array boardLookup, incarnation param, per-incarnation dedup),
  `taskWakesDeliveredIn`/`recordTaskWakeDelivered` (new private helpers),
  `assignedTaskOnBoard` replaced by `openTasksNeedingRebrief`,
  `deliverTaskOnBringup` reads and threads `incarnation`, updated doc
  comments on `DELIVERED_TASK_KEY`/`deliveredTaskIn`.
- `apps/fleet/test/studio.wake-gate.test.ts` — ported
  `deliverAssignedTaskOnBringup` coverage to the new signature, new
  incarnation-reset and multi-task coverage (issue #137).
- `apps/fleet/test/board.board.test.ts` — new `openTasksNeedingRebrief`
  coverage.
- This file.
