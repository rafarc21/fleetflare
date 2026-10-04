# Survival-brief/rescue follow-ups left by #227's own review

**Issue:** https://github.com/rafarc21/fleetflare/issues/228

**Goal:** PR #227 fixed "restart brief misses rescue refs on resolved-PR
studios + wt/ shapes; empty-diff rescue counts as success". Its own review
turned up three further gaps — one real fail-hard bug in the re-brief's
rescue-ref fetch, one shipped-without-a-test fix, and one real unbounded-growth
gap in what the re-brief lists. Three independent fixes, each pinned by its
own test. A fourth, pre-existing gap is acknowledged but explicitly left
unfixed (see item 4).

## 1. MEDIUM — `resolveSurvivalInput`'s unconditional rescue-ref fetch has no try/catch

`survival-delivery.ts`'s `resolveSurvivalInput` now calls
`await sources.rescueBranches()` unconditionally (fix #216) with no try/catch
around it. A GitHub 5xx, rate-limit, or network blip there throws the WHOLE
`resolveSurvivalInput` call — every studio's survival brief fails on bring-up
whenever GitHub hiccups even slightly, not just this one section. (There is an
outer catch + deferred-retry in the bring-up delivery path, so it is not lost
forever — just delayed and noisy for every studio over a section failure that
should be local.)

**Fix:** follow this file's own `Checked<T>` convention exactly, the same way
`tasks`/`openPrs` already do ("a failed lookup renders 'could not check
(<reason>)', never a silently blank section" — `survival-brief.ts`'s own
header comment):

1. `SurvivalInput.unclaimedRescueBranches` (survival-brief.ts) widens from
   `string[]` to `Checked<string[]>`.
2. `resolveSurvivalInput` wraps `await sources.rescueBranches()` in try/catch.
   On success, attribution runs exactly as today. On failure: log once
   (`console.error`, matching the `pull`/`compareAhead` ports' own catches
   nearby) and set the section to `{ok: false, reason}` — attribution cannot
   run without the ref list, so every unresolved task simply keeps
   `branch: null`, same as it would if there were zero refs.
3. The early-return branch (`!tasks.ok`) sets `unclaimedRescueBranches` to
   `{ok: false, reason: tasks.reason}` instead of a bare `[]`, matching
   `openPrs`'s own choice in that branch — full symmetry across all 3 `Checked`
   fields when the task data itself is unavailable.
4. `composeSurvivalBrief` gains an `if (!input.unclaimedRescueBranches.ok)`
   branch rendering `- Rescue refs: could not check (<reason>)`, mirroring the
   `tasks`/`openPrs` pattern. `genuinelyEmpty` is updated so a failed check is
   never mistaken for "genuinely nothing to report."

**Test:** every existing call site that sets/asserts a bare array is updated
to `{ok: true, value: [...]}` (`test/studio.survival-brief.test.ts`,
`test/studio.replacement.test.ts`, `test/studio.survival-delivery.test.ts`),
plus a new test: `sources.rescueBranches` rejecting -> `unclaimedRescueBranches`
is `{ok: false, reason}` and the composed brief contains
"Rescue refs: could not check".

## 2. MINOR — the #216 missing-index fix shipped with no test

`rescue_one`'s dirty-tree branch (`rescuePushCmd` and `rescueSnapshotCmd`) can
hand a 0-byte `mktemp` file to `GIT_INDEX_FILE` when no real index exists to
seed from. #216 fixed it (`else rm -f "$idxfile"` instead of leaving the
0-byte file in place) but shipped with no test — the issue's own text records
why one looked unreachable at the time (every real precondition that reaches
`rescue_one` already has a populated index from its own prior checkout). A
fixture does exist, though: deleting the real index file by hand, directly
against the live checkout, before rescue runs. Measured directly
(scratch repro) — a 0-byte `GIT_INDEX_FILE` makes `git add -A` fail with
`fatal: index file smaller than expected` (rc 128), while an ABSENT
`GIT_INDEX_FILE` path makes git build a fresh, valid, empty index on its own
(`rc 0`) — so this is a real, reproducible fixture, not a forced one.

**Fix:** none needed in `rescue.ts` itself — this is a test-coverage gap only.

**Test:** `test/bun/rescue-push.test.ts`, parametrized across both command
builders (`describe.each`-style, same as the existing `#216 fix 3` block):
commit a tracked file, `rm` the real `.git/index` directly
(`$(git rev-parse --absolute-git-dir)/index`), create an untracked file so the
tree reads dirty, run rescue, and assert a real `RESCUE_PUSHED` (the push
succeeds) rather than `RESCUE_FAILED ... add`. Verified RED against the old
(pre-#216) shape in a scratch copy before writing the GREEN assertion, per the
task's own instruction — see "deviations" below.

**Bonus (included):** `wipSyncCmd` (added later, #208) has a THIRD copy of this
exact index-seeding pattern (`if [ -f "$realidx" ]; then cp ...; fi`, no
`else rm -f` branch at all) — the identical bug, just never caught because it
postdates #216's fix and was never back-ported to it. One-line fix
(`else rm -f "$idxfile"`, same as the other two), one test mirroring the above
against `wipSyncCmd`'s own calling convention (`wipSyncCmd(repo, studio,
bootStamp, root)`). Cheap enough (same bug class, same fix, same file) to
include rather than defer.

## 3. MINOR — rescue refs never age out of the re-brief

`unclaimedRescueBranches` (and `rescueBranchesFor`'s underlying list) lists
every anchored rescue ref for a studio on origin forever — nothing ever ages
them out, so a studio with rescue refs from months ago keeps listing them
alongside genuinely recent ones in every future brief.

Every rescue-ref shape `isRescueBranchFor` recognizes already encodes a
14-digit UTC timestamp directly in its own name (the
`$(date -u +%Y%m%d%H%M%S)` convention, `RESCUE_STAMP_DIGITS`) — capping by age
needs zero extra network calls, just parsing the stamp already embedded in the
ref name.

**Fix:**

1. `isRescueBranchFor` is refactored into a one-line wrapper around a new
   sibling, `rescueRefStamp(studioId, branch): string | null`, which returns
   the matched 14-digit stamp (or null) instead of a bare boolean — the
   per-shape anchoring logic (flat/checkout/wt/wip) is not duplicated, only
   exposed.
2. `SURVIVAL_RESCUE_REF_MAX_AGE_DAYS = 14` (survival-delivery.ts), with a doc
   comment on the choice.
3. `resolveSurvivalInput`, after fetching+filtering through
   `rescueBranchesFor`, parses each surviving ref's stamp via
   `rescueRefStamp` + a new `parseRescueStamp(stamp): Date` helper (the
   mirror image of `rescue.ts`'s `formatRescueStamp`, but living here since
   this file owns the read side and `rescue.ts` cannot be imported from here
   without closing an import cycle — same reasoning `formatRescueStamp`'s own
   doc comment already gives for why IT lives in rescue.ts and not here).
   Age is computed against the `now` parameter already threaded through this
   function (never `Date.now()`/`new Date()` with no args). Any ref older than
   the cap is dropped from both the attribution candidate pool and
   `unclaimedRescueBranches` — too stale to list is also too stale to
   attribute.

**Test:** `rescueRefStamp`/`parseRescueStamp` as pure unit tests (no DO, no
network), plus an integration-style test on `resolveSurvivalInput` proving a
20-day-old ref is excluded from `unclaimedRescueBranches` while a 2-day-old one
is kept, using the explicit `now` parameter rather than the real clock.

## 4. NIT, acknowledged but explicitly OUT OF SCOPE

"Index-only content (staged then worktree reverted) not rescued" — recorded in
#228 as a known PRE-EXISTING gap with no fix instruction given. Not addressed
here; left for a future, separately-scoped fix.

## Files touched

- `apps/fleet/src/studio/survival-brief.ts` — item 1 (`Checked<string[]>`,
  the new "could not check" render branch, `genuinelyEmpty`).
- `apps/fleet/src/studio/survival-delivery.ts` — item 1
  (`resolveSurvivalInput`'s try/catch + early-return symmetry), item 3
  (`rescueRefStamp`, `parseRescueStamp`, `SURVIVAL_RESCUE_REF_MAX_AGE_DAYS`,
  the age filter).
- `apps/fleet/src/studio/rescue.ts` — item 2 bonus (`wipSyncCmd`'s own missing
  `else rm -f "$idxfile"`).
- `apps/fleet/test/studio.survival-brief.test.ts`,
  `apps/fleet/test/studio.replacement.test.ts`,
  `apps/fleet/test/studio.survival-delivery.test.ts` — item 1 and item 3
  coverage, and the `unclaimedRescueBranches` shape update everywhere it is
  referenced.
- `apps/fleet/test/bun/rescue-push.test.ts` — item 2 coverage (both command
  builders, plus the `wipSyncCmd` bonus).
- This file.
