# PR #75 merge-with-main resolution round (board issue #59 reassignment)

This doc covers ONLY this round's merge-resolution work, not #59's own
spawn/board/registry-gate architecture — that was already designed,
implemented, and documented by a prior studio; see PR #75's own body for all
of that. Scope here: reassignment text, verbatim — "Resolve PR #75 merge
conflicts with main (approved at 713c266); re-review needed only for the
resolution."

## Finding — origin/main had no shared ancestry with this branch

`origin/main` tip: `76b1b85`, a single orphan commit, zero shared history
with `59-maestro-in-container-routes`. Checked against the repo's own known
pattern first, before treating it as a problem: this matches the repo's
periodic squashed-public-export cycle (private history periodically
collapsed to one commit, real history preserved in a separate archive repo)
— not a bug, not something to "fix" by force-pushing or rewriting main.

## Approach — tree-diff before merge, to find the real content delta

Plain `git merge origin/main` refused outright: unrelated histories, no
common ancestor. `--allow-unrelated-histories` would work but produces
conflict noise proportional to the ENTIRE repo tree, not the real delta —
before running it, found the branch's own last-synced main tip still
present in its ancestry (`18b504a`, `#96`'s commit) and tree-diffed it
directly against the new `origin/main` tip (`git diff 18b504a 76b1b85` —
works fine without shared history, since it's a plain tree comparison, not a
merge-base walk). Result: exactly 3 files changed, 30 insertions, 1
deletion — matching PR #99 (write-proxy multi-ref default-branch test +
README/threat-model additions) end to end. Now the real target was known
before touching a single conflict marker.

## Execution

`git merge --allow-unrelated-histories origin/main` surfaced 18 add/add
conflicts (every file git couldn't 3-way-diff without a common ancestor).
Checked each one individually against the tree-diff computed above:

- 15 had zero real diff between `18b504a` and `76b1b85` — pure artifact of
  the missing common base, not genuine content changes. Resolved
  `--ours` (this branch's own content, unchanged).
- 3 were PR #99's real files. Hand-applied PR #99's exact hunks on top of
  this branch's own existing content at those paths, then diffed the result
  against the true `18b504a..76b1b85` delta again to confirm byte-identical
  — no partial-apply, no drift.

Merge commit: `6884628`, "merge origin/main into
59-maestro-in-container-routes - #59".

## Semantic check

PR #99 (write-proxy default-branch handling) and #59 (spawn/board/registry
gate logic) have zero conceptual overlap — confirmed by reading both, not
assumed from disjoint file paths alone.

## Verification

- Targeted vitest: 262/262 across the 6 touched-adjacent files.
- Targeted `bun test`: 21/21.
- `bun run check` (all 5 tsconfig projects): clean.
- english-check: clean.
- Both GitHub Actions checks on `6884628`: green.

Full detail (exact conflict list, exact hunks, exact commands run) lives in
PR #75's own "Merge with main (round 2)" body section — not duplicated here.
