# Rescue-push to private remote refused: workflow scope + skip already-on-origin

**Issue:** https://github.com/rafarc21/fleetflare/issues/233

**Goal:** rescue-push to `FLEET_RESCUE_REMOTE` rejected: "refusing to allow a
Personal Access Token to create or update workflow ... without `workflow`
scope". Root cause: a worktree touching `.github/workflows/*` pushed to a
remote with disjoint history reads as a workflow create/update to GitHub.
Issue asks for both fixes.

## Root cause (systematic-debugging, phase 1-3, done before any code change)

Reproduced live (scratch repro, not committed): a worktree detached at a
commit that is a genuine ANCESTOR of origin's current default-branch tip, no
local `refs/remotes/origin/main` (deleted, simulating a fetch-by-sha
member checkout that never set one up) -> `rescue_check_ahead`'s `wahead`
count comes back non-zero (no remote-tracking ref proves ancestry locally)
-> `rescue_on_origin "$w" "$sha" "$branch"` is asked, `$branch` is EMPTY
(detached HEAD, `symbolic-ref --short HEAD` fails) -> the function's own
ancestor-check path (`[ -n "${3:-}" ] || return 1`) returns 1 immediately,
never even tries the fetch-and-merge-base check -> only the exact-tip match
(sha membership in `ls-remote --heads`) is left, which fails for a worktree
BEHIND the tip -> `rescue_on_origin` wrongly says "not on origin" -> a real
push to the rescue remote is attempted for content that was already safe.

Confirmed the SAME exact-tip case (worktree AT origin's default tip,
detached, no tracking ref) already returns `RESCUE_CLEAN` correctly today
-- the exact-tip match does not depend on a branch name at all. So only the
ANCESTOR (behind-tip) case is the real gap; no fix needed for the at-tip
case, only a regression test.

## Part 1 -- widen the rescue mint's requested permissions for push

`rescueMintPermissions("push")` currently returns `{ contents: "write" }`.
Add `workflows: "write"` for `purpose === "push"` only; `"discovery"` stays
`{ contents: "read" }` (list/fetch only, no workflow-scope need).

Traced the whole path before touching it:
- `do.ts`'s `rescueTarget()` passes this to `containerToken(env,
  workRepoSlug, repo, rescueMintPermissions(purpose))` where `repo` is the
  RESCUE slug (resolved from `FLEET_RESCUE_REMOTE`), never the work repo --
  confirmed by reading `resolveRescueTarget`'s own `mint(slug)` call.
- `resolveRescueTarget` only ever calls `mint` after `rescueRepoIsPrivate`
  (issue #7's guard) already confirmed the RESCUE repo private. No new
  privacy guard needed -- the existing one already gates every path that
  reaches this widened permission.
- `containerToken` (write-proxy/mode.ts) forwards `{ permissions }` straight
  to `mintRepoToken` -> `mintInstallationToken` (github/app.ts) whose own
  doc comment (read in full, not assumed) says plainly: GitHub's
  `permissions` field on the token-mint endpoint can only NARROW the App's
  own installed/configured permissions, never widen past them.

**This means:** this code change alone does nothing if the GitHub App
installation itself was never granted a `workflows` permission in its own
GitHub settings -- that is an operator-side App-settings change, outside
this repo, outside anything a container can do. Stated plainly in the PR
body; not something this PR can verify or fix from inside the repo.

**Test:** `test/studio.rescue-token.test.ts` updated first (TDD): the
existing `rescueMintPermissions("push")` assertion widens to
`{ contents: "write", workflows: "write" }` -- fails against the
unmodified function, then the function is changed to match.

## Part 2 -- skip a worktree already on origin before any push is attempted

`rescue_on_origin`'s ancestor-check (issue #80's own fix, matches the
worktree's OWN branch name `$3` against an identically-named origin branch)
is extended to ALSO try origin's own DEFAULT branch name, resolved via
`git symbolic-ref -q refs/remotes/origin/HEAD` (set by every clone,
shallow included) with its `refs/remotes/origin/` prefix stripped by
parameter expansion. Tried in a small loop (dedup if `$3` already equals
the default name) sharing the same budget check, scratch ref, and cleanup
-- first ancestor match wins, no duplicated block.

This closes the real gap: a detached-HEAD worktree (no `$3` at all) or one
whose branch name was never pushed under that name, genuinely behind (not
AT) a moved-ahead default-branch tip, with no local tracking ref to prove
it for free, is now recognized as "already on origin" and the push to the
rescue remote (private, workflow-scope-sensitive or not) never happens at
all -- closing the false failure regardless of Part 1's token scope.

**Test:** `test/bun/rescue-push.test.ts`, two new cases following the
existing real-git fixture style (`#263 C3`'s pattern):
1. worktree HEAD exactly at origin's default-branch tip (detached, no
   local tracking ref) -> `RESCUE_WT ... nothing`, no push, no FAILED.
   Written as regression coverage for a case confirmed ALREADY correct
   (no code change needed for this one -- confirmed by RED-testing it
   against the unmodified function too: it already passes).
2. worktree HEAD an ancestor of origin's default-branch tip (behind,
   detached, no local tracking ref) -> same assertions. RED against the
   unmodified `rescue_on_origin` (reproduces a real push attempt instead),
   GREEN after the fix.

## Files touched

- `apps/fleet/src/studio/rescue.ts` -- `rescueMintPermissions` (Part 1),
  `rescueOnOriginFn` (Part 2).
- `apps/fleet/test/studio.rescue-token.test.ts` -- Part 1 assertion update.
- `apps/fleet/test/bun/rescue-push.test.ts` -- Part 2's two new cases.
- This file.
