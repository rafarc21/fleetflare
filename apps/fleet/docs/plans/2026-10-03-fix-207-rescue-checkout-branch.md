# rescue_target() must never push to the checked-out branch's own name (board issue #207)

## The bug

2026-10-03 02:17Z: an operator ran `fleet destroy --park` on a studio in
another repo. The studio had an uncommitted, dev-only edit (a config file
that must never be committed), checked out on the HEAD branch of an open,
already-gated PR. Rescue-push committed that edit as the bot commit
`fleet: rescue-push before teardown` and pushed it straight onto the
checked-out branch — the gated PR's own head. A 45s push timeout happened to
turn that push into a harmless 409 (nothing landed), but had it succeeded,
the gated PR's head would have moved with an unreviewed, forbidden-file
commit.

Contrast: rescue on another studio, the same night, correctly pushed to
`refs/heads/fleet/rescue/<studio>/wt/<branch>-<ts>` — the generated-ref path
working as intended.

## Root cause

`apps/fleet/src/studio/rescue.ts`, `rescuePushCmd`'s `rescue_target()` (the
function used by the main-checkout dirty-tree and clean-but-ahead branches of
`rescue_one`). In checkout mode it resolved the repo's default branch and
compared it against the checked-out branch:

- checked-out branch == resolved default, or the default could not be
  resolved at all -> generate a fresh `fleet/rescue/<studio>-<ts>` ref
- checked-out branch != resolved default (the ordinary case once a studio's
  own agent branches) -> push to `$branch`, i.e. **the checked-out branch's
  own name**

This was a deliberate, documented design decision ("Fix round 2", 2026-08-27,
T5 Finding 1): the original bug it fixed was rescue pushing a studio's entire
dirty tree straight to `main` (unreviewed, or rejected non-fast-forward by a
shallow clone). The round-2 fix correctly stopped that for the default
branch, but kept pushing to any OTHER checked-out branch's own name — on the
theory that "a studio's own task branch" is always safe to write to directly.

Issue #207 is a filed bug saying that theory is wrong: a checked-out branch
can be the head of an already-gated, already-reviewed PR (e.g. after a studio
is parked and later re-attached, or simply because the lead's own task branch
IS the PR branch), and rescue must never write to it, ever — gated or
reviewed history must never move because of a teardown-time safety net.

`rescue_push()` (the function that does the actual push) threaded this
provenance through explicitly via a `generated` flag (Fresh review of PR
#359, Finding 1): `--no-verify` only when `generated="1"`, so a real-branch
push still ran through a repo's own pre-push hook. That conditional existed
entirely to protect the one case this fix removes — once `rescue_target()`
never produces a real branch name, the condition is always true and the
conditional is dead code.

## The fix

The precedent already exists in this same file: `rescueSnapshotCmd`'s
`snapshot_target()` was fixed for the same class of bug under issue #312
("HOLD-round fix", 2026-08-xx real-git review on PR #312) — in checkout mode
it ALWAYS generates a fresh `fleet/rescue/<studio>-<ts>` ref, never the
checked-out branch's own name, because a live studio's real branch must never
be a push target for a rescue's own (synthetic, in that case) commit.

`rescue_target()` (used by `rescuePushCmd`) now does the identical thing —
checkout mode always generates, matching `snapshot_target()`'s shape exactly:

```sh
rescue_target() {
  local mode="$2" id="$3"
  if [ "$mode" = "checkout" ]; then
    target="fleet/rescue/${studio}-$(date -u +%Y%m%d%H%M%S)"
  else
    target="fleet/rescue/${studio}/wt/$id-$(date -u +%Y%m%d%H%M%S)"
  fi
}
```

`$1`/`$w` is no longer read — the function no longer needs to inspect the
checkout at all, since it never branches on what's checked out. The calling
convention (called as a plain statement, setting `target` in the caller's
scope, never `$(...)`) is unchanged, so every call site (`rescue_one "$w"
"$id" "$mode"`'s two call sites) needed no change.

Since `rescue_target()` can no longer produce a real branch name, provenance
tracking (`target_generated`) is now always `1` in every case it can ever
produce — dead state, removed rather than left behind:

- `rescue_push()` drops the `generated` parameter and the `nv=""`/`if
  [ "$generated" = "1" ]` conditional entirely; it now always uses
  `--no-verify`, exactly like `rescueSnapshotCmd`'s own `rescue_push()`
  already does (which never had the conditional in the first place, for the
  same reason).
- `rescue_one()` drops the `target_generated` local and the 4th argument to
  both `rescue_push "$w" "$id" "$target" "$target_generated"` calls (both the
  dirty-tree branch and the clean-but-unpushed-commits branch), which become
  `rescue_push "$w" "$id" "$target"`.

No other call site in this file changes: the member-worktree branch of
`rescue_target()`, the branch-walk (`$b`), and the stash-walk never used the
checked-out-branch path in the first place — they already always generate.
`destroy.ts` and `do.ts` are untouched; they call `rescuePush`/`rescuePushCmd`
without knowing or caring how the target ref is chosen, so this one chokepoint
closes the bug for every caller.

## Doc-comment cleanup

Several long-standing doc comments in `rescue.ts` described the
branch-vs-default split as current behavior, or explained the now-removed
provenance threading as still necessary. Rather than delete the historical
narrative (this file's own convention — every fix cites its issue and
reasoning, kept as a record), each is corrected in place with a short note
pointing at #207 and explaining what changed and why, directly above or
beside the text that is now stale:

- The "Fix round 2... Two outcomes" bullets (describing the branch-vs-default
  split as rescuePushCmd's current behavior).
- "Fresh review of PR #359 round 1, Finding 1... Provenance is now threaded
  through explicitly" (the comment introducing `target_generated`).
- The C1 comment's claim that real-branch pushes "deliberately do NOT [skip
  hooks]" (no longer true — there is no real-branch push path left to protect
  with a hook).
- `rescue_push()`'s own `nv`/`generated` comment block.
- The #359 "mutant this guards against" comment, which explained why a test
  needed to distinguish "every push" from "only generated refs" — that
  distinction no longer exists.

## Tests changed

`apps/fleet/test/bun/rescue-push.test.ts`:

- New `describe("#207 ...")` block (added first, RED, before the production
  fix): dirty tree on a non-default checked-out branch that is also an open
  PR's own pushed head — asserts origin's branch ref is byte-unchanged and
  the edit lands on a generated `fleet/rescue/<studio>-<ts>` ref instead.
  Modeled directly on the existing `rescueSnapshotCmd`/#312 HOLD-round test.
- `"#263 C2"` / "dirty member AND lead on a new upstream-less branch..."
  test: rewritten. The lead's unpushed commit now lands on a generated
  `fleet/rescue/${STUDIO}-<ts>` ref (not `task/feature`'s own name);
  `task/feature` was never pushed in this fixture, so the rewritten
  assertion confirms it still doesn't exist on origin, and that the
  generated ref holds the lead's commit.
- `"#263 N3"` describe block (the non-fast-forward-retry-to-a-generated-ref
  test, which required a real checked-out branch as the FIRST push attempt's
  target so that branch could be moved out from under it by another clone)
  — deleted. Its precondition can no longer occur: the first attempt is now
  always a fresh generated ref no concurrent push can ever collide with.
  Replaced with a short comment at the same spot, referencing #207, matching
  the already-accepted gap `rescueSnapshotCmd`'s own HOLD-round comment
  documents for its own (never-reachable) NFF-retry call site.
- `"#359"` describe block: the parametrized `RESCUE_CMDS` test (dirty tree on
  the DEFAULT branch bypasses a failing pre-push hook) is unchanged. The two
  `rescuePushCmd`-only tests immediately after it ("still honors a failing
  pre-push hook" on a real feature branch, and the `fleet/rescue/collision`
  coincidental-name variant) are deleted, along with the comment block
  explaining their rationale — their whole premise (a real branch can ever be
  a push target) no longer exists.
- `"issue #1"` describe block (private rescue remote): the
  "pushed under its own name to the private remote" test is rewritten — the
  lead's work now lands on a generated `fleet/rescue/${STUDIO}-<ts>` ref on
  the private remote, and `task/lead` is absent from both origin and the
  private remote. The immediately-following non-fast-forward-on-the-private-
  remote test is deleted for the same unreachable-precondition reason as N3
  above.

Beyond the scenarios named above, running the full file surfaced three more
fixtures with the identical root problem, not individually anticipated going
in:

- `"#371 review Finding 1"`'s `setUpNonFastForwardRetryFixture` (the
  "remaining budget covers the DOUBLED (retry-pair) threshold" test) and
  `"#359 round 2 review, item 3"`'s own `rescue_push()`-retry-timeout test
  both built a real `task/lead` branch collision to force the first push
  attempt's rejection, the same way N3 did. Rather than delete these two
  (they prove a real, still-reachable code path — the NFF-retry's own
  `timeout -k` wrapping, and the budget guard's handling of a genuinely
  slow retry), both are rewritten to force the same rejection
  deterministically: `date -u +%Y%m%d%H%M%S` is PATH-shimmed to a fixed
  value, and that exact first-attempt ref name is squatted on origin by an
  unrelated commit ahead of the real run. This is the same technique the
  pre-existing `rescueSnapshotCmd`/private-remote collision test already
  used (`"its generated ref already taken on the private remote"`), just
  applied to `rescuePushCmd` and to origin instead of the private remote.
  Confirmed this mattered, not cosmetic: with the real-branch fixture left
  in place, the item-3 retry test kept passing but started proving the
  WRONG thing — the first attempt (now always a fresh, uncollided ref)
  tripped the slow hook itself and got killed by the timeout, never
  reaching the retry branch the test's own name and comment claim to
  isolate.
- `"issue #16"`'s `"rescuePushCmd, shallow + non-fast-forward: a push the
  budget cannot cover is never started"` test: same real-branch-collision
  problem, same fix — a `date`-shimmed deterministic collision squatted on
  the private remote this time, combined with the pre-existing slow
  `timeout` shim already in that test.

`"#49"` describe block: its own leading doc comment claimed "a repo's own
pre-push hook runs (#359: real branches keep hooks)" — corrected in place.
Its one broken test ("a GENUINE unpushed commit on that branch still fails
under the hook") is rewritten: the commit now lands cleanly on a generated
ref (a client-side hook can no longer observe a real-branch push at all),
rather than deleted, since the underlying fixture (an upstream-less branch
with a genuinely-ahead commit) is still a real, useful scenario once
re-pointed at the new expected outcome.

`"#58"` describe block: one test (`"pushurl differs from the fetch url"`)
asserted the push landed under `task/pr`'s own name at the pushurl
destination — updated to assert a generated ref lands there instead.

`apps/fleet/test/studio.session.test.ts`, `describe("rescuePushCmd — the
shell shape...")`:

- First test: dropped the now-unemitted `rev-parse --abbrev-ref HEAD`
  assertion; updated the `rescue_try_push` assertion from `"$w" "$nv" HEAD
  "$target"` to `"$w" --no-verify HEAD "$target"` (no more `$nv`).
- "resolves the repo's ACTUAL default branch..." test: deleted — there is no
  default-branch resolution left in `rescuePushCmd` at all.
- "diverts to a generated ref when checked-out branch matches default..."
  test: rewritten to assert the new unconditional-generation shape (no more
  `target_generated=1`, no more `$default`/`$branch` guard).
- "treats a detached HEAD... the same as the default branch" test: deleted —
  branch/HEAD is never inspected now, nothing to special-case.
- Every other test in the block (identity, `exit`, bare `cd`) is unaffected.

## Verification

- `bun test apps/fleet/test/bun/rescue-push.test.ts -t "#207"` — RED before
  the fix, GREEN after.
- `bun test apps/fleet/test/bun/rescue-push.test.ts` — full file green after
  all stale-test fixes.
- `cd apps/fleet && bunx vitest run test/studio.session.test.ts` — green
  after the stale-test fixes there.
- Full gates, run one at a time (never concurrently, per this fleet's own
  memory-ceiling constraint): `bun run check`, `bun run test`, `bun run
  bun-test`. `bun run test:integration` and `bun run test:acceptance` are
  deliberately out of scope — both need Docker this container doesn't have,
  matching the precedent in
  `apps/fleet/docs/plans/2026-09-30-bringup-launch-already-fixed-6.md`.

## Files touched

- `apps/fleet/src/studio/rescue.ts` — the fix itself, plus doc-comment
  cleanup.
- `apps/fleet/test/bun/rescue-push.test.ts` — new RED test, rewritten/deleted
  stale tests.
- `apps/fleet/test/studio.session.test.ts` — rewritten/deleted stale tests in
  the `rescuePushCmd` shell-shape describe block.
- This plan doc.
