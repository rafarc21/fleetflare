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
