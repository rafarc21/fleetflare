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
  `rescueOnOriginFn` (Part 2), and its own stale doc comment ("exact tip
  match only" -- no longer true once Part 2's ancestor check shipped).
- `apps/fleet/test/studio.rescue-token.test.ts` -- Part 1 assertion update.
- `apps/fleet/test/bun/rescue-push.test.ts` -- Part 2's two new cases, plus
  a real-git test-infra fix (Part 3, below).
- This file.

## Part 3 (added after QA flagged the suite RED) -- the #253 git-safety
## wrapper was refusing this file's own throwaway fixture pushes

QA re-ran `bun test apps/fleet/test/bun/rescue-push.test.ts` fresh inside a
provisioned studio container and got 10 real failures (6 pre-existing, 4 on
Part 2's own new cases), contradicting the "green" self-report. Root-caused
with `systematic-debugging`, not assumed:

1. Reproduced directly: `/usr/local/bin/git` -- this very repo's OWN #253
   `studioGitWrapperScript`, installed into every PROVISIONED studio
   container ahead of real git on PATH -- refuses any push whose dry run
   says it would move the remote's resolved default branch. It cannot tell
   a real tracked repo apart from this test file's own throwaway
   `git init --bare` fixtures (`origin`/`priv`, under `tmpdir()`, deleted
   every `afterEach`) -- a SECOND push to an already-real "main" on one of
   those scratch repos (simulating origin having moved, or confirming a
   worktree is already covered by it) gets the exact same refusal a real
   studio pushing the real default branch would get.
2. Confirmed this is NOT a Part 2 regression: checked out `main` (pre-#233)
   in a scratch worktree and ran the identical suite -- the SAME 6 failures
   (`#216 fix 3`, `#313 Finding 3`, issue #1's `-nff` fallback, each x2
   builders) reproduce byte-for-byte already on `main`. Part 2's own 4 new
   cases fail the SAME way, for the SAME reason (their own fixtures push a
   second time to a scratch "main" too) -- not a flaw in the new
   `rescue_on_origin` ancestor-check loop.
3. Proved Part 2's shipped code is correct: ran the suite with the wrapper
   excluded from PATH (`PATH="/usr/bin:/bin:$PATH"`) -- 160/160 pass, 0
   fail, including both of Part 2's own new cases. The ancestor-check loop
   (`$3` then `$__rdef`) works exactly as designed; the failures were pure
   test-environment interference, never a logic bug.
4. Fixed at the right layer -- the TEST file, not `rescue.ts` (whose logic
   was already proven correct): `resolveRealGit()`/`REAL_GIT_SHIM_DIR`
   (new, module-level, same "goes first on every fixture's PATH" convention
   `TIMEOUT_SHIM_DIR` already uses) route `git` straight past
   `STUDIO_GIT_WRAPPER_PATH` for every fixture in this file, reusing
   `STUDIO_REAL_GIT_PATH` (credentials.ts) instead of a second,
   independently-PATH-dependent lookup. The pre-existing `issue #1` describe
   block's own `REAL_GIT` constant (`Bun.which("git", { PATH:
   process.env.PATH })`) had the identical bug -- it resolved to the wrapper
   itself inside a provisioned studio container, which is exactly the
   failure its own doc comment already described for a DIFFERENT prior
   cause (issue #8) without catching this one -- now reuses the shared,
   fixed `REAL_GIT_BIN`. A host with no wrapper installed (CI, a developer's
   own machine) builds no shim at all: `STUDIO_GIT_WRAPPER_PATH` simply does
   not exist there, so `git` resolves exactly as it always did.
5. Re-verified genuinely green with the wrapper back in its normal place on
   PATH (no `PATH=` override): `bun test
   apps/fleet/test/bun/rescue-push.test.ts` -- 160 pass, 0 fail, 613
   expect() calls.

## Round 2 (2026-10-05, PR #236 maestro review) -- Fix 1's blocker + Fix 2's extra coverage

Maestro's own review on PR #236, quoted in full in the dispatch for this
round: `rescueMintPermissions("push")` always asking for `workflows: write`
means an App installation that was never granted that permission 422s
EVERY push-purpose mint, not only the rare one that touches
`.github/workflows/*` -- turns a narrow fix into a universal regression
(every rescue push falls back to the leak-gated origin path). Required a
retry: full permissions first, narrower (`{contents: write}` only) on a
mint rejection shaped like a permissions rejection.

### Where the retry lives

Traced before touching anything (systematic-debugging): `do.ts`'s
`rescueTarget()` used to call `rescueMintPermissions(purpose)` ITSELF,
outside the `mint` closure it hands to `resolveRescueTarget` -- so
`resolveRescueTarget` never had the permissions object in hand at all, only
an already-scoped `mint(repo) => Promise<string|null>`. A retry with a
DIFFERENT permissions object has to be able to ask for that different
object, so `mint`'s own signature had to grow a second parameter:
`(repo, permissions) => Promise<string|null>`. `resolveRescueTarget` now
computes `rescueMintPermissions(purpose)` itself and passes it to `mint` on
every call (full, then narrower on retry) -- `do.ts`'s closure shrank to a
single parameter rename (`permissions` in, `rescueMintPermissions(purpose)`
out), since `containerToken` already took permissions as a plain argument.

New helper `mintRescuePushToken` (rescue.ts, not exported -- tested through
`resolveRescueTarget`'s own stubbed `mint`, same convention every other
case in that function already uses): tries `mint(repo, permissions)`; on a
rejection, retries ONCE with `{contents: "write"}` only, but ONLY when
`permissions.workflows !== undefined` (discovery/narrow calls have nothing
to retry -- its own contract stays untouched, exactly as the review asked)
AND the rejection is a `MintTokenError` with `status === 422`. On a
successful narrower retry: logs exactly one line (`"rescue: token minted
without workflows; workflow-touching pushes may be refused -- grant App
Workflows: write"`) and returns that token -- used for the push, never
discarded in favor of origin.

### Detecting "this 422 is about permissions" -- documented decision

A 422 alone does not uniquely mean "GitHub rejected these permissions" --
`mintRepoToken` (github/auth.ts) already has its OWN 422 case (a
renamed/transferred repo) and retries that internally before ever
re-throwing. GitHub's response body for a permission-not-granted mint is
not a documented, stable, machine-parseable shape this code can safely
text-match against, and there is no live App installation lacking
Workflows available to confirm one against -- so this does NOT attempt to
text-match the response body at all. Decision: by the time a 422 escapes
`mint()`, `mintRepoToken`'s own rename-retry has ALREADY run and ruled
itself out (it only re-throws the original error once its own
canonical-name retry also found nothing to fix) -- what's left is either a
genuine permissions rejection or some other validation failure this code
cannot name from here. Retrying narrower on EITHER is safe: it costs one
extra mint call, and succeeding is strictly better than falling back to
origin regardless of the real cause; if the real cause was unrelated, the
narrower mint fails too and this falls through to the exact SAME
origin-fallback a pre-this-fix failure already used. The warning logged on
a successful narrower retry is accurate either way: the resulting token
genuinely lacks `workflows`.

**Test** (`test/bun/rescue-remote.test.ts`, new describe block): a stubbed
`mint` rejecting with `MintTokenError(422, ...)` whenever `permissions.
workflows` is set, succeeding otherwise -- asserts both calls happen in
order with the right permissions objects, the one-line warning is logged,
and the narrower token is the one actually returned for the push. Three
more cases: discovery never retries (never asks for workflows at all); the
narrower retry ALSO failing falls back to origin exactly like any other
mint failure (no infinite retry, `calls` stays at 2); a non-`MintTokenError`
or non-422 failure never retries at all (`calls` stays at 1) -- RED against
the unmodified code (3 of 5 failed for the right reason: no second call,
no permissions argument at all, or wrong returned content), GREEN after
`mintRescuePushToken` shipped.

### Fix 2's extra coverage (dirty-tree snapshot on an ancestor HEAD)

Read `rescue_one`'s own dirty-tree branch (both command builders) before
writing anything: it does NOT call `rescue_on_origin` at all for a
genuinely dirty tree -- it unconditionally commits a throwaway snapshot and
pushes it; `rescue_on_origin`'s ancestor-check only ever guards the
CLEAN-but-ahead path (`rescue_check_ahead`) and the separate local-branch
walk (a real branch tip, never a synthetic snapshot sha). So the exact
scenario the review named -- Part 2's new default-branch-name ancestor arm
accidentally gating a real new commit -- is not reachable in the shipped
code today; this is regression coverage against a FUTURE version of that
mistake, not a bug found in the current one.

Added to the existing `#233` describe block in
`test/bun/rescue-push.test.ts`: a worktree detached at an OLD ancestor of
origin's moved-ahead default-branch tip (no local tracking ref, same
fixture shape as the existing two cases in that block) PLUS a real file
change (not a marker) -- asserts `RESCUE_PUSHED` appears, never
`RESCUE_CLEAN`, never skipped. Verified meaningful by two live mutations,
reverted immediately after (not committed): (a) adding a bogus
`rescue_on_origin "$w" "$sha" "$rbranch"` gate into the dirty-tree branch
alone left this test GREEN -- proving `rescue_on_origin`'s own ancestor
logic correctly answers "no" for a genuinely new, never-pushed commit sha
(ancestry only ever runs the other direction); (b) the same bogus gate
PLUS forcing `rescue_on_origin` to unconditionally `return 0` turned this
test RED (`RESCUE_CLEAN` instead of a push) -- confirming the test does
catch the real failure shape the review was worried about, it just isn't
present in the code as shipped.

### Files touched (round 2)

- `apps/fleet/src/studio/rescue.ts` -- `resolveRescueTarget`'s `mint` param
  grew a `permissions` argument; new `mintRescuePushToken` helper; doc
  comments on `rescueMintPermissions` and the new helper.
- `apps/fleet/src/studio/do.ts` -- `rescueTarget()`'s mint closure now takes
  `permissions` as its own parameter instead of calling
  `rescueMintPermissions(purpose)` itself; dropped the now-unused
  `rescueMintPermissions` import.
- `apps/fleet/test/bun/rescue-remote.test.ts` -- five new cases for the
  retry (and its boundaries).
- `apps/fleet/test/bun/rescue-push.test.ts` -- one new case for Fix 2's
  extra coverage.
- `apps/fleet/test/studio.rescue-token.test.ts` -- pinned-source assertion
  updated to match the new closure shape (`permissions` passed straight
  through, never hard-coded, never calling `rescueMintPermissions` from
  `do.ts` directly any more).
- This file.

### Verification run (round 2, scoped -- no full gate)

- `bun test apps/fleet/test/bun/rescue-remote.test.ts` -- 21 pass, 0 fail.
- `bun test apps/fleet/test/bun/rescue-push.test.ts` -- 162 pass, 0 fail,
  621 expect() calls (160 pre-existing + 2 new).
- `npx vitest run test/studio.rescue-token.test.ts` -- 2 pass.
- `npx vitest run test/studio.provision.test.ts` -- 99 pass (unaffected
  source-pinning test for the shared `resolveRescueTarget(` call site).
- `npx vitest run test/studio.session.test.ts` -- 262 pass (unaffected
  `rescueTarget` port stub).
- Full `check`/`test`/`bun-test` gate deliberately NOT run here -- reserved
  for the lead, serialized, after this fix and the sibling #234 fix both
  land (per this round's own dispatch).

### Round 3 -- TS project-boundary regression (lead's own `check` run)

The lead's own `cd apps/fleet && bun run check` on this branch found a
genuine, deterministic break (reproduced fresh clone + fresh `bun install`,
not a flake): round 2 added `import { MintTokenError } from "../github/app"`
to `rescue.ts` and the same import to `test/bun/rescue-remote.test.ts`.
`rescue.ts` is documented as pure (no Worker bindings) and is imported
directly by `cli/fleet.ts`, which `cli/tsconfig.json` type-checks under
`"types": ["bun"]` -- no Cloudflare Workers ambient types at all. `app.ts`
(home of `mintInstallationToken`, which genuinely needs `Env`) imports
`Env`, which needs `D1Database`/`DurableObjectNamespace`/`R2Bucket`/etc from
`@cloudflare/workers-types`. TypeScript type-checks an imported file in full
once it's in a program's graph, regardless of which single export is
actually used -- so importing anything from `app.ts` dragged that whole
Workers-typed graph (every Durable Object class, `env.ts`, `state.ts`, etc.)
into `cli/tsconfig.json`'s and `test/tsconfig.json`'s `types:["bun"]`
projects, breaking both with ~288 lines of unrelated `Cannot find name
'D1Database'` / `Property 'env' does not exist on type 'StudioDO'` errors.
No runtime test caught this since none of them exercise TS project
boundaries -- only `tsc -p <project>` does.

Fix: moved `MintTokenError` (a tiny, self-contained class with zero
dependency on `Env`) out of `app.ts` into its own dependency-free module,
`apps/fleet/src/github/mint-token-error.ts`. `app.ts` now imports it and
re-exports it (so `auth.ts`'s existing import from `./app` is untouched);
`rescue.ts` and `rescue-remote.test.ts` import directly from the new module
instead of from `app.ts`. Pure file reorganization, zero behavior change,
same class, same semantics.

#### Files touched (round 3)

- `apps/fleet/src/github/mint-token-error.ts` -- new file, `MintTokenError`
  class moved here verbatim (plus its doc comment, plus a note on why it's
  split out).
- `apps/fleet/src/github/app.ts` -- removed the class definition; now
  imports and re-exports `MintTokenError` from the new module.
- `apps/fleet/src/studio/rescue.ts` -- import changed from `../github/app`
  to `../github/mint-token-error`.
- `apps/fleet/test/bun/rescue-remote.test.ts` -- import changed from
  `../../src/github/app` to `../../src/github/mint-token-error`.
- This file.

#### Verification run (round 3)

- RED confirmed first: `bun run check` on the branch as fetched (before this
  fix) failed with ~288 unrelated TS errors across `src/studio/do.ts`,
  `src/studio/sandbox-api.ts`, `src/studio/terminal.ts`,
  `src/tasks/loop.ts`, `src/tasks/watchdog.ts` -- all `Cannot find name
  'D1Database'`/`'WebSocketPair'` or `Property 'ctx'/'env' does not exist on
  type 'StudioDO'`, exactly the Workers-ambient-types-missing shape the root
  cause predicts.
- GREEN after the fix: `bun run check` -- exit 0, no output (all 5 `tsc
  --noEmit` invocations: root, `-p container`, `-p cli`, `-p
  test-integration`, `-p test`).
- `bun test test/bun/rescue-remote.test.ts test/bun/rescue-push.test.ts` --
  183 pass, 0 fail, 673 expect() calls.
- `npx vitest run test/studio.rescue-token.test.ts` -- 2 pass.
- Full `check`/`test`/`bun-test` heavy gate deliberately NOT re-run here --
  reserved for the lead, serialized, once.
