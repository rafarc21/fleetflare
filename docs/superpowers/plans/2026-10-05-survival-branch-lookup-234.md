# Survival brief misses a pushed-but-unlinked branch (#234)

**Issue:** https://github.com/rafarc21/fleetflare/issues/234

**Goal:** a restarted lead's survival brief said `Task #231 ...: no branch on
origin` while `fix-231-replaced-session` genuinely existed on origin with 8+
commits. The branch had no open PR and no `{kind:"branch"}` artifact, so none
of `resolveSurvivalInput`'s 3 existing branch sources (survival-delivery.ts)
could find it, even though it was sitting right there on origin.

## Root cause (confirmed by reading the code, not just the issue text)

`resolveSurvivalInput` (survival-delivery.ts ~line 550) resolves each task's
branch through 3 sources, first-resolvable-wins:

- SOURCE 1 (~596): a linked PR's own head branch — needs an OPEN PR artifact.
- SOURCE 2 (~601): a `{kind:"branch"}` artifact explicitly recorded.
- SOURCE 3 (~605-667): the `fleet/rescue/<studio>/...` rescue-ref convention,
  attributed only in the unambiguous single-candidate case
  (`attributeRescueBranch`).

A branch the lead pushes itself, with no PR opened yet and no artifact
recorded, matches none of the three. Confirmed: `fix-231-replaced-session`
does not start with the studio id, so it is not a rescue ref either.

## Fix: SOURCE 4 — anchored task-number match against every branch name

Per the issue's own Fix section, add a 4th source that matches origin branch
NAMES against the task's own number, anchored on `-`/`/` boundaries so
`fix-2310-x` can never match task `231`.

This file's own header doc comment (survival-delivery.ts:13-19, restated at
~488-494) is a hard, incident-backed rule: nothing here ever execs git inside
a studio's own clone (studio clones are shallow/single-branch — #107 measured
a git-log-based ahead-count as wrong). So the new source is a GitHub REST call,
following `SurvivalSources`'s own all-ports-are-GitHub-API-calls convention.

### 1. `src/github/api.ts` — `listAllBranchNames`

New function near `listMatchingBranches` (~963, which is PREFIX-anchored via
`git/matching-refs` and does not help here — a task number is rarely the
literal first token of the branch name). `GET /repos/{owner}/{repo}/branches
?per_page=100`, one page, GitHub's own 100-item max — same "out of scope for
this check" posture `listOpenPullNumbers` (~535) already states for itself,
restated in this function's own doc comment.

### 2. `SurvivalSources` port + `do.ts` wiring

New port `branchNames: () => Promise<string[]>` on `SurvivalSources`
(survival-delivery.ts ~496), wired in `do.ts`'s `survivalSources()` (~5857) to
`listAllBranchNames(await token(), repo)` — same one-call, no-git-exec pattern
every other port there follows.

### 3. `resolveSurvivalInput` — SOURCE 4

A new exported pure helper, `matchesTaskNumber(branch: string, taskNumber:
number): boolean`, anchored both ends: `(^|[-/])<n>([-/]|$)` against the full
branch name.

After SOURCE 3's rescue-ref attribution has run (different ref namespace —
additive, not a replacement) and before the per-task `compareAhead` loop:
recompute `stillUnresolved = resolved.filter(r => r.branch === null)`. If
non-empty, fetch `sources.branchNames()` ONCE for the whole composition
(same "one lookup, not one per task" discipline `pull`'s memoization and
`rescueBranches()` already follow), wrapped in try/catch — a thrown fetch logs
and leaves every still-unresolved task exactly as it was (never fails the
whole call). On success, for each still-unresolved task, filter the full name
list through `matchesTaskNumber`:

- **0 matches** → unchanged, stays `branch: null`, renders "no branch on
  origin" exactly as today.
- **1 match** → mutate `r.branch` in place (same pattern SOURCE 3's
  `unresolved[0]!.branch = attributed` already uses), so the existing
  `compareAhead` loop right after picks it up and resolves ahead-count/last-
  commit-date normally — no duplicated logic.
- **>1 matches** → NOT assigned, and NOT silently left reading as "no branch
  on origin" either. Recorded on a new optional field, `r.ambiguousBranches:
  string[]`, carried through to the final `SurvivalTaskBranch` for that task.

### 4. `SurvivalTaskBranch` + `taskLine` — a 4th distinct render state

`SurvivalTaskBranch` (survival-brief.ts) gains `ambiguousBranches?: string[]`.
`taskLine` (~207) checks it before the `branch === null` case and renders a
new, distinct line — e.g. `- Task #231 "...": ambiguous: 2 branches match
(name1, name2) — resolve manually` — through `sanitizeBranch`, same as every
other branch name this composer renders. A reader of the brief must be able
to tell "found exactly one" / "found none" / "found several, could not pick"
apart, always — this is the same "don't guess, don't drop" shape
`unclaimedRescueBranches`/`Checked<T>` already solve for a different
ambiguity in this same file.

## Tests (RED first)

`test/studio.survival-delivery.test.ts`:
- `matchesTaskNumber` as a pure unit: `fix-231-replaced-session`,
  `234-some-slug`, `task/231-foo` all match; `fix-2310-x` does NOT match 231
  (the issue's own anchoring example).
- `sources()` fixture fixture gains a `branchNames: async () => []` default.
- integration: task 231 + `branchNames` returning
  `["fix-231-replaced-session"]`, no PR, no branch artifact → task's branch
  resolves to that name, `compareAhead` runs against it.
- `fix-2310-x` present in `branchNames`, task 231 unresolved → stays
  `branch: null` (anchoring holds end to end, not just in the unit test).
- 2 matching branches for one task → `branch` stays `null`,
  `ambiguousBranches` carries both names, not dropped.
- SOURCE 4 only runs for tasks still unresolved after sources 1-3 — a task
  already resolved via a PR artifact is untouched even when a same-numbered
  branch also exists.
- `branchNames()` is fetched at most once for the whole composition even with
  multiple unresolved tasks; not fetched at all when every task already
  resolved.
- a thrown `branchNames()` doesn't fail the whole `resolveSurvivalInput` call;
  every other section's work is unaffected.

`test/studio.survival-brief.test.ts`:
- `ambiguousBranches` populated → a distinct rendered line, never containing
  "no branch on origin", listing every candidate name.

`test/github.api.test.ts`:
- `listAllBranchNames`: GETs `/repos/o/r/branches?per_page=100`, returns
  names; throws GitHub's own words on a non-2xx.

## Files touched

- `apps/fleet/src/github/api.ts` — `listAllBranchNames`.
- `apps/fleet/src/studio/survival-delivery.ts` — `SurvivalSources.branchNames`,
  `matchesTaskNumber`, SOURCE 4 in `resolveSurvivalInput`.
- `apps/fleet/src/studio/survival-brief.ts` — `SurvivalTaskBranch
  .ambiguousBranches`, `taskLine`'s new render branch.
- `apps/fleet/src/studio/do.ts` — `survivalSources()` wiring, import.
- `apps/fleet/test/studio.survival-delivery.test.ts`,
  `apps/fleet/test/studio.survival-brief.test.ts`,
  `apps/fleet/test/github.api.test.ts` — coverage above.
- This file.

## Round 2 (PR #239 review, 2026-10-05) — 2 real findings, both confirmed by reading code first

Owner review on #239: `gh pr view 239 --repo rafarc21/fleetflare --comments`.
Both re-derived from the actual code, not trusted from the summary.

### Finding 1: one page only, and this repo is ALREADY past it

`listAllBranchNames` did ONE `GET .../branches?per_page=100` call, no
pagination. `git ls-remote origin 'refs/heads/*' | wc -l` against this repo's
real origin, 2026-10-05: **116 branches**. Already past one page TODAY, not a
someday-maybe. A task branch on page 2 was invisible to SOURCE 4 — the
original #234 bug, unfixed for any repo this size.

Fix: follow the `Link: rel="next"` response header GitHub's REST pagination
sends, capped at `BRANCH_NAMES_MAX_PAGES = 10` (1,000 branches — same "orders
of magnitude above this fleet's scale" sizing `INSTALLATION_REPOS_MAX_PAGES`
already uses). Return shape widened `string[] -> {names, truncated}` — every
caller/mock/fixture updated (api.ts's own test, `SurvivalSources.branchNames`,
every `sources({branchNames})` fixture in survival-delivery.test.ts).
`truncated` threads through `resolveSurvivalInput` onto a new optional
`SurvivalInput.branchLookupTruncated`, rendered by `composeSurvivalBrief` as
its own line naming the cap (1,000) — never silently read as "that's
everything".

Test: exactly 2 pages (page 1 full + `Link: rel="next"`, page 2 the real
tail) — confirms a name that only exists on page 2 is actually found. Plus a
page-cap test (`Link: rel="next"` still present after `MAX_PAGES` fetches ->
`truncated: true`).

### Finding 2: a rescue ref anchor-matches a task number — genuine false positive

Hand-traced `matchesTaskNumber("fleet/rescue/x--web-studio--40/wip/<stamp>",
40)` against the real regex `(^|[-/])40([-/]|$)`: the char before "40" is "-"
(from "--40"), the char after is "/" — BOTH are valid anchor boundaries. True
match, not hypothetical. Any studio id ending `--<n>` collides with task `n`.

SOURCE 3 already owns rescue-ref attribution end to end (including its own
"never guess" ambiguous case) — a `fleet/rescue/` name must never re-enter
SOURCE 4's pool. Fix: filter `allBranchNames` to drop every
`fleet/rescue/`-prefixed name BEFORE `matchesTaskNumber` ever runs against
it, not merely deprioritize it against a real match.

Test (exact reviewer scenario): task 40, candidates
`[fleet/rescue/x--web-studio--40/wip/20261004000000, fix-40-y]` -> resolves to
`fix-40-y`, not ambiguous, not the rescue ref. Plus a variant proving the
exclusion doesn't suppress a GENUINE ambiguous case (2 real branches + 1
rescue decoy -> still ambiguous on the 2 real ones only).

### Files touched, round 2

- `apps/fleet/src/github/api.ts` — `listAllBranchNames` pagination,
  `parseNextLink`, `BRANCH_NAMES_PAGE_SIZE`/`BRANCH_NAMES_MAX_PAGES`.
- `apps/fleet/src/studio/survival-delivery.ts` — `SurvivalSources.branchNames`
  return shape, SOURCE 4's rescue-ref exclusion + truncation threading.
- `apps/fleet/src/studio/survival-brief.ts` —
  `SurvivalInput.branchLookupTruncated`, its rendered line.
- `apps/fleet/test/github.api.test.ts`,
  `apps/fleet/test/studio.survival-delivery.test.ts`,
  `apps/fleet/test/studio.survival-brief.test.ts` — coverage above.
- `do.ts`'s `survivalSources()` wiring needed NO change: `branchNames: async
  () => listAllBranchNames(...)` was already a bare pass-through, and
  `listAllBranchNames`'s new `{names, truncated}` return IS the new
  `SurvivalSources.branchNames` contract.
- This file.
