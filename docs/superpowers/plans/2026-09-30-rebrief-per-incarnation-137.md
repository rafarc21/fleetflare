# Bring-up task re-delivery: per-incarnation, not per-task-forever

**Issue:** https://github.com/rafarc21/fleetflare/issues/137

**Goal:** After an image rollout (or any container replacement), a lead's
fresh pane has zero memory of any task it was ever told about, but
`deliverAssignedTaskOnBringup`'s dedup marker (`DELIVERED_TASK_KEY`, do.ts)
records a task NUMBER forever, with no notion of container identity — so a
task delivered once (e.g. at original assignment, days before the rollout)
is never re-delivered on any later bring-up for that SAME task, even though
the container behind the pane was fully destroyed and rebuilt. The sibling
feature, `deliverSurvivalBriefOnBringup` (survival-delivery.ts), already
solved exactly this by scoping its own dedup to the bring-up's `incarnation`
token (`Observed.incarnation`) rather than any task-shaped identity —
`deliverAssignedTaskOnBringup` never adopted that scoping. This closes that
gap, and widens the trigger from "only the single newest assigned task"
(`resolveLatestAssignedBrief`, "newest wins") to every OPEN task in
`working`/`input_required` — `submitted` is excluded on purpose, since a
submitted task hasn't been started and the ordinary fresh-assignment wake
already covers it.

## Design

### 1. `apps/fleet/src/studio/observed.ts` — the new dedup record

```ts
/** Issue #137: task numbers that have already received a bring-up
 *  re-delivery wake for THIS incarnation. Reset implicitly: a record whose
 *  own `incarnation` no longer matches `Observed.incarnation` reads as
 *  empty, so a container replacement (new incarnation) earns every open
 *  working/input_required task exactly one fresh wake again, even a task
 *  that had already been delivered before the replacement — the gap
 *  `DELIVERED_TASK_KEY` (do.ts) left, because that marker is keyed on the
 *  task number alone and never expires. */
taskWakesDeliveredFor?: { incarnation: string; numbers: number[] } | null;
```

`emptyObserved()` sets it `null`.

### 2. `apps/fleet/src/board/board.ts` — the widened lookup

```ts
export const REBRIEF_TASK_STATES: readonly TaskState[] = ["working", "input_required"];

export async function openTasksNeedingRebrief(
  api: BoardApi, repo: string, studioId: string,
): Promise<{ taskNumber: number; title: string }[]>
```

Same `listTasks(api, repo, {assignedTo: studioId})` call
`resolveLatestAssignedBrief` makes, same fail-open-to-`[]` posture on a
thrown error or `{ok:false}` (a board hiccup at bring-up must never block
provisioning), filtered to `t.open && t.state !== null &&
REBRIEF_TASK_STATES.includes(t.state)`, sorted newest-updated-first (same
`Date.parse` sort `resolveLatestAssignedBrief` uses — order has no
behavioral effect here, since every entry gets delivered; kept only for
deterministic test output).

### 3. `apps/fleet/src/studio/do.ts` — the gate, widened and rescoped

`deliverAssignedTaskOnBringup` (kept as the do.ts standalone extraction, no
DO construction, same as before) is rewritten to:

```ts
export async function deliverAssignedTaskOnBringup(
  storage: StudioStorage,
  incarnation: string | null,
  boardLookup: () => Promise<{ taskNumber: number; title: string }[]>,
  wake: (prompt: string, taskNumber: number) => Promise<WakeOutcome>,
  moved: () => Promise<boolean> = async () => false,
): Promise<void>
```

- Loops over every task `boardLookup()` returns.
- Reads the incarnation-scoped delivered set
  (`Observed.taskWakesDeliveredFor`, off `getObserved`/`mergeObserved` —
  reusing this file's existing `storage as unknown as ObservedStorage` cast
  discipline, the same one `DeliveredTaskStorage`/`LimitSighting` already use
  for their own narrow keyed reads) keyed by `incarnation ?? ""` — a null
  incarnation behaves like the OLD per-task-forever marker (never resets)
  rather than regressing to "never delivers"; real incarnation tokens
  (`isIncarnationToken`) are never empty strings, so this never collides with
  a genuine one.
- For each task NOT already in that set: checks `moved()` immediately before
  the wake (same "AFTER boardLookup, right before wake" ordering the
  pre-existing destroy-veto test pins), calls `wake(prompt, taskNumber)`, and
  on `outcome.ok` records BOTH the OLD `recordDeliveredTask` (unconditional,
  unchanged — harvest/teardown's own "last delivered, forever" pointer) AND
  the NEW incarnation-scoped entry, written on every landed wake (not batched
  at the end), so a mid-loop failure/restart still remembers what already
  landed.

`assignedTaskOnBoard` (private, single-task) is replaced by a call to the new
`openTasksNeedingRebrief`. `deliverTaskOnBringup` (private wiring) reads
`(await getObserved(this.ctx.storage)).incarnation` the same way
`deliverSurvivalOnBringup` already does, and threads it through as the new
2nd param. The refusal log line still names the specific task refused (now
per-task inside the loop, not a single captured `taskNumber`).

### `DELIVERED_TASK_KEY` / `deliveredTaskIn` — unchanged, re-scoped in doc only

Verified before touching anything: `deliveredTaskIn` has a SECOND, unrelated
consumer — `harvestLearnings` (do.ts) reads it at teardown as "the task this
studio was delivered", to pick which completion record
(`/workspace/.fleet/done/<task>.json`) to harvest learnings from. That
consumer wants "the single most-recently-delivered task number, forever",
not incarnation-scoped. So `DELIVERED_TASK_KEY`/`deliveredTaskIn`/
`recordDeliveredTask` are kept EXACTLY as they were — still written
unconditionally on every landed wake, still "last delivered wins" — as a
separate, parallel piece of bookkeeping the new incarnation-scoped record
does not replace. Only the doc comments describing it are corrected: it is
no longer the rebrief gate's own dedup marker, only harvest/teardown's
pointer.

## Test-drive it (TDD)

`test/studio.wake-gate.test.ts`'s `deliverAssignedTaskOnBringup` block:
ported every existing test to the new `(storage, incarnation, boardLookup,
wake, moved?)` shape with an array-returning `boardLookup` and two-arg
`wake`. The pre-existing "a task already delivered: no second wake, across
two separate bring-ups on the same storage" test encoded the bug as intended
behavior; it is now run with the SAME incarnation across both calls (still
asserts at-most-once — that part was never wrong) and a NEW sibling test
proves the fix: same task, same storage, a DIFFERENT incarnation on the
second bring-up — the task IS re-delivered. Confirmed this new test fails
against the pre-fix code path (RED) before implementing, then green after.
Also added: multiple simultaneously-open working/input_required tasks, each
independently dedup'd; the old "newest wins" test rewritten as "both open
tasks are delivered" (the whole premise of picking exactly one is gone under
the array model).

`test/board.board.test.ts`: new `openTasksNeedingRebrief` coverage (empty,
board-error fail-open, filters to working/input_required only, excludes
submitted, excludes closed), modeled on the existing
`resolveLatestAssignedBrief` describe blocks.

## Files touched

- `apps/fleet/src/studio/observed.ts` — `Observed.taskWakesDeliveredFor`,
  `emptyObserved()`.
- `apps/fleet/src/board/board.ts` — `REBRIEF_TASK_STATES`,
  `openTasksNeedingRebrief`.
- `apps/fleet/src/studio/do.ts` — `deliverAssignedTaskOnBringup` rewritten
  (incarnation-scoped, array-based); its own doc comment and
  `DELIVERED_TASK_KEY`/`deliveredTaskIn`'s doc comment corrected;
  `assignedTaskOnBoard` replaced by `openTasksNeedingRebrief`;
  `deliverTaskOnBringup` reads and threads `incarnation`.
- `apps/fleet/src/studio/survival-delivery.ts` — doc comment wording only
  (the "board #213's own DELIVERED_TASK_KEY" contrast, checked for accuracy
  now that the rebrief gate has moved off that marker).
- `apps/fleet/test/studio.wake-gate.test.ts` — ported + new coverage for
  `deliverAssignedTaskOnBringup`.
- `apps/fleet/test/board.board.test.ts` — new `openTasksNeedingRebrief`
  coverage.
- This plan doc.
