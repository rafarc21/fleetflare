# wip refs: live snapshot, not unclaimed; age from last commit, not boot stamp

**Issue:** https://github.com/rafarc21/fleetflare/issues/241 (items 1-3 only;
items 4-5, wip-sync rotation + per-target status, are a follow-up pass on the
same branch, not this one).

**Base:** PR #235 (`fix-231-replaced-session`) is still open/unmerged as of
this plan — branched off its tip, not `main`. Rebase onto `main` once #235
lands.

**Goal:** `rescueRefStamp` matches 5 ref shapes as "this studio's rescue ref".
All 5 flow identically into SOURCE 3's attribution + `unclaimedRescueBranches`.
2 of the 5 (main wip-sync `wip/<14>`, member wip-sync `wip/<14>-wt-<id>`) are
LIVE, periodically-refreshed safety nets, not abandoned work — attributing one
to a task is nonsense, and "unclaimed" implies an abandonment it doesn't have.
Also: the wip shapes' embedded stamp is the boot time, fixed for the whole
container lifetime, while the ref itself is force-pushed with new commits
throughout that boot — the existing 14-day stamp-age filter wrongly drops a
long-running studio's wip ref even though its last commit is fresh.

## 1. Recognize a wip ref as its own shape

New exported `isWipRescueRef(studioId, branch): boolean` in
`survival-delivery.ts`, matching only the two wip shapes (`wip/<14digits>` and
`wip/<14digits>-wt-<id>`) under the nested prefix — reuses
`rescueBranchNestedPrefix`, same anchoring discipline as `rescueRefStamp`
(never a bare substring, never an unescaped studio-id regex). Does not touch
`rescueRefStamp`/`isRescueBranchFor` — both keep matching all 5 shapes exactly
as before (SOURCE 3's fetch + `rescueBranchesFor` filter stay unchanged); the
new predicate is applied AFTER that filter, as a partition.

## 2. Partition before attribution, new `SurvivalInput.liveWipRefs`

`SurvivalInput` (survival-brief.ts) gains `liveWipRefs: Checked<string[]>`,
same `Checked<T>` convention as `unclaimedRescueBranches`. In
`resolveSurvivalInput`'s SOURCE 3 block: split `fetched` into `realRefs` /
`wipRefs` via `isWipRescueRef`, BEFORE the age filter, BEFORE
`attributeRescueBranch`, BEFORE `unclaimedRescueBranches`. `realRefs` flow
through the EXACT existing age filter + attribution + unclaimed logic,
byte-for-byte unchanged (just reading `realRefs` instead of `fetched`). `wipRefs`
never reach `attributeRescueBranch` — excluded by construction, fixing item 3
as a direct consequence of the partition (no new "exclude wip" check needed;
wip refs are simply never in the list attribution sees).

Early-return (`!tasks.ok`) and the outer catch (rescue-branch fetch itself
throws) both set `liveWipRefs` symmetrically with `unclaimedRescueBranches`
(`{ok: false, reason}`).

## 3. wip age from `compareAhead`, not the boot stamp

For each `wipRefs` entry (after the partition, inside the same try block):
call `sources.compareAhead(ref)`, apply the SAME `SURVIVAL_RESCUE_REF_MAX_AGE_DAYS`
cutoff against `lastCommitAt` instead of the parsed stamp. Three outcomes,
same discipline as every other per-ref lookup in this file:
- `null` (404, ref genuinely gone) -> drop.
- thrown error -> KEEP (never discard a real ref over a lookup this function
  failed to make — same words as the existing age-filter comment).
- `lastCommitAt` null (compare succeeded, no date) -> KEEP, same reasoning.
- a real `lastCommitAt` -> keep iff `now - lastCommitAt <= maxAgeMs`.

Non-wip refs keep the EXACT existing `parseRescueStamp`-based filter,
untouched.

## 4. Render `liveWipRefs` as its own line

`survival-brief.ts`: new `liveWipSnapshotLine(ref)` ->
`- Live wip snapshot: <ref> (refreshed periodically while the studio was
running, not attributed to any task)` — `sanitizeBranch`, same as
`unclaimedRescueLine`. New section in `composeSurvivalBrief`, right after the
`unclaimedRescueBranches` section (same SOURCE 3 origin), following the exact
`Checked<T>` render pattern (`could not check (<reason>)` / per-ref lines,
capped at `MAX_LINES_PER_SECTION`, `+N more`). `genuinelyEmpty` gains the
`liveWipRefs.ok && liveWipRefs.value.length === 0` conjunct.

## Tests (TDD, RED first)

`test/studio.survival-delivery.test.ts`:
- `isWipRescueRef` unit-matches both wip shapes, rejects all other 4 shapes
  and foreign studios.
- Combined scenario: a main wip ref + a member wip ref among
  `rescueBranches()`'s output, one lone unresolved task -> both land in
  `liveWipRefs`, neither in `unclaimedRescueBranches`, task stays
  `branch: null` (items 1 + 3).
- Existing test "the nested member wip ref gets the SAME unclaimedRescueBranches
  treatment..." pinned the OLD (buggy) behavior directly contradicted by item
  1 — rewritten to assert the NEW behavior (`liveWipRefs`, not
  `unclaimedRescueBranches`) with an updated doc comment explaining why.
- Item 2: a member wip ref whose boot stamp is >14 days old, `compareAhead`
  mock returns `lastCommitAt` 2 minutes old -> survives. A real (non-wip) ref
  with the SAME old stamp -> still dropped (existing behavior unchanged).
- A wip ref's `compareAhead` 404s -> dropped from `liveWipRefs`. Throws ->
  kept.
- Error-path symmetry: rescue-branch fetch itself throws, and `!tasks.ok` ->
  `liveWipRefs` mirrors `unclaimedRescueBranches`'s `{ok: false, reason}`.

`test/studio.survival-brief.test.ts`:
- A brief with one `unclaimedRescueBranches` ref and one `liveWipRefs` ref
  shows BOTH lines, worded distinctly, neither absorbing the other.
- `could not check` rendering for a failed `liveWipRefs` check.
- `genuinelyEmpty` still collapses to `""` when every section (including
  `liveWipRefs`) is checked-and-empty.

Existing literal `SurvivalInput`/`composeSurvivalBrief({...})` call sites
(`test/studio.replacement.test.ts` x3, `test/studio.survival-delivery.test.ts`
x1, `test/studio.survival-brief.test.ts`'s `baseInput`) gain
`liveWipRefs: { ok: true, value: [] }` — the field is non-optional, same as
`unclaimedRescueBranches`.

## Files touched

- `apps/fleet/src/studio/survival-delivery.ts` — `isWipRescueRef`, the SOURCE
  3 partition + wip-specific age filter in `resolveSurvivalInput`.
- `apps/fleet/src/studio/survival-brief.ts` — `SurvivalInput.liveWipRefs`,
  `liveWipSnapshotLine`, the new render section + `genuinelyEmpty` conjunct.
- `apps/fleet/test/studio.survival-delivery.test.ts`,
  `apps/fleet/test/studio.survival-brief.test.ts`,
  `apps/fleet/test/studio.replacement.test.ts` — new coverage + the
  `liveWipRefs` field added to existing literal fixtures.
- This file.

## Items 4-5 (follow-up pass, same branch, on top of items 1-3)

Base: items 1-3 commit (66709b5), on top of merged #235.

### Item 4 — rotate wip-sync target walk start each tick

Bug: main checkout always first, members always same order
(`worktree list --porcelain` order). Slow early target burns
`wip_budget_ok`'s budget, starves whoever sorts last, every tick, forever.

Fix: `wipSyncCmd` (rescue.ts) gains trailing param `rotationIndex = 0`.
Bash side: build ONE flat array (`targets_dir[]`/`targets_ref[]`), main
checkout as index 0, each member worktree appended by the SAME
`worktree list --porcelain` loop (restructured from "call then loop" to
"collect into arrays then one loop"). `tcount` = array length, computed
fresh each run. `tstart = rotationIndex % tcount` (bash integer math,
negative-safe). Walk `tcount` times from `tidx = (tstart + i) % tcount`,
calling `wip_sync_one` in THAT order. Bash 3.2 safe: indexed arrays only,
no `case` inside `$(...)`, same discipline as the rest of this file
(see PR #263 round 5 comment on `checked_out` for why).

do.ts: `wipSync` reads `Observed.wipRotationIndex` (new field,
observed.ts, default 0/absent-reads-0) via `getObserved` BEFORE building
the command, passes it into `wipSyncCmd`, and the caller
(`syncSessionCycle`) persists `wipRotationIndex + 1` AFTER, regardless of
success/partial-failure/full-failure (fairness-over-time, not
fairness-only-on-success). Plain `+1`, wrap at 1_000_000 before persisting
(cheap safety valve, bash's own `%` against the REAL per-tick count is what
actually matters; the TS-side counter never needs to be exact).

Tests (`test/bun/rescue-push.test.ts`, real git fixtures, 2nd member
worktree `agent-zz` added alongside existing `agent-a1b2`):
- rotationIndex 0 on 3 targets (main + 2 members): main's own PUSHED line
  is first in stdout (unchanged default behavior).
- rotationIndex 1 on the SAME 3 targets: a DIFFERENT target's PUSHED line
  is now first (order rotated by exactly 1).
- rotationIndex large enough to need wraparound (e.g. 7 against 3 targets,
  7 % 3 = 1) behaves identically to rotationIndex 1 — proves real modulo,
  not a guess/clamp.
- main-checkout-only (no member worktrees, count=1): any rotationIndex
  still runs main first — `1 % 1 = 0` always, so no behavior change
  possible, asserted directly.
- existing tests calling `wipSyncCmd` with no rotationIndex arg keep
  passing unchanged (default 0 reproduces today's fixed order).

### Item 5 — per-target wipLastCheck, not one blended value

Bug: main pushes + a member fails, SAME tick ->
`mainCheckoutPushFromFailure` recovers main's success,
`wipLastCheckResultOf` labels the WHOLE tick "pushed", member's failure
vanishes from `Observed.wipLastCheck` entirely. `fleet ls` shows a clean
bill of health while a member's safety net is silently broken.

Finding: `RescuePushFailedError.fails` (do.ts) ALREADY carries every
per-target `RESCUE_FAILED <target> <step>` line parsed off wip-sync's own
real stdout (`wip_sync_one` already emits `RESCUE_FAILED_PREFIX $wtarget
<step>` on every one of its own failure returns — nothing new to add to
rescue.ts for this item). `.pushes` already carries every per-target
`RESCUE_PUSHED` line the same way. So both outcomes are already parsed;
the gap is purely TS-side composition: `mainCheckoutPushFromFailure` only
ever pulls ONE name (main's) back out, and `wipLastCheckResultOf` only
ever produces ONE value for the whole tick.

Fix:
- `Observed.wipLastCheck` (observed.ts) type changes from one
  `{at, result}` to `Record<string, {at, result}>`, keyed by the target's
  own push/fail ref name (main's `wipSyncRef(...)`, each member's own
  `wip/<stamp>-wt-<id>` ref) — both already byte-identical strings between
  `.pushes[].branch`/`.fails[].worktree` and `wipSyncRef`, no new
  derivation needed.
- New `wipTargetChecksFrom(studio, bootStamp, result, err)` (do.ts):
  reads whichever of `result`/`err` is non-null, labels every named
  target "pushed" (from `.pushes`) or "failed" (from `.fails`), and
  additionally labels the MAIN target with `wipLastCheckResultOf(result)`
  when `result` is given and no `.pushes` line named main already (covers
  the quiet clean/markers-only/no-checkout cases, where wip-sync's own
  script never emits a per-target line at all — a real limitation of the
  shell side, not fixed here: a quiet MEMBER target is invisible on a
  fully-quiet tick, same as it always was).
- `syncSessionCycle`'s call site replaces the old
  `recordWipLastCheck(..., wipLastCheckResultOf(result))` /
  `recordWipLastCheck(..., "pushed")` / `recordWipLastCheck(...,
  "failed")` three-way branch with ONE call per branch, passing
  `wipTargetChecksFrom(...)`'s own map — `mainCheckoutPushFromFailure`
  still separately drives `recordWipSyncOnSuccess` (the `wipSyncedAt`
  stamp), unchanged.
- `recordWipLastCheck`'s signature changes from a single
  `WipLastCheckResult` to the per-target map; stamps `now` onto every
  entry, replaces the whole stored map each tick (same "stamps on every
  attempt" discipline, now per-target instead of blended — NOT merged
  with a prior tick's map, since a target silently absent this tick has
  no fresh evidence either way).
- `cli/wip-format.ts`: `formatWipCell`/`formatWipInspectLines` read the
  new `Record` shape. Floor requirement: never render "pushed" when ANY
  target's latest entry is "failed". `formatWipCell` rolls up to the
  single worst entry by priority `failed > pushed > no-checkout >
  markers-only > clean` (failed always wins; among the rest, a real push
  is the most informative to surface). `formatWipInspectLines` keeps its
  existing "synced <age>" line (from `wipSyncedAt`, untouched) and appends
  ONE "last attempt FAILED" line PER failed target (sorted by key, for
  determinism) instead of at most one for the whole tick.

Tests:
- `test/studio.session.test.ts`: the EXISTING end-to-end test ("a member
  worktree's wip-sync failure never masks the main checkout's own real
  success") already sets up exactly this scenario (main RESCUE_PUSHED +
  member RESCUE_FAILED, same exec) — extended to assert BOTH
  `wipLastCheck[mainRef].result === "pushed"` AND
  `wipLastCheck[memberRef].result === "failed"` simultaneously (was only
  asserting the old blended `.result === "pushed"`, which is exactly the
  bug this item fixes).
- New unit tests for `wipTargetChecksFrom` mirroring
  `mainCheckoutPushFromFailure`'s own existing describe block: success
  only, error with main+member mixed, error with ONLY a member named,
  quiet success (clean/markers/no-checkout) labels main only.
- `recordWipLastCheck` unit test: writes the per-target map, stamping
  `now` on every entry.
- `test/bun/fleet-ls-wip.test.ts`: existing `wipLastCheck: {at, result}`
  literal fixtures migrate to `wipLastCheck: {"<key>": {at, result}}`.
  New case: two targets, one "pushed" one "failed" -> `formatWipCell`
  reads the failed one's age with trailing `!`, never "pushed".
  `formatWipInspectLines`: two failed targets -> two "last attempt FAILED"
  lines, one per target.

## Files touched (items 4-5)

- `apps/fleet/src/studio/rescue.ts` — `wipSyncCmd`'s new `rotationIndex`
  param, the flat-array target walk.
- `apps/fleet/src/studio/do.ts` — `wipSync` reads/threads rotation index;
  `wipTargetChecksFrom`; `recordWipLastCheck`'s new signature;
  `syncSessionCycle`'s wip-sync block.
- `apps/fleet/src/studio/observed.ts` — `Observed.wipRotationIndex`,
  `Observed.wipLastCheck`'s new per-target type.
- `apps/fleet/cli/wip-format.ts` — `formatWipCell`/`formatWipInspectLines`
  read the per-target map, worst-status rollup.
- `apps/fleet/test/bun/rescue-push.test.ts`,
  `apps/fleet/test/studio.session.test.ts`,
  `apps/fleet/test/bun/fleet-ls-wip.test.ts` — new/updated coverage.
- This file.

## Round 1 review fixes (PR #245, maestro round 1 of 2 — round 2 is final)

2 major (small), 3 minor ("fix if cheap" — done, not deferred).

### MAJOR 1 — `wipLastCheck` shape change has no back-compat either direction

Bug: item 5 changed `Observed.wipLastCheck` from one blended `{at,result}`
object to a per-target map, with no migration. An OLD record (`{at,
result:"failed"}`, written before this field became a map) read by the NEW
`worstWipCheck`/`formatWipInspectLines` iterates `Object.values` and gets the
bare strings `"<iso>"`/`"failed"` as "entries" — neither has `.result`, so the
failure silently vanishes (`formatWipCell` reads `-`/age-with-no-`!`, inspect
prints no FAILED line). Reverse (old CLI/reader expecting the flat shape,
reading a record the NEW code wrote as a map) also hides it: `.result` on a
`Record` is `undefined`.

Fix:
- Read side (`cli/wip-format.ts`): new `normalizeWipLastCheck(stored)`,
  duck-types which shape a stored value actually is, ONCE — any key whose own
  VALUE is itself `{at,result}`-shaped is a real per-target entry; when NONE
  are (the value itself has top-level `at`/`result` strings), it's folded
  into a single entry under a fixed sentinel key (`"(legacy)"`, never a real
  ref name — those always contain `/`). `worstWipCheck` and
  `formatWipInspectLines`'s own loop both run through this ONE normalized
  shape — no duplicated rollup logic.
- Write side (`do.ts`'s `recordWipLastCheck`): now ALSO stamps a derived
  `at`/`result` SUMMARY pair (the worst result across every named target, by
  the identical priority order `wip-format.ts` uses, duplicated here since
  `src/` cannot import `cli/`) onto the SAME stored object, alongside the
  real per-target entries — an old reader that only ever looks at
  `wipLastCheck.at`/`.result` directly still sees a sensible single value.
  `normalizeWipLastCheck` recognizes this hybrid shape correctly: real
  per-target entries win whenever even one exists; the decoration keys are
  only read as a target when none do.
- `Observed.wipLastCheck`'s TYPE widened to a union (map OR legacy flat
  object) so a row genuinely written before this field existed types cleanly
  too.
- Fixture tests, both directions, as asked:
  (a) NEW code reading an OLD-shape record (`test/bun/fleet-ls-wip.test.ts`,
      "legacy single-value back-compat" describe block) — `formatWipCell`/
      `formatWipInspectLines` against a hand-written flat `{at,result}`
      value; a hybrid (map + legacy decoration) fixture too, proving
      decoration is ignored whenever real per-target entries exist.
  (b) an old reader (simulated by reading `.at`/`.result` directly off the
      stored value) seeing a record `recordWipLastCheck` (NEW code) wrote —
      `test/studio.session.test.ts`'s "old-CLI back-compat" describe block.

### MAJOR 2 — a `compareAhead` 404 must not drop a live wip ref

Bug: `survival-delivery.ts`'s wip-ref age-filter loop treated `compareAhead`
returning `null` as "ref genuinely gone, drop it" — correct for every other
ref shape (real shared history with `main`, so a 404 really does mean gone),
wrong for a wip ref specifically: rescue.ts's own shallow-clone fallback can
push one as a PARENTLESS commit with no shared ancestry with `main` at all,
and GitHub's compare API answers THAT with its own 404 ("No common
ancestor") — indistinguishable from "ref doesn't exist" at the HTTP level,
but the ref is very much alive.

Fix: a wip ref's `compareAhead` 404 is now treated exactly like the
thrown-error case right next to it — KEEP, age unknown (`lastCommitAt:
null`). There is no OTHER signal in this function to confirm a wip ref is
genuinely absent (that confirmation already happened upstream, in the
`rescueBranches()` listing it came from) — only a confirmed-absent ref from
THAT listing should ever drop one, never this per-ref compare's own 404.
`SurvivalInput.liveWipRefs` widened from `string[]` to a new
`SurvivalWipRef[]` (`{branch, lastCommitAt}`) so "age unknown" can thread
through to the render side; `liveWipSnapshotLine` (survival-brief.ts) renders
it explicitly ("age unknown"), same "unknown" word `taskLine` already uses
for the identical "checked, could not tell" situation, rather than silently
omitting any age.

### MINOR 3 — sort wip refs newest-first before the display cap

Bug: `composeSurvivalBrief`'s "Live wip snapshot" section sorted ascending
(oldest boot stamp first) before capping at `MAX_LINES_PER_SECTION` (8) — a
fleet with more than 8 live wip refs always truncated the NEWEST one into
"+N more", exactly backwards from what a reader needs.

Fix: sort DESCENDING (newest boot stamp first) before capping — one
`.sort()` direction flip. The ref's own embedded boot stamp is still fine for
SORTING (a weaker, display-ordering-only use) even though MAJOR 2 means it's
no longer trusted for the age/staleness DECISION.

### MINOR 4 — bound the per-wip-ref `compareAhead` lookups

Bug: the age-filter loop called `compareAhead` once per wip ref, serially,
unbounded — a studio with many member worktrees could burn a lot of
sequential API calls composing ONE re-brief, many of which would be
immediately truncated into "+N more" by the render cap anyway.

Fix: sort wip refs descending by boot stamp (same sort MINOR 3 needs) and
slice to `MAX_LINES_PER_SECTION` (now exported from survival-brief.ts and
reused here, rather than a second constant that could drift) BEFORE any
`compareAhead` call runs — only the refs that could possibly be displayed
are ever looked up at all.

### MINOR 5 — main must report its own result, never borrow a member's

Bug: `wipTargetChecksFrom`'s fallback label for the main target
(`out[mainRef] = wipLastCheckResultOf(result)`) ran whenever `mainRef` was
absent from `.pushes`, including when some OTHER target (a member worktree)
DID push in the same tick. `result.pushed` is a BLENDED flag — true the
moment ANYTHING in the whole exec pushed — so `wipLastCheckResultOf` read it
as "pushed" and mislabeled main "pushed" even though main's own push never
happened.

Fix: that fallback now only runs when `pushes.length === 0` (genuinely
nothing named at all — the fully-quiet case it was meant for). When
something else named a push but main wasn't among them, main reads "clean"
— the one honest label available (main did not push, and wip-sync's own
script emits no per-target quiet reason when anything else in the same tick
pushed, so there's no finer label to give it) — never "pushed".

### Tests touched (round 1 fixes)

- `apps/fleet/cli/wip-format.ts` — `normalizeWipLastCheck`.
- `apps/fleet/src/studio/do.ts` — `recordWipLastCheck`'s legacy-summary
  write, `wipTargetChecksFrom`'s main-fallback fix.
- `apps/fleet/src/studio/observed.ts` — `wipLastCheck`'s widened type.
- `apps/fleet/src/studio/survival-brief.ts` — `SurvivalWipRef`,
  `MAX_LINES_PER_SECTION` exported, `liveWipSnapshotLine`'s "age unknown"
  rendering + newest-first sort.
- `apps/fleet/src/studio/survival-delivery.ts` — wip-ref age-filter loop:
  404-keeps, sort+cap before `compareAhead`.
- `apps/fleet/test/bun/fleet-ls-wip.test.ts`,
  `apps/fleet/test/studio.session.test.ts`,
  `apps/fleet/test/studio.survival-brief.test.ts`,
  `apps/fleet/test/studio.survival-delivery.test.ts` — new/updated coverage
  for all 5 findings, including both explicitly-requested MAJOR 1 fixture
  directions.
- This file.
